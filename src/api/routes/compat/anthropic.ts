import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { memoryStores, repos, sessionConfig, vaults, vaultCredentials } from "../../../infra/db.ts";
import { appendEvents, listEvents } from "../../../infra/events.ts";
import { subscribe } from "../../../infra/pubsub.ts";
import { hasMcpCredentials, sealMcpServers } from "../../../infra/mcp-credentials.ts";
import { secretsConfigured } from "../../../infra/secrets.ts";
import type { SessionEvent, SessionResource, UserEventInput, WorkspaceRef } from "../../../shared/types.ts";
import { invalid, notFound, queryInt, readJson } from "../../errors.ts";
import { ownerId, scope } from "../../auth.ts";
import { sendUserEvents } from "../events.ts";
import { initialRef } from "../sessions.ts";
import { validateMounts } from "../memories.ts";
import { credentialInput, validateMcpCredentialIds, validateVaultIds, type CredentialBody } from "../vaults.ts";
import { cmaAgentToRethink, cmaContent, toCmaAgent, toCmaEvents, toCmaSession, type CmaAgentSpec, type CmaCallKinds } from "./anthropic-translate.ts";

/**
 * The Claude Managed Agents surface, mounted at /anthropic so `@anthropic-ai/sdk` works with
 * `baseURL: "<host>/anthropic"` (the SDK appends /v1/... itself). A pure adapter over the same engine
 * the native API and the OpenAI surface run on — no Anthropic SDK is imported and no request leaves
 * the deployment.
 *
 * Dialect rules this surface follows: every mutation is a POST (no PATCH), lists page with
 * `{data, next_page}`, the SSE stream names each event in its `event:` line, and archive is a POST
 * with no body. What rethink cannot honor is refused at the edge or reported in the agent's
 * `unsupported` list — see DESIGN §21 for the full matrix.
 */

const DEFAULT_LIMIT = 20;

/** CMA's PageCursor: `{data, next_page}` where the cursor is the last id of the page. */
function pageCursor<T extends { id: string }>(rows: T[], c: Context, extra: Record<string, unknown> = {}) {
  const limit = c.req.query("limit") ? queryInt(c, "limit", DEFAULT_LIMIT, 1) : DEFAULT_LIMIT;
  const page = c.req.query("page") || undefined;
  const start = page ? rows.findIndex((r) => r.id === page) + 1 : 0;
  const slice = rows.slice(start, start + limit);
  const hasMore = start + limit < rows.length;
  return { data: slice, next_page: hasMore ? (slice[slice.length - 1]?.id ?? null) : null, ...extra };
}

const asc = (c: Context) => c.req.query("order") !== "desc";

async function loadSession(c: Context): Promise<SessionResource> {
  const s = await repos.sessions.get(c.req.param("id"), scope(c));
  if (!s) throw notFound("session", c.req.param("id"));
  return s;
}

/** Agent rows carry their CMA echo in `compat.anthropic`; the version counter lives there too. */
const versionOf = (row: { compat?: Record<string, unknown> }) => Number((row.compat?.anthropic as { version?: number } | undefined)?.version ?? 1);

export const anthropicAgents = new Hono()
  // ---------- Agents ----------
  .post("/v1/agents", async (c) => {
    const spec = await readJson<CmaAgentSpec>(c);
    const draft = cmaAgentToRethink(spec);
    const row = await repos.agents.create({
      owner_id: ownerId(c), name: draft.name, model: draft.model, system: draft.system, tools: draft.tools,
      packages: draft.packages, skills: [], mcp_servers: draft.mcp_servers, metadata: draft.metadata,
      client_tools: draft.client_tools, compat: { anthropic: draft.echo },
    });
    return c.json(toCmaAgent(row), 201);
  })
  .get("/v1/agents", async (c) => {
    const rows = await repos.agents.list(scope(c));
    const ordered = asc(c) ? rows : [...rows].reverse();
    return c.json(pageCursor(ordered.map(toCmaAgent), c));
  })
  .get("/v1/agents/:agentId", async (c) => {
    const row = await repos.agents.get(c.req.param("agentId"), scope(c));
    if (!row) throw notFound("agent", c.req.param("agentId"));
    return c.json(toCmaAgent(row));
  })
  /** Update: provided fields replace, omitted ones are kept; `version` is an optimistic-concurrency check. */
  .post("/v1/agents/:agentId", async (c) => {
    const id = c.req.param("agentId");
    const current = await repos.agents.get(id, scope(c));
    if (!current) throw notFound("agent", id);
    const body = await readJson<CmaAgentSpec & { version?: number }>(c);
    const echo = (current.compat?.anthropic ?? {}) as Record<string, unknown>;
    const version = versionOf(current);
    if (body.version !== undefined && body.version !== version) throw invalid(`agent ${id} is at version ${version}, not ${body.version}`);
    const merged: CmaAgentSpec = {
      model: body.model !== undefined ? body.model : (echo.model as CmaAgentSpec["model"]),
      name: body.name ?? current.name,
      description: body.description !== undefined ? body.description : (echo.description as string | null),
      system: body.system !== undefined ? body.system : current.system,
      tools: body.tools !== undefined ? (body.tools ?? []) : (echo.tools as CmaAgentSpec["tools"]),
      mcp_servers: body.mcp_servers !== undefined ? (body.mcp_servers ?? []) : (echo.mcp_servers as CmaAgentSpec["mcp_servers"]),
      skills: body.skills !== undefined ? (body.skills ?? []) : (echo.skills as unknown[]),
      multiagent: body.multiagent !== undefined ? body.multiagent : echo.multiagent,
      metadata: patchMetadata(current.metadata ?? {}, body.metadata),
    };
    const draft = cmaAgentToRethink(merged, { version: version + 1 });
    const row = await repos.agents.update(id, {
      name: draft.name, model: draft.model, system: draft.system, tools: draft.tools, packages: draft.packages,
      mcp_servers: draft.mcp_servers, metadata: draft.metadata, client_tools: draft.client_tools, compat: { anthropic: draft.echo },
    }, scope(c));
    if (!row) throw notFound("agent", id);
    return c.json(toCmaAgent(row));
  })
  /** Archive: the row stays referenced by its sessions but is no longer usable for new ones. */
  .post("/v1/agents/:agentId/archive", async (c) => {
    const row = await repos.agents.get(c.req.param("agentId"), scope(c));
    if (!row) throw notFound("agent", c.req.param("agentId"));
    const r = await repos.agents.delete(row.id, scope(c));
    return c.json({ ...toCmaAgent(row), archived_at: new Date().toISOString(), deleted: r ? !r.archived : false });
  })
  /** Versions: rethink keeps one row per agent, so the list is the current version alone. */
  .get("/v1/agents/:agentId/versions", async (c) => {
    const row = await repos.agents.get(c.req.param("agentId"), scope(c));
    if (!row) throw notFound("agent", c.req.param("agentId"));
    return c.json({ data: [toCmaAgent(row)], next_page: null });
  })

  // ---------- Sessions ----------
  .post("/v1/sessions", async (c) => {
    const body = await readJson<{
      agent?: unknown; environment_id?: string; title?: string | null; metadata?: Record<string, string>;
      vault_ids?: unknown; initial_events?: unknown; resources?: unknown; budget?: unknown;
    }>(c);
    const owner = ownerId(c);
    const sc = scope(c);
    const { agent, agentId } = await resolveCmaAgent(body.agent, sc);
    if (!body.environment_id) throw invalid("environment_id is required");
    const environment = await repos.environments.get(body.environment_id, sc);
    if (!environment) throw notFound("environment", body.environment_id);
    if (body.budget) throw invalid("budget is not supported: rethink does not meter sessions in currency");
    const vault_ids = await validateVaultIds(body.vault_ids, sc);
    await validateMcpCredentialIds(agent.mcp_servers, vault_ids);
    if (hasMcpCredentials(agent.mcp_servers) && !secretsConfigured()) throw invalid("MCP server credentials need PMA_SECRET_KEY to be stored encrypted");
    const memory_stores = await validateMounts(cmaResourceMounts(body.resources), sc);
    const initial = body.initial_events !== undefined ? cmaInitialEvents(body.initial_events) : [];
    const metadata = { ...(body.metadata ?? {}), ...(body.title ? { title: body.title } : {}) };

    const workspace = await repos.workspaces.create(environment.workspace, initialRef(environment.workspace) as WorkspaceRef, owner);
    const session = await repos.sessions.create({
      owner_id: owner, agent_id: agentId, environment_id: environment.id, workspace_id: workspace.id,
      agent: { ...agent, mcp_servers: sealMcpServers(agent.mcp_servers) }, vault_ids, memory_stores, metadata,
    });
    if (initial.length) await sendUserEvents(session, initial);
    return c.json(toCmaSession(session), 201);
  })
  .get("/v1/sessions", async (c) => {
    const statuses = c.req.queries("statuses") ?? [];
    const page = await repos.sessions.listPage(scope(c), {
      limit: c.req.query("limit") ? queryInt(c, "limit", DEFAULT_LIMIT, 1) : DEFAULT_LIMIT,
      after: c.req.query("page") || undefined,
      agentId: c.req.query("agent_id") || undefined,
      order: c.req.query("order") === "asc" ? "asc" : "desc",
    });
    const data = page.data.filter((s) => !statuses.length || statuses.includes(s.status)).map((s) => toCmaSession(s));
    return c.json({ data, next_page: page.has_more ? (data[data.length - 1]?.id ?? null) : null, prev_page: null });
  })
  .get("/v1/sessions/:id", async (c) => c.json(toCmaSession(await loadSession(c))))
  /** Update: title and metadata (a patch). Changing the agent mid-session is native-API territory. */
  .post("/v1/sessions/:id", async (c) => {
    const session = await loadSession(c);
    const body = await readJson<{ title?: string | null; metadata?: Record<string, string | null>; agent?: unknown; vault_ids?: unknown; budget?: unknown }>(c);
    if (body.vault_ids !== undefined) throw invalid("vault_ids cannot be changed after a session is created");
    if (body.agent !== undefined) throw invalid("the agent of a running session can only be changed through the native API (PATCH /v1/sessions/:id)");
    if (body.budget !== undefined) throw invalid("budget is not supported: rethink does not meter sessions in currency");
    const patch: Record<string, string | null> = { ...(body.metadata ?? {}) };
    if (body.title !== undefined) patch.title = body.title;
    const metadata = Object.keys(patch).length ? await sessionConfig.patchMetadata(session.id, patch, scope(c)) : session.metadata;
    return c.json(toCmaSession({ ...session, metadata: metadata ?? {} }));
  })
  .post("/v1/sessions/:id/archive", async (c) => {
    const session = await loadSession(c);
    if (session.status === "running") throw invalid("a running session must be interrupted before it is archived");
    if (session.status !== "terminated") await appendEvents(session.id, [{ type: "session.status_terminated", reason: "archived" }], { status: "terminated" });
    return c.json(toCmaSession({ ...session, status: "terminated" }, { archived: true }));
  })
  .delete("/v1/sessions/:id", async (c) => {
    const session = await loadSession(c);
    if (session.status === "running") throw invalid("a running session must be interrupted before it is deleted");
    await repos.sessions.delete(session.id);
    return c.json({ id: session.id, type: "session_deleted" });
  })

  // ---------- Session events ----------
  .post("/v1/sessions/:id/events", async (c) => {
    const session = await loadSession(c);
    const body = await readJson<{ events?: unknown }>(c);
    if (!Array.isArray(body.events) || body.events.length === 0) throw invalid("events must be a non-empty array");
    const inputs = cmaEventsToUserEvents(body.events, session);
    const appended = await sendUserEvents(session, inputs);
    const calls: CmaCallKinds = new Map();
    return c.json({ data: appended.flatMap((e) => toCmaEvents(e, session, calls)) });
  })
  .get("/v1/sessions/:id/events", async (c) => {
    const session = await loadSession(c);
    const types = c.req.queries("types") ?? [];
    const calls: CmaCallKinds = new Map();
    const all = (await allEvents(session.id)).flatMap((e) => toCmaEvents(e, session, calls)) as { id: string; type: string }[];
    const filtered = types.length ? all.filter((e) => types.includes(e.type)) : all;
    return c.json(pageCursor(asc(c) ? filtered : [...filtered].reverse(), c));
  })
  .get("/v1/sessions/:id/events/stream", async (c) => streamCmaEvents(c, await loadSession(c)))

  // ---------- Session threads (rethink sub-agent sessions) ----------
  .get("/v1/sessions/:id/threads", async (c) => {
    const session = await loadSession(c);
    const kids = await repos.sessions.childrenOf(session.id, scope(c));
    return c.json(pageCursor([toThread(session, session), ...kids.map((k) => toThread(k, session))], c));
  })
  .get("/v1/sessions/:id/threads/:threadId", async (c) => c.json(toThread(await loadThread(c), await loadSession(c))))
  .get("/v1/sessions/:id/threads/:threadId/events", async (c) => {
    const thread = await loadThread(c);
    const threadCalls: CmaCallKinds = new Map();
    const data = (await allEvents(thread.id)).flatMap((e) => toCmaEvents(e, thread, threadCalls)) as { id: string }[];
    return c.json(pageCursor(data, c));
  })
  .get("/v1/sessions/:id/threads/:threadId/stream", async (c) => streamCmaEvents(c, await loadThread(c)))

  // ---------- Vaults ----------
  .post("/v1/vaults", async (c) => {
    const body = await readJson<{ display_name?: string; metadata?: Record<string, string> }>(c);
    if (!body.display_name) throw invalid("display_name is required");
    const v = await vaults.create({ owner_id: ownerId(c), name: body.display_name, metadata: body.metadata });
    return c.json(toCmaVault(v), 201);
  })
  .get("/v1/vaults", async (c) => c.json(pageCursor((await vaults.list(scope(c))).map(toCmaVault), c)))
  .get("/v1/vaults/:vaultId", async (c) => c.json(toCmaVault(await loadVault(c))))
  .post("/v1/vaults/:vaultId", async (c) => {
    const v = await loadVault(c);
    const body = await readJson<{ display_name?: string | null; metadata?: Record<string, string | null> }>(c);
    // the store has no vault update; re-create is not an option (the id must stay), so this echoes the patch
    if (body.display_name !== undefined || body.metadata !== undefined) throw invalid("a vault's display_name and metadata cannot be changed after creation");
    return c.json(toCmaVault(v));
  })
  .delete("/v1/vaults/:vaultId", async (c) => {
    const v = await loadVault(c);
    await vaults.delete(v.id, scope(c));
    return c.json({ id: v.id, type: "vault_deleted" });
  })
  /** Archive purges the secrets but keeps the record; rethink has no separate archive state, so it deletes. */
  .post("/v1/vaults/:vaultId/archive", async (c) => {
    const v = await loadVault(c);
    await vaults.delete(v.id, scope(c));
    return c.json({ ...toCmaVault(v), archived_at: new Date().toISOString() });
  })
  .post("/v1/vaults/:vaultId/credentials", async (c) => {
    if (!secretsConfigured()) throw invalid("PMA_SECRET_KEY is not set: cannot store vault secrets");
    const v = await loadVault(c);
    const body = await readJson<CredentialBody>(c);
    const cred = await vaultCredentials.put(v.id, credentialInput(body));
    return c.json(toCmaCredential(cred), 201);
  })
  .get("/v1/vaults/:vaultId/credentials", async (c) => {
    const v = await loadVault(c);
    return c.json(pageCursor((await vaultCredentials.list(v.id)).map(toCmaCredential), c));
  })
  .get("/v1/vaults/:vaultId/credentials/:credentialId", async (c) => c.json(toCmaCredential(await loadCredential(c))))
  .post("/v1/vaults/:vaultId/credentials/:credentialId", async (c) => {
    if (!secretsConfigured()) throw invalid("PMA_SECRET_KEY is not set: cannot store vault secrets");
    const cred = await loadCredential(c);
    const body = await readJson<CredentialBody>(c);
    const auth = body.auth ?? {};
    const value = auth.token ?? auth.access_token ?? auth.secret_value;
    if (typeof value !== "string" || !value) throw invalid("a new secret is required (auth.token, auth.access_token or auth.secret_value)");
    if (auth.type && auth.type !== cred.kind) throw invalid(`this credential is a ${cred.kind}; its type is fixed at creation`);
    const updated = await vaultCredentials.put(cred.vault_id, {
      name: cred.name, value, kind: cred.kind, mcp_server_url: cred.mcp_server_url ?? null,
      refresh: auth.refresh ?? null, expires_at: auth.expires_at ?? null,
    });
    return c.json(toCmaCredential(updated));
  })
  .delete("/v1/vaults/:vaultId/credentials/:credentialId", async (c) => {
    const cred = await loadCredential(c);
    await vaultCredentials.delete(cred.vault_id, cred.id);
    return c.json({ id: cred.id, type: "vault_credential_deleted" });
  })
  .post("/v1/vaults/:vaultId/credentials/:credentialId/archive", async (c) => {
    const cred = await loadCredential(c);
    await vaultCredentials.delete(cred.vault_id, cred.id);
    return c.json({ ...toCmaCredential(cred), archived_at: new Date().toISOString() });
  })

  // ---------- Environments ----------
  .post("/v1/environments", async (c) => {
    const body = await readJson<{ name?: string; description?: string | null; metadata?: Record<string, string>; config?: { type?: string; networking?: { type?: string } } }>(c);
    if (!body.name) throw invalid("name is required");
    const cfg = body.config ?? { type: "cloud" };
    if (cfg.type !== "cloud" && cfg.type !== "self_hosted") throw invalid(`config.type must be "cloud" or "self_hosted"`);
    // cloud -> the deployment's own isolating sandbox provider; self_hosted -> a worker you run (byoc)
    const provider = cfg.type === "self_hosted" ? "byoc" : "docker";
    const network = cfg.type === "cloud" && cfg.networking?.type === "limited" ? "none" : "bridge";
    const row = await repos.environments.create({
      owner_id: ownerId(c), name: body.name, provider, image: null, network,
      plugin_host: "runner", workspace: { kind: "empty" },
    } as never);
    return c.json(toCmaEnvironment(row, cfg.type), 201);
  })
  .get("/v1/environments", async (c) => c.json(pageCursor((await repos.environments.list(scope(c))).map((e) => toCmaEnvironment(e)), c)))
  .get("/v1/environments/:envId", async (c) => {
    const row = await repos.environments.get(c.req.param("envId"), scope(c));
    if (!row) throw notFound("environment", c.req.param("envId"));
    return c.json(toCmaEnvironment(row));
  })
  .delete("/v1/environments/:envId", async (c) => {
    const r = await repos.environments.delete(c.req.param("envId"), scope(c));
    if (!r) throw notFound("environment", c.req.param("envId"));
    return c.json({ id: c.req.param("envId"), type: "environment_deleted" });
  })
  .post("/v1/environments/:envId/archive", async (c) => {
    const row = await repos.environments.get(c.req.param("envId"), scope(c));
    if (!row) throw notFound("environment", c.req.param("envId"));
    await repos.environments.delete(row.id, scope(c));
    return c.json({ ...toCmaEnvironment(row), archived_at: new Date().toISOString() });
  })

  // ---------- Memory stores ----------
  .post("/v1/memory_stores", async (c) => {
    const body = await readJson<{ name?: string; description?: string; metadata?: Record<string, string> }>(c);
    if (!body.name) throw invalid("name is required");
    const store = await memoryStores.create({ owner_id: ownerId(c), name: body.name, description: body.description });
    return c.json(toCmaMemoryStore(store), 201);
  })
  .get("/v1/memory_stores", async (c) => c.json(pageCursor((await memoryStores.list(scope(c))).map(toCmaMemoryStore), c)))
  .get("/v1/memory_stores/:storeId", async (c) => {
    const store = await memoryStores.get(c.req.param("storeId"), scope(c));
    if (!store) throw notFound("memory_store", c.req.param("storeId"));
    return c.json(toCmaMemoryStore(store));
  })
  .delete("/v1/memory_stores/:storeId", async (c) => {
    if (!(await memoryStores.delete(c.req.param("storeId"), scope(c)))) throw notFound("memory_store", c.req.param("storeId"));
    return c.json({ id: c.req.param("storeId"), type: "memory_store_deleted" });
  })
  .post("/v1/memory_stores/:storeId/archive", async (c) => {
    const store = await memoryStores.get(c.req.param("storeId"), scope(c));
    if (!store) throw notFound("memory_store", c.req.param("storeId"));
    await memoryStores.delete(store.id, scope(c));
    return c.json({ ...toCmaMemoryStore(store), archived_at: new Date().toISOString() });
  });

// ---------- helpers ----------

const EVENTS_PAGE = 5000;
async function allEvents(sessionId: string): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for (;;) {
    const page = await listEvents(sessionId, out.length ? { since: out[out.length - 1]!.seq, limit: EVENTS_PAGE } : { limit: EVENTS_PAGE });
    out.push(...page);
    if (page.length < EVENTS_PAGE) return out;
  }
}

/** Metadata patch semantics: a string upserts its key, null deletes it, an absent map changes nothing. */
function patchMetadata(current: Record<string, string>, patch: Record<string, string | null> | null | undefined): Record<string, string> {
  if (!patch) return current;
  const out = { ...current };
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete out[k]; else out[k] = v; }
  return out;
}

/** `agent` on session create: an id, {type:"agent", id}, or {type:"agent_with_overrides", id, ...}. */
async function resolveCmaAgent(input: unknown, sc: ReturnType<typeof scope>): Promise<{ agent: SessionResource["agent"]; agentId: string }> {
  const ref = typeof input === "string" ? { id: input } : (input as { type?: string; id?: string } | undefined);
  if (!ref?.id) throw invalid('agent must be an agent id, {type:"agent", id} or {type:"agent_with_overrides", id, ...}');
  const base = await repos.agents.get(ref.id, sc);
  if (!base) throw notFound("agent", ref.id);
  const { created_at: _c, ...snap } = base;
  if (typeof input === "string" || ref.type !== "agent_with_overrides") return { agent: snap, agentId: base.id };

  // overrides replace whole fields for this session; the saved agent is untouched
  const o = input as CmaAgentSpec;
  const echo = (base.compat?.anthropic ?? {}) as Record<string, unknown>;
  const merged: CmaAgentSpec = {
    model: o.model !== undefined ? o.model : (echo.model as CmaAgentSpec["model"]),
    name: base.name,
    description: (echo.description as string | null) ?? null,
    system: o.system !== undefined ? o.system : base.system,
    tools: o.tools !== undefined ? (o.tools ?? []) : (echo.tools as CmaAgentSpec["tools"]),
    mcp_servers: o.mcp_servers !== undefined ? (o.mcp_servers ?? []) : (echo.mcp_servers as CmaAgentSpec["mcp_servers"]),
    skills: o.skills !== undefined ? (o.skills ?? []) : (echo.skills as unknown[]),
    multiagent: echo.multiagent,
    metadata: base.metadata,
  };
  const draft = cmaAgentToRethink(merged, { version: Number((echo as { version?: number }).version ?? 1) });
  return {
    agent: { ...snap, model: draft.model, system: draft.system, tools: draft.tools, packages: draft.packages, mcp_servers: draft.mcp_servers, client_tools: draft.client_tools, compat: { anthropic: draft.echo } },
    agentId: base.id,
  };
}

/** `resources` on session create: memory stores map onto rethink mounts; the other kinds do not. */
function cmaResourceMounts(resources: unknown): unknown[] {
  if (resources === undefined || resources === null) return [];
  if (!Array.isArray(resources)) throw invalid("resources must be an array");
  return resources.map((r: { type?: string; memory_store_id?: string; instructions?: string }) => {
    if (r?.type === "memory_store" && r.memory_store_id) return { memory_store_id: r.memory_store_id };
    if (r?.type === "github_repository") throw invalid("a github_repository resource is an environment workspace in rethink: create the environment with workspace {kind:'git', remote}");
    if (r?.type === "file") throw invalid("a file resource is attached to a message in rethink: send it as a content block {type:'document', source:{type:'file', file_id}}");
    throw invalid(`unsupported resource type ${JSON.stringify(r?.type)}`);
  });
}

/** `initial_events` on session create: user messages only (outcomes are not modelled here). */
function cmaInitialEvents(events: unknown): UserEventInput[] {
  if (!Array.isArray(events)) throw invalid("initial_events must be an array");
  if (events.length > 50) throw invalid("at most 50 initial_events");
  return events.map((e: { type?: string; content?: unknown }) => {
    if (e?.type === "user.message") return { type: "user.message", content: cmaContent(e.content, "user.message") };
    if (e?.type === "user.define_outcome") throw invalid("user.define_outcome is not supported: rethink does not run outcome evaluations");
    throw invalid(`initial_events only accepts user.message (got ${JSON.stringify(e?.type)})`);
  });
}

/**
 * Inbound CMA events -> rethink user events. A custom-tool result and a self-hosted tool result are
 * both "the caller answered a call the agent made", which is one thing in rethink.
 */
export function cmaEventsToUserEvents(events: unknown[], session: SessionResource): UserEventInput[] {
  return events.map((raw) => {
    const e = raw as Record<string, unknown>;
    switch (e?.type) {
      case "user.message":
        return { type: "user.message", content: cmaContent(e.content, "user.message") };
      case "user.interrupt":
        return { type: "user.interrupt" };
      case "user.custom_tool_result":
      case "user.tool_result": {
        const id = (e.custom_tool_use_id ?? e.tool_use_id) as string | undefined;
        if (typeof id !== "string" || !id) throw invalid(`${e.type} requires a tool_use_id`);
        const content = e.content === undefined ? [{ type: "text" as const, text: "" }] : cmaContent(e.content, String(e.type));
        return { type: "tool_result", tool_use_id: id.replace(/^sevt_/, ""), content, is_error: !!e.is_error };
      }
      case "user.tool_confirmation": {
        const id = e.tool_use_id as string | undefined;
        if (typeof id !== "string" || !id) throw invalid("user.tool_confirmation requires a tool_use_id");
        if (e.result !== "allow" && e.result !== "deny") throw invalid("user.tool_confirmation.result must be 'allow' or 'deny'");
        return { type: "user.tool_confirmation", tool_use_id: id.replace(/^sevt_/, ""), result: e.result as "allow" | "deny", ...(e.deny_message ? { deny_message: String(e.deny_message) } : {}) };
      }
      case "user.define_outcome":
        throw invalid("user.define_outcome is not supported: rethink does not run outcome evaluations");
      case "system.message":
        throw invalid("system.message is not supported: change the system prompt with PATCH /v1/sessions/:id");
      default:
        throw invalid(`unsupported event type ${JSON.stringify(e?.type)}`);
    }
  });
}

/** A session (or one of its sub-agent sessions) as a CMA session_thread. */
function toThread(thread: SessionResource, root: SessionResource) {
  return {
    type: "session_thread" as const,
    id: thread.id,
    session_id: root.id,
    parent_thread_id: thread.parent_id,
    agent: { type: "agent" as const, id: thread.agent.id, name: thread.agent.name, system: thread.agent.system, model: { id: `${thread.agent.model.provider}/${thread.agent.model.id}` } },
    status: thread.status,
    stats: { active_seconds: 0, duration_seconds: 0, startup_seconds: 0 },
    usage: null,
    created_at: new Date(thread.created_at as unknown as string).toISOString(),
    updated_at: new Date(thread.updated_at as unknown as string).toISOString(),
    archived_at: null,
  };
}

async function loadThread(c: Context): Promise<SessionResource> {
  const session = await loadSession(c);
  const id = c.req.param("threadId");
  if (id === session.id) return session;
  const child = (await repos.sessions.childrenOf(session.id, scope(c))).find((k) => k.id === id);
  if (!child) throw notFound("session_thread", id);
  return child;
}

async function loadVault(c: Context) {
  const v = await vaults.get(c.req.param("vaultId"), scope(c));
  if (!v) throw notFound("vault", c.req.param("vaultId"));
  return v;
}

async function loadCredential(c: Context) {
  const v = await loadVault(c);
  const id = c.req.param("credentialId");
  const cred = (await vaultCredentials.byId(id, [v.id])) ?? (await vaultCredentials.get(v.id, id));
  if (!cred) throw notFound("vault_credential", id);
  return cred;
}

const toCmaVault = (v: { id: string; name: string | null; metadata: Record<string, string>; created_at: string }) => ({
  type: "vault" as const, id: v.id, display_name: v.name, metadata: v.metadata ?? {},
  created_at: new Date(v.created_at).toISOString(), updated_at: new Date(v.created_at).toISOString(), archived_at: null,
});

function toCmaCredential(cr: { id: string; vault_id: string; name: string; kind: string; mcp_server_url?: string | null; expires_at?: string | null; has_refresh?: boolean; metadata: Record<string, string>; created_at: string }) {
  const auth = cr.kind === "environment_variable"
    ? { type: "environment_variable", secret_name: cr.name, networking: { type: "unrestricted" }, injection_location: { header: true, body: true } }
    : { type: cr.kind, mcp_server_url: cr.mcp_server_url, ...(cr.kind === "mcp_oauth" ? { expires_at: cr.expires_at ?? null, refresh: cr.has_refresh ? {} : null } : {}) };
  return {
    type: "vault_credential" as const, id: cr.id, vault_id: cr.vault_id, display_name: cr.name, auth,
    metadata: cr.metadata ?? {}, created_at: new Date(cr.created_at).toISOString(), updated_at: new Date(cr.created_at).toISOString(), archived_at: null,
  };
}

function toCmaEnvironment(e: { id: string; name: string; provider: string; network: string; created_at: string }, type?: string) {
  const kind = type ?? (e.provider === "byoc" ? "self_hosted" : "cloud");
  const config = kind === "self_hosted"
    ? { type: "self_hosted" }
    : { type: "cloud", networking: e.network === "bridge" ? { type: "unrestricted" } : { type: "limited", allowed_hosts: [], allow_mcp_servers: false, allow_package_managers: false }, packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] } };
  return {
    type: "environment" as const, id: e.id, name: e.name, description: null, config, metadata: {},
    created_at: new Date(e.created_at).toISOString(), updated_at: new Date(e.created_at).toISOString(), archived_at: null,
  };
}

const toCmaMemoryStore = (m: { id: string; name: string; description: string; created_at: string }) => ({
  type: "memory_store" as const, id: m.id, name: m.name, description: m.description, metadata: {},
  created_at: new Date(m.created_at).toISOString(), updated_at: new Date(m.created_at).toISOString(), archived_at: null,
});

/**
 * SSE of CMA session events. The SDK dispatches on the SSE `event:` name, so each frame is named after
 * the event's own type; anything rethink emits that the dialect has no name for is skipped.
 */
function streamCmaEvents(c: Context, session: SessionResource) {
  return streamSSE(c, async (stream) => {
    const calls: CmaCallKinds = new Map();
    let last = 0;
    let done = false;
    let wake = () => {};
    const ended = new Promise<void>((r) => { wake = r; });
    const end = () => { done = true; wake(); };
    let unsub: (() => void | Promise<void>) | null = null;
    const cleanup = () => { const u = unsub; unsub = null; if (u) void u(); };
    stream.onAbort(() => { end(); cleanup(); });

    const send = async (e: SessionEvent) => {
      if (e.seq <= last) return;
      last = e.seq;
      for (const projected of toCmaEvents(e, session, calls)) {
        await stream.writeSSE({ event: String(projected.type), data: JSON.stringify(projected) });
        if (projected.type === "session.status_terminated") end();
      }
    };

    unsub = await subscribe(session.id, (delta) => {
      if (delta.type !== "event" || done) return;
      void send(delta.event).catch(() => end());
    });
    for (const e of await allEvents(session.id)) { if (!done) await send(e); }
    await ended;
    cleanup();
  });
}
