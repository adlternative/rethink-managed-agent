import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Route tests for the official OpenAI Agents API surface (/openai/v1) with every storage and bus
 * seam faked in memory: repos (sessions, workspaces, environments, agents), vaults, the event log,
 * pubsub subscribe, sendUserEvents, and the secrets switch. Artifacts use a real temp directory.
 */

const st = vi.hoisted(() => ({
  sessions: new Map<string, any>(),
  environments: new Map<string, any>(),
  workspaces: new Map<string, any>(),
  events: new Map<string, any[]>(),
  vaults: new Map<string, any>(),
  creds: new Map<string, Map<string, string>>(),
  calls: { workspacesCreate: 0, agentsCreate: 0, sessionsCreate: 0, listPage: [] as any[], listEvents: [] as any[], sendUserEvents: [] as any[], put: [] as any[] },
  subs: [] as { sid: string; cb: (d: any) => void; unsubs: number }[],
  secrets: true,
  deferredSince: null as null | Promise<any[]>,
  n: 0,
}));

vi.mock("../src/infra/db.ts", async (orig) => {
  const real = await orig<typeof import("../src/infra/db.ts")>();
  const owned = (row: any, scope?: { owner: string }) => (row && (!scope || row.owner_id === scope.owner) ? row : null);
  return {
    ...real,
    repos: {
      ...real.repos,
      environments: { get: async (id: string, scope?: any) => owned(st.environments.get(id), scope) },
      workspaces: {
        create: async (spec: any, ref: any, owner_id: string) => { st.calls.workspacesCreate++; const w = { id: `ws_${++st.n}`, owner_id, spec, ref }; st.workspaces.set(w.id, w); return w; },
        get: async (id: string, scope?: any) => owned(st.workspaces.get(id), scope),
      },
      agents: { create: async (input: any) => { st.calls.agentsCreate++; return { id: `agent_${++st.n}`, created_at: "2026-01-01T00:00:00.000Z", ...input }; } },
      sessions: {
        create: async (input: any) => { st.calls.sessionsCreate++; const s = { id: `sess_${++st.n}`, status: "idle", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", parent_id: null, ...input }; st.sessions.set(s.id, s); return s; },
        get: async (id: string, scope?: any) => owned(st.sessions.get(id), scope),
        childrenOf: async (parentId: string, scope?: any) => [...st.sessions.values()].filter((s) => s.parent_id === parentId && owned(s, scope)),
        listPage: async (scope: any, opts: any) => { st.calls.listPage.push(opts); return { data: [...st.sessions.values()].filter((s) => owned(s, scope)), has_more: false, next_cursor: null }; },
        delete: async (id: string) => { st.sessions.delete(id); },
      },
    },
    vaults: {
      create: async (input: any) => { const v = { id: `vault_${++st.n}`, owner_id: input.owner_id, name: input.name, metadata: input.metadata ?? {}, created_at: "2026-01-01T00:00:00.000Z" }; st.vaults.set(v.id, v); return v; },
      get: async (id: string, scope?: any) => owned(st.vaults.get(id), scope),
      list: async (scope?: any) => [...st.vaults.values()].filter((v) => owned(v, scope)),
      delete: async (id: string, scope?: any) => (owned(st.vaults.get(id), scope) ? st.vaults.delete(id) : false),
    },
    vaultCredentials: {
      put: async (vaultId: string, input: any) => { st.calls.put.push({ vaultId, ...input }); (st.creds.get(vaultId) ?? st.creds.set(vaultId, new Map()).get(vaultId)!).set(input.name, input); return { id: `cred_${input.name}`, vault_id: vaultId, name: input.name, kind: input.kind, mcp_server_url: input.mcp_server_url ?? null, metadata: {}, created_at: "2026-01-01T00:00:00.000Z" }; },
      list: async (vaultId: string) => [...(st.creds.get(vaultId)?.keys() ?? [])].map((name) => ({ id: `cred_${name}`, vault_id: vaultId, name, metadata: {}, created_at: "x" })),
      byId: async (id: string, vaultIds: string[]) => { for (const v of vaultIds) for (const [name, input] of st.creds.get(v) ?? []) if (`cred_${name}` === id) return { id, vault_id: v, name, kind: input.kind, mcp_server_url: input.mcp_server_url ?? null, metadata: {}, created_at: "x" }; return null; },
      delete: async (vaultId: string, name: string) => st.creds.get(vaultId)?.delete(name) ?? false,
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
    // Mirrors the real SQL: seq > since, ORDER BY seq, LIMIT (default 10000).
    listEvents: async (sid: string, opts: { since?: number; limit?: number } = {}) => {
      st.calls.listEvents.push({ sid, opts });
      if (opts.since !== undefined && st.deferredSince) { const d = st.deferredSince; st.deferredSince = null; return d; }
      return (st.events.get(sid) ?? []).filter((e) => e.seq > (opts.since ?? 0)).slice(0, opts.limit ?? 10000);
    },
  };
});

vi.mock("../src/infra/pubsub.ts", async (orig) => {
  const real = await orig<typeof import("../src/infra/pubsub.ts")>();
  return { ...real, subscribe: async (sid: string, cb: (d: any) => void) => { const s = { sid, cb, unsubs: 0 }; st.subs.push(s); return () => { s.unsubs++; }; } };
});

vi.mock("../src/infra/secrets.ts", async (orig) => {
  const real = await orig<typeof import("../src/infra/secrets.ts")>();
  return { ...real, secretsConfigured: () => st.secrets };
});

vi.mock("../src/api/routes/events.ts", async (orig) => {
  const real = await orig<typeof import("../src/api/routes/events.ts")>();
  return { ...real, sendUserEvents: async (session: any, inputs: any[]) => { st.calls.sendUserEvents.push({ session: session.id, inputs }); return []; } };
});

const { openaiAgents } = await import("../src/api/routes/compat/openai-agents.ts");
const { errorResponse } = await import("../src/api/errors.ts");

const app = new Hono()
  .onError((err, c) => errorResponse(c, err))
  .use("*", async (c, next) => { c.set("owner" as never, (c.req.header("x-owner") ?? "prc_a") as never); await next(); })
  .route("/openai/v1", openaiAgents);

const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) =>
  app.request(`/openai/v1${p}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), signal });

const agentSnap = { id: "agent_1", name: null, model: { provider: "qoder", id: "ultimate" }, system: null, tools: [], packages: [], skills: [], client_tools: [{ type: "function", name: "lookup", parameters: {} }], mcp_servers: [] };
const addSession = (over: Record<string, unknown> = {}) => {
  const s = { id: `sess_${++st.n}`, owner_id: "prc_a", agent_id: "agent_1", environment_id: "env_1", workspace_id: "ws_none", status: "idle", parent_id: null, vault_ids: [], created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", agent: agentSnap, ...over };
  st.sessions.set(s.id, s);
  return s;
};
const ev = (sid: string, seq: number, payload: any) => ({ id: `evt_${seq}`, session_id: sid, seq, type: payload.type, payload, created_at: "2026-01-01T00:00:00.000Z" });
const setLog = (sid: string, payloads: any[]) => st.events.set(sid, payloads.map((p, i) => ev(sid, i + 1, p)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read an SSE body until it closes or `ms` elapses; then cancel. */
async function readSse(res: Response, ms: number, ctrl?: AbortController): Promise<{ frames: any[]; ended: boolean }> {
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
  const frames = text.split("\n\n").map((f) => f.split("\n").find((l) => l.startsWith("data:"))).filter(Boolean).map((l) => JSON.parse(l!.slice(5).trim()));
  return { frames, ended };
}

beforeEach(() => {
  st.sessions.clear(); st.environments.clear(); st.workspaces.clear(); st.events.clear(); st.vaults.clear(); st.creds.clear();
  st.calls = { workspacesCreate: 0, agentsCreate: 0, sessionsCreate: 0, listPage: [], listEvents: [], sendUserEvents: [], put: [] };
  st.subs.length = 0; st.secrets = true; st.deferredSince = null;
  st.environments.set("env_1", { id: "env_1", owner_id: "prc_a", workspace: { kind: "empty" } });
});

describe("POST /agents/sessions", () => {
  const good = { agent: { model: "x", tools: [{ type: "function", name: "lookup", parameters: {} }] }, environment: { environment_id: "env_1" } };

  it("creates a session, forwards a string input, and returns an AgentSession (201)", async () => {
    st.vaults.set("vault_z", { id: "vault_z", owner_id: "prc_a", name: null, metadata: {}, created_at: "2026-01-01T00:00:00.000Z" }); // vault_ids must be the caller's own vaults
    const res = await call("POST", "/agents/sessions", { ...good, input: "hello", vault_ids: ["vault_z"] });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ object: "agent.session", status: "idle", environment: { environment_id: "env_1" }, vault_ids: ["vault_z"] });
    expect(st.calls.sendUserEvents).toEqual([{ session: body.id, inputs: [{ type: "user.message", content: [{ type: "text", text: "hello" }] }] }]);
    expect(st.sessions.get(body.id).agent.client_tools.map((t: any) => t.name)).toEqual(["lookup"]);
  });

  it("an mcp tool may name a vault credential; one outside the session's vaults, or an env var, is rejected", async () => {
    st.vaults.set("vault_z", { id: "vault_z", owner_id: "prc_a", name: null, metadata: {}, created_at: "2026-01-01T00:00:00.000Z" });
    st.vaults.set("vault_other", { id: "vault_other", owner_id: "prc_a", name: null, metadata: {}, created_at: "2026-01-01T00:00:00.000Z" });
    const put = (vid: string, body: any) => call("POST", `/vaults/${vid}/credentials`, body);
    await put("vault_z", { name: "docs", auth: { type: "static_bearer", mcp_server_url: "https://docs.example.com/mcp", token: "tok" } });
    await put("vault_z", { name: "PLAIN_ENV", value: "v" });
    await put("vault_other", { name: "elsewhere", auth: { type: "static_bearer", mcp_server_url: "https://x.example.com/mcp", token: "tok" } });
    const withServer = (extra: Record<string, unknown>) => ({
      ...good,
      agent: { model: "x", tools: [{ type: "mcp", server_label: "docs", transport: { type: "http", server_url: "https://docs.example.com/mcp" }, ...extra }] },
      vault_ids: ["vault_z"],
    });

    const ok = await call("POST", "/agents/sessions", withServer({ credential_id: "cred_docs" }));
    expect(ok.status).toBe(201);
    expect(st.sessions.get((await ok.json()).id).agent.mcp_servers).toEqual([{ label: "docs", url: "https://docs.example.com/mcp", credential_id: "cred_docs" }]);

    for (const bad of [{ credential_id: "cred_elsewhere" }, { credential_id: "cred_nope" }, { credential_id: "cred_PLAIN_ENV" }]) {
      const res = await call("POST", "/agents/sessions", withServer(bad));
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toMatch(/credential/);
    }
    // a server without credentials needs no secret key at all: the runner matches one by URL at run time
    st.secrets = false;
    expect((await call("POST", "/agents/sessions", withServer({}))).status).toBe(201);
  });

  it("rejects an mcp tool asking for the stdio transport instead of ignoring it", async () => {
    const res = await call("POST", "/agents/sessions", { ...good, agent: { model: "x", tools: [{ type: "mcp", server_label: "local", transport: { type: "stdio", command: "npx", cwd: "/tmp" } }] } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/stdio/);
  });

  it("requires agent, and 404s an environment the caller does not own", async () => {
    expect((await call("POST", "/agents/sessions", { environment: { environment_id: "env_1" } })).status).toBe(400);
    const res = await call("POST", "/agents/sessions", good, { "x-owner": "prc_b" });
    expect(res.status).toBe(404);
    expect(st.calls.sessionsCreate).toBe(0);
  });

  it("input array of messages concatenates input_text blocks", async () => {
    await call("POST", "/agents/sessions", { ...good, input: [{ role: "user", content: [{ type: "input_text", text: "a" }, { type: "input_text", text: "b" }] }] });
    expect(st.calls.sendUserEvents[0].inputs).toEqual([{ type: "user.message", content: [{ type: "text", text: "ab" }] }]);
  });

  it("a non-string, non-array input returns 400", async () => {
    const res = await call("POST", "/agents/sessions", { ...good, input: 42 });
    expect(res.status).toBe(400);
  });

  // Regression: input is parsed after the workspace/agent/session rows are persisted, leaving orphans behind the 400.
  it("invalid input is rejected before any row is created", async () => {
    const res = await call("POST", "/agents/sessions", { ...good, input: 42 });
    expect(res.status).toBe(400);
    expect({ ws: st.calls.workspacesCreate, agents: st.calls.agentsCreate, sessions: st.calls.sessionsCreate }).toEqual({ ws: 0, agents: 0, sessions: 0 });
  });

  // Regression: stream:true with no usable input never enqueues a turn, so the SSE loop waits forever for idle.
  it("stream:true with input omitted either 400s or returns a stream that terminates", async () => {
    const ctrl = new AbortController();
    const res = await call("POST", "/agents/sessions", { ...good, stream: true }, {}, ctrl.signal);
    if (res.status === 400) return;
    expect((await readSse(res, 1500, ctrl)).ended).toBe(true);
  });

  it("stream:true with only input_image blocks either 400s or returns a stream that terminates", async () => {
    const ctrl = new AbortController();
    const res = await call("POST", "/agents/sessions", { ...good, stream: true, input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA" }] }] }, {}, ctrl.signal);
    if (res.status === 400) return;
    expect((await readSse(res, 1500, ctrl)).ended).toBe(true);
  });

  it("stream:true with input streams from the input's seq and ends at idle", async () => {
    const ctrl = new AbortController();
    const p = call("POST", "/agents/sessions", { ...good, stream: true, input: "go" }, {}, ctrl.signal);
    // The session id is only known after create; emit its run once the subscription is live.
    for (let i = 0; i < 100 && st.subs.length === 0; i++) await sleep(5);
    const sid = st.subs[0]!.sid;
    expect(st.calls.sendUserEvents[0].session).toBe(sid);
    const res = await p;
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    st.subs[0]!.cb({ type: "event", event: ev(sid, 2, { type: "session.status_running" }) });
    st.subs[0]!.cb({ type: "event", event: ev(sid, 3, { type: "session.status_idle", stop_reason: "end_turn" }) });
    const { frames, ended } = await readSse(res, 3000, ctrl);
    expect(ended).toBe(true);
    expect(frames.map((f) => f.type)).toEqual(["agent.session.turn.created", "agent.session.turn.completed", "agent.session.idle"]);
  });
});

describe("POST /agents/sessions/:id/events (input mapping)", () => {
  const post = (sid: string, events: unknown[]) => call("POST", `/agents/sessions/${sid}/events`, { events });

  it("rejects a missing or empty events array", async () => {
    const s = addSession();
    expect((await call("POST", `/agents/sessions/${s.id}/events`, {})).status).toBe(400);
    expect((await post(s.id, [])).status).toBe(400);
  });

  it("(b) tool_result without call_id -> 400", async () => {
    const s = addSession();
    const res = await post(s.id, [{ type: "agent.session.input.tool_result", output: "x" }]);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/call_id/);
    expect(st.calls.sendUserEvents).toEqual([]);
  });

  it("(e) an unknown type -> 400 naming the type", async () => {
    const s = addSession();
    const res = await post(s.id, [{ type: "agent.session.input.bogus" }]);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("agent.session.input.bogus");
  });

  it("(f) cancel -> user.interrupt; string tool output -> text; success:false -> is_error", async () => {
    const s = addSession();
    const res = await post(s.id, [{ type: "agent.session.input.cancel" }, { type: "agent.session.input.tool_result", call_id: "c1", output: "42", success: false }]);
    expect(res.status).toBe(200);
    expect(st.calls.sendUserEvents[0].inputs).toEqual([{ type: "user.interrupt" }, { type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "42" }], is_error: true }]);
    expect((await res.json()).object).toBe("agent.session");
  });

  it("an SDK JSON-object output (already stringified by the SDK) passes through as text", async () => {
    const s = addSession();
    await post(s.id, [{ type: "agent.session.input.tool_result", call_id: "c1", success: true, output: "{\"a\":1}" }]);
    expect(st.calls.sendUserEvents[0].inputs[0]).toEqual({ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "{\"a\":1}" }], is_error: false });
  });

  // Regression: the SDK's content-array output is JSON-stringified instead of joined as text.
  it("(c) SDK content-array output [{type:'input_text',text:'hi'}] becomes the text 'hi'", async () => {
    const s = addSession();
    await post(s.id, [{ type: "agent.session.input.tool_result", call_id: "c1", success: true, output: [{ type: "input_text", text: "hi" }] }]);
    expect(st.calls.sendUserEvents[0].inputs[0].content).toEqual([{ type: "text", text: "hi" }]);
  });

  // Regression: the SDK failure form {success:false, error} (no output) loses the error text.
  it("(d) SDK failure form {success:false, error:'Tool handler failed.'} carries the error text", async () => {
    const s = addSession();
    await post(s.id, [{ type: "agent.session.input.tool_result", call_id: "c1", success: false, error: "Tool handler failed." }]);
    const input = st.calls.sendUserEvents[0].inputs[0];
    expect(input.is_error).toBe(true);
    expect(input.content[0].text).toContain("Tool handler failed.");
  });

  // Regression: an image-only message is silently dropped; the SDK then waits for a turn that never starts.
  it("(a) an image-only message is rejected (400) or forwarded as a non-empty user event", async () => {
    const s = addSession();
    const res = await post(s.id, [{ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA" }] }] }]);
    if (res.status === 400) return;
    expect(st.calls.sendUserEvents).toHaveLength(1);
  });

  // Regression: a message event with no content returns 200 and starts nothing (SDK sessions.stream hangs).
  it("a message event with empty content is rejected with 400", async () => {
    const s = addSession();
    const res = await post(s.id, [{ type: "agent.session.input.message", input: [{ role: "user", content: [] }] }]);
    expect(st.calls.sendUserEvents).toEqual([]);
    expect(res.status).toBe(400);
  });

  it("returns the reloaded session with required_actions from the log", async () => {
    const s = addSession({ status: "running" });
    setLog(s.id, [{ type: "user.message", content: [{ type: "text", text: "hi" }] }, { type: "session.status_running" }, { type: "agent.tool_use", tool_use_id: "call_9", name: "lookup", input: {} }]);
    const body = await (await post(s.id, [{ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text: "more" }] }] }])).json();
    expect(body.status).toBe("requires_action");
    expect(body.required_actions[0]).toMatchObject({ call_id: "call_9" });
  });
});

describe("GET /agents/sessions (list + pagination)", () => {
  it("returns a list with first_id/last_id and passes the scope", async () => {
    const a = addSession(); const b = addSession(); addSession({ owner_id: "prc_b" });
    const body = await (await call("GET", "/agents/sessions?limit=2")).json();
    expect(body.data.map((s: any) => s.id)).toEqual([a.id, b.id]);
    expect(body).toMatchObject({ object: "list", first_id: a.id, last_id: b.id, has_more: false });
    expect(st.calls.listPage[0]).toEqual({ limit: 2, cursor: undefined });
  });

  // Regression: the SDK's CursorPage sends after=<last session id>, but listPage casts the cursor with ::timestamptz.
  it("the `after` cursor passed to listPage is resolvable (not a raw session id cast to timestamptz)", async () => {
    addSession();
    await call("GET", "/agents/sessions?after=sess_abc&limit=2");
    const cursor = st.calls.listPage[0].cursor;
    expect(cursor === undefined || !Number.isNaN(Date.parse(cursor))).toBe(true);
    expect(cursor).not.toBe("sess_abc");
  });

  // Regression: ?limit=abc passes NaN, which yields `LIMIT NaN` in listPage.
  it("?limit=abc returns 400 or uses a finite default limit", async () => {
    const res = await call("GET", "/agents/sessions?limit=abc");
    if (res.status === 400) return;
    const limit = st.calls.listPage[0].limit;
    expect(limit === undefined || Number.isFinite(limit)).toBe(true);
  });
});

describe("session reads: retrieve, update, delete, events, items, turns", () => {
  it("retrieve/update/delete", async () => {
    const s = addSession();
    expect((await (await call("GET", `/agents/sessions/${s.id}`)).json()).id).toBe(s.id);
    expect((await call("POST", `/agents/sessions/${s.id}`, "not json")).status).toBe(200);
    expect(await (await call("DELETE", `/agents/sessions/${s.id}`)).json()).toEqual({ id: s.id, object: "agent.session.deleted", deleted: true });
    expect((await call("GET", `/agents/sessions/${s.id}`)).status).toBe(404);
  });

  it("events list, items, turns and turns/:id project the log", async () => {
    const s = addSession();
    setLog(s.id, [{ type: "user.message", content: [{ type: "text", text: "hi" }] }, { type: "session.status_running" }, { type: "agent.message", content: [{ type: "text", text: "yo" }], pi: {} }, { type: "session.status_idle", stop_reason: "end_turn" }]);
    const evs = await (await call("GET", `/agents/sessions/${s.id}/events`)).json();
    expect(evs.data.map((e: any) => [e.event_id, e.seq, e.type])).toEqual([["evt_1", 1, "user.message"], ["evt_2", 2, "session.status_running"], ["evt_3", 3, "agent.message"], ["evt_4", 4, "session.status_idle"]]);
    expect((await (await call("GET", `/agents/sessions/${s.id}/items`)).json()).data).toHaveLength(2);
    expect((await (await call("GET", `/agents/sessions/${s.id}/turns`)).json()).data.map((t: any) => t.id)).toEqual(["turn_2"]);
    expect((await (await call("GET", `/agents/sessions/${s.id}/turns/turn_2`)).json()).status).toBe("completed");
    expect((await call("GET", `/agents/sessions/${s.id}/turns/turn_9`)).status).toBe(404);
  });

  // Regression: listEvents' default 10000-row cap silently truncates; a late pending client tool call is not surfaced.
  it("a pending client tool call beyond 10000 events still surfaces as requires_action", async () => {
    const s = addSession({ status: "running" });
    const payloads: any[] = [{ type: "user.message", content: [{ type: "text", text: "go" }] }, { type: "session.status_running" }];
    while (payloads.length < 10039) payloads.push({ type: "session.usage", usage: {}, context: null });
    payloads.push({ type: "agent.tool_use", tool_use_id: "call_late", name: "lookup", input: {} });
    while (payloads.length < 10050) payloads.push({ type: "session.usage", usage: {}, context: null });
    setLog(s.id, payloads);
    const body = await (await call("GET", `/agents/sessions/${s.id}`)).json();
    expect(body.status).toBe("requires_action");
  });

  it("GET .../events reports has_more (or returns every event) when the log exceeds the cap", async () => {
    const s = addSession();
    setLog(s.id, Array.from({ length: 10050 }, () => ({ type: "session.usage", usage: {}, context: null })));
    const body = await (await call("GET", `/agents/sessions/${s.id}/events`)).json();
    expect(body.data.length === 10050 || body.has_more === true).toBe(true);
  });
});

describe("ownership scoping (owner B against owner A's resources)", () => {
  it("B gets 404 on every session-scoped route of A's session", async () => {
    const s = addSession();
    const child = addSession({ parent_id: s.id });
    const B = { "x-owner": "prc_b" };
    const routes: [string, string, unknown?][] = [
      ["GET", `/agents/sessions/${s.id}`], ["POST", `/agents/sessions/${s.id}`, {}], ["DELETE", `/agents/sessions/${s.id}`],
      ["POST", `/agents/sessions/${s.id}/events`, { events: [{ type: "agent.session.input.cancel" }] }], ["GET", `/agents/sessions/${s.id}/events`],
      ["GET", `/agents/sessions/${s.id}/items`], ["GET", `/agents/sessions/${s.id}/turns`], ["GET", `/agents/sessions/${s.id}/turns/turn_1`],
      ["GET", `/agents/sessions/${s.id}/artifacts`], ["GET", `/agents/sessions/${s.id}/subagents`], ["GET", `/agents/sessions/${s.id}/subagents/${child.id}`],
    ];
    for (const [m, p, b] of routes) expect([m, p, (await call(m, p, b, B)).status]).toEqual([m, p, 404]);
    expect(st.sessions.has(s.id)).toBe(true);
    expect(st.calls.sendUserEvents).toEqual([]);
  });

  it("B's own session cannot reach A's child as a subagent", async () => {
    const a = addSession();
    const childOfA = addSession({ parent_id: a.id });
    const b = addSession({ owner_id: "prc_b" });
    expect((await call("GET", `/agents/sessions/${b.id}/subagents/${childOfA.id}`, undefined, { "x-owner": "prc_b" })).status).toBe(404);
  });

  it("B cannot see A's vault or its credentials", async () => {
    const v = await (await call("POST", "/vaults", { name: "a" })).json();
    const B = { "x-owner": "prc_b" };
    expect((await call("GET", `/vaults/${v.id}`, undefined, B)).status).toBe(404);
    expect((await (await call("GET", "/vaults", undefined, B)).json()).data).toEqual([]);
    expect((await call("GET", `/vaults/${v.id}/credentials`, undefined, B)).status).toBe(404);
    expect((await call("POST", `/vaults/${v.id}/credentials`, { name: "K", value: "v" }, B)).status).toBe(404);
    expect((await call("DELETE", `/vaults/${v.id}/credentials/K`, undefined, B)).status).toBe(404);
    expect((await call("DELETE", `/vaults/${v.id}`, undefined, B)).status).toBe(404);
    expect(st.calls.put).toEqual([]);
  });
});

describe("subagents routes", () => {
  it("list/get/items/turns read the child's own log; a grandchild is 404 under the root", async () => {
    const root = addSession();
    const child = addSession({ parent_id: root.id, status: "running", agent: { ...agentSnap, name: "kid" } });
    const grandchild = addSession({ parent_id: child.id });
    setLog(child.id, [{ type: "user.message", content: [{ type: "text", text: "task" }] }, { type: "session.status_running" }]);
    const list = await (await call("GET", `/agents/sessions/${root.id}/subagents`)).json();
    expect(list.data).toEqual([expect.objectContaining({ id: child.id, status: "active", name: "kid" })]);
    expect((await (await call("GET", `/agents/sessions/${root.id}/subagents/${child.id}`)).json()).id).toBe(child.id);
    expect((await (await call("GET", `/agents/sessions/${root.id}/subagents/${child.id}/items`)).json()).data[0].content).toEqual([{ type: "input_text", text: "task" }]);
    expect((await (await call("GET", `/agents/sessions/${root.id}/subagents/${child.id}/turns`)).json()).data).toEqual([expect.objectContaining({ id: "turn_2", status: "in_progress" })]);
    for (const suffix of ["", "/items", "/turns"]) expect((await call("GET", `/agents/sessions/${root.id}/subagents/${grandchild.id}${suffix}`)).status).toBe(404);
  });
});

describe("artifacts routes (dir workspace over a temp directory)", () => {
  let dir: string;
  let sid: string;
  const id = (p: string) => `art_${Buffer.from(p, "utf8").toString("base64url")}`;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "compat-art-"));
    await writeFile(path.join(dir, "note.txt"), "hello");
    await mkdir(path.join(dir, "sub dir"), { recursive: true });
    await writeFile(path.join(dir, "sub dir", "héllo wörld.json"), "{\"a\":1}");
    await writeFile(path.join(dir, "page.html"), "<script>alert(1)</script>");
    st.workspaces.set("ws_dir", { id: "ws_dir", owner_id: "prc_a", ref: { kind: "dir", path: dir } });
    sid = addSession({ workspace_id: "ws_dir" }).id;
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("list ids round-trip through retrieve and content (bytes and content-type), including unicode/space paths", async () => {
    const list = await (await call("GET", `/agents/sessions/${sid}/artifacts`)).json();
    expect(list.data.map((a: any) => a.path)).toEqual(["note.txt", "page.html", "sub dir/héllo wörld.json"]);
    for (const a of list.data) {
      const meta = await (await call("GET", `/agents/sessions/${sid}/artifacts/${a.id}`)).json();
      expect(meta).toMatchObject({ id: a.id, object: "agent.session.artifact", path: a.path, size: a.size, environment_id: "env_1" });
    }
    const uni = list.data.find((a: any) => a.path.endsWith(".json"));
    const res = await call("GET", `/agents/sessions/${sid}/artifacts/${uni.id}/content`);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe("{\"a\":1}");
    const txt = await call("GET", `/agents/sessions/${sid}/artifacts/${id("note.txt")}/content`);
    expect(txt.headers.get("content-type")).toBe("text/plain");
    expect(new Uint8Array(await txt.arrayBuffer())).toEqual(new TextEncoder().encode("hello"));
  });

  it("a missing file or an id that decodes to garbage is 404", async () => {
    expect((await call("GET", `/agents/sessions/${sid}/artifacts/${id("nope.txt")}`)).status).toBe(404);
    expect((await call("GET", `/agents/sessions/${sid}/artifacts/garbage`)).status).toBe(404);
    expect((await call("GET", `/agents/sessions/${sid}/artifacts/${id("sub dir")}/content`)).status).toBe(404);
  });

  // Regression: resolveInRoot throws a plain Error, which errorResponse turns into a 500 api_error.
  it("an id encoding a path outside the workspace returns 400/404, not 500", async () => {
    for (const suffix of ["", "/content"]) {
      const res = await call("GET", `/agents/sessions/${sid}/artifacts/${id("../outside")}${suffix}`);
      expect([400, 404]).toContain(res.status);
    }
    expect([400, 404]).toContain((await call("DELETE", `/agents/sessions/${sid}/artifacts/${id("../../etc/passwd")}`)).status);
  });

  it("DELETE removes the file; a second DELETE is 404", async () => {
    const first = await call("DELETE", `/agents/sessions/${sid}/artifacts/${id("note.txt")}`);
    expect(await first.json()).toEqual({ id: id("note.txt"), object: "agent.session.artifact.deleted", deleted: true });
    expect((await call("DELETE", `/agents/sessions/${sid}/artifacts/${id("note.txt")}`)).status).toBe(404);
    expect((await (await call("GET", `/agents/sessions/${sid}/artifacts`)).json()).data.map((a: any) => a.path)).not.toContain("note.txt");
  });

  it("a git/empty ref yields [] and 404", async () => {
    st.workspaces.set("ws_git", { id: "ws_git", owner_id: "prc_a", ref: { kind: "git", remote: "r", base: "HEAD" } });
    const s = addSession({ workspace_id: "ws_git" });
    expect((await (await call("GET", `/agents/sessions/${s.id}/artifacts`)).json()).data).toEqual([]);
    expect((await call("GET", `/agents/sessions/${s.id}/artifacts/${id("note.txt")}`)).status).toBe(404);
    expect((await call("DELETE", `/agents/sessions/${s.id}/artifacts/${id("note.txt")}`)).status).toBe(404);
  });

  // Regression: agent-written HTML is served as text/html from the API origin (script execution in that origin).
  it("agent-controlled HTML is not served as renderable text/html inline", async () => {
    const res = await call("GET", `/agents/sessions/${sid}/artifacts/${id("page.html")}/content`);
    const inline = (res.headers.get("content-type") ?? "").startsWith("text/html") && !/attachment/.test(res.headers.get("content-disposition") ?? "") && !res.headers.get("content-security-policy");
    expect(inline).toBe(false);
  });
});

describe("vault credentials", () => {
  const mkVault = async () => (await (await call("POST", "/vaults", { name: "v", metadata: { k: "1" } })).json()).id as string;

  it("vault create/get/list/delete", async () => {
    const vid = await mkVault();
    expect((await (await call("GET", `/vaults/${vid}`)).json())).toMatchObject({ id: vid, object: "vault", name: "v" });
    expect((await (await call("GET", "/vaults")).json()).data.map((v: any) => v.id)).toEqual([vid]);
    expect(await (await call("DELETE", `/vaults/${vid}`)).json()).toEqual({ id: vid, object: "vault.deleted", deleted: true });
    expect((await call("DELETE", `/vaults/${vid}`)).status).toBe(404);
  });

  it("(a) PMA_SECRET_KEY unset -> 400", async () => {
    const vid = await mkVault();
    st.secrets = false;
    const res = await call("POST", `/vaults/${vid}/credentials`, { name: "K", value: "v" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/PMA_SECRET_KEY/);
  });

  it("(b) static_bearer token, mcp_oauth access_token and plain value are stored; (e) the secret is never echoed", async () => {
    const vid = await mkVault();
    const bodies = [
      { name: "A", auth: { type: "static_bearer", mcp_server_url: "https://a.example.com/mcp", token: "tok-A" } },
      { name: "B", auth: { type: "mcp_oauth", mcp_server_url: "https://b.example.com/mcp", access_token: "tok-B" } },
      { name: "C", value: "tok-C" },
    ];
    for (const b of bodies) {
      const res = await call("POST", `/vaults/${vid}/credentials`, b);
      expect(res.status).toBe(201);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ name: b.name, object: "vault.credential", vault_id: vid });
      expect(text).not.toContain("tok-");
    }
    expect(st.calls.put.map((p) => [p.name, p.value])).toEqual([["A", "tok-A"], ["B", "tok-B"], ["C", "tok-C"]]);
    const list = await (await call("GET", `/vaults/${vid}/credentials`)).text();
    expect(JSON.parse(list).data.map((c: any) => c.name)).toEqual(["A", "B", "C"]);
    expect(list).not.toContain("tok-");
  });

  it("(c) missing name -> 400; (d) non-string secret -> 400", async () => {
    const vid = await mkVault();
    expect((await call("POST", `/vaults/${vid}/credentials`, { value: "x" })).status).toBe(400);
    expect((await call("POST", `/vaults/${vid}/credentials`, { name: "K", value: 123 })).status).toBe(400);
    expect((await call("POST", `/vaults/${vid}/credentials`, { name: "K", auth: { type: "static_bearer" } })).status).toBe(400); // no mcp_server_url
    expect((await call("POST", `/vaults/${vid}/credentials`, { name: "K", auth: { type: "static_bearer", mcp_server_url: "https://a.example.com/mcp" } })).status).toBe(400); // no token
    expect((await call("POST", `/vaults/${vid}/credentials`, { name: "K", auth: { type: "static_bearer", mcp_server_url: "not-a-url", token: "t" } })).status).toBe(400);
    expect((await call("POST", `/vaults/${vid}/credentials`, { name: "K", auth: { type: "environment_variable" } })).status).toBe(400);
    expect((await call("POST", `/vaults/${vid}/credentials`, { name: "K", auth: { type: "wat", token: "t" } })).status).toBe(400);
    expect(st.calls.put).toEqual([]);
  });

  it("(f) DELETE of an unknown credential -> 404; a known one deletes", async () => {
    const vid = await mkVault();
    await call("POST", `/vaults/${vid}/credentials`, { name: "K", value: "v" });
    expect((await call("DELETE", `/vaults/${vid}/credentials/NOPE`)).status).toBe(404);
    expect(await (await call("DELETE", `/vaults/${vid}/credentials/K`)).json()).toEqual({ id: "K", object: "vault.credential.deleted", deleted: true });
    expect((await call("POST", "/vaults/vault_missing/credentials", { name: "K", value: "v" })).status).toBe(404);
  });
});

describe("GET /agents/sessions/:id/events as SSE (streamAgentSessionEvents)", () => {
  const sseGet = (sid: string, ctrl: AbortController) => call("GET", `/agents/sessions/${sid}/events`, undefined, { accept: "text/event-stream" }, ctrl.signal);
  const waitSub = async () => { for (let i = 0; i < 200 && st.subs.length === 0; i++) await sleep(5); return st.subs[0]!; };
  const emit = (sid: string, seq: number, payload: any) => st.subs[0]!.cb({ type: "event", event: ev(sid, seq, payload) });

  it("starts at the log tail (no replay of prior turns) and ends after session.idle, unsubscribing", async () => {
    const s = addSession();
    setLog(s.id, [{ type: "session.status_running" }, { type: "session.status_idle", stop_reason: "end_turn" }]);
    const ctrl = new AbortController();
    const res = await sseGet(s.id, ctrl);
    const sub = await waitSub();
    emit(s.id, 2, { type: "session.status_idle", stop_reason: "end_turn" }); // a duplicate of the stored tail is skipped
    emit(s.id, 3, { type: "session.status_running" });
    st.subs[0]!.cb({ type: "agent.message_delta", session_id: s.id, stream_id: "st", text: "he" });
    emit(s.id, 4, { type: "agent.tool_use", tool_use_id: "c1", name: "lookup", input: { a: 1 } });
    emit(s.id, 5, { type: "session.status_idle", stop_reason: "end_turn" });
    emit(s.id, 6, { type: "session.status_running" }); // after terminal: dropped
    const { frames, ended } = await readSse(res, 3000, ctrl);
    expect(ended).toBe(true);
    expect(frames.map((f) => f.type)).toEqual(["agent.session.turn.created", "agent.session.turn.output_text.delta", "agent.session.turn.item.added", "agent.session.turn.completed", "agent.session.idle"]);
    expect(frames[2]).toMatchObject({ turn_id: "turn_3", item: { call_id: "c1", name: "lookup", arguments: { a: 1 } } });
    expect(sub.unsubs).toBeGreaterThanOrEqual(1);
  });

  it("ends after agent.session.failed (session.error)", async () => {
    const s = addSession();
    const ctrl = new AbortController();
    const res = await sseGet(s.id, ctrl);
    await waitSub();
    emit(s.id, 1, { type: "session.status_running" });
    emit(s.id, 2, { type: "session.error", error: { type: "model_error", message: "nope" } });
    const { frames, ended } = await readSse(res, 3000, ctrl);
    expect(ended).toBe(true);
    expect(frames.at(-1)).toMatchObject({ type: "agent.session.failed", session: { error: "nope" } });
  });

  // Regression: status_terminated is not terminal, so the SSE and its Redis subscriber stay open forever.
  it("ends after session.status_terminated", async () => {
    const s = addSession();
    const ctrl = new AbortController();
    const res = await sseGet(s.id, ctrl);
    await waitSub();
    emit(s.id, 1, { type: "session.status_terminated", reason: "archived" });
    expect((await readSse(res, 1500, ctrl)).ended).toBe(true);
  });

  const abortAfterFirstFrame = async () => {
    const s = addSession();
    const ctrl = new AbortController();
    const res = await sseGet(s.id, ctrl);
    const sub = await waitSub();
    emit(s.id, 1, { type: "session.status_running" });
    const { ended, frames } = await readSse(res, 300, ctrl);
    for (let i = 0; i < 100 && sub.unsubs === 0; i++) await sleep(20);
    await sleep(700); // let the sleep loop observe done and run its final cleanup
    return { ended, frames, sub };
  };

  it("client abort stops the stream and unsubscribes", async () => {
    const { ended, frames, sub } = await abortAfterFirstFrame();
    expect(ended).toBe(false);
    expect(frames.map((f) => f.type)).toEqual(["agent.session.turn.created"]);
    expect(sub.unsubs).toBeGreaterThanOrEqual(1);
  });

  // Regression: onAbort unsubscribes and the loop's final cleanup unsubscribes again (double disconnect).
  it("client abort calls unsubscribe exactly once", async () => {
    expect((await abortAfterFirstFrame()).sub.unsubs).toBe(1);
  });

  // Regression: a live event arriving while listEvents(since) is in flight advances `last` past the stored events, which are then dropped.
  it("a stored event replayed after a newer live event is not dropped (turn.created precedes item.added)", async () => {
    const s = addSession();
    setLog(s.id, [{ type: "user.message", content: [{ type: "text", text: "go" }] }, { type: "session.status_idle", stop_reason: "end_turn" }]);
    let resolve!: (v: any[]) => void;
    st.deferredSince = new Promise((r) => { resolve = r; });
    const ctrl = new AbortController();
    const res = await sseGet(s.id, ctrl);
    await waitSub();
    for (let i = 0; i < 200 && !st.calls.listEvents.some((c) => c.opts.since !== undefined); i++) await sleep(5);
    emit(s.id, 4, { type: "agent.tool_use", tool_use_id: "c1", name: "lookup", input: {} });
    await sleep(20);
    resolve([ev(s.id, 3, { type: "session.status_running" })]);
    await sleep(20);
    emit(s.id, 5, { type: "session.status_idle", stop_reason: "end_turn" });
    const { frames } = await readSse(res, 2000, ctrl);
    const types = frames.map((f) => f.type);
    expect(types).toContain("agent.session.turn.created");
    expect(types.indexOf("agent.session.turn.created")).toBeLessThan(types.indexOf("agent.session.turn.item.added"));
  });
});
