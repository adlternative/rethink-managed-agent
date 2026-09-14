/**
 * A minimal MCP (Model Context Protocol) client over the Streamable HTTP transport — enough to
 * connect to a remote MCP server, list its tools, and call them. Used by the compat layer so an
 * OpenAI `{type:"mcp", transport:{type:"http", server_url, authorization}}` tool decl actually
 * reaches a real server. It runs server-side (the runner), so credentials never enter the sandbox
 * (OpenAI's connection_origin:"service"); callers gate the server URL by the fetch allowlist.
 *
 * JSON-RPC 2.0 over HTTP POST. The server may answer a POST with either application/json (one
 * response) or text/event-stream (SSE frames); we accept both. An Mcp-Session-Id returned on
 * initialize is echoed on every later request.
 */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}
export interface McpCallResult {
  content: { type: string; text?: string; [k: string]: unknown }[];
  isError: boolean;
}

const PROTOCOL_VERSION = "2025-06-18";

export class McpHttpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  constructor(private url: string, private opts: { authorization?: string; headers?: Record<string, string>; timeoutMs?: number } = {}) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...this.opts.headers };
    if (this.opts.authorization) h.authorization = this.opts.authorization;
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    return h;
  }

  /** POST a JSON-RPC request and return its `result` (throws on JSON-RPC error). */
  private async rpc(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const res = await fetch(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      redirect: "error", // the URL was allowlist-checked; a redirect could lead anywhere
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (!res.ok) throw new Error(`MCP ${method} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const ct = res.headers.get("content-type") ?? "";
    const msgs = ct.includes("text/event-stream") ? this.parseSse(await res.text()) : [await res.json()];
    const reply = msgs.find((m) => m && (m as { id?: number }).id === id) as { result?: unknown; error?: { message?: string; code?: number } } | undefined;
    if (!reply) throw new Error(`MCP ${method}: no response for id ${id}`);
    if (reply.error) throw new Error(`MCP ${method} error ${reply.error.code}: ${reply.error.message}`);
    return reply.result;
  }

  /** Fire-and-forget JSON-RPC notification (no id, no response expected). */
  private async notify(method: string, params?: unknown): Promise<void> {
    await fetch(this.url, { method: "POST", headers: this.headers(), body: JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }), signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000), redirect: "error" }).catch(() => {});
  }

  private parseSse(body: string): unknown[] {
    const out: unknown[] = [];
    for (const frame of body.split(/\r?\n\r?\n/)) { // SSE allows CRLF line endings
      const data = frame.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (data) { try { out.push(JSON.parse(data)); } catch { /* skip */ } }
    }
    return out;
  }

  async connect(): Promise<void> {
    await this.rpc("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "rethink-managed-agent", version: "0.1" } });
    await this.notify("notifications/initialized");
  }

  /** All tools, following nextCursor pagination (bounded, in case a server keeps returning a cursor). */
  async listTools(): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const r = (await this.rpc("tools/list", cursor ? { cursor } : undefined)) as { tools?: McpToolInfo[]; nextCursor?: string };
      out.push(...(r.tools ?? []));
      if (typeof r.nextCursor !== "string" || !r.nextCursor || r.nextCursor === cursor) break;
      cursor = r.nextCursor;
    }
    return out;
  }

  async callTool(name: string, args: unknown): Promise<McpCallResult> {
    const r = (await this.rpc("tools/call", { name, arguments: args ?? {} })) as { content?: McpCallResult["content"]; isError?: boolean };
    return { content: r.content ?? [], isError: !!r.isError };
  }
}
