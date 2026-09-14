import { describe, it, expect, vi, afterEach } from "vitest";
import { createClient } from "../src/api/routes/compat/sdk/index.ts";

/** The legacy dependency-free client (sdk/index.ts) against a stub fetch. */

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
function stubFetch(handler: Handler) {
  const calls: { url: string; method: string; body: any; headers: any }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers });
    return handler(url, init);
  });
  return calls;
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
/** An SSE body delivered as the given raw chunks (so frames can be split across chunks). */
const sse = (chunks: string[]) => new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch)); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
const frame = (e: unknown) => `event: x\ndata: ${JSON.stringify(e)}\n\n`;

afterEach(() => { vi.unstubAllGlobals(); });

describe("legacy sdk createClient", () => {
  it("create posts stream:false with bearer auth, strips a trailing slash, and returns a session", async () => {
    const calls = stubFetch(() => json({ id: "sess_1", info: { environment: { environment_id: "env_1" }, required_actions: [] } }, 201));
    const c = createClient({ baseURL: "http://h/agents-api/v1/", apiKey: "k" });
    const s = await c.beta.agents.sessions.create({ agent: { model: "m" }, stream: true });
    expect(calls[0]).toMatchObject({ url: "http://h/agents-api/v1/sessions", method: "POST", body: { agent: { model: "m" }, stream: false }, headers: { authorization: "Bearer k", "content-type": "application/json" } });
    expect(s.id).toBe("sess_1");
    expect(s.info.environment.environment_id).toBe("env_1");
  });

  it("create throws on a non-2xx response with the status and body", async () => {
    stubFetch(() => json({ error: { message: "nope" } }, 400));
    await expect(createClient({ baseURL: "http://h" }).beta.agents.sessions.create({ agent: { model: "m" } })).rejects.toThrow(/create failed 400: .*nope/);
  });

  it("retrieve sets info and status", async () => {
    stubFetch(() => json({ id: "sess_1", status: "requires_action", info: { environment: { environment_id: "e" }, required_actions: [{ call_id: "c" }] } }));
    const s: any = await createClient({ baseURL: "http://h" }).beta.agents.sessions.retrieve("sess_1");
    expect(s.status).toBe("requires_action");
    expect(s.info.required_actions).toEqual([{ call_id: "c" }]);
  });

  it("stream yields every frame and runs a handler on action_required", async () => {
    const client = createClient({ baseURL: "http://h" });
    const calls = stubFetch((url, init) => {
      if (url.endsWith("/tool_result")) return json({ accepted: true }, 202);
      if (url.endsWith("/sessions")) return json({ id: "sess_1", info: {} }, 201);
      if (init.method === "POST") return sse([frame({ type: "agent.session.action_required", session_id: "s", required_action: { turn_id: "turn_2", call_id: "c1", type: "function_call", name: "add", arguments: { a: 1, b: 2 } } }), frame({ type: "agent.session.turn.completed", session_id: "s" })]);
      return json({});
    });
    const sess = await client.beta.agents.sessions.create({ agent: { model: "m" } });
    const seen: string[] = [];
    let got: unknown;
    for await (const ev of sess.stream({ input: "go", tool_handlers: { add: (args: any) => { got = args; return args.a + args.b; } } })) seen.push(ev.type);
    expect(seen).toEqual(["agent.session.action_required", "agent.session.turn.completed"]);
    expect(got).toEqual({ a: 1, b: 2 });
    expect(calls.filter((c) => c.url.endsWith("/tool_result"))).toHaveLength(1);
  });

  it("stream posts success:false with {error} when the handler throws, and handles item.added function_call", async () => {
    const client = createClient({ baseURL: "http://h" });
    const calls = stubFetch((url, init) => {
      if (url.endsWith("/tool_result")) return json({ accepted: true }, 202);
      if (url.endsWith("/sessions")) return json({ id: "sess_1", info: {} }, 201);
      if (init.method === "POST") return sse([frame({ type: "session.turn.item.added", session_id: "s", function_call: { call_id: "c7", name: "boom", arguments: {} } }), frame({ type: "agent.session.turn.completed", session_id: "s" })]);
      return json({});
    });
    const sess = await client.beta.agents.sessions.create({ agent: { model: "m" } });
    for await (const _ of sess.stream({ input: "go", tool_handlers: { boom: () => { throw new Error("kaboom"); } } })) void _;
    const tr = calls.filter((c) => c.url.endsWith("/tool_result"));
    expect(tr).toHaveLength(1);
    expect(tr[0]!.body).toMatchObject({ call_id: "c7", success: false, output: { error: "Error: kaboom" } });
    expect(calls.find((c) => c.url.endsWith("/sessions/sess_1"))!.body).toEqual({ input: "go", stream: true });
  });

  it("stream posts the handler output on success and skips calls without a handler", async () => {
    const client = createClient({ baseURL: "http://h" });
    const calls = stubFetch((url, init) => {
      if (url.endsWith("/tool_result")) return json({ accepted: true }, 202);
      if (url.endsWith("/sessions")) return json({ id: "sess_1", info: {} }, 201);
      if (init.method === "POST") return sse([frame({ type: "agent.session.action_required", session_id: "s", required_action: { turn_id: "turn_2", call_id: "c1", type: "function_call", name: "add", arguments: { a: 1, b: 2 } } }), frame({ type: "agent.session.action_required", session_id: "s", required_action: { turn_id: "turn_2", call_id: "c2", type: "function_call", name: "unhandled", arguments: {} } })]);
      return json({});
    });
    const sess = await client.beta.agents.sessions.create({ agent: { model: "m" } });
    for await (const _ of sess.stream({ input: "go", tool_handlers: { add: ({ a, b }: any) => a + b } })) void _;
    expect(calls.filter((c) => c.url.endsWith("/tool_result")).map((c) => c.body)).toEqual([{ call_id: "c1", turn_id: "turn_2", success: true, output: 3 }]);
  });

  it("parseSse handles a frame split across chunks and ignores non-JSON data", async () => {
    const client = createClient({ baseURL: "http://h" });
    const whole = frame({ type: "a", session_id: "s" }) + "data: not json\n\n" + frame({ type: "b", session_id: "s" });
    stubFetch((url) => (url.endsWith("/sessions") ? json({ id: "sess_1", info: {} }, 201) : sse([whole.slice(0, 7), whole.slice(7, 30), whole.slice(30)])));
    const sess = await client.beta.agents.sessions.create({ agent: { model: "m" } });
    const seen: string[] = [];
    for await (const ev of sess.stream({ input: "x" })) seen.push(ev.type);
    expect(seen).toEqual(["a", "b"]);
  });

  // Regression: stream() never checks res.ok; a 404 JSON body yields no frames and the generator ends silently.
  it("stream against a 404 response surfaces an error", async () => {
    const client = createClient({ baseURL: "http://h" });
    stubFetch((url) => (url.endsWith("/sessions") ? json({ id: "sess_1", info: {} }, 201) : json({ type: "error", error: { type: "not_found_error", message: "session sess_1 not found" } }, 404)));
    const sess = await client.beta.agents.sessions.create({ agent: { model: "m" } });
    await expect((async () => { for await (const _ of sess.stream({ input: "x" })) void _; })()).rejects.toThrow();
  });

  // Regression: retrieve() never checks res.ok; a 404 silently sets info to undefined.
  it("retrieve on a 404 surfaces an error", async () => {
    stubFetch(() => json({ type: "error", error: { type: "not_found_error", message: "gone" } }, 404));
    await expect(createClient({ baseURL: "http://h" }).beta.agents.sessions.retrieve("sess_1")).rejects.toThrow();
  });

  // Regression: tool_result() never checks res.ok; a rejected result is swallowed.
  it("tool_result on a 400 surfaces an error", async () => {
    stubFetch((url) => (url.endsWith("/sessions") ? json({ id: "sess_1", info: {} }, 201) : json({ type: "error", error: { message: "call_id is required" } }, 400)));
    const sess = await createClient({ baseURL: "http://h" }).beta.agents.sessions.create({ agent: { model: "m" } });
    await expect(sess.tool_result({ call_id: "", success: true, output: "x" })).rejects.toThrow();
  });
});
