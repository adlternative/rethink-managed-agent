import { Hono } from "hono";
import path from "node:path";
import type { Context } from "hono";
import { repos, vaults, vaultCredentials } from "../../../infra/db.ts";
import { lastSeq, listEvents, listEventsForState } from "../../../infra/events.ts";
import { secretsConfigured } from "../../../infra/secrets.ts";
import { listArtifacts, readArtifact, deleteArtifact } from "../../../infra/artifacts.ts";
import type { SessionEvent, SessionResource, UserEventInput, WorkspaceRef } from "../../../shared/types.ts";
import { invalid, notFound, queryInt, readJson } from "../../errors.ts";
import { scope, ownerId } from "../../auth.ts";
import { sendUserEvents } from "../events.ts";
import { initialRef } from "../sessions.ts";
import { openaiAgentToRethink, openaiEnvToEnvironmentId, type OpenAiAgentSpec, type OpenAiEnvSpec } from "./translate.ts";
import { requiredActions, clientToolNames, environmentActions, STATE_EVENT_TYPES } from "./required-actions.ts";
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
    metadata: {},
    usage: null,
    vault_ids: session.vault_ids ?? [],
    agent: {
      id: session.agent.id,
      model: `${session.agent.model.provider}/${session.agent.model.id}`,
      instructions: session.agent.system ?? null,
      name: session.agent.name ?? null,
      multi_agent: { max_concurrent_subagents: 0 },
      reasoning: {},
      service_tier: "auto" as const,
      text: {},
      tools: [] as unknown[],
    },
  };
}

const textOf = (content: { type: string; text?: string }[]) => content.map((b) => (b.type === "text" ? b.text ?? "" : "")).join("");

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
  for (const [i, e] of events.entries()) {
    const p = e.payload;
    const turn_id = ids[i]!;
    if (p.type === "user.message") items.push({ id: `item_${e.seq}`, type: "message", role: "user", content: [{ type: "input_text", text: textOf(p.content) }], phase: null, status: "completed", turn_id });
    else if (p.type === "agent.message") items.push({ id: `item_${e.seq}`, type: "message", role: "assistant", content: [{ type: "output_text", text: textOf(p.content) }], phase: "final_answer", status: "completed", turn_id });
    else if (p.type === "agent.tool_use") items.push({ id: `item_${e.seq}`, type: "function_call", call_id: p.tool_use_id, name: p.name, arguments: p.input, status: "completed", turn_id });
    else if (p.type === "agent.tool_result") items.push({ id: `item_${e.seq}`, type: "function_call_output", call_id: p.tool_use_id, output: textOf(p.content), error: p.is_error ? textOf(p.content) : null, status: "completed", turn_id });
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
      cur = { id: `turn_${e.seq}`, object: "agent.session.turn", agent_id: session.agent.id, session_id: session.id, subagent_id: null, status: "in_progress", created_at: sec, started_at: sec, completed_at: null, error: null };
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
  return { id: artifactId(e.path), object: "agent.session.artifact" as const, path: e.path, size: e.size, environment_id: session.environment_id, created_at: e.mtimeSec };
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
    status: child.status === "terminated" ? "closed" : child.status === "running" ? "active" : "idle",
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

async function loadSession(c: Context): Promise<SessionResource> {
  const s = await repos.sessions.get(c.req.param("id"), scope(c));
  if (!s) throw notFound("session", c.req.param("id"));
  return s;
}

export const openaiAgents = new Hono()
  .post("/agents/sessions", async (c) => {
    const body = await readJson<{ agent?: OpenAiAgentSpec; environment?: OpenAiEnvSpec; input?: unknown; metadata?: unknown; vault_ids?: string[]; stream?: boolean }>(c);
    if (!body.agent) throw invalid("agent (with a model) is required; agent_id references are not supported yet");
    const owner = ownerId(c);
    const draft = openaiAgentToRethink(body.agent);
    const environmentId = openaiEnvToEnvironmentId(body.environment);
    // validate everything before any row is written
    const inputs = createInputToUserEvents(body.input);
    if (body.stream && inputs.length === 0) throw invalid("stream:true needs input (the stream follows the turn it triggers)");
    const environment = await repos.environments.get(environmentId, scope(c));
    if (!environment) throw notFound("environment", environmentId);
    const spec = environment.workspace;
    const workspace = await repos.workspaces.create(spec, initialRef(spec) as WorkspaceRef, owner);
    const agentRow = await repos.agents.create({ owner_id: owner, name: draft.name, model: draft.model, system: draft.system, tools: draft.tools, packages: draft.packages, skills: [] });
    const { created_at: _c, ...snapshot } = { ...agentRow, client_tools: draft.client_tools, mcp_servers: draft.mcp_servers };
    const session = await repos.sessions.create({ owner_id: owner, agent_id: agentRow.id, environment_id: environmentId, workspace_id: workspace.id, agent: snapshot, vault_ids: Array.isArray(body.vault_ids) ? body.vault_ids : [] });
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
    const page = await repos.sessions.listPage(scope(c), { limit, after });
    // List is a light projection: status from the row, required_actions resolved on retrieve.
    const data = page.data.map((s) => toAgentSession(s, [], s.environment_id));
    return c.json({ object: "list", data, has_more: page.has_more, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null });
  })
  .get("/agents/sessions/:id", async (c) => {
    const session = await loadSession(c);
    return c.json(toAgentSession(session, await stateEvents(session), session.environment_id));
  })
  /** Update session metadata (best-effort: accepted, not persisted yet). */
  .post("/agents/sessions/:id", async (c) => {
    const session = await loadSession(c);
    await readJson<{ metadata?: unknown }>(c).catch(() => ({}));
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
    return c.json({ object: "list", data: toItems(session, await listEventsForState(session.id, ITEM_EVENT_TYPES)), has_more: false });
  })
  /** List the session's turns. */
  .get("/agents/sessions/:id/turns", async (c) => {
    const session = await loadSession(c);
    return c.json({ object: "list", data: toTurns(session, await listEventsForState(session.id, TURN_EVENT_TYPES)), has_more: false });
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
    const data = entries.map((e) => toArtifact(session, e));
    return c.json({ object: "list", data, has_more: false });
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
    return c.json({ object: "list", data: kids.map(toSubagent), has_more: false });
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
    return c.json({ object: "list", data: toItems(child, await listEventsForState(child.id, ITEM_EVENT_TYPES)), has_more: false });
  })
  .get("/agents/sessions/:id/subagents/:subId/turns", async (c) => {
    const session = await loadSession(c);
    const child = (await repos.sessions.childrenOf(session.id, scope(c))).find((k) => k.id === c.req.param("subId"));
    if (!child) throw notFound("subagent", c.req.param("subId"));
    return c.json({ object: "list", data: toTurns(child, await listEventsForState(child.id, TURN_EVENT_TYPES)), has_more: false });
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
  /** Store a credential. The SDK sends a typed `auth` union (mcp_oauth | static_bearer); we store the token. */
  .post("/vaults/:vaultId/credentials", async (c) => {
    if (!secretsConfigured()) throw invalid("PMA_SECRET_KEY is not set: cannot store vault secrets");
    const v = await vaults.get(c.req.param("vaultId"), scope(c));
    if (!v) throw notFound("vault", c.req.param("vaultId"));
    const body = await readJson<{ name?: string; auth?: { type?: string; token?: string; access_token?: string }; value?: string }>(c);
    if (!body.name) throw invalid("name is required");
    const value = body.auth?.token ?? body.auth?.access_token ?? body.value; // static_bearer.token | mcp_oauth.access_token | plain value
    if (typeof value !== "string") throw invalid("a credential secret is required (auth.token, auth.access_token, or value)");
    const cred = await vaultCredentials.put(v.id, body.name, value);
    return c.json({ ...cred, object: "vault.credential" }, 201);
  })
  .get("/vaults/:vaultId/credentials", async (c) => {
    const v = await vaults.get(c.req.param("vaultId"), scope(c));
    if (!v) throw notFound("vault", c.req.param("vaultId"));
    return c.json({ object: "list", data: (await vaultCredentials.list(v.id)).map((cr) => ({ ...cr, object: "vault.credential" })), has_more: false });
  })
  .delete("/vaults/:vaultId/credentials/:name", async (c) => {
    const v = await vaults.get(c.req.param("vaultId"), scope(c));
    if (!v) throw notFound("vault", c.req.param("vaultId"));
    if (!(await vaultCredentials.delete(v.id, c.req.param("name")))) throw notFound("credential", c.req.param("name"));
    return c.json({ id: c.req.param("name"), object: "vault.credential.deleted", deleted: true });
  });
