import { afterEach, describe, expect, it, vi } from "vitest";
import { McpHttpClient } from "../src/harness/mcp.ts";

afterEach(() => { vi.unstubAllGlobals(); });

type Handler = (body: any, init: any) => Response | Promise<Response>;
/** Fake MCP server: `handlers[method]` answers requests; notifications get an empty 202. */
function serve(handlers: Record<string, Handler>) {
  const posts: { body: any; init: any }[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    posts.push({ body, init });
    const h = handlers[body.method];
    if (h) return h(body, init);
    if (body.id === undefined) return new Response(null, { status: 202 });
    return json({ jsonrpc: "2.0", id: body.id, result: {} });
  });
  return posts;
}
const json = (v: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" }, ...init });
const ok = (result: unknown): Handler => (b) => json({ jsonrpc: "2.0", id: b.id, result });

describe("McpHttpClient errors", () => {
  it("surfaces HTTP errors with status and a body excerpt", async () => {
    serve({ initialize: () => new Response("x".repeat(1000) + "TAIL", { status: 500 }) });
    const err = await new McpHttpClient("https://m/mcp").connect().catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^MCP initialize HTTP 500: x+$/);
    expect((err as Error).message).not.toContain("TAIL");
  });

  it("throws 'no response for id' when the reply id does not match", async () => {
    serve({ initialize: (b) => json({ jsonrpc: "2.0", id: b.id + 100, result: {} }) });
    await expect(new McpHttpClient("https://m/mcp").connect()).rejects.toThrow(/MCP initialize: no response for id 1/);
  });

  it("returns isError from tools/call and defaults missing content", async () => {
    serve({ "tools/call": (b) => json({ jsonrpc: "2.0", id: b.id, result: b.params.name === "bad" ? { content: [{ type: "text", text: "denied" }], isError: true } : {} }) });
    const c = new McpHttpClient("https://m/mcp");
    expect(await c.callTool("bad", undefined)).toEqual({ content: [{ type: "text", text: "denied" }], isError: true });
    expect(await c.callTool("empty", { a: 1 })).toEqual({ content: [], isError: false });
  });

  it("sends an empty arguments object when args are undefined", async () => {
    const posts = serve({ "tools/call": ok({ content: [] }) });
    await new McpHttpClient("https://m/mcp").callTool("t", undefined);
    expect(posts[0]!.body.params).toEqual({ name: "t", arguments: {} });
  });
});

describe("McpHttpClient SSE", () => {
  it("skips a notification frame that precedes the response (LF framing)", async () => {
    serve({ "tools/list": (b) => new Response(`event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: b.id, result: { tools: [{ name: "a", inputSchema: {} }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } }) });
    expect((await new McpHttpClient("https://m/mcp").listTools()).map((t) => t.name)).toEqual(["a"]);
  });

  it("parses CRLF-framed SSE responses (regression: frames split on \\n\\n only)", async () => {
    serve({ initialize: (b) => new Response(`event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: b.id, result: {} })}\r\n\r\n`, { headers: { "content-type": "text/event-stream" } }) });
    await expect(new McpHttpClient("https://m/mcp").connect()).resolves.toBeUndefined();
  });
});

describe("McpHttpClient requests", () => {
  it("follows tools/list nextCursor pagination (regression: only the first page is returned)", async () => {
    const posts = serve({ "tools/list": (b) => json({ jsonrpc: "2.0", id: b.id, result: b.params?.cursor === "p2" ? { tools: [{ name: "second", inputSchema: {} }] } : { tools: [{ name: "first", inputSchema: {} }], nextCursor: "p2" } }) });
    const names = (await new McpHttpClient("https://m/mcp").listTools()).map((t) => t.name);
    expect(names).toEqual(["first", "second"]);
    expect(posts.filter((p) => p.body.method === "tools/list")[1]!.body.params).toEqual({ cursor: "p2" });
  });

  it("honors timeoutMs through the request signal", async () => {
    vi.stubGlobal("fetch", (_u: string, init: any) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason), { once: true })));
    const started = Date.now();
    await expect(new McpHttpClient("https://m/mcp", { timeoutMs: 30 }).connect()).rejects.toThrow(/timeout|aborted/i);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("merges custom headers; authorization overrides a header of the same name; session id is echoed", async () => {
    const posts = serve({ initialize: (b) => json({ jsonrpc: "2.0", id: b.id, result: {} }, { headers: { "content-type": "application/json", "mcp-session-id": "sid-1" } }) });
    const c = new McpHttpClient("https://m/mcp", { authorization: "Bearer real", headers: { authorization: "Bearer stale", "x-tenant": "t1" } });
    await c.connect();
    await c.listTools();
    const [init, notify, list] = posts.map((p) => p.init.headers as Record<string, string>);
    expect(init).toMatchObject({ authorization: "Bearer real", "x-tenant": "t1", "content-type": "application/json", accept: "application/json, text/event-stream" });
    expect(init!["mcp-session-id"]).toBeUndefined();
    expect(posts[1]!.body).toEqual({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    expect(notify!["mcp-session-id"]).toBe("sid-1");
    expect(list!["mcp-session-id"]).toBe("sid-1");
    expect(posts.map((p) => p.body.id)).toEqual([1, undefined, 2]);
  });

  it("a failing initialized notification does not fail connect", async () => {
    vi.stubGlobal("fetch", async (_u: string, init: any) => {
      const b = JSON.parse(init.body);
      if (b.id === undefined) throw new Error("network down");
      return json({ jsonrpc: "2.0", id: b.id, result: {} });
    });
    await expect(new McpHttpClient("https://m/mcp").connect()).resolves.toBeUndefined();
  });
});
