import { env } from "../../../shared/env.ts";
import { invalid } from "../../errors.ts";
import { REDACTED } from "../../../infra/mcp-credentials.ts";
import type { AgentResource, BuiltinToolName, ContentBlock, FunctionToolDecl, McpServerDecl, ModelRef, SessionEvent, SessionResource, ToolPermission } from "../../../shared/types.ts";
import { mapModel } from "./translate.ts";

/**
 * Translate the Claude Managed Agents dialect into rethink's shapes, and back.
 *
 * CMA splits an agent the way rethink already does: a reusable definition that names its MCP servers
 * but holds no secrets, and a session that supplies credentials from its vaults. The pieces that do not
 * line up are named in DESIGN §21 rather than silently dropped — a declaration rethink cannot honor is
 * refused at the edge or reported in `unsupported`, never accepted and ignored.
 */

/** The four sandbox tools rethink runs; CMA's toolset also names glob/grep/web_fetch/web_search. */
const BUILTINS = new Set<BuiltinToolName>(["bash", "read", "write", "edit"]);

export interface CmaModelConfig { id: string; effort?: unknown; speed?: string | null; inference_geo?: string | null }
export interface CmaToolConfig { name?: string; type?: string; enabled?: boolean | null; permission_policy?: { type?: string } | null; [k: string]: unknown }
export interface CmaTool {
  type: string;
  configs?: CmaToolConfig[] | null;
  default_config?: { enabled?: boolean | null; permission_policy?: { type?: string } | null } | null;
  mcp_server_name?: string;
  name?: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  [k: string]: unknown;
}
export interface CmaMcpServer { type?: string; name?: string; url?: string }
export interface CmaAgentSpec {
  model?: string | CmaModelConfig;
  name?: string;
  description?: string | null;
  system?: string | null;
  tools?: CmaTool[] | null;
  mcp_servers?: CmaMcpServer[] | null;
  skills?: unknown[] | null;
  multiagent?: unknown;
  metadata?: Record<string, string> | null;
}

/** Fields CMA echoes back that the engine does not act on, plus what rethink could not honor. */
export interface CmaAgentEcho {
  tools: CmaTool[];
  mcp_servers: CmaMcpServer[];
  skills: unknown[];
  multiagent: unknown;
  description: string | null;
  model: CmaModelConfig;
  /** declarations accepted for round-tripping that this engine does not run (surfaced on the agent) */
  unsupported: { field: string; value: string; reason: string }[];
  version: number;
}

const policyOf = (p: { type?: string } | null | undefined): ToolPermission | undefined =>
  p?.type === "always_ask" ? "always_ask" : p?.type === "always_allow" ? "always_allow" : undefined;

export interface CmaAgentDraft {
  name: string;
  model: ModelRef;
  system: string | null;
  tools: BuiltinToolName[];
  packages: string[];
  client_tools: FunctionToolDecl[];
  mcp_servers: McpServerDecl[];
  metadata: Record<string, string>;
  echo: CmaAgentEcho;
}

/**
 * An agent definition in the CMA dialect -> a rethink agent row. `mcp_servers` names the servers,
 * `tools` says which of their tools are on and how they are approved; every server must be referenced
 * by an mcp_toolset and every toolset must name a declared server, as CMA requires.
 */
export function cmaAgentToRethink(spec: CmaAgentSpec, opts: { version?: number } = {}): CmaAgentDraft {
  const modelCfg: CmaModelConfig = typeof spec.model === "string" ? { id: spec.model } : (spec.model as CmaModelConfig);
  if (!modelCfg || typeof modelCfg.id !== "string" || !modelCfg.id) throw invalid("model is required (a model id, or {id, effort?, speed?})");
  if (!spec.name || typeof spec.name !== "string") throw invalid("name is required");

  const unsupported: CmaAgentEcho["unsupported"] = [];
  const servers = new Map<string, McpServerDecl>();
  for (const s of spec.mcp_servers ?? []) {
    if (s?.type && s.type !== "url") throw invalid(`mcp_servers: only {type:"url"} is supported`);
    if (!s?.name || typeof s.name !== "string") throw invalid("each mcp_servers entry needs a name");
    if (servers.has(s.name)) throw invalid(`mcp server name ${JSON.stringify(s.name)} is used more than once`);
    if (!s.url || typeof s.url !== "string") throw invalid(`mcp server ${s.name} needs a url`);
    try { new URL(s.url); } catch { throw invalid(`mcp server ${s.name}: url ${JSON.stringify(s.url)} is not a valid URL`); }
    servers.set(s.name, { label: s.name, url: s.url });
  }
  if (servers.size > 20) throw invalid("at most 20 mcp_servers");

  const builtins: BuiltinToolName[] = [];
  const clientTools: FunctionToolDecl[] = [];
  const packages: string[] = [];
  const referenced = new Set<string>();
  let webSearch = false;

  for (const t of spec.tools ?? []) {
    if (t?.type === "agent_toolset_20260401") {
      const onByDefault = t.default_config?.enabled !== false;
      const byName = new Map((t.configs ?? []).map((cfg) => [cfg.name ?? cfg.type ?? "", cfg]));
      for (const name of ["bash", "read", "write", "edit"] as BuiltinToolName[]) {
        const cfg = byName.get(name);
        if (cfg?.enabled ?? onByDefault) builtins.push(name);
      }
      for (const name of ["glob", "grep"]) {
        const cfg = byName.get(name);
        if (cfg?.enabled ?? onByDefault) unsupported.push({ field: "tools", value: name, reason: "no rethink builtin; the agent can do the same with bash" });
      }
      for (const name of ["web_search", "web_fetch"]) {
        const cfg = byName.get(name);
        if (!(cfg?.enabled ?? onByDefault)) continue;
        if (env.COMPAT_WEBSEARCH_PACKAGE) webSearch = true;
        else unsupported.push({ field: "tools", value: name, reason: "COMPAT_WEBSEARCH_PACKAGE is not configured" });
      }
      const askPolicies = [t.default_config, ...(t.configs ?? [])].filter((cfg) => policyOf(cfg?.permission_policy) === "always_ask");
      if (askPolicies.length) unsupported.push({ field: "tools", value: "agent_toolset_20260401.permission_policy", reason: "sandbox tools always run; only MCP tools can be held for confirmation" });
    } else if (t?.type === "mcp_toolset") {
      const server = servers.get(String(t.mcp_server_name ?? ""));
      if (!server) throw invalid(`mcp_toolset references mcp_server_name ${JSON.stringify(t.mcp_server_name)}, which is not declared in mcp_servers`);
      referenced.add(server.label);
      const onByDefault = t.default_config?.enabled !== false;
      const configs = t.configs ?? [];
      // CMA expresses the tool list either way round: default off + an allow list, or default on + a deny list.
      if (onByDefault) {
        const denied = configs.filter((cfg) => cfg.enabled === false).map((cfg) => String(cfg.name));
        if (denied.length) server.denied_tools = denied;
      } else {
        server.allowed_tools = configs.filter((cfg) => cfg.enabled !== false).map((cfg) => String(cfg.name));
      }
      // MCP tools default to always_ask in this dialect, so the default is written down explicitly.
      const tools: Record<string, ToolPermission> = {};
      for (const cfg of configs) { const p = policyOf(cfg.permission_policy); if (p && cfg.name) tools[String(cfg.name)] = p; }
      server.permissions = { default: policyOf(t.default_config?.permission_policy) ?? "always_ask", ...(Object.keys(tools).length ? { tools } : {}) };
    } else if (t?.type === "custom") {
      if (!t.name || typeof t.name !== "string") throw invalid("a custom tool needs a name");
      clientTools.push({ type: "function", name: t.name, description: t.description, parameters: t.input_schema ?? { type: "object", properties: {} } });
    } else {
      throw invalid(`unsupported tool type ${JSON.stringify(t?.type)}`);
    }
  }
  for (const label of servers.keys()) {
    if (!referenced.has(label)) throw invalid(`mcp server ${label} is not referenced by any mcp_toolset`);
  }
  if (webSearch && env.COMPAT_WEBSEARCH_PACKAGE) packages.push(env.COMPAT_WEBSEARCH_PACKAGE);
  if (spec.multiagent) {
    if (env.COMPAT_TEAM_PACKAGE) packages.push(env.COMPAT_TEAM_PACKAGE);
    else unsupported.push({ field: "multiagent", value: "coordinator", reason: "COMPAT_TEAM_PACKAGE is not configured" });
  }
  for (const sk of spec.skills ?? []) {
    unsupported.push({ field: "skills", value: JSON.stringify(sk), reason: "attach rethink skills with the native API (skill ids differ)" });
  }
  if (modelCfg.speed || modelCfg.inference_geo) {
    unsupported.push({ field: "model", value: String(modelCfg.speed ?? modelCfg.inference_geo), reason: "speed / inference_geo are Anthropic-hosted knobs" });
  }

  return {
    name: spec.name,
    model: mapModel(modelCfg.id),
    system: spec.system ?? null,
    tools: builtins,
    packages,
    client_tools: clientTools,
    mcp_servers: [...servers.values()],
    metadata: spec.metadata ?? {},
    echo: {
      tools: resolvedTools(spec.tools ?? []),
      mcp_servers: [...servers.values()].map((s) => ({ type: "url", name: s.label, url: s.url })),
      skills: spec.skills ?? [],
      multiagent: spec.multiagent ?? null,
      description: spec.description ?? null,
      model: modelCfg,
      unsupported,
      version: opts.version ?? 1,
    },
  };
}

/** Tool declarations as CMA returns them: every config resolved to explicit enabled + permission_policy. */
function resolvedTools(tools: CmaTool[]): CmaTool[] {
  return tools.map((t) => {
    if (t.type === "custom") return t;
    const dflt = { enabled: t.default_config?.enabled !== false, permission_policy: t.default_config?.permission_policy ?? { type: t.type === "mcp_toolset" ? "always_ask" : "always_allow" } };
    const configs = (t.configs ?? []).map((cfg) => ({
      ...(t.type === "mcp_toolset" ? {} : { type: cfg.type ?? cfg.name }),
      name: cfg.name ?? cfg.type,
      enabled: cfg.enabled ?? dflt.enabled,
      permission_policy: cfg.permission_policy ?? dflt.permission_policy,
    }));
    return { ...t, configs, default_config: dflt };
  });
}

const iso = (t: string | undefined) => (t ? new Date(t).toISOString() : new Date().toISOString());

/** A stored agent row as CMA's `agent` object. */
export function toCmaAgent(row: AgentResource) {
  const echo = (row.compat?.anthropic ?? {}) as Partial<CmaAgentEcho>;
  return {
    type: "agent" as const,
    id: row.id,
    version: echo.version ?? 1,
    name: row.name,
    description: echo.description ?? null,
    system: row.system,
    model: echo.model ?? { id: `${row.model.provider}/${row.model.id}` },
    tools: echo.tools ?? [],
    mcp_servers: echo.mcp_servers ?? (row.mcp_servers ?? []).map((s) => ({ type: "url", name: s.label, url: s.url })),
    skills: echo.skills ?? [],
    multiagent: echo.multiagent ?? null,
    metadata: row.metadata ?? {},
    created_at: iso(row.created_at),
    updated_at: iso(row.created_at),
    archived_at: null,
    /** rethink extension: declarations accepted for round-tripping that this engine does not run */
    unsupported: echo.unsupported ?? [],
  };
}

/** The agent snapshot a session carries, in CMA's shape. */
function toCmaSessionAgent(session: SessionResource) {
  const echo = (session.agent.compat?.anthropic ?? {}) as Partial<CmaAgentEcho>;
  return {
    type: "agent" as const,
    id: session.agent.id,
    version: echo.version ?? 1,
    name: session.agent.name,
    description: echo.description ?? null,
    system: session.agent.system,
    model: echo.model ?? { id: `${session.agent.model.provider}/${session.agent.model.id}` },
    tools: echo.tools ?? [],
    mcp_servers: (session.agent.mcp_servers ?? []).map((s) => ({ type: "url", name: s.label, url: s.url })),
    skills: echo.skills ?? [],
    multiagent: echo.multiagent ?? null,
  };
}

/** The outcome record the outcome plugin keeps, as this dialect's `outcome_evaluation` objects. */
export interface StoredOutcome {
  outcome_id: string; goal: string; rubric: string; iteration: number; max: number;
  status: "open" | "satisfied" | "max_iterations_reached";
  evaluations?: { outcome_id: string; iteration: number; result: string; explanation: string; completed_at: string }[];
}
export const toOutcomeEvaluations = (o: StoredOutcome | null | undefined) =>
  (o?.evaluations ?? []).map((e) => ({
    type: "outcome_evaluation" as const, outcome_id: e.outcome_id, description: o!.goal,
    iteration: e.iteration, result: e.result, explanation: e.explanation, completed_at: e.completed_at,
  }));

/** A rethink session as CMA's `session` object. */
export function toCmaSession(session: SessionResource, opts: { archived?: boolean; outcome?: StoredOutcome | null } = {}) {
  const u = session.usage;
  return {
    type: "session" as const,
    id: session.id,
    agent: toCmaSessionAgent(session),
    environment_id: session.environment_id,
    status: session.status,
    title: (session.metadata?.title as string | undefined) ?? null,
    metadata: session.metadata ?? {},
    vault_ids: session.vault_ids ?? [],
    budget: null,
    resources: (session.memory_stores ?? []).map((m) => ({ type: "memory_store" as const, memory_store_id: m.memory_store_id, mount_path: m.mount_path })),
    outcome_evaluations: toOutcomeEvaluations(opts.outcome),
    stats: { active_seconds: 0, duration_seconds: 0 },
    usage: {
      input_tokens: u?.input ?? 0,
      output_tokens: u?.output ?? 0,
      cache_read_input_tokens: u?.cache_read ?? 0,
      cache_creation: { ephemeral_5m_input_tokens: u?.cache_write ?? 0, ephemeral_1h_input_tokens: 0 },
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    },
    created_at: iso(session.created_at),
    updated_at: iso(session.updated_at),
    archived_at: opts.archived ? iso(session.updated_at) : null,
  };
}

/** Credentials are never echoed, so a session's MCP servers are shown by name and URL only. */
export const cmaMcpServers = (servers: McpServerDecl[] | undefined) =>
  (servers ?? []).map((s) => ({ type: "url" as const, name: s.label, url: s.url, ...(s.credential_id ? { credential_id: s.credential_id } : {}), ...(s.secret || s.authorization ? { authorization: REDACTED } : {}) }));

// ---------- Events ----------

/** CMA content blocks -> rethink content blocks (text, or a file-backed image/document). */
export function cmaContent(content: unknown, what: string): ContentBlock[] {
  if (!Array.isArray(content) || content.length === 0) throw invalid(`${what} requires a non-empty content array`);
  return content.map((b: Record<string, unknown>) => {
    if (b?.type === "text" && typeof b.text === "string") return { type: "text", text: b.text } as ContentBlock;
    if (b?.type === "image" || b?.type === "document") {
      const src = b.source as { type?: string; file_id?: string } | undefined;
      if (src?.type === "file" && typeof src.file_id === "string") return { type: b.type, source: { type: "file", file_id: src.file_id } } as ContentBlock;
      throw invalid(`${what}: image/document blocks must use {source:{type:"file", file_id}} (upload with the files API first)`);
    }
    if (b?.type === "redacted") throw invalid(`${what}: redacted blocks are emitted by the server, not sent by a client`);
    throw invalid(`${what}: unsupported content block ${JSON.stringify(b?.type)}`);
  });
}

/** Which MCP server a namespaced tool name came from, if any. */
export const mcpServerOf = (name: string) => (name.includes("__") ? name.slice(0, name.indexOf("__")) : null);
export const mcpToolOf = (name: string) => name.slice(name.indexOf("__") + 2);

const stopReasonOf = (r: string | undefined) =>
  r === "interrupted" ? { type: "end_turn" } : r === "error" ? { type: "retries_exhausted" } : { type: "end_turn" };

/**
 * Which kind of call a tool_use_id was, so its result can be named the way this dialect names it. The
 * caller keeps one of these across a log (or a stream) and passes it back in.
 */
export type CmaCallKinds = Map<string, "mcp" | "custom" | "builtin">;

/**
 * One rethink event as the CMA event it corresponds to, or null when the dialect has no equivalent
 * (sandbox leases, workspace captures, plugin notes — rethink-only machinery).
 */
export function toCmaEvent(e: SessionEvent, session: SessionResource, calls: CmaCallKinds = new Map()): Record<string, unknown> | null {
  const out = toCmaEvents(e, session, calls);
  return out[out.length - 1] ?? null;
}

/**
 * One rethink event as the CMA events it corresponds to. Usually zero or one, but a held tool call is
 * two: this dialect announces the call and then idles the session with `requires_action`, which is what
 * its clients wait for before confirming.
 */
export function toCmaEvents(e: SessionEvent, session: SessionResource, calls: CmaCallKinds = new Map()): Record<string, unknown>[] {
  const single = projectOne(e, session, calls);
  const p = e.payload;
  if (p.type === "agent.tool_confirmation_required") {
    return [
      { id: `sevt_${e.seq}_ask`, processed_at: iso(e.created_at as unknown as string), type: p.mcp_server ? "agent.mcp_tool_use" : "agent.tool_use", name: p.name, ...(p.mcp_server ? { mcp_server_name: p.mcp_server } : {}), input: {}, evaluated_permission: "ask", evaluation: { type: "always_ask" } },
      { id: `sevt_${e.seq}`, processed_at: iso(e.created_at as unknown as string), type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: [`sevt_${p.tool_use_id}`] } },
    ];
  }
  // an outcome evaluation is a plugin note with structured data: this dialect spells it as a span pair
  if (p.type === "plugin.message" && (p.data as { kind?: string } | undefined)?.kind === "outcome_evaluation") {
    const d = p.data as { outcome_id: string; iteration: number; result: string; explanation: string };
    const at = iso(e.created_at as unknown as string);
    return [
      { id: `sevt_${e.seq}_start`, processed_at: at, type: "span.outcome_evaluation_start", outcome_id: d.outcome_id, iteration: d.iteration },
      { id: `sevt_${e.seq}`, processed_at: at, type: "span.outcome_evaluation_end", outcome_evaluation_start_id: `sevt_${e.seq}_start`, outcome_id: d.outcome_id, iteration: d.iteration, result: d.result, explanation: d.explanation, usage: null },
    ];
  }
  // a defined outcome is recorded as a session update; this dialect calls that event user.define_outcome
  if (p.type === "session.updated" && (p.changes as { outcome?: unknown } | undefined)?.outcome) {
    const o = (p.changes as { outcome: { outcome_id: string; description: string; max_iterations: number } }).outcome;
    return [{ id: `sevt_${e.seq}`, processed_at: iso(e.created_at as unknown as string), type: "user.define_outcome", outcome_id: o.outcome_id, description: o.description, max_iterations: o.max_iterations }];
  }
  // answering a held call resumes the session, which this dialect reports as a status change
  if (p.type === "user.tool_confirmation") {
    return [
      { id: `sevt_${e.seq}`, processed_at: iso(e.created_at as unknown as string), type: "user.tool_confirmation", tool_use_id: `sevt_${p.tool_use_id}`, result: p.result, ...(p.deny_message ? { deny_message: p.deny_message } : {}) },
      { id: `sevt_${e.seq}_resume`, processed_at: iso(e.created_at as unknown as string), type: "session.status_running" },
    ];
  }
  return single ? [single] : [];
}

function projectOne(e: SessionEvent, session: SessionResource, calls: CmaCallKinds): Record<string, unknown> | null {
  const p = e.payload;
  const base = { id: `sevt_${e.seq}`, processed_at: iso(e.created_at as unknown as string) };
  const clientTools = new Set((session.agent.client_tools ?? []).map((t) => t.name));
  switch (p.type) {
    case "user.message": return { ...base, type: "user.message", content: p.content };
    case "user.interrupt": return { ...base, type: "user.interrupt" };
    case "agent.message": return { ...base, type: "agent.message", content: p.content };
    case "agent.tool_use": {
      const server = mcpServerOf(p.name);
      if (server) {
        calls.set(p.tool_use_id, "mcp");
        return { ...base, type: "agent.mcp_tool_use", name: mcpToolOf(p.name), mcp_server_name: server, input: p.input, evaluated_permission: "allow" };
      }
      if (clientTools.has(p.name)) {
        calls.set(p.tool_use_id, "custom");
        return { ...base, type: "agent.custom_tool_use", name: p.name, input: p.input };
      }
      calls.set(p.tool_use_id, "builtin");
      return { ...base, type: "agent.tool_use", name: p.name, input: p.input, evaluated_permission: "allow" };
    }
    case "agent.tool_result": {
      const id = `sevt_${p.tool_use_id}`;
      const kind = calls.get(p.tool_use_id) ?? "builtin";
      // each kind of call has its own result event here; a custom tool's result came from the caller
      if (kind === "mcp") return { ...base, type: "agent.mcp_tool_result", mcp_tool_use_id: id, content: p.content, is_error: p.is_error };
      if (kind === "custom") return { ...base, type: "user.custom_tool_result", custom_tool_use_id: id, content: p.content, is_error: p.is_error };
      return { ...base, type: "agent.tool_result", tool_use_id: id, content: p.content, is_error: p.is_error };
    }
    case "session.status_running": return { ...base, type: "session.status_running" };
    case "session.status_idle": return { ...base, type: "session.status_idle", stop_reason: stopReasonOf(p.stop_reason) };
    case "session.status_terminated": return { ...base, type: "session.status_terminated" };
    case "session.error": return { ...base, type: "session.error", error: { type: cmaErrorType(p.error?.type), message: p.error?.message ?? "session failed", retry_status: { type: "terminal" } } };
    case "session.usage": return { ...base, type: "session.usage", usage: toCmaSession(session).usage };
    case "span.model_request_end": return { ...base, type: "span.model_request_end", model_request_start_id: null, is_error: false, model_usage: { input_tokens: p.usage.input, output_tokens: p.usage.output, cache_read_input_tokens: p.usage.cache_read, cache_creation_input_tokens: p.usage.cache_write } };
    case "session.updated": return { ...base, type: "session.updated", ...p.changes };
    case "agent.thread_context_compacted": return { ...base, type: "agent.thread_context_compacted" };
    case "session.thread_created": return { ...base, type: "session.thread_created", session_thread_id: p.child_session_id, agent_name: p.name ?? p.role ?? "subagent" };
    case "agent.thread_message_received": return { ...base, type: "agent.thread_message_received", content: p.content, from_session_thread_id: p.from_session_id };
    case "agent.thread_message_sent": return { ...base, type: "agent.thread_message_sent", content: p.content, to_session_thread_id: p.to_session_id };
    default: return null;
  }
}

/** rethink error types -> the closest member of CMA's session.error union. */
function cmaErrorType(type: string | undefined): string {
  if (type === "model_error") return "model_request_failed_error";
  if (type === "mcp_error") return "mcp_connection_failed_error";
  return "unknown_error";
}
