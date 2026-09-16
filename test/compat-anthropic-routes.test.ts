import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

/**
 * Route tests for the Claude Managed Agents surface (/anthropic), with storage and bus seams faked in
 * memory. What they pin down is the dialect: POST-only mutations, `{data, next_page}` pages, the
 * agent/session object shapes, the event translation both ways, and that a declaration this engine
 * cannot honor is refused or reported rather than silently dropped.
 */

const st = vi.hoisted(() => ({
  agents: new Map<string, any>(),
  sessions: new Map<string, any>(),
  environments: new Map<string, any>(),
  workspaces: new Map<string, any>(),
  events: new Map<string, any[]>(),
  vaults: new Map<string, any>(),
  creds: new Map<string, Map<string, any>>(),
  stores: new Map<string, any>(),
  sent: [] as { session: string; inputs: any[] }[],
  n: 0,
}));

vi.mock("../src/infra/db.ts", async (orig) => {
  const real = await orig<typeof import("../src/infra/db.ts")>();
  const owned = (row: any, scope?: { owner: string }) => (row && (!scope || row.owner_id === scope.owner) ? row : null);
  return {
    ...real,
    repos: {
      ...real.repos,
      agents: {
        create: async (input: any) => { const a = { id: `agent_${++st.n}`, created_at: "2026-01-01T00:00:00.000Z", ...input }; st.agents.set(a.id, a); return a; },
        get: async (id: string, sc?: any) => owned(st.agents.get(id), sc),
        list: async (sc?: any) => [...st.agents.values()].filter((a) => owned(a, sc)),
        update: async (id: string, patch: any, sc?: any) => { const a = owned(st.agents.get(id), sc); if (!a) return null; Object.assign(a, patch); return a; },
        delete: async (id: string, sc?: any) => (owned(st.agents.get(id), sc) ? { archived: true } : null),
      },
      environments: {
        create: async (input: any) => { const e = { id: `env_${++st.n}`, created_at: "2026-01-01T00:00:00.000Z", ...input }; st.environments.set(e.id, e); return e; },
        get: async (id: string, sc?: any) => owned(st.environments.get(id), sc),
        list: async (sc?: any) => [...st.environments.values()].filter((e) => owned(e, sc)),
        delete: async (id: string, sc?: any) => (owned(st.environments.get(id), sc) ? (st.environments.delete(id), { archived: false }) : null),
      },
      workspaces: { create: async (spec: any, ref: any, owner_id: string) => { const w = { id: `ws_${++st.n}`, owner_id, spec, ref }; st.workspaces.set(w.id, w); return w; } },
      sessions: {
        create: async (input: any) => { const s = { id: `sess_${++st.n}`, status: "idle", parent_id: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", usage: {}, ...input }; st.sessions.set(s.id, s); return s; },
        get: async (id: string, sc?: any) => owned(st.sessions.get(id), sc),
        childrenOf: async (pid: string, sc?: any) => [...st.sessions.values()].filter((s) => s.parent_id === pid && owned(s, sc)),
        listPage: async (sc: any, opts: any) => ({ data: [...st.sessions.values()].filter((s) => owned(s, sc)), has_more: false, next_cursor: null }),
        delete: async (id: string) => { st.sessions.delete(id); },
      },
    },
    sessionConfig: {
      ...real.sessionConfig,
      patchMetadata: async (id: string, patch: Record<string, string | null>) => {
        const s = st.sessions.get(id);
        if (!s) return null;
        s.metadata = { ...(s.metadata ?? {}) };
        for (const [k, v] of Object.entries(patch)) { if (v === null) delete s.metadata[k]; else s.metadata[k] = v; }
        return s.metadata;
      },
    },
    vaults: {
      create: async (input: any) => { const v = { id: `vlt_${++st.n}`, owner_id: input.owner_id, name: input.name, metadata: input.metadata ?? {}, created_at: "2026-01-01T00:00:00.000Z" }; st.vaults.set(v.id, v); return v; },
      get: async (id: string, sc?: any) => owned(st.vaults.get(id), sc),
      list: async (sc?: any) => [...st.vaults.values()].filter((v) => owned(v, sc)),
      delete: async (id: string, sc?: any) => (owned(st.vaults.get(id), sc) ? st.vaults.delete(id) : false),
    },
    vaultCredentials: {
      put: async (vaultId: string, input: any) => {
        const cred = { id: `vcrd_${input.name}`, vault_id: vaultId, name: input.name, kind: input.kind ?? "environment_variable", mcp_server_url: input.mcp_server_url ?? null, expires_at: input.expires_at ?? null, has_refresh: !!input.refresh, metadata: input.metadata ?? {}, created_at: "2026-01-01T00:00:00.000Z", value: input.value };
        (st.creds.get(vaultId) ?? st.creds.set(vaultId, new Map()).get(vaultId)!).set(input.name, cred);
        return cred;
      },
      list: async (vaultId: string) => [...(st.creds.get(vaultId)?.values() ?? [])],
      get: async (vaultId: string, name: string) => st.creds.get(vaultId)?.get(name) ?? null,
      byId: async (id: string, vaultIds: string[]) => { for (const v of vaultIds) for (const cr of st.creds.get(v)?.values() ?? []) if (cr.id === id) return cr; return null; },
      delete: async (vaultId: string, idOrName: string) => { for (const [name, cr] of st.creds.get(vaultId) ?? []) if (cr.id === idOrName || name === idOrName) return st.creds.get(vaultId)!.delete(name); return false; },
    },
    memoryStores: {
      create: async (input: any) => { const m = { id: `mem_${++st.n}`, owner_id: input.owner_id, name: input.name, description: input.description ?? "", created_at: "2026-01-01T00:00:00.000Z" }; st.stores.set(m.id, m); return m; },
      get: async (id: string, sc?: any) => owned(st.stores.get(id), sc),
      list: async (sc?: any) => [...st.stores.values()].filter((m) => owned(m, sc)),
      delete: async (id: string, sc?: any) => (owned(st.stores.get(id), sc) ? st.stores.delete(id) : false),
    },
  };
});

vi.mock("../src/infra/events.ts", async (orig) => {
  const real = await orig<typeof import("../src/infra/events.ts")>();
  return {
    ...real,
    appendEvents: async () => [],
    listEvents: async (sid: string, opts: { since?: number; limit?: number } = {}) => (st.events.get(sid) ?? []).filter((e) => e.seq > (opts.since ?? 0)).slice(0, opts.limit ?? 10000),
  };
});

vi.mock("../src/api/routes/events.ts", async (orig) => {
  const real = await orig<typeof import("../src/api/routes/events.ts")>();
  return {
    ...real,
    sendUserEvents: async (session: any, inputs: any[]) => {
      st.sent.push({ session: session.id, inputs });
      return inputs.map((p, i) => ({ id: `ev_${i}`, seq: 100 + i, session_id: session.id, type: p.type, payload: p, created_at: "2026-01-01T00:00:00.000Z" }));
    },
  };
});

vi.mock("../src/infra/secrets.ts", async (orig) => {
  const real = await orig<typeof import("../src/infra/secrets.ts")>();
  return { ...real, secretsConfigured: () => true };
});

const { anthropicAgents } = await import("../src/api/routes/compat/anthropic.ts");
const { errorResponse } = await import("../src/api/errors.ts");

const app = new Hono()
  .onError((err, c) => errorResponse(c, err))
  .use("*", async (c, next) => { c.set("owner" as never, (c.req.header("x-owner") ?? "prc_a") as never); await next(); })
  .route("/anthropic", anthropicAgents);

// every CMA path carries a literal ?beta=true, so it is appended the way the SDK does
const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(`/anthropic${p}${p.includes("?") ? "&" : "?"}beta=true`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (method: string, p: string, body?: unknown, headers?: Record<string, string>) => (await call(method, p, body, headers)).json();

const agentSpec = {
  name: "GitHub Assistant",
  model: "qoder/auto",
  system: "be brief",
  mcp_servers: [{ type: "url", name: "github", url: "https://api.githubcopilot.com/mcp/" }],
  tools: [
    { type: "agent_toolset_20260401", configs: [{ name: "write", enabled: false }] },
    { type: "mcp_toolset", mcp_server_name: "github", default_config: { enabled: false }, configs: [{ name: "get_issue", enabled: true }, { name: "list_issues", enabled: true }] },
  ],
  metadata: { team: "dev" },
};

beforeEach(() => {
  for (const m of [st.agents, st.sessions, st.environments, st.workspaces, st.events, st.vaults, st.creds, st.stores]) m.clear();
  st.sent.length = 0;
  st.environments.set("env_1", { id: "env_1", owner_id: "prc_a", name: "e", provider: "docker", network: "bridge", workspace: { kind: "empty" }, created_at: "2026-01-01T00:00:00.000Z" });
});

describe("agents", () => {
  it("create maps the toolsets onto the engine and echoes the dialect back", async () => {
    const res = await call("POST", "/v1/agents", agentSpec);
    expect(res.status).toBe(201);
    const agent = await res.json();
    expect(agent).toMatchObject({ type: "agent", version: 1, name: "GitHub Assistant", system: "be brief", metadata: { team: "dev" } });
    expect(agent.mcp_servers).toEqual([{ type: "url", name: "github", url: "https://api.githubcopilot.com/mcp/" }]);
    // every config comes back resolved, with the dialect's defaults made explicit
    expect(agent.tools[1].default_config).toEqual({ enabled: false, permission_policy: { type: "always_ask" } });

    const row = st.agents.get(agent.id);
    expect(row.tools).toEqual(["bash", "read", "edit"]); // write was disabled
    expect(row.mcp_servers).toEqual([{
      label: "github", url: "https://api.githubcopilot.com/mcp/",
      allowed_tools: ["get_issue", "list_issues"],
      permissions: { default: "always_ask" },
    }]);
  });

  it("a deny list maps to denied_tools, and per-tool policies are kept", async () => {
    const agent = await json("POST", "/v1/agents", {
      ...agentSpec,
      tools: [{ type: "mcp_toolset", mcp_server_name: "github", configs: [{ name: "delete_repository", enabled: false }, { name: "get_issue", permission_policy: { type: "always_allow" } }] }],
    });
    expect(st.agents.get(agent.id).mcp_servers[0]).toMatchObject({
      denied_tools: ["delete_repository"],
      permissions: { default: "always_ask", tools: { get_issue: "always_allow" } },
    });
  });

  it("a custom tool becomes a client tool the caller answers", async () => {
    const agent = await json("POST", "/v1/agents", { ...agentSpec, mcp_servers: [], tools: [{ type: "custom", name: "lookup", description: "look up", input_schema: { type: "object", properties: {} } }] });
    expect(st.agents.get(agent.id).client_tools).toEqual([{ type: "function", name: "lookup", description: "look up", parameters: { type: "object", properties: {} } }]);
  });

  it("what this engine cannot run is reported, not silently dropped", async () => {
    const agent = await json("POST", "/v1/agents", {
      name: "a", model: { id: "qoder/auto", speed: "fast" },
      tools: [{ type: "agent_toolset_20260401", configs: [{ name: "grep", enabled: true }, { name: "web_search", enabled: true }] }],
      skills: [{ type: "anthropic", skill_id: "xlsx" }],
    });
    expect(agent.unsupported.map((u: any) => `${u.field}:${u.value}`)).toEqual(
      expect.arrayContaining(["tools:grep", "tools:web_search", "skills:{\"type\":\"anthropic\",\"skill_id\":\"xlsx\"}", "model:fast"]),
    );
  });

  it("the dialect's structural rules are enforced", async () => {
    const bad: [any, RegExp][] = [
      [{ ...agentSpec, name: undefined }, /name/],
      [{ ...agentSpec, model: undefined }, /model/],
      [{ ...agentSpec, tools: [{ type: "mcp_toolset", mcp_server_name: "nope" }] }, /not declared/],
      [{ ...agentSpec, tools: [{ type: "agent_toolset_20260401" }] }, /not referenced/],
      [{ ...agentSpec, mcp_servers: [{ type: "url", name: "github", url: "nope" }] }, /valid URL/],
      [{ ...agentSpec, tools: [{ type: "wat" }] }, /unsupported tool type/],
    ];
    for (const [body, re] of bad) {
      const res = await call("POST", "/v1/agents", body);
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toMatch(re);
    }
  });

  it("update is a POST that bumps the version and honors the version check", async () => {
    const agent = await json("POST", "/v1/agents", agentSpec);
    const updated = await json("POST", `/v1/agents/${agent.id}`, { system: "be terse", version: 1 });
    expect(updated).toMatchObject({ version: 2, system: "be terse", name: "GitHub Assistant" });
    expect(st.agents.get(agent.id).mcp_servers).toHaveLength(1); // untouched fields survive
    const stale = await call("POST", `/v1/agents/${agent.id}`, { system: "x", version: 1 });
    expect(stale.status).toBe(400);
    // metadata is a patch: a null deletes its key
    const patched = await json("POST", `/v1/agents/${agent.id}`, { metadata: { team: null, owner: "me" } });
    expect(patched.metadata).toEqual({ owner: "me" });
  });

  it("list pages with {data, next_page}; archive stamps archived_at; versions lists the current one", async () => {
    const a1 = await json("POST", "/v1/agents", agentSpec);
    const a2 = await json("POST", "/v1/agents", agentSpec);
    const page = await json("GET", "/v1/agents?limit=1");
    expect(page.data.map((a: any) => a.id)).toEqual([a1.id]);
    expect(page.next_page).toBe(a1.id);
    expect((await json("GET", `/v1/agents?limit=1&page=${a1.id}`)).data.map((a: any) => a.id)).toEqual([a2.id]);
    expect((await json("GET", `/v1/agents/${a1.id}/versions`)).data).toHaveLength(1);
    expect((await json("POST", `/v1/agents/${a1.id}/archive`)).archived_at).toBeTruthy();
    expect((await call("GET", "/v1/agents/agent_missing")).status).toBe(404);
  });
});

describe("sessions", () => {
  const mkAgent = () => json("POST", "/v1/agents", agentSpec);

  it("create references a saved agent and snapshots it", async () => {
    const agent = await mkAgent();
    const res = await call("POST", "/v1/sessions", { agent: agent.id, environment_id: "env_1", title: "nightly", metadata: { run: "7" } });
    expect(res.status).toBe(201);
    const session = await res.json();
    expect(session).toMatchObject({ type: "session", status: "idle", environment_id: "env_1", title: "nightly", metadata: { run: "7", title: "nightly" }, vault_ids: [] });
    expect(session.agent).toMatchObject({ type: "agent", id: agent.id, name: "GitHub Assistant" });
    expect(session.usage).toMatchObject({ input_tokens: 0, output_tokens: 0 });
  });

  it("agent_with_overrides replaces fields for this session only", async () => {
    const agent = await mkAgent();
    const session = await json("POST", "/v1/sessions", {
      agent: { type: "agent_with_overrides", id: agent.id, system: "be loud", tools: [], mcp_servers: [] },
      environment_id: "env_1",
    });
    expect(session.agent.system).toBe("be loud");
    expect(st.sessions.get(session.id).agent.mcp_servers).toEqual([]);
    expect(st.agents.get(agent.id).system).toBe("be brief"); // the saved agent is unchanged
  });

  it("initial_events start the session; unsupported creation inputs are refused", async () => {
    const agent = await mkAgent();
    const session = await json("POST", "/v1/sessions", {
      agent: agent.id, environment_id: "env_1",
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "go" }] }],
    });
    expect(st.sent).toEqual([{ session: session.id, inputs: [{ type: "user.message", content: [{ type: "text", text: "go" }] }] }]);

    const refused: [any, RegExp][] = [
      [{ budget: { type: "limit", max_list_cost: { amount: "100", currency: "USD" } } }, /budget/],
      [{ initial_events: [{ type: "user.define_outcome", description: "x" }] }, /define_outcome/],
      [{ resources: [{ type: "github_repository", url: "https://github.com/a/b" }] }, /environment workspace/],
      [{ resources: [{ type: "file", file_id: "file_1" }] }, /content block/],
    ];
    for (const [extra, re] of refused) {
      const res = await call("POST", "/v1/sessions", { agent: agent.id, environment_id: "env_1", ...extra });
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toMatch(re);
    }
  });

  it("update patches title and metadata; changing the agent or vaults mid-session is refused", async () => {
    const agent = await mkAgent();
    const session = await json("POST", "/v1/sessions", { agent: agent.id, environment_id: "env_1", title: "one" });
    const updated = await json("POST", `/v1/sessions/${session.id}`, { title: "two", metadata: { k: "v" } });
    expect(updated).toMatchObject({ title: "two", metadata: { title: "two", k: "v" } });
    expect((await call("POST", `/v1/sessions/${session.id}`, { vault_ids: ["vlt_1"] })).status).toBe(400);
    expect((await call("POST", `/v1/sessions/${session.id}`, { agent: { tools: [] } })).status).toBe(400);
  });

  it("archive terminates; delete returns the dialect's deleted shape", async () => {
    const agent = await mkAgent();
    const a = await json("POST", "/v1/sessions", { agent: agent.id, environment_id: "env_1" });
    const archived = await json("POST", `/v1/sessions/${a.id}/archive`);
    expect(archived).toMatchObject({ status: "terminated" });
    expect(archived.archived_at).toBeTruthy();

    const b = await json("POST", "/v1/sessions", { agent: agent.id, environment_id: "env_1" });
    expect(await json("DELETE", `/v1/sessions/${b.id}`)).toEqual({ id: b.id, type: "session_deleted" });
    st.sessions.set(b.id, { ...b, owner_id: "prc_a", status: "running", agent: st.agents.get(agent.id) });
    expect((await call("DELETE", `/v1/sessions/${b.id}`)).status).toBe(400); // interrupt it first
  });
});

describe("session events", () => {
  const seed = async () => {
    const agent = await json("POST", "/v1/agents", { ...agentSpec, tools: [...agentSpec.tools, { type: "custom", name: "lookup", description: "d", input_schema: { type: "object" } }] });
    const session = await json("POST", "/v1/sessions", { agent: agent.id, environment_id: "env_1" });
    return session;
  };
  const log = (sid: string, payloads: any[]) => st.events.set(sid, payloads.map((payload, i) => ({ id: `e${i}`, seq: i + 1, session_id: sid, type: payload.type, payload, created_at: "2026-01-01T00:00:00.000Z" })));

  it("translates the engine's log into the dialect's event types", async () => {
    const session = await seed();
    log(session.id, [
      { type: "user.message", content: [{ type: "text", text: "hi" }] },
      { type: "session.status_running" },
      { type: "agent.message", content: [{ type: "text", text: "on it" }] },
      { type: "agent.tool_use", tool_use_id: "t1", name: "bash", input: { command: "ls" } },
      { type: "agent.tool_use", tool_use_id: "t2", name: "github__get_issue", input: { n: 1 } },
      { type: "agent.tool_use", tool_use_id: "t3", name: "lookup", input: {} },
      { type: "sandbox.acquired", sandbox_id: "sb", provider: "local" },
      { type: "session.status_idle", stop_reason: "end_turn" },
    ]);
    const { data } = await json("GET", `/v1/sessions/${session.id}/events`);
    expect(data.map((e: any) => e.type)).toEqual([
      "user.message", "session.status_running", "agent.message",
      "agent.tool_use", "agent.mcp_tool_use", "agent.custom_tool_use", "session.status_idle",
    ]); // sandbox.acquired has no equivalent in this dialect, so it is left out
    expect(data[4]).toMatchObject({ type: "agent.mcp_tool_use", name: "get_issue", mcp_server_name: "github" });
    expect(data[6]).toMatchObject({ stop_reason: { type: "end_turn" } });
    expect((await json("GET", `/v1/sessions/${session.id}/events?types=agent.message`)).data.map((e: any) => e.type)).toEqual(["agent.message"]);
  });

  it("a held tool call is announced, idles the session with requires_action, and resumes when answered", async () => {
    const session = await seed();
    log(session.id, [
      { type: "session.status_running" },
      { type: "agent.tool_confirmation_required", tool_use_id: "t9", name: "delete_repo", mcp_server: "github" },
      { type: "user.tool_confirmation", tool_use_id: "t9", result: "allow" },
    ]);
    const held = (await json("GET", `/v1/sessions/${session.id}/events`)).data;
    expect(held.map((e: any) => e.type)).toEqual([
      "session.status_running", "agent.mcp_tool_use", "session.status_idle", "user.tool_confirmation", "session.status_running",
    ]);
    expect(held[1]).toMatchObject({ evaluated_permission: "ask", mcp_server_name: "github", name: "delete_repo" });
    expect(held[2].stop_reason).toEqual({ type: "requires_action", event_ids: ["sevt_t9"] });
  });

  it("accepts the client-postable events and refuses the ones with no equivalent", async () => {
    const session = await seed();
    await call("POST", `/v1/sessions/${session.id}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "go" }] }, { type: "user.custom_tool_result", custom_tool_use_id: "sevt_t3", content: [{ type: "text", text: "42" }] }],
    });
    expect(st.sent.at(-1)!.inputs).toEqual([
      { type: "user.message", content: [{ type: "text", text: "go" }] },
      { type: "tool_result", tool_use_id: "t3", content: [{ type: "text", text: "42" }], is_error: false },
    ]);

    // a confirmation releases the held call, keyed by the id the ask event carried
    await call("POST", `/v1/sessions/${session.id}/events`, { events: [{ type: "user.tool_confirmation", tool_use_id: "sevt_t9", result: "deny", deny_message: "not that one" }] });
    expect(st.sent.at(-1)!.inputs).toEqual([{ type: "user.tool_confirmation", tool_use_id: "t9", result: "deny", deny_message: "not that one" }]);

    const refused: [any, RegExp][] = [
      [{ type: "user.tool_confirmation", tool_use_id: "x", result: "maybe" }, /allow/],
      [{ type: "system.message", content: [{ type: "text", text: "x" }] }, /system prompt/],
      [{ type: "user.define_outcome", description: "x" }, /outcome/],
      [{ type: "user.message", content: [{ type: "image", source: { type: "url", url: "https://x/y.png" } }] }, /file_id/],
    ];
    for (const [event, re] of refused) {
      const res = await call("POST", `/v1/sessions/${session.id}/events`, { events: [event] });
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toMatch(re);
    }
  });

  it("threads list the session and its sub-agent sessions", async () => {
    const session = await seed();
    st.sessions.set("sess_child", { ...st.sessions.get(session.id), id: "sess_child", parent_id: session.id });
    const { data } = await json("GET", `/v1/sessions/${session.id}/threads`);
    expect(data.map((t: any) => t.id)).toEqual([session.id, "sess_child"]);
    expect(data[0]).toMatchObject({ type: "session_thread", session_id: session.id, parent_thread_id: null, status: "idle" });
    expect(data[1].parent_thread_id).toBe(session.id);
    expect((await call("GET", `/v1/sessions/${session.id}/threads/sthr_missing`)).status).toBe(404);
  });
});

describe("vaults, environments and memory stores", () => {
  it("vault + credential round-trip never echoes the secret", async () => {
    const vault = await json("POST", "/v1/vaults", { display_name: "Alice", metadata: { user: "u1" } });
    expect(vault).toMatchObject({ type: "vault", display_name: "Alice", metadata: { user: "u1" }, archived_at: null });

    const res = await call("POST", `/v1/vaults/${vault.id}/credentials`, { display_name: "Linear", auth: { type: "static_bearer", mcp_server_url: "https://mcp.linear.app/mcp", token: "lin_secret" } });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain("lin_secret");
    const cred = JSON.parse(text);
    expect(cred).toMatchObject({ type: "vault_credential", auth: { type: "static_bearer", mcp_server_url: "https://mcp.linear.app/mcp" } });

    expect(await json("GET", `/v1/vaults/${vault.id}/credentials/${cred.id}`)).toMatchObject({ id: cred.id });
    const rotated = await call("POST", `/v1/vaults/${vault.id}/credentials/${cred.id}`, { auth: { type: "static_bearer", token: "lin_new" } });
    expect(rotated.status).toBe(200);
    expect(await rotated.text()).not.toContain("lin_new");
    expect((await call("POST", `/v1/vaults/${vault.id}/credentials/${cred.id}`, { auth: { type: "mcp_oauth", access_token: "x" } })).status).toBe(400);

    expect(await json("POST", `/v1/vaults/${vault.id}/credentials/${cred.id}/archive`)).toMatchObject({ archived_at: expect.any(String) });
    expect(await json("DELETE", `/v1/vaults/${vault.id}`)).toEqual({ id: vault.id, type: "vault_deleted" });
  });

  it("environments map cloud to an isolating provider and self_hosted to a worker", async () => {
    const cloud = await json("POST", "/v1/environments", { name: "cloud", config: { type: "cloud", networking: { type: "limited", allowed_hosts: ["api.github.com"] } } });
    expect(cloud).toMatchObject({ type: "environment", name: "cloud", config: { type: "cloud", networking: { type: "limited" } } });
    expect(st.environments.get(cloud.id)).toMatchObject({ provider: "docker", network: "none" });

    const self = await json("POST", "/v1/environments", { name: "mine", config: { type: "self_hosted" } });
    expect(self.config).toEqual({ type: "self_hosted" });
    expect(st.environments.get(self.id).provider).toBe("byoc");

    expect((await json("GET", "/v1/environments")).data.length).toBeGreaterThanOrEqual(2);
    expect(await json("DELETE", `/v1/environments/${self.id}`)).toEqual({ id: self.id, type: "environment_deleted" });
  });

  it("memory stores create, list and archive", async () => {
    const store = await json("POST", "/v1/memory_stores", { name: "prefs", description: "user preferences" });
    expect(store).toMatchObject({ type: "memory_store", name: "prefs", description: "user preferences" });
    expect((await json("GET", "/v1/memory_stores")).data.map((m: any) => m.id)).toEqual([store.id]);
    expect((await json("POST", `/v1/memory_stores/${store.id}/archive`)).archived_at).toBeTruthy();
    expect((await call("GET", `/v1/memory_stores/${store.id}`)).status).toBe(404);
  });

  it("a session mounts a memory store declared as a resource", async () => {
    const store = await json("POST", "/v1/memory_stores", { name: "prefs" });
    const agent = await json("POST", "/v1/agents", agentSpec);
    const session = await json("POST", "/v1/sessions", { agent: agent.id, environment_id: "env_1", resources: [{ type: "memory_store", memory_store_id: store.id }] });
    expect(session.resources).toEqual([{ type: "memory_store", memory_store_id: store.id, mount_path: "memories/prefs" }]);
  });

  it("everything is owner-scoped", async () => {
    const agent = await json("POST", "/v1/agents", agentSpec);
    const vault = await json("POST", "/v1/vaults", { display_name: "v" });
    const other = { "x-owner": "prc_b" };
    expect((await call("GET", `/v1/agents/${agent.id}`, undefined, other)).status).toBe(404);
    expect((await call("POST", `/v1/agents/${agent.id}`, { system: "x" }, other)).status).toBe(404);
    expect((await call("GET", `/v1/vaults/${vault.id}`, undefined, other)).status).toBe(404);
    expect((await call("POST", "/v1/sessions", { agent: agent.id, environment_id: "env_1" }, other)).status).toBe(404);
  });
});
