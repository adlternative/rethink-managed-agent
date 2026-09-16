import { describe, it, expect, vi, beforeEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";

/**
 * Contract test against the REAL Anthropic SDK (@anthropic-ai/sdk 0.123.0, the Claude Managed Agents
 * client). The SDK drives our actual /anthropic router through an in-process fetch, so what is proven
 * is the whole path: the SDK's own request builder hits our routes, our responses parse back into its
 * typed objects, and its SSE parser reads our stream.
 *
 * Storage is faked in memory (as in compat-anthropic-routes), because what is under test is the
 * dialect, not Postgres.
 */

const st = vi.hoisted(() => ({
  agents: new Map<string, any>(),
  sessions: new Map<string, any>(),
  environments: new Map<string, any>(),
  vaults: new Map<string, any>(),
  creds: new Map<string, Map<string, any>>(),
  events: new Map<string, any[]>(),
  sent: [] as any[],
  n: 0,
}));

vi.mock("../src/infra/db.ts", async (orig) => {
  const real = await orig<typeof import("../src/infra/db.ts")>();
  const owned = (row: any, sc?: { owner: string }) => (row && (!sc || row.owner_id === sc.owner) ? row : null);
  return {
    ...real,
    repos: {
      ...real.repos,
      agents: {
        create: async (input: any) => { const a = { id: `agent_${++st.n}`, created_at: "2026-01-01T00:00:00.000Z", ...input }; st.agents.set(a.id, a); return a; },
        get: async (id: string, sc?: any) => owned(st.agents.get(id), sc),
        list: async (sc?: any) => [...st.agents.values()].filter((a) => owned(a, sc)),
        update: async (id: string, patch: any, sc?: any) => { const a = owned(st.agents.get(id), sc); if (!a) return null; Object.assign(a, patch); return a; },
        delete: async () => ({ archived: true }),
      },
      environments: { get: async (id: string, sc?: any) => owned(st.environments.get(id), sc), list: async () => [...st.environments.values()] },
      workspaces: { create: async (spec: any, ref: any, owner_id: string) => ({ id: `ws_${++st.n}`, owner_id, spec, ref }) },
      sessions: {
        create: async (input: any) => { const s = { id: `sess_${++st.n}`, status: "idle", parent_id: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", usage: {}, ...input }; st.sessions.set(s.id, s); return s; },
        get: async (id: string, sc?: any) => owned(st.sessions.get(id), sc),
        childrenOf: async () => [],
        listPage: async (sc: any) => ({ data: [...st.sessions.values()].filter((s) => owned(s, sc)), has_more: false, next_cursor: null }),
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
      delete: async () => true,
    },
    vaultCredentials: {
      put: async (vaultId: string, input: any) => {
        const cred = { id: `vcrd_${input.name}`, vault_id: vaultId, name: input.name, kind: input.kind, mcp_server_url: input.mcp_server_url ?? null, expires_at: null, has_refresh: false, metadata: {}, created_at: "2026-01-01T00:00:00.000Z" };
        (st.creds.get(vaultId) ?? st.creds.set(vaultId, new Map()).get(vaultId)!).set(input.name, cred);
        return cred;
      },
      list: async (vaultId: string) => [...(st.creds.get(vaultId)?.values() ?? [])],
      get: async (vaultId: string, name: string) => st.creds.get(vaultId)?.get(name) ?? null,
      byId: async (id: string, vaultIds: string[]) => { for (const v of vaultIds) for (const cr of st.creds.get(v)?.values() ?? []) if (cr.id === id) return cr; return null; },
      delete: async () => true,
    },
    memoryStores: { create: async () => ({ id: "mem_1", name: "m", description: "", created_at: "2026-01-01T00:00:00.000Z" }), get: async () => null, list: async () => [], delete: async () => true },
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

vi.mock("../src/infra/pubsub.ts", async (orig) => {
  const real = await orig<typeof import("../src/infra/pubsub.ts")>();
  return { ...real, subscribe: async () => () => {} };
});

vi.mock("../src/api/routes/events.ts", async (orig) => {
  const real = await orig<typeof import("../src/api/routes/events.ts")>();
  return {
    ...real,
    sendUserEvents: async (session: any, inputs: any[]) => {
      st.sent.push(...inputs);
      return inputs.map((payload, i) => ({ id: `ev_${i}`, seq: 100 + i, session_id: session.id, type: payload.type, payload, created_at: "2026-01-01T00:00:00.000Z" }));
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
  .use("*", async (c, next) => { c.set("owner" as never, "prc_a" as never); await next(); })
  .route("/anthropic", anthropicAgents);

const paths: string[] = [];
const client = new Anthropic({
  apiKey: "sk-ant-test",
  baseURL: "http://local/anthropic",
  fetch: (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url);
    paths.push(`${init?.method ?? "GET"} ${u.pathname}`);
    return app.request(u.pathname + u.search, { method: init?.method ?? "GET", headers: init?.headers as HeadersInit, body: init?.body as BodyInit });
  }) as never,
});

beforeEach(() => {
  for (const m of [st.agents, st.sessions, st.environments, st.vaults, st.creds, st.events]) m.clear();
  st.sent.length = 0;
  paths.length = 0;
  st.environments.set("env_1", { id: "env_1", owner_id: "prc_a", name: "e", provider: "docker", network: "bridge", workspace: { kind: "empty" }, created_at: "2026-01-01T00:00:00.000Z" });
});

const agentParams = {
  name: "GitHub Assistant",
  model: "claude-opus-5",
  system: "be brief",
  mcp_servers: [{ type: "url" as const, name: "github", url: "https://api.githubcopilot.com/mcp/" }],
  tools: [
    { type: "agent_toolset_20260401" as const },
    { type: "mcp_toolset" as const, mcp_server_name: "github", default_config: { enabled: false }, configs: [{ name: "get_issue", enabled: true }] },
  ],
};

describe("Claude Managed Agents SDK contract (@anthropic-ai/sdk 0.123.0)", () => {
  it("agents.create/retrieve/update/list/archive hit our routes and parse back", async () => {
    const agent = await client.beta.agents.create(agentParams);
    expect(paths[0]).toBe("POST /anthropic/v1/agents");
    expect(agent.type).toBe("agent");
    expect(agent.name).toBe("GitHub Assistant");
    expect(agent.version).toBe(1);
    expect(agent.mcp_servers).toEqual([{ type: "url", name: "github", url: "https://api.githubcopilot.com/mcp/" }]);

    const got = await client.beta.agents.retrieve(agent.id);
    expect(paths[1]).toBe(`GET /anthropic/v1/agents/${agent.id}`);
    expect(got.id).toBe(agent.id);

    const updated = await client.beta.agents.update(agent.id, { system: "be terse" });
    expect(paths[2]).toBe(`POST /anthropic/v1/agents/${agent.id}`); // this dialect updates with POST
    expect(updated.system).toBe("be terse");
    expect(updated.version).toBe(2);

    const page = await client.beta.agents.list();
    expect(page.data.map((a) => a.id)).toEqual([agent.id]);

    const archived = await client.beta.agents.archive(agent.id);
    expect(archived.archived_at).toBeTruthy();
  });

  it("the model resolves through rethink's provider table, not an Anthropic model id", async () => {
    const agent = await client.beta.agents.create({ ...agentParams, model: { id: "qoder/auto", effort: "high" } });
    expect(st.agents.get(agent.id).model).toEqual({ provider: "qoder", id: "auto" });
    expect(agent.model).toMatchObject({ id: "qoder/auto", effort: "high" }); // echoed as declared
  });

  it("sessions.create/retrieve/update/list/archive and the typed session object", async () => {
    const agent = await client.beta.agents.create(agentParams);
    const session = await client.beta.sessions.create({ agent: agent.id, environment_id: "env_1", title: "nightly", metadata: { run: "7" } });
    expect(paths.at(-1)).toBe("POST /anthropic/v1/sessions");
    expect(session.type).toBe("session");
    expect(session.status).toBe("idle");
    expect(session.title).toBe("nightly");
    expect(session.agent.id).toBe(agent.id);
    expect(session.usage).toMatchObject({ input_tokens: 0, output_tokens: 0 });

    expect((await client.beta.sessions.retrieve(session.id)).id).toBe(session.id);
    expect((await client.beta.sessions.update(session.id, { title: "renamed" })).title).toBe("renamed");
    expect((await client.beta.sessions.list()).data.map((s) => s.id)).toEqual([session.id]);
    expect((await client.beta.sessions.archive(session.id)).status).toBe("terminated");
  });

  it("agent_with_overrides is accepted on session create", async () => {
    const agent = await client.beta.agents.create(agentParams);
    const session = await client.beta.sessions.create({
      agent: { type: "agent_with_overrides", id: agent.id, system: "be loud" },
      environment_id: "env_1",
    });
    expect(session.agent.system).toBe("be loud");
    expect(st.agents.get(agent.id).system).toBe("be brief");
  });

  it("events.send posts the dialect's input events and events.list reads the log back", async () => {
    const agent = await client.beta.agents.create(agentParams);
    const session = await client.beta.sessions.create({ agent: agent.id, environment_id: "env_1" });
    await client.beta.sessions.events.send(session.id, { events: [{ type: "user.message", content: [{ type: "text", text: "go" }] }] });
    expect(paths.at(-1)).toBe(`POST /anthropic/v1/sessions/${session.id}/events`);
    expect(st.sent).toEqual([{ type: "user.message", content: [{ type: "text", text: "go" }] }]);

    st.events.set(session.id, [
      { id: "e1", seq: 1, session_id: session.id, type: "session.status_running", payload: { type: "session.status_running" }, created_at: "2026-01-01T00:00:00.000Z" },
      { id: "e2", seq: 2, session_id: session.id, type: "agent.message", payload: { type: "agent.message", content: [{ type: "text", text: "done" }] }, created_at: "2026-01-01T00:00:01.000Z" },
      { id: "e3", seq: 3, session_id: session.id, type: "agent.tool_use", payload: { type: "agent.tool_use", tool_use_id: "t1", name: "github__get_issue", input: { n: 1 } }, created_at: "2026-01-01T00:00:02.000Z" },
      { id: "e4", seq: 4, session_id: session.id, type: "session.status_idle", payload: { type: "session.status_idle", stop_reason: "end_turn" }, created_at: "2026-01-01T00:00:03.000Z" },
    ]);
    const page = await client.beta.sessions.events.list(session.id);
    expect(page.data.map((e) => e.type)).toEqual(["session.status_running", "agent.message", "agent.mcp_tool_use", "session.status_idle"]);
    const mcp = page.data[2] as { type: string; name: string; mcp_server_name: string };
    expect(mcp).toMatchObject({ type: "agent.mcp_tool_use", name: "get_issue", mcp_server_name: "github" });
    const idle = page.data[3] as { stop_reason: { type: string } };
    expect(idle.stop_reason).toEqual({ type: "end_turn" });
  });

  it("events.stream: the SDK's SSE parser reads our stream, dispatching on the event name", async () => {
    const agent = await client.beta.agents.create(agentParams);
    const session = await client.beta.sessions.create({ agent: agent.id, environment_id: "env_1" });
    st.events.set(session.id, [
      { id: "e1", seq: 1, session_id: session.id, type: "session.status_running", payload: { type: "session.status_running" }, created_at: "2026-01-01T00:00:00.000Z" },
      { id: "e2", seq: 2, session_id: session.id, type: "agent.message", payload: { type: "agent.message", content: [{ type: "text", text: "hello" }] }, created_at: "2026-01-01T00:00:01.000Z" },
      { id: "e3", seq: 3, session_id: session.id, type: "session.status_terminated", payload: { type: "session.status_terminated" }, created_at: "2026-01-01T00:00:02.000Z" },
    ]);
    const seen: string[] = [];
    for await (const event of await client.beta.sessions.events.stream(session.id)) seen.push(event.type);
    expect(paths.at(-1)).toBe(`GET /anthropic/v1/sessions/${session.id}/events/stream`);
    expect(seen).toEqual(["session.status_running", "agent.message", "session.status_terminated"]);
  });

  it("vaults.create + credentials.create/retrieve/list, with the secret never echoed", async () => {
    const vault = await client.beta.vaults.create({ display_name: "Alice" });
    expect(paths.at(-1)).toBe("POST /anthropic/v1/vaults");
    expect(vault.type).toBe("vault");
    expect(vault.display_name).toBe("Alice");

    const cred = await client.beta.vaults.credentials.create(vault.id, {
      display_name: "Linear",
      auth: { type: "static_bearer", mcp_server_url: "https://mcp.linear.app/mcp", token: "lin_secret" },
    });
    expect(cred.type).toBe("vault_credential");
    expect(JSON.stringify(cred)).not.toContain("lin_secret");
    expect(cred.auth).toMatchObject({ type: "static_bearer", mcp_server_url: "https://mcp.linear.app/mcp" });

    expect((await client.beta.vaults.credentials.retrieve(cred.id, { vault_id: vault.id })).id).toBe(cred.id);
    expect((await client.beta.vaults.credentials.list(vault.id)).data.map((x) => x.id)).toEqual([cred.id]);
  });

  it("what rethink cannot run comes back as a typed API error, not a silent success", async () => {
    await expect(client.beta.agents.create({ ...agentParams, tools: [{ type: "mcp_toolset", mcp_server_name: "nope" }] }))
      .rejects.toMatchObject({ status: 400, error: { error: { type: "invalid_request_error" } } });
    const agent = await client.beta.agents.create(agentParams);
    await expect(client.beta.sessions.create({ agent: agent.id, environment_id: "env_1", budget: { type: "limit", max_list_cost: { amount: "100", currency: "USD" } } }))
      .rejects.toMatchObject({ status: 400 });
  });
});
