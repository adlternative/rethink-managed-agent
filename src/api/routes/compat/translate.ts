import { env } from "../../../shared/env.ts";
import { invalid } from "../../errors.ts";
import type { BuiltinToolName, FunctionToolDecl, ModelRef } from "../../../shared/types.ts";

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

export interface OpenAiToolDecl { type: string; name?: string; description?: string; parameters?: Record<string, unknown>; [k: string]: unknown }

export interface SplitTools {
  builtins: BuiltinToolName[];
  clientTools: FunctionToolDecl[];
  /** accepted-but-not-run tool types (mcp / web_search / programmatic_tool_calling) surfaced to the caller as a note */
  ignored: { type: string; label?: string }[];
}

/** Split OpenAI tool decls into rethink builtin tools, client/function tools, and accepted-and-ignored types. */
export function splitTools(tools: OpenAiToolDecl[] | undefined): SplitTools {
  const out: SplitTools = { builtins: [], clientTools: [], ignored: [] };
  for (const t of tools ?? []) {
    if (t.type === "function") {
      if (!t.name || typeof t.name !== "string") throw invalid("function tool requires a name");
      out.clientTools.push({ type: "function", name: t.name, description: t.description, parameters: t.parameters ?? { type: "object", properties: {} } });
    } else if (BUILTINS.has(t.type as BuiltinToolName)) {
      out.builtins.push(t.type as BuiltinToolName);
    } else if (t.type === "mcp" || t.type === "web_search" || t.type === "programmatic_tool_calling") {
      out.ignored.push({ type: t.type, label: typeof t.server_label === "string" ? t.server_label : undefined });
    } else {
      throw invalid(`unsupported tool type ${JSON.stringify(t.type)}`);
    }
  }
  return out;
}

export interface OpenAiAgentSpec {
  model: string;
  instructions?: string;
  reasoning?: { effort?: string };
  multi_agent?: { enabled?: boolean; max_concurrent_subagents?: number };
  tools?: OpenAiToolDecl[];
}

export interface AgentSnapshotDraft {
  name: string;
  model: ModelRef;
  system: string | null;
  tools: BuiltinToolName[];
  packages: string[];
  client_tools: FunctionToolDecl[];
  ignored: { type: string; label?: string }[];
}

/** Build the rethink agent draft from an OpenAI agent spec (persisted as an agent row + session snapshot). */
export function openaiAgentToRethink(spec: OpenAiAgentSpec): AgentSnapshotDraft {
  if (!spec || typeof spec.model !== "string") throw invalid("agent.model (a string) is required");
  const split = splitTools(spec.tools);
  const packages: string[] = [];
  if (spec.multi_agent?.enabled && env.COMPAT_TEAM_PACKAGE) packages.push(env.COMPAT_TEAM_PACKAGE);
  return {
    name: "openai-compat",
    model: mapModel(spec.model),
    system: spec.instructions ?? null,
    tools: split.builtins,
    packages,
    client_tools: split.clientTools,
    ignored: split.ignored,
  };
}

export interface OpenAiEnvSpec { type?: string; environment_id?: string; workspace_directory?: string; capability_directories?: string[] }

/** Resolve the OpenAI environment spec to a rethink environment id (explicit id, or the configured default). */
export function openaiEnvToEnvironmentId(spec: OpenAiEnvSpec | undefined): string {
  if (spec?.environment_id) return spec.environment_id;
  if (env.COMPAT_DEFAULT_ENVIRONMENT) return env.COMPAT_DEFAULT_ENVIRONMENT;
  throw invalid("environment.environment_id is required (or set COMPAT_DEFAULT_ENVIRONMENT to back environment.type)");
}
