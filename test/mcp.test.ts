import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpHttpClient } from "../src/harness/mcp.ts";

// A fake MCP server over fetch: records posted JSON-RPC and replies (as JSON or SSE) per method.
let posts: { body: any; headers: Record<string, string> }[] = [];
let mode: "json" | "sse" = "json";
function reply(id: number, result: unknown) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  if (mode === "sse") return new Response(`event: message\ndata: ${msg}\n\n`, { status: 200, headers: { "content-type": "text/event-stream", "mcp-session-id": "sess-abc" } });
  return new Response(msg, { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "sess-abc" } });
}
beforeEach(() => {
  posts = [];
  vi.stubGlobal("fetch", async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    posts.push({ body, headers: init.headers });
    if (body.method === "initialize") return reply(body.id, { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake" } });
    if (body.method === "tools/list") return reply(body.id, { tools: [{ name: "list_commits", description: "list", inputSchema: { type: "object", properties: { repo: { type: "string" } } } }, { name: "secret_tool", inputSchema: {} }] });
    if (body.method === "tools/call") return reply(body.id, { content: [{ type: "text", text: `called ${body.params.name} with ${JSON.stringify(body.params.arguments)}` }], isError: false });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); // notifications
  });
});

describe("McpHttpClient", () => {
  for (const m of ["json", "sse"] as const) {
    it(`connects, lists and calls tools over ${m} responses; echoes the session id`, async () => {
      mode = m;
      const c = new McpHttpClient("https://api.example/mcp", { authorization: "Bearer tok" });
      await c.connect();
      // initialize sent auth; later requests echo the returned mcp-session-id
      expect(posts[0]!.headers.authorization).toBe("Bearer tok");
      expect(posts[0]!.body.method).toBe("initialize");
      const tools = await c.listTools();
      expect(tools.map((t) => t.name)).toEqual(["list_commits", "secret_tool"]);
      const listReq = posts.find((p) => p.body.method === "tools/list")!;
      expect(listReq.headers["mcp-session-id"]).toBe("sess-abc");
      const r = await c.callTool("list_commits", { repo: "acme/api" });
      expect(r.isError).toBe(false);
      expect(r.content[0]!.text).toContain("called list_commits");
    });
  }

  it("throws a helpful error on a JSON-RPC error response", async () => {
    vi.stubGlobal("fetch", async (_u: string, init: any) => {
      const b = JSON.parse(init.body);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, error: { code: -32601, message: "method not found" } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    await expect(new McpHttpClient("https://x/mcp").connect()).rejects.toThrow(/method not found/);
  });
});
