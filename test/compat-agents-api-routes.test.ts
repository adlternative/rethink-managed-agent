import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

/**
 * Route tests for the legacy /agents-api/v1 surface and its SSE re-encode (sse.ts
 * streamOpenAiEvents), with repos, the event log, pubsub and sendUserEvents faked in memory.
 */

const st = vi.hoisted(() => ({
  sessions: new Map<string, any>(),
  events: new Map<string, any[]>(),
  calls: { listEvents: [] as any[], sendUserEvents: [] as any[], sessionsCreate: 0 },
  subs: [] as { sid: string; cb: (d: any) => void; unsubs: number }[],
  n: 0,
}));

vi.mock("../src/infra/db.ts", async (orig) => {
  const real = await orig<typeof import("../src/infra/db.ts")>();
  const owned = (row: any, scope?: { owner: string }) => (row && (!scope || row.owner_id === scope.owner) ? row : null);
  return {
    ...real,
    repos: {
      ...real.repos,
      environments: { get: async (id: string) => (id === "env_1" ? { id, owner_id: "prc_a", workspace: { kind: "empty" } } : null) },
      workspaces: { create: async (spec: any, ref: any, owner_id: string) => ({ id: `ws_${++st.n}`, owner_id, spec, ref }) },
      agents: { create: async (input: any) => ({ id: `agent_${++st.n}`, created_at: "x", ...input }) },
      sessions: {
        create: async (input: any) => { st.calls.sessionsCreate++; const s = { id: `sess_${++st.n}`, status: "idle", created_at: "x", ...input }; st.sessions.set(s.id, s); return s; },
        get: async (id: string, scope?: any) => owned(st.sessions.get(id), scope),
        delete: async (id: string) => { st.sessions.delete(id); },
      },
    },
  };
});

vi.mock("../src/infra/events.ts", async (orig) => {
  const real = await orig<typeof import("../src/infra/events.ts")>();
  const q = await import("./fixtures/event-queries/index.ts");
  return {
    ...real,
    lastSeq: async (sid: string) => q.lastSeqOf(st.events.get(sid) ?? []),
    listEventsForState: async (sid: string, types: string[], toolNames: string[] = []) => q.stateFilter(st.events.get(sid) ?? [], types, toolNames),
    listEvents: async (sid: string, opts: { since?: number; limit?: number } = {}) => {
      st.calls.listEvents.push({ sid, opts });
      return (st.events.get(sid) ?? []).filter((e) => e.seq > (opts.since ?? 0)).slice(0, opts.limit ?? 10000);
    },
  };
});

vi.mock("../src/infra/pubsub.ts", async (orig) => {
  const real = await orig<typeof import("../src/infra/pubsub.ts")>();
  return { ...real, subscribe: async (sid: string, cb: (d: any) => void) => { const s = { sid, cb, unsubs: 0 }; st.subs.push(s); return () => { s.unsubs++; }; } };
});

vi.mock("../src/api/routes/events.ts", async (orig) => {
  const real = await orig<typeof import("../src/api/routes/events.ts")>();
  return { ...real, sendUserEvents: async (session: any, inputs: any[]) => { st.calls.sendUserEvents.push({ session: session.id, inputs }); return []; } };
});

const { agentsApi } = await import("../src/api/routes/compat/agents-api.ts");
const { errorResponse } = await import("../src/api/errors.ts");

const app = new Hono()
  .onError((err, c) => errorResponse(c, err))
  .use("*", async (c, next) => { c.set("owner" as never, (c.req.header("x-owner") ?? "prc_a") as never); await next(); })
  .route("/agents-api/v1", agentsApi);

const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) =>
  app.request(`/agents-api/v1${p}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal });

const agentSnap = { id: "agent_1", name: null, model: { provider: "qoder", id: "ultimate" }, system: null, tools: [], client_tools: [{ type: "function", name: "propose", parameters: {} }], mcp_servers: [] };
const addSession = (over: Record<string, unknown> = {}) => {
  const s = { id: `sess_${++st.n}`, owner_id: "prc_a", environment_id: "env_1", workspace_id: "ws_1", status: "idle", agent: agentSnap, ...over };
  st.sessions.set(s.id, s);
  return s;
};
const ev = (sid: string, seq: number, payload: any) => ({ id: `evt_${seq}`, session_id: sid, seq, type: payload.type, payload, created_at: "x" });
const setLog = (sid: string, payloads: any[]) => st.events.set(sid, payloads.map((p, i) => ev(sid, i + 1, p)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readSse(res: Response, ms: number, ctrl?: AbortController): Promise<{ frames: { event?: string; data: any }[]; ended: boolean }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  let ended = false;
  const deadline = Date.now() + ms;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const r = await Promise.race([reader.read(), sleep(left).then(() => null)]);
    if (!r) break;
    if (r.done) { ended = true; break; }
    text += dec.decode(r.value, { stream: true });
  }
  if (!ended) { ctrl?.abort(); await reader.cancel().catch(() => {}); }
  const frames = text.split("\n\n").filter((f) => f.includes("data:")).map((f) => {
    const lines = f.split("\n");
    return { event: lines.find((l) => l.startsWith("event:"))?.slice(6).trim(), data: JSON.parse(lines.find((l) => l.startsWith("data:"))!.slice(5).trim()) };
  });
  return { frames, ended };
}

beforeEach(() => {
  st.sessions.clear(); st.events.clear(); st.subs.length = 0;
  st.calls = { listEvents: [], sendUserEvents: [], sessionsCreate: 0 };
});

describe("legacy /agents-api/v1 routes", () => {
  it("POST /sessions creates, forwards a string input, and returns the OpenAI-shaped session", async () => {
    const res = await call("POST", "/sessions", { agent: { model: "x", tools: [{ type: "function", name: "propose", parameters: {} }] }, environment: { environment_id: "env_1" }, input: "go" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ object: "agent.session", status: "idle", info: { environment: { environment_id: "env_1" }, required_actions: [] } });
    expect(st.calls.sendUserEvents).toEqual([{ session: body.id, inputs: [{ type: "user.message", content: [{ type: "text", text: "go" }] }] }]);
  });

  it("POST /sessions without agent -> 400; unknown environment -> 404", async () => {
    expect((await call("POST", "/sessions", {})).status).toBe(400);
    expect((await call("POST", "/sessions", { agent: { model: "x" }, environment: { environment_id: "env_zz" } })).status).toBe(404);
  });

  it("POST /sessions/:id with input 123 -> 400 and nothing sent", async () => {
    const s = addSession();
    const res = await call("POST", `/sessions/${s.id}`, { input: 123 });
    expect(res.status).toBe(400);
    expect(st.calls.sendUserEvents).toEqual([]);
  });

  it("POST /sessions/:id with a string input (non-stream) returns the reloaded session", async () => {
    const s = addSession({ status: "running" });
    setLog(s.id, [{ type: "session.status_running" }, { type: "agent.tool_use", tool_use_id: "c1", name: "propose", input: {} }]);
    const body = await (await call("POST", `/sessions/${s.id}`, { input: "more" })).json();
    expect(body.status).toBe("requires_action");
    expect(st.calls.sendUserEvents[0].inputs[0]).toEqual({ type: "user.message", content: [{ type: "text", text: "more" }] });
  });

  it("POST /sessions/:id/tool_result without call_id -> 400", async () => {
    const s = addSession();
    expect((await call("POST", `/sessions/${s.id}/tool_result`, { output: "x" })).status).toBe(400);
    expect(st.calls.sendUserEvents).toEqual([]);
  });

  it("POST /sessions/:id/tool_result with call_id -> 202, is_error from success===false, object output stringified", async () => {
    const s = addSession();
    const res = await call("POST", `/sessions/${s.id}/tool_result`, { call_id: "c1", turn_id: "turn_3", success: false, output: { error: "bad" } });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ session_id: s.id, call_id: "c1", turn_id: "turn_3", accepted: true });
    expect(st.calls.sendUserEvents[0].inputs).toEqual([{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "{\"error\":\"bad\"}" }], is_error: true }]);
    await call("POST", `/sessions/${s.id}/tool_result`, { call_id: "c2", output: "ok" });
    expect(st.calls.sendUserEvents[1].inputs[0]).toMatchObject({ content: [{ type: "text", text: "ok" }], is_error: false });
  });

  it("DELETE /sessions/:id returns deleted:true; other owners get 404", async () => {
    const s = addSession();
    expect((await call("GET", `/sessions/${s.id}`, undefined, { "x-owner": "prc_b" })).status).toBe(404);
    expect((await call("DELETE", `/sessions/${s.id}`, undefined, { "x-owner": "prc_b" })).status).toBe(404);
    expect(await (await call("DELETE", `/sessions/${s.id}`)).json()).toEqual({ id: s.id, object: "agent.session", deleted: true });
    expect((await call("GET", `/sessions/${s.id}`)).status).toBe(404);
  });

  // Regression: Number("abc") is NaN, which is passed straight to listEvents as the cursor.
  it("GET /sessions/:id/events/stream?since=abc does not issue a NaN cursor query", async () => {
    const s = addSession();
    setLog(s.id, [{ type: "session.status_running" }, { type: "session.status_idle", stop_reason: "end_turn" }]);
    const ctrl = new AbortController();
    const res = await call("GET", `/sessions/${s.id}/events/stream?since=abc`, undefined, {}, ctrl.signal);
    if (res.status !== 400) await readSse(res, 1500, ctrl);
    for (const c of st.calls.listEvents) expect(Number.isNaN(c.opts.since)).toBe(false);
  });
});

describe("legacy SSE (streamOpenAiEvents)", () => {
  it("events/stream replays from the cursor and closes at turn end", async () => {
    const s = addSession();
    setLog(s.id, [{ type: "session.status_running" }, { type: "agent.tool_use", tool_use_id: "c1", name: "propose", input: { a: 1 } }, { type: "agent.tool_use", tool_use_id: "c2", name: "bash", input: {} }, { type: "session.status_idle", stop_reason: "end_turn" }]);
    const ctrl = new AbortController();
    const res = await call("GET", `/sessions/${s.id}/events/stream?since=1`, undefined, {}, ctrl.signal);
    const { frames, ended } = await readSse(res, 3000, ctrl);
    expect(ended).toBe(true);
    expect(frames.map((f) => f.event)).toEqual(["agent.session.action_required", "session.turn.item.added", "agent.session.turn.completed"]);
    expect(frames[0]!.data.required_action).toMatchObject({ call_id: "c1", name: "propose" });
    expect(st.subs[0]!.unsubs).toBeGreaterThanOrEqual(1);
  });

  it("POST /sessions stream:true emits synthCreated first and closes on status_terminated", async () => {
    const ctrl = new AbortController();
    const res = await call("POST", "/sessions", { agent: { model: "x", tools: [{ type: "programmatic_tool_calling" }] }, environment: { environment_id: "env_1" }, input: "go", stream: true }, {}, ctrl.signal);
    for (let i = 0; i < 200 && st.subs.length === 0; i++) await sleep(5);
    const sub = st.subs[0]!;
    sub.cb({ type: "event", event: ev(sub.sid, 1, { type: "session.status_running" }) });
    sub.cb({ type: "agent.message_delta", session_id: sub.sid, stream_id: "x", text: "hi" });
    sub.cb({ type: "event", event: ev(sub.sid, 2, { type: "session.status_terminated", reason: "archived" }) });
    const { frames, ended } = await readSse(res, 3000, ctrl);
    expect(ended).toBe(true);
    expect(frames.map((f) => f.event)).toEqual(["session.created", "session.turn.created", "response.output_text.delta", "session.completed"]);
    expect(frames[0]!.data).toMatchObject({ type: "session.created", session_id: sub.sid, environment: { environment_id: "env_1" }, ignored: [{ type: "programmatic_tool_calling" }] });
  });

  it("POST /sessions/:id stream:true starts at the tail and closes at idle", async () => {
    const s = addSession();
    setLog(s.id, [{ type: "session.status_running" }, { type: "session.status_idle", stop_reason: "end_turn" }]);
    const ctrl = new AbortController();
    const res = await call("POST", `/sessions/${s.id}`, { input: "again", stream: true }, {}, ctrl.signal);
    for (let i = 0; i < 200 && st.subs.length === 0; i++) await sleep(5);
    st.subs[0]!.cb({ type: "event", event: ev(s.id, 3, { type: "session.status_running" }) });
    st.subs[0]!.cb({ type: "event", event: ev(s.id, 4, { type: "session.status_idle", stop_reason: "interrupted" }) });
    const { frames, ended } = await readSse(res, 3000, ctrl);
    expect(ended).toBe(true);
    expect(frames.map((f) => f.event)).toEqual(["session.turn.created", "turn.cancelled"]);
  });

  // Regression: stream:true without input never triggers a turn, so the SSE never closes.
  it("POST /sessions stream:true without input either 400s or terminates", async () => {
    const ctrl = new AbortController();
    const res = await call("POST", "/sessions", { agent: { model: "x" }, environment: { environment_id: "env_1" }, stream: true }, {}, ctrl.signal);
    if (res.status === 400) return;
    expect((await readSse(res, 1500, ctrl)).ended).toBe(true);
  });
});
