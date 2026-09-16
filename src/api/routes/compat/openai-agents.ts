import { Hono } from "hono";
import { hasMcpCredentials, normalizeMcpUrl, sealMcpServers } from "../../../infra/mcp-credentials.ts";
import path from "node:path";
import type { Context } from "hono";
import { repos, sessionConfig, vaults, vaultCredentials } from "../../../infra/db.ts";
import { lastSeq, listEvents, listEventsForState } from "../../../infra/events.ts";
import { secretsConfigured } from "../../../infra/secrets.ts";
import { listArtifacts, readArtifact, deleteArtifact } from "../../../infra/artifacts.ts";
import type { SessionEvent, SessionResource, UserEventInput, VaultCredentialResource, WorkspaceRef } from "../../../shared/types.ts";
import { invalid, notFound, queryInt, readJson } from "../../errors.ts";
import { scope, ownerId } from "../../auth.ts";
import { sendUserEvents } from "../events.ts";
import { initialRef } from "../sessions.ts";
import { COMPAT_AGENT_NAME, openaiAgentEcho, openaiAgentToRethink, openaiEnvToEnvironmentId, toOpenAiAgent, type OpenAiAgentSpec, type OpenAiEnvSpec } from "./translate.ts";
import { requiredActions, clientToolNames, environmentActions, STATE_EVENT_TYPES } from "./required-actions.ts";
import { credentialInput, validateMcpCredentialIds, validateVaultIds, type CredentialBody } from "../vaults.ts";
import { streamAgentSessionEvents } from "./openai-stream.ts";

/**
 * The OFFICIAL OpenAI Agents API surface (openai-node `client.beta.agents.sessions.*`), mounted at
 * /openai/v1 so the real SDK works with `baseURL: "<host>/openai/v1"`. It matches the SDK's exact
 * paths (`/agents/sessions...`), the AgentSession object shape, and the `agent.session.input.*`
 * event union — as a pure adapter over rethink's native engine (events-as-truth, sandbox leases,
 * principals). The hand-written /agents-api/v1 (showcase shape) is kept alongside, untouched.
 *
 * Covers: sessions (create incl. stream / retrieve / update / list / delete), events (submit + list +
 * SSE stream), items, turns, subagents (+items/turns), and vaults (+credentials). Streaming and the
 * turn projection live in ./openai-stream.ts. Artifacts are the remaining resource.
 */

const nowSec = () => Math.floor(Date.now() / 1000);

const EVENTS_PAGE = 5000;
/** Whole event log, paged (listEvents caps a single read). */
export async function allEvents(sessionId: string): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for (;;) {
    const page = await listEvents(sessionId, out.length ? { since: out[out.length - 1]!.seq, limit: EVENTS_PAGE } : { limit: EVENTS_PAGE });
    out.push(...page);
    if (page.length < EVENTS_PAGE) return out;
  }
}

/** Just the events toAgentSession reads (status, error, environment signals, client tool calls + results). */
export const stateEvents = (session: SessionResource) => listEventsForState(session.id, STATE_EVENT_TYPES, clientToolNames(session));
/** Event types toItems reads (turnIds included). */
export const ITEM_EVENT_TYPES = ["user.message", "agent.message", "agent.tool_use", "agent.tool_result", "session.status_running", "session.status_idle"];
/** Event types toTurns reads. */
export const TURN_EVENT_TYPES = ["session.status_running", "session.status_idle"];

/**
 * The session's current error, if its latest run failed: a session.error not superseded by a later
 * run start. run_lost is claimRun's recoverable takeover notice (the run resumes right after it).
 */
function currentError(events: SessionEvent[]): string | null {
  let error: string | null = null;
  for (const e of events) {
    const p = e.payload;
    if (p.type === "session.status_running") error = null;
    else if (p.type === "session.error" && p.error?.type !== "run_lost") error = p.error?.message || "session failed";
  }
  return error;
}

/**
 * One page of a projected list, in the SDK's CursorPage shape: `after` is the id of the last item of
 * the previous page and `order` flips the direction (the projections are built oldest-first).
 */
export function cursorPage<T extends Record<string, unknown>>(items: T[], q: { after?: string; limit?: number; order?: string }) {
  const ordered = q.order === "desc" ? [...items].reverse() : items;
  const start = q.after ? ordered.findIndex((i) => i.id === q.after) + 1 : 0;
  const limit = q.limit ?? 100;
  const page = ordered.slice(start, start + limit);
  return { object: "list" as const, data: page, has_more: start + limit < ordered.length };
}
const pageQuery = (c: Context) => ({ after: c.req.query("after") || undefined, limit: c.req.query("limit") ? queryInt(c, "limit", 100, 1) : undefined, order: c.req.query("order") });

/** Build the SDK's AgentSession object from a rethink session + its event log. */
export function toAgentSession(session: SessionResource, events: SessionEvent[], environmentId: string) {
  const error = currentError(events);
  const actions = [...requiredActions(events, clientToolNames(session)), ...environmentActions(events)];
  const status: "idle" | "in_progress" | "requires_action" | "failed" =
    error ? "failed" : actions.length ? "requires_action" : session.status === "running" ? "in_progress" : "idle";
  const created = Math.floor(new Date(session.created_at as unknown as string).getTime() / 1000) || nowSec();
  return {
    id: session.id,
    object: "agent.session" as const,
    status,
    error,
    created_at: created,
    last_active_at: created,
    environment: { type: "reference" as const, environment_id: environmentId },
    required_actions: actions,
    metadata: session.metadata ?? {},
    usage: session.usage?.requests ? {
      input_tokens: session.usage.input,
      input_tokens_details: { cached_tokens: session.usage.cache_read },
      output_tokens: session.usage.output,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: session.usage.total_tokens,
    } : null,
    vault_ids: session.vault_ids ?? [],
    agent: (() => {
      const echo = (session.agent.compat?.openai ?? {}) as Partial<ReturnType<typeof openaiAgentEcho>>;
      return {
        id: session.agent.id,
        model: `${session.agent.model.provider}/${session.agent.model.id}`,
        instructions: session.agent.system ?? null,
        name: session.agent.name === COMPAT_AGENT_NAME ? null : session.agent.name ?? null,
        multi_agent: echo.multi_agent ?? { enabled: false, max_concurrent_subagents: null },
        reasoning: echo.reasoning ?? { effort: null, summary: null },
        service_tier: echo.service_tier ?? "auto",
        text: echo.text ?? { format: { type: "text" }, verbosity: "medium" },
        tools: echo.tools ?? [],
      };
    })(),
  };
}

import { clientToolSet, itemKindOf, textOf, toolUseItem } from "./items.ts";

/**
 * The turn id of each event: a turn spans session.status_running -> status_idle and is named after the
 * running event. A user message sent while no turn is open precedes the running event it triggers
 * (the engine appends it first), so it belongs to that next turn; one steered into an open turn stays there.
 */
function turnIds(events: SessionEvent[]): string[] {
  const next: string[] = new Array(events.length);
  let upcoming = "";
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.payload.type === "session.status_running") upcoming = `turn_${events[i]!.seq}`;
    next[i] = upcoming;
  }
  let cur = ""; let open = false;
  return events.map((e, i) => {
    const t = e.payload.type;
    if (t === "session.status_running") { cur = `turn_${e.seq}`; open = true; return cur; }
    const id = t === "user.message" && !open ? next[i] || cur || `turn_${e.seq}` : cur || `turn_${e.seq}`;
    if (t === "session.status_idle") open = false;
    return id;
  });
}

/** Project the event log into the SDK's AgentSessionItem list (messages, function calls + outputs). */
export function toItems(session: SessionResource, events: SessionEvent[]) {
  const ids = turnIds(events);
  const items: Record<string, unknown>[] = [];
  // a tool call and its result are one item in this dialect (mcp_call / command_execution), so pair them up first
  const results = new Map<string, { content: { type: string; text?: string }[]; is_error?: boolean }>();
  const selfContained = new Set<string>();
  const clientTools = clientToolSet(session);
  const kinds = new Map<string, ReturnType<typeof itemKindOf>>();
  for (const e of events) {
    const p = e.payload;
    if (p.type === "agent.tool_result") results.set(p.tool_use_id, p as never);
    else if (p.type === "agent.tool_use") {
      const kind = itemKindOf(p.name, clientTools);
      kinds.set(p.tool_use_id, kind);
      if (kind !== "function_call") selfContained.add(p.tool_use_id);
    }
  }
  for (const [i, e] of events.entries()) {
    const p = e.payload;
    const turn_id = ids[i]!;
    if (p.type === "user.message") items.push({ id: `item_${e.seq}`, type: "message", role: "user", content: [{ type: "input_text", text: textOf(p.content) }], phase: null, status: "completed", turn_id });
    else if (p.type === "agent.message") items.push({ id: `item_${e.seq}`, type: "message", role: "assistant", content: [{ type: "output_text", text: textOf(p.content) }], phase: "final_answer", status: "completed", turn_id });
    else if (p.type === "agent.tool_use") {
      const kind = kinds.get(p.tool_use_id)!;
      // a sandbox file tool has no item type in this dialect: it is left out rather than mislabelled
      if (kind !== "none") items.push({ id: `item_${e.seq}`, ...toolUseItem(p, kind, results.get(p.tool_use_id)), turn_id });
    } else if (p.type === "agent.tool_result") {
      // an MCP or command call carries its own result; only a call the caller answers gets an output item
      if (!selfContained.has(p.tool_use_id)) items.push({ id: `item_${e.seq}`, type: "function_call_output", call_id: p.tool_use_id, output: textOf(p.content), error: p.is_error ? textOf(p.content) : null, status: "completed", turn_id });
    }
  }
  return items;
}

/** Project the event log into Turn objects (one per session.status_running, closed by status_idle). */
export function toTurns(session: SessionResource, events: SessionEvent[]) {
  const turns: Record<string, unknown>[] = [];
  let cur: Record<string, unknown> | null = null;
  for (const e of events) {
    const p = e.payload;
    const sec = Math.floor(new Date((e.created_at as unknown as string) ?? Date.now()).getTime() / 1000) || nowSec();
    if (p.type === "session.status_running") {
      // a second run start while a turn is open: the previous run was lost (run_lost takeover); close it
      if (cur) { cur.status = "failed"; cur.completed_at = sec; }
      cur = { id: `turn_${e.seq}`, object: "agent.session.turn", agent_id: session.agent.id, session_id: session.id, subagent_id: null, status: "in_progress", created_at: sec, started_at: sec, completed_at: null, error: null, usage: null };
      turns.push(cur);
    } else if (p.type === "session.status_idle" && cur) {
      cur.status = p.stop_reason === "error" ? "failed" : p.stop_reason === "interrupted" ? "cancelled" : "completed";
      cur.completed_at = sec;
      cur = null;
    }
  }
  return turns;
}

// Artifact id <-> workspace-relative path (base64url, so any path round-trips through the URL).
const artifactId = (p: string) => `art_${Buffer.from(p, "utf8").toString("base64url")}`;
/** The workspace-relative path an artifact id names; an absolute or '..' path reads as a missing artifact (404). */
const artifactPath = (id: string) => {
  const p = Buffer.from(id.replace(/^art_/, ""), "base64url").toString("utf8");
  return path.isAbsolute(p) || p.split(/[\\/]/).includes("..") ? null : p;
};
const EXT_TYPES: Record<string, string> = { ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".js": "text/javascript", ".ts": "text/plain", ".html": "text/html", ".csv": "text/csv", ".png": "image/png", ".jpg": "image/jpeg", ".pdf": "application/pdf" };
const contentType = (p: string) => EXT_TYPES[p.slice(p.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream";
function toArtifact(session: SessionResource, e: { path: string; size: number; mtimeSec: number }) {
  return { id: artifactId(e.path), object: "agent.session.artifact" as const, path: e.path, size_bytes: e.size, session_id: session.id, turn_id: null, environment_id: session.environment_id, created_at: e.mtimeSec };
}

/** Project a child (sub-agent) session into the SDK's Subagent object. */
export function toSubagent(child: SessionResource) {
  const opened = Math.floor(new Date(child.created_at as unknown as string).getTime() / 1000) || nowSec();
  const closed = child.status === "terminated" ? Math.floor(new Date(child.updated_at as unknown as string).getTime() / 1000) || opened : null;
  return {
    id: child.id,
    object: "agent.session.subagent" as const,
    name: child.agent.name ?? null,
    instructions: child.agent.system ? [{ type: "output_text", text: child.agent.system }] : null,
    // the SDK's union is active | closed: an idle child is still open, only a terminated one is closed
    status: child.status === "terminated" ? "closed" : "active",
    session_id: child.parent_id ?? child.id,
    parent_agent_id: child.agent.id,
    opened_at: opened,
    closed_at: closed,
  };
}

/** A tool output as text: a string as-is, the SDK's content-part array joined, anything else as JSON. */
function toolOutputText(output: unknown): string {
  if (output === undefined || output === null) return "";
  if (typeof output === "string") return output;
  if (Array.isArray(output) && output.every((b) => b && typeof b === "object")) return output.map((b) => (typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "")).join("");
  return JSON.stringify(output);
}

/** Map the SDK's `agent.session.input.*` events onto rethink user events. */
function inputEventsToUserEvents(events: unknown[]): UserEventInput[] {
  const out: UserEventInput[] = [];
  for (const ev of events) {
    const e = ev as { type?: string; input?: unknown; call_id?: string; output?: unknown; success?: boolean; error?: unknown };
    if (e.type === "agent.session.input.message") {
      // input: [{ role:'user', content:[{type:'input_text', text} | {type:'input_image', ...}] }]
      if (!Array.isArray(e.input) || e.input.length === 0) throw invalid("agent.session.input.message requires a non-empty input array");
      for (const m of e.input as { content?: unknown }[]) {
        const text = (Array.isArray(m?.content) ? m.content : [])
          .map((b) => (b as { type?: string; text?: string }))
          .filter((b) => b?.type === "input_text" && typeof b.text === "string")
          .map((b) => b.text!)
          .join("");
        // dropping it would return 200 while no turn ever starts (the SDK then waits forever)
        if (!text) throw invalid("each input message needs input_text content (input_image is not supported yet)");
        out.push({ type: "user.message", content: [{ type: "text", text }] });
      }
    } else if (e.type === "agent.session.input.tool_result") {
      if (typeof e.call_id !== "string") throw invalid("agent.session.input.tool_result requires call_id");
      let text = toolOutputText(e.output);
      if (e.success === false && typeof e.error === "string" && e.error) text = text ? `${e.error}\n${text}` : e.error;
      out.push({ type: "tool_result", tool_use_id: e.call_id, content: [{ type: "text", text: text || "{}" }], is_error: e.success === false });
    } else if (e.type === "agent.session.input.cancel") {
      out.push({ type: "user.interrupt" });
    } else {
      throw invalid(`unsupported input event type ${JSON.stringify(e.type)}`);
    }
  }
  return out;
}

/** `input` on create is `string | AgentSessionInputMessageParam[]`. */
function createInputToUserEvents(input: unknown): UserEventInput[] {
  if (input === undefined || input === null) return [];
  if (typeof input === "string") return input ? [{ type: "user.message", content: [{ type: "text", text: input }] }] : [];
  if (Array.isArray(input)) {
    // wrap each message as an input.message event so we reuse one mapper
    return inputEventsToUserEvents(input.map((m) => ({ type: "agent.session.input.message", input: [m] })));
  }
  throw invalid("input must be a string or an array of input messages");
}

/** A stored credential as the SDK's Credential object: `auth` says what it is, never what it holds. */
function toOpenAiCredential(cr: VaultCredentialResource) {
  const auth = cr.kind === "environment_variable"
    ? { type: "environment_variable", secret_name: cr.name }
    : { type: cr.kind, mcp_server_url: cr.mcp_server_url, ...(cr.kind === "mcp_oauth" ? { expires_at: cr.expires_at ?? null, refresh: cr.has_refresh ? {} : null } : {}) };
  return { id: cr.id, object: "vault.credential" as const, vault_id: cr.vault_id, name: cr.name, auth, created_at: cr.created_at, updated_at: cr.created_at };
}

/** The credential named in the path, within a vault the caller owns. */
async function loadCredential(c: Context): Promise<VaultCredentialResource> {
  const v = await vaults.get(c.req.param("vaultId"), scope(c));
  if (!v) throw notFound("vault", c.req.param("vaultId"));
  const id = c.req.param("credentialId");
  const cred = (await vaultCredentials.byId(id, [v.id])) ?? (await vaultCredentials.get(v.id, id));
  if (!cred) throw notFound("credential", id);
  return cred;
}

/** The named child of the session in the path, or 404. */
async function loadSubagent(c: Context): Promise<SessionResource> {
  const session = await loadSession(c);
  const child = (await repos.sessions.childrenOf(session.id, scope(c))).find((k) => k.id === c.req.param("subId"));
  if (!child) throw notFound("subagent", c.req.param("subId"));
  return child;
}

async function loadSession(c: Context): Promise<SessionResource> {
  const s = await repos.sessions.get(c.req.param("id"), scope(c));
  if (!s) throw notFound("session", c.req.param("id"));
  return s;
}

/** Caller labels: a string map, as both dialects define it (values are never interpreted). */
export function validateMetadata(v: unknown, { patch = false } = {}): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw invalid("metadata must be an object of string values");
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === null && patch) { out[k] = null as unknown as string; continue; } // patch: null deletes the key
    if (typeof val !== "string") throw invalid(`metadata.${k} must be a string`);
    out[k] = val;
  }
  if (Object.keys(out).length > 16) throw invalid("at most 16 metadata keys");
  return out;
}

/**
 * Build a stored agent row from an SDK agent spec. `mcp_servers` on a reusable agent must stay
 * credential-free (the SDK's PersistedMcpTransport has no `authorization`), so inline credentials are
 * refused here and a session supplies them from its vaults instead.
 */
async function agentRowFromSpec(spec: OpenAiAgentSpec, owner: string, persisted: boolean) {
  const draft = openaiAgentToRethink(spec);
  if (persisted && hasMcpCredentials(draft.mcp_servers)) {
    throw invalid("a saved agent stores no credentials: drop transport.authorization/headers and attach a vault credential to the session (credential_id, or matched by server URL)");
  }
  return {
    owner_id: owner,
    name: draft.name,
    model: draft.model,
    system: draft.system,
    tools: draft.tools,
    packages: draft.packages,
    skills: [],
    mcp_servers: draft.mcp_servers,
    metadata: validateMetadata(spec.metadata),
    client_tools: draft.client_tools,
    compat: { openai: openaiAgentEcho(spec) },
  };
}

export const openaiAgents = new Hono()
  .post("/agents/sessions", async (c) => {
    const body = await readJson<{ agent?: OpenAiAgentSpec; agent_id?: string; environment?: OpenAiEnvSpec; input?: unknown; metadata?: unknown; vault_ids?: unknown; stream?: boolean }>(c);
    const owner = ownerId(c);
    // Either a saved agent (optionally overridden field by field) or a complete inline definition.
    const saved = body.agent_id ? await repos.agents.get(body.agent_id, scope(c)) : null;
    if (body.agent_id && !saved) throw notFound("agent", body.agent_id);
    if (!saved && !body.agent) throw invalid("agent (with a model) or agent_id is required");
    const agentSpec: OpenAiAgentSpec = saved
      ? { ...(saved.compat?.openai as object ?? {}), model: `${saved.model.provider}/${saved.model.id}`, instructions: saved.system ?? undefined, name: saved.name, ...(body.agent ?? {}) } as OpenAiAgentSpec
      : body.agent!;
    const draft = openaiAgentToRethink(agentSpec);
    const environmentId = openaiEnvToEnvironmentId(body.environment);
    // validate everything before any row is written
    const inputs = createInputToUserEvents(body.input);
    if (body.stream && inputs.length === 0) throw invalid("stream:true needs input (the stream follows the turn it triggers)");
    const environment = await repos.environments.get(environmentId, scope(c));
    if (!environment) throw notFound("environment", environmentId);
    const vaultIds = await validateVaultIds(body.vault_ids, scope(c));
    // MCP credentials are sealed before anything is stored (they would otherwise live in plaintext in the snapshot)
    if (hasMcpCredentials(draft.mcp_servers) && !secretsConfigured()) throw invalid("MCP server credentials need PMA_SECRET_KEY to be stored encrypted; set it on the api and runner");
    await validateMcpCredentialIds(draft.mcp_servers, vaultIds);
    const mcpServers = sealMcpServers(draft.mcp_servers);
    const wsSpec = environment.workspace;
    const workspace = await repos.workspaces.create(wsSpec, initialRef(wsSpec) as WorkspaceRef, owner);
    const agentRow = saved ?? await repos.agents.create({ owner_id: owner, name: draft.name, model: draft.model, system: draft.system, tools: draft.tools, packages: draft.packages, skills: [], compat: { openai: openaiAgentEcho(agentSpec) } });
    // the snapshot is what this session runs with: the saved agent as overridden here, never the saved row alone
    const { created_at: _c, ...snapshot } = {
      ...agentRow, name: draft.name, model: draft.model, system: draft.system, tools: draft.tools, packages: draft.packages,
      client_tools: draft.client_tools, mcp_servers: mcpServers, compat: { openai: openaiAgentEcho(agentSpec) },
    };
    const session = await repos.sessions.create({ owner_id: owner, agent_id: agentRow.id, environment_id: environmentId, workspace_id: workspace.id, agent: snapshot, vault_ids: vaultIds, metadata: validateMetadata(body.metadata) });
    const appended = inputs.length ? await sendUserEvents(session, inputs) : [];
    // stream:true -> SSE of AgentSessionEvents for the turn the input just triggered. Start at the
    // input's seq (the fresh session's first user.message) so the run's events that follow are all captured.
    if (body.stream) {
      const inputSeq = appended.find((e) => e.payload.type === "user.message")?.seq ?? 0;
      return streamAgentSessionEvents(c, session, Math.max(0, inputSeq));
    }
    return c.json(toAgentSession(session, await stateEvents(session), environmentId), 201);
  })
  .get("/agents/sessions", async (c) => {
    const limit = c.req.query("limit") ? queryInt(c, "limit", 20, 1) : undefined;
    // the SDK's CursorPage sends after=<last id of the previous page>
    const after = c.req.query("after") || undefined;
    const page = await repos.sessions.listPage(scope(c), { limit, after, agentId: c.req.query("agent_id") || undefined, order: c.req.query("order") === "asc" ? "asc" : "desc" });
    // List is a light projection: status from the row, required_actions resolved on retrieve.
    const data = page.data.map((s) => toAgentSession(s, [], s.environment_id));
    return c.json({ object: "list", data, has_more: page.has_more, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null });
  })
  .get("/agents/sessions/:id", async (c) => {
    const session = await loadSession(c);
    return c.json(toAgentSession(session, await stateEvents(session), session.environment_id));
  })
  /** Update session metadata (a patch: a string upserts its key, null deletes it). */
  .post("/agents/sessions/:id", async (c) => {
    const session = await loadSession(c);
    const body = await readJson<{ metadata?: unknown }>(c).catch(() => ({ metadata: undefined }));
    if (body.metadata !== undefined) {
      const metadata = await sessionConfig.patchMetadata(session.id, validateMetadata(body.metadata, { patch: true }), scope(c));
      if (metadata) session.metadata = metadata;
    }
    return c.json(toAgentSession(session, await stateEvents(session), session.environment_id));
  })
  .delete("/agents/sessions/:id", async (c) => {
    const session = await loadSession(c);
    await repos.sessions.delete(session.id);
    return c.json({ id: session.id, object: "agent.session.deleted", deleted: true });
  })
  /** Submit input events: messages, tool results, or a cancel. */
  .post("/agents/sessions/:id/events", async (c) => {
    const session = await loadSession(c);
    const body = await readJson<{ events?: unknown }>(c);
    if (!Array.isArray(body.events) || body.events.length === 0) throw invalid("events must be a non-empty array");
    const inputs = inputEventsToUserEvents(body.events);
    if (inputs.length) await sendUserEvents(session, inputs);
    return c.json(toAgentSession(await loadSession(c), await stateEvents(session), session.environment_id));
  })
  /** List the session's persisted events, or stream them (getEvents / events.stream). */
  .get("/agents/sessions/:id/events", async (c) => {
    const session = await loadSession(c);
    // The SDK's sessions.stream() subscribes here with Accept: text/event-stream, then submits input.
    if ((c.req.header("accept") ?? "").includes("text/event-stream")) {
      const since = await lastSeq(session.id); // tail: the fresh turn only
      return streamAgentSessionEvents(c, session, since);
    }
    const events = await allEvents(session.id);
    const data = events.map((e) => ({ object: "agent.session.event", event_id: `evt_${e.seq}`, session_id: session.id, seq: e.seq, type: e.type, payload: e.payload }));
    return c.json({ object: "list", data, has_more: false });
  })
  /** List the session's items (messages, function calls + outputs), projected from the log. */
  .get("/agents/sessions/:id/items", async (c) => {
    const session = await loadSession(c);
    return c.json(cursorPage(toItems(session, await listEventsForState(session.id, ITEM_EVENT_TYPES)), pageQuery(c)));
  })
  /** List the session's turns. */
  .get("/agents/sessions/:id/turns", async (c) => {
    const session = await loadSession(c);
    return c.json(cursorPage(toTurns(session, await listEventsForState(session.id, TURN_EVENT_TYPES)), pageQuery(c)));
  })
  /** Retrieve one turn. */
  .get("/agents/sessions/:id/turns/:turnId", async (c) => {
    const session = await loadSession(c);
    const turn = toTurns(session, await listEventsForState(session.id, TURN_EVENT_TYPES)).find((t) => t.id === c.req.param("turnId"));
    if (!turn) throw notFound("turn", c.req.param("turnId"));
    return c.json(turn);
  })
  // ---- Artifacts (client.beta.agents.sessions.artifacts.*) — files in the captured workspace ----
  .get("/agents/sessions/:id/artifacts", async (c) => {
    const session = await loadSession(c);
    const ws = await repos.workspaces.get(session.workspace_id, scope(c));
    const entries = await listArtifacts(ws?.ref);
    return c.json(cursorPage(entries.map((e) => toArtifact(session, e)), pageQuery(c)));
  })
  .get("/agents/sessions/:id/artifacts/:artifactId/content", async (c) => {
    const session = await loadSession(c);
    const ws = await repos.workspaces.get(session.workspace_id, scope(c));
    const p = artifactPath(c.req.param("artifactId"));
    if (p === null) throw notFound("artifact", c.req.param("artifactId"));
    const f = await readArtifact(ws?.ref, p);
    if (!f) throw notFound("artifact", c.req.param("artifactId"));
    // Return a fresh ArrayBuffer slice so the framework sets an accurate content-length.
    const buf = f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength);
    // agent-written bytes on the API/UI origin: download (never render) and forbid script execution
    return c.body(buf as ArrayBuffer, 200, { "content-type": contentType(p), "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(p))}`, "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'" });
  })
  .get("/agents/sessions/:id/artifacts/:artifactId", async (c) => {
    const session = await loadSession(c);
    const ws = await repos.workspaces.get(session.workspace_id, scope(c));
    const p = artifactPath(c.req.param("artifactId"));
    if (p === null) throw notFound("artifact", c.req.param("artifactId"));
    const f = await readArtifact(ws?.ref, p);
    if (!f) throw notFound("artifact", c.req.param("artifactId"));
    return c.json(toArtifact(session, { path: p, size: f.size, mtimeSec: f.mtimeSec }));
  })
  .delete("/agents/sessions/:id/artifacts/:artifactId", async (c) => {
    const session = await loadSession(c);
    const ws = await repos.workspaces.get(session.workspace_id, scope(c));
    const p = artifactPath(c.req.param("artifactId"));
    if (p === null) throw notFound("artifact", c.req.param("artifactId"));
    if (!(await deleteArtifact(ws?.ref, p))) throw notFound("artifact", c.req.param("artifactId"));
    return c.json({ id: c.req.param("artifactId"), object: "agent.session.artifact.deleted", deleted: true });
  })
  // ---- Subagents (client.beta.agents.sessions.subagents.*) ----
  .get("/agents/sessions/:id/subagents", async (c) => {
    const session = await loadSession(c);
    const kids = await repos.sessions.childrenOf(session.id, scope(c));
    return c.json(cursorPage(kids.map(toSubagent), pageQuery(c)));
  })
  .get("/agents/sessions/:id/subagents/:subId", async (c) => {
    const session = await loadSession(c);
    const child = (await repos.sessions.childrenOf(session.id, scope(c))).find((k) => k.id === c.req.param("subId"));
    if (!child) throw notFound("subagent", c.req.param("subId"));
    return c.json(toSubagent(child));
  })
  .get("/agents/sessions/:id/subagents/:subId/items", async (c) => {
    const session = await loadSession(c);
    const child = (await repos.sessions.childrenOf(session.id, scope(c))).find((k) => k.id === c.req.param("subId"));
    if (!child) throw notFound("subagent", c.req.param("subId"));
    return c.json(cursorPage(toItems(child, await listEventsForState(child.id, ITEM_EVENT_TYPES)), pageQuery(c)));
  })
  .get("/agents/sessions/:id/subagents/:subId/turns", async (c) => {
    const session = await loadSession(c);
    const child = (await repos.sessions.childrenOf(session.id, scope(c))).find((k) => k.id === c.req.param("subId"));
    if (!child) throw notFound("subagent", c.req.param("subId"));
    return c.json(cursorPage(toTurns(child, await listEventsForState(child.id, TURN_EVENT_TYPES)), pageQuery(c)));
  })
  /** One turn of a subagent, and the items inside it. */
  .get("/agents/sessions/:id/subagents/:subId/turns/:turnId", async (c) => {
    const child = await loadSubagent(c);
    const turn = toTurns(child, await listEventsForState(child.id, TURN_EVENT_TYPES)).find((t) => t.id === c.req.param("turnId"));
    if (!turn) throw notFound("turn", c.req.param("turnId"));
    return c.json(turn);
  })
  .get("/agents/sessions/:id/subagents/:subId/turns/:turnId/items", async (c) => {
    const child = await loadSubagent(c);
    const items = toItems(child, await listEventsForState(child.id, ITEM_EVENT_TYPES)).filter((i) => i.turn_id === c.req.param("turnId"));
    return c.json(cursorPage(items, pageQuery(c)));
  })
  // ---- Environments (client.beta.agents.environments.retrieve) ----
  .get("/agents/environments/:envId", async (c) => {
    const e = await repos.environments.get(c.req.param("envId"), scope(c));
    if (!e) throw notFound("environment", c.req.param("envId"));
    // a rethink environment is a sandbox provider + a workspace; there is no hosted template behind it
    return c.json({
      id: e.id, object: "agent.environment", type: e.provider === "byoc" ? "self_hosted" : "openai_hosted",
      status: "connected", files: [], plugins: [], skills: [],
    });
  })
  // ---- Reusable agents (client.beta.agents.*) ----
  .post("/agents", async (c) => {
    const spec = await readJson<OpenAiAgentSpec>(c);
    const row = await repos.agents.create(await agentRowFromSpec(spec, ownerId(c), true));
    return c.json(toOpenAiAgent(row), 201);
  })
  .get("/agents", async (c) => {
    const limit = c.req.query("limit") ? queryInt(c, "limit", 20, 1) : 20;
    const after = c.req.query("after") || undefined;
    const all = await repos.agents.list(scope(c));
    const ordered = c.req.query("order") === "asc" ? all : [...all].reverse();
    const start = after ? ordered.findIndex((a) => a.id === after) + 1 : 0;
    const page = ordered.slice(start, start + limit);
    return c.json({ object: "list", data: page.map(toOpenAiAgent), has_more: start + limit < ordered.length });
  })
  .get("/agents/:agentId", async (c) => {
    const row = await repos.agents.get(c.req.param("agentId"), scope(c));
    if (!row) throw notFound("agent", c.req.param("agentId"));
    return c.json(toOpenAiAgent(row));
  })
  /** Update is POST in this dialect. Provided fields replace; omitted ones are kept. */
  .post("/agents/:agentId", async (c) => {
    const id = c.req.param("agentId");
    const current = await repos.agents.get(id, scope(c));
    if (!current) throw notFound("agent", id);
    const body = await readJson<Partial<OpenAiAgentSpec>>(c);
    const echo = (current.compat?.openai ?? {}) as Partial<ReturnType<typeof openaiAgentEcho>>;
    // merge onto the stored spec so an omitted field keeps its value, then re-translate the whole thing
    const merged: OpenAiAgentSpec = {
      model: body.model ?? `${current.model.provider}/${current.model.id}`,
      name: body.name !== undefined ? body.name : (current.name === COMPAT_AGENT_NAME ? null : current.name),
      instructions: body.instructions !== undefined ? (body.instructions ?? undefined) : (current.system ?? undefined),
      tools: body.tools !== undefined ? body.tools : echo.tools,
      reasoning: body.reasoning !== undefined ? body.reasoning : (echo.reasoning as OpenAiAgentSpec["reasoning"]),
      service_tier: body.service_tier !== undefined ? body.service_tier : echo.service_tier,
      text: body.text !== undefined ? body.text : (echo.text as Record<string, unknown>),
      multi_agent: body.multi_agent !== undefined ? body.multi_agent : echo.multi_agent,
      metadata: body.metadata !== undefined ? body.metadata : current.metadata,
    };
    const next = await agentRowFromSpec(merged, current.owner_id, true);
    const { owner_id: _o, ...patch } = next;
    const row = await repos.agents.update(id, { ...patch, system: merged.instructions ?? null }, scope(c));
    if (!row) throw notFound("agent", id);
    return c.json(toOpenAiAgent(row));
  })
  .delete("/agents/:agentId", async (c) => {
    const r = await repos.agents.delete(c.req.param("agentId"), scope(c));
    if (!r) throw notFound("agent", c.req.param("agentId"));
    return c.json({ id: c.req.param("agentId"), object: "agent.deleted", deleted: true });
  })
  // ---- Vaults (client.beta.agents.vaults.*) ----
  .post("/vaults", async (c) => {
    const body = await readJson<{ name?: string; metadata?: Record<string, string> }>(c);
    const v = await vaults.create({ owner_id: ownerId(c), name: body.name ?? null, metadata: body.metadata });
    return c.json({ ...v, object: "vault" }, 201);
  })
  .get("/vaults", async (c) => c.json({ object: "list", data: (await vaults.list(scope(c))).map((v) => ({ ...v, object: "vault" })), has_more: false }))
  .get("/vaults/:vaultId", async (c) => {
    const v = await vaults.get(c.req.param("vaultId"), scope(c));
    if (!v) throw notFound("vault", c.req.param("vaultId"));
    return c.json({ ...v, object: "vault" });
  })
  .delete("/vaults/:vaultId", async (c) => {
    if (!(await vaults.delete(c.req.param("vaultId"), scope(c)))) throw notFound("vault", c.req.param("vaultId"));
    return c.json({ id: c.req.param("vaultId"), object: "vault.deleted", deleted: true });
  })
  /**
   * Store a credential. The SDK sends a typed `auth` union (mcp_oauth | static_bearer), both keyed by
   * `mcp_server_url`: the runner matches that URL against the MCP servers a session declares.
   */
  .post("/vaults/:vaultId/credentials", async (c) => {
    if (!secretsConfigured()) throw invalid("PMA_SECRET_KEY is not set: cannot store vault secrets");
    const v = await vaults.get(c.req.param("vaultId"), scope(c));
    if (!v) throw notFound("vault", c.req.param("vaultId"));
    const cred = await vaultCredentials.put(v.id, credentialInput(await readJson<CredentialBody>(c)));
    return c.json(toOpenAiCredential(cred), 201);
  })
  .get("/vaults/:vaultId/credentials", async (c) => {
    const v = await vaults.get(c.req.param("vaultId"), scope(c));
    if (!v) throw notFound("vault", c.req.param("vaultId"));
    return c.json(cursorPage((await vaultCredentials.list(v.id)).map(toOpenAiCredential), pageQuery(c)));
  })
  .get("/vaults/:vaultId/credentials/:credentialId", async (c) => {
    const cred = await loadCredential(c);
    return c.json(toOpenAiCredential(cred));
  })
  /** Rotate the secret of a credential in place (its server URL and kind are fixed at creation). */
  .post("/vaults/:vaultId/credentials/:credentialId", async (c) => {
    if (!secretsConfigured()) throw invalid("PMA_SECRET_KEY is not set: cannot store vault secrets");
    const cred = await loadCredential(c);
    const body = await readJson<CredentialBody>(c);
    const auth = body.auth ?? {};
    const value = auth.token ?? auth.access_token ?? auth.secret_value ?? body.value;
    if (typeof value !== "string" || !value) throw invalid("a new secret is required (auth.token, auth.access_token, auth.secret_value, or value)");
    if (auth.type && auth.type !== cred.kind) throw invalid(`this credential is a ${cred.kind}; its type cannot change (archive it and create a new one)`);
    if (auth.mcp_server_url && normalizeMcpUrl(auth.mcp_server_url) !== normalizeMcpUrl(cred.mcp_server_url ?? "")) throw invalid("mcp_server_url is fixed at creation; create a new credential instead");
    const updated = await vaultCredentials.put(cred.vault_id, {
      name: cred.name, value, kind: cred.kind, mcp_server_url: cred.mcp_server_url ?? null,
      refresh: auth.refresh ?? null, expires_at: auth.expires_at ?? null, metadata: body.metadata,
    });
    return c.json(toOpenAiCredential(updated));
  })
  /** The SDK addresses a credential by id; a name is accepted too, since that is this store's key. */
  .delete("/vaults/:vaultId/credentials/:credentialId", async (c) => {
    const v = await vaults.get(c.req.param("vaultId"), scope(c));
    if (!v) throw notFound("vault", c.req.param("vaultId"));
    if (!(await vaultCredentials.delete(v.id, c.req.param("credentialId")))) throw notFound("credential", c.req.param("credentialId"));
    return c.json({ id: c.req.param("credentialId"), object: "vault.credential.deleted", deleted: true });
  });
