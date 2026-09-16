import { env } from "../../../shared/env.ts";
import { invalid } from "../../errors.ts";
import type { BuiltinToolName, FunctionToolDecl, McpServerDecl, ModelRef } from "../../../shared/types.ts";
import { REDACTED } from "../../../infra/mcp-credentials.ts";

/**
 * Translate an OpenAI Agents API agent/environment spec into rethink's shapes. This is the ONLY
 * vendor-specific glue; the engine underneath is provider-neutral (model via a rethink provider row,
 * environment via a pluggable sandbox provider). No OpenAI/cloud SDK is imported.
 */

const BUILTINS = new Set<BuiltinToolName>(["bash", "read", "write", "edit"]);

/** OpenAI model string -> rethink ModelRef. COMPAT_MODEL_MAP remaps names; "provider/id" splits; else COMPAT_DEFAULT_PROVIDER. */
export function mapModel(model: string): ModelRef {
  let map: Record<string, string> = {};
  try { map = JSON.parse(env.COMPAT_MODEL_MAP) as Record<string, string>; } catch { /* ignore bad map */ }
  const target = map[model] ?? model;
  if (target.includes("/")) { const i = target.indexOf("/"); return { provider: target.slice(0, i), id: target.slice(i + 1) }; }
  return { provider: env.COMPAT_DEFAULT_PROVIDER, id: target };
}

export interface OpenAiToolDecl { type: string; name?: string; description?: string; parameters?: Record<string, unknown>; server_label?: string; transport?: Record<string, unknown>; allowed_tools?: string[]; [k: string]: unknown }

export interface SplitTools {
  builtins: BuiltinToolName[];
  clientTools: FunctionToolDecl[];
  mcpServers: McpServerDecl[];
  /** a {type:'web_search'} tool was declared */
  webSearch: boolean;
  /** accepted-but-not-run tool types (programmatic_tool_calling, or web_search with no package) surfaced as a note */
  ignored: { type: string; label?: string }[];
}

/** Split OpenAI tool decls into rethink builtin tools, client/function tools, and accepted-and-ignored types. */
export function splitTools(tools: OpenAiToolDecl[] | undefined): SplitTools {
  const out: SplitTools = { builtins: [], clientTools: [], mcpServers: [], webSearch: false, ignored: [] };
  let unlabeled = 0;
  for (const t of tools ?? []) {
    if (t.type === "function") {
      if (!t.name || typeof t.name !== "string") throw invalid("function tool requires a name");
      out.clientTools.push({ type: "function", name: t.name, description: t.description, parameters: t.parameters ?? { type: "object", properties: {} } });
    } else if (BUILTINS.has(t.type as BuiltinToolName)) {
      out.builtins.push(t.type as BuiltinToolName);
    } else if (t.type === "mcp") {
      const tr = (t.transport ?? {}) as { type?: string; server_url?: string; authorization?: string; headers?: Record<string, string> };
      // tool names are namespaced by label, so every server needs a distinct one
      const label = typeof t.server_label === "string" ? t.server_label : unlabeled++ ? `mcp${unlabeled}` : "mcp";
      if (out.mcpServers.some((m) => m.label === label)) throw invalid(`mcp server_label ${JSON.stringify(label)} is used by more than one mcp tool`);
      if (tr.type && tr.type !== "http") throw invalid(`mcp tool ${label}: only transport.type "http" is supported (stdio MCP servers are not)`);
      if (!tr.server_url || typeof tr.server_url !== "string") throw invalid(`mcp tool ${label} requires transport.server_url`);
      if (t.credential_id !== undefined && t.credential_id !== null && typeof t.credential_id !== "string") throw invalid(`mcp tool ${label}: credential_id must be a vault credential id`);
      out.mcpServers.push({
        label, url: tr.server_url, authorization: tr.authorization, headers: tr.headers,
        allowed_tools: Array.isArray(t.allowed_tools) ? (t.allowed_tools as string[]) : undefined,
        credential_id: (t.credential_id as string | undefined) ?? undefined,
      });
    } else if (t.type === "web_search") {
      out.webSearch = true;
    } else if (t.type === "programmatic_tool_calling" || t.type === "tool_search") {
      // declared by the SDK, no rethink equivalent: accepted so an agent definition round-trips, never run
      out.ignored.push({ type: t.type });
    } else {
      throw invalid(`unsupported tool type ${JSON.stringify(t.type)}`);
    }
  }
  return out;
}

export interface OpenAiAgentSpec {
  model: string;
  name?: string | null;
  instructions?: string;
  reasoning?: { effort?: string };
  service_tier?: string | null;
  text?: Record<string, unknown> | null;
  metadata?: Record<string, string> | null;
  multi_agent?: { enabled?: boolean; max_concurrent_subagents?: number | null };
  tools?: OpenAiToolDecl[];
}

/** Knobs the SDK's Agent object carries that the engine does not act on; stored so reads echo them back. */
export interface OpenAiAgentEcho {
  tools: OpenAiToolDecl[];
  reasoning: { effort: string | null; summary: string | null };
  service_tier: string;
  text: { format: { type: string }; verbosity: string };
  multi_agent: { enabled: boolean; max_concurrent_subagents: number | null };
}

/**
 * The echo block for an agent spec: what create/retrieve/update must return verbatim — minus the
 * credentials. An inline `transport.authorization` is a secret; the real value is sealed into
 * `mcp_servers`, so the echoed declaration only shows that one was set.
 */
export function openaiAgentEcho(spec: OpenAiAgentSpec): OpenAiAgentEcho {
  const text = (spec.text ?? {}) as { format?: { type?: string }; verbosity?: string };
  const tools = (spec.tools ?? []).map((t) => {
    if (t.type !== "mcp" || !t.transport) return t;
    const tr = t.transport as { authorization?: string; headers?: Record<string, string> };
    if (!tr.authorization && !tr.headers) return t;
    return {
      ...t,
      transport: {
        ...tr,
        ...(tr.authorization ? { authorization: REDACTED } : {}),
        ...(tr.headers ? { headers: Object.fromEntries(Object.keys(tr.headers).map((k) => [k, REDACTED])) } : {}),
      },
    };
  });
  return {
    tools,
    reasoning: { effort: spec.reasoning?.effort ?? null, summary: (spec.reasoning as { summary?: string } | undefined)?.summary ?? null },
    service_tier: spec.service_tier ?? "auto",
    text: { format: { type: text.format?.type ?? "text" }, verbosity: text.verbosity ?? "medium" },
    multi_agent: { enabled: !!spec.multi_agent?.enabled, max_concurrent_subagents: spec.multi_agent?.max_concurrent_subagents ?? null },
  };
}

const unixOf = (t: string | undefined) => Math.floor(new Date(t ?? Date.now()).getTime() / 1000) || Math.floor(Date.now() / 1000);

/** Render a stored agent row as the SDK's `Agent` object (the echo block fills what the engine ignores). */
export function toOpenAiAgent(row: {
  id: string; name: string; model: ModelRef; system: string | null; created_at?: string;
  metadata?: Record<string, string>; compat?: Record<string, unknown>;
}) {
  const echo = ((row.compat?.openai ?? {}) as Partial<OpenAiAgentEcho>);
  const created = unixOf(row.created_at);
  return {
    id: row.id,
    object: "agent" as const,
    created_at: created,
    updated_at: created,
    name: row.name === COMPAT_AGENT_NAME ? null : row.name,
    model: `${row.model.provider}/${row.model.id}`,
    instructions: row.system,
    metadata: row.metadata ?? {},
    reasoning: echo.reasoning ?? { effort: null, summary: null },
    service_tier: echo.service_tier ?? "auto",
    text: echo.text ?? { format: { type: "text" }, verbosity: "medium" },
    multi_agent: echo.multi_agent ?? { enabled: false, max_concurrent_subagents: null },
    tools: echo.tools ?? [],
  };
}

/** Name given to the agent row a session creates for itself, shown back to the SDK as `name: null`. */
export const COMPAT_AGENT_NAME = "openai-compat";

export interface AgentSnapshotDraft {
  name: string;
  model: ModelRef;
  system: string | null;
  tools: BuiltinToolName[];
  packages: string[];
  client_tools: FunctionToolDecl[];
  mcp_servers: McpServerDecl[];
  ignored: { type: string; label?: string }[];
}

/** Build the rethink agent draft from an OpenAI agent spec (persisted as an agent row + session snapshot). */
export function openaiAgentToRethink(spec: OpenAiAgentSpec): AgentSnapshotDraft {
  if (!spec || typeof spec.model !== "string") throw invalid("agent.model (a string) is required");
  const split = splitTools(spec.tools);
  const packages: string[] = [];
  if (spec.multi_agent?.enabled && env.COMPAT_TEAM_PACKAGE) packages.push(env.COMPAT_TEAM_PACKAGE);
  const ignored = [...split.ignored];
  if (split.webSearch) { if (env.COMPAT_WEBSEARCH_PACKAGE) packages.push(env.COMPAT_WEBSEARCH_PACKAGE); else ignored.push({ type: "web_search" }); }
  return {
    name: spec.name || COMPAT_AGENT_NAME,
    model: mapModel(spec.model),
    system: spec.instructions ?? null,
    tools: split.builtins,
    packages,
    client_tools: split.clientTools,
    mcp_servers: split.mcpServers,
    ignored,
  };
}

export interface OpenAiEnvSpec { type?: string; environment_id?: string; workspace_directory?: string; capability_directories?: string[] }

/** Resolve the OpenAI environment spec to a rethink environment id (explicit id, or the configured default). */
export function openaiEnvToEnvironmentId(spec: OpenAiEnvSpec | undefined): string {
  if (spec?.environment_id) return spec.environment_id;
  if (env.COMPAT_DEFAULT_ENVIRONMENT) return env.COMPAT_DEFAULT_ENVIRONMENT;
  throw invalid("environment.environment_id is required (or set COMPAT_DEFAULT_ENVIRONMENT to back environment.type)");
}
