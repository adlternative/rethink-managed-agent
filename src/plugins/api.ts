/**
 * pma plugin API — the only surface third-party code sees.
 *
 * Design rule: no ambient authority. A plugin never gets Node's fs / child_process / net; it
 * gets `ctx` with capabilities that are all mediated by the runner (sandbox, fetch, store, model,
 * sub-agent). Plugins run in a separate host process started with Node's permission model
 * (no fs write, no child processes), so `ctx` is the only way out.
 *
 * Packages: package.json with a `pma` field
 *   { "pma": { "plugins": ["./index.ts"], "skills": ["./skills"], "prompts": ["./prompts"] } }
 * A pi package (`pi` field) is loaded through the compat adapter with a reduced API.
 */
import type { TSchema, Static } from "typebox";

// ---------- what a plugin can register ----------
export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface ToolSpec<TParams extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParams;
  execute(input: Static<TParams>, ctx: PluginContext): Promise<ToolResult | string>;
}

// ---------- hook events ----------
export interface ToolCallEvent { type: "tool_call"; toolName: string; input: unknown; toolCallId: string }
export interface ToolCallResult { block?: boolean; reason?: string }
export interface ToolResultEvent { type: "tool_result"; toolName: string; input: unknown; toolCallId: string; content: string; isError: boolean }
export interface ToolResultResult { content?: string; isError?: boolean }
/** Runs before each model request; may add text to the system prompt for this request only. */
export interface ContextEvent { type: "context"; systemPrompt: string; messageCount: number }
export interface ContextResult { appendSystemPrompt?: string }
export interface TurnEvent { type: "turn_start" | "turn_end"; turn: number }
export interface SessionEvent { type: "session_start" | "session_end"; sessionId: string; stopReason?: string }

export type HookEvent = ToolCallEvent | ToolResultEvent | ContextEvent | TurnEvent | SessionEvent;
export type HookResultFor<E extends HookEvent> = E extends ToolCallEvent ? ToolCallResult
  : E extends ToolResultEvent ? ToolResultResult
  : E extends ContextEvent ? ContextResult
  : void;
export type HookName = HookEvent["type"];

// ---------- capabilities (all mediated by the runner) ----------
export interface SandboxCapability {
  /** Run a shell command in the session's sandbox; resolves with combined output and exit code. */
  exec(command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; code: number }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}
export interface StoreCapability {
  /** Per-agent (or per-workspace with scope "workspace") JSON document store, persisted in Postgres. */
  get<T = unknown>(key: string, scope?: "agent" | "workspace"): Promise<T | null>;
  set(key: string, value: unknown, scope?: "agent" | "workspace"): Promise<void>;
}
export interface ModelCapability {
  /** One-shot completion with the session's model (no tools). */
  complete(prompt: string, opts?: { system?: string; maxTokens?: number }): Promise<string>;
}
export interface AgentCapability {
  /**
   * Run a sub-agent in the same sandbox: its own loop, the session's builtin tools, own context.
   * Returns the sub-agent's final text. Events are recorded on the parent session as tool output.
   */
  run(task: string, opts?: { system?: string; maxTurns?: number; tools?: string[] }): Promise<string>;
}
export interface FetchCapability {
  /** HTTP via the runner; the agent's allowlist (env PLUGIN_FETCH_ALLOW) is enforced there. */
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, string>; body: string }>;
}

export interface PluginContext {
  sessionId: string;
  agentId: string;
  workspaceId: string;
  sandbox: SandboxCapability;
  store: StoreCapability;
  model: ModelCapability;
  agent: AgentCapability;
  fetch: FetchCapability;
  log(...args: unknown[]): void;
}

export interface PluginAPI {
  registerTool<T extends TSchema>(tool: ToolSpec<T>): void;
  on<E extends HookEvent>(event: E["type"], handler: (event: E, ctx: PluginContext) => Promise<HookResultFor<E> | undefined | void> | HookResultFor<E> | undefined | void): void;
}
export type PluginFactory = (api: PluginAPI) => void | Promise<void>;

// ---------- package manifest ----------
export interface PackageManifest {
  /** absolute install dir */
  dir: string;
  source: string;
  kind: "pma" | "pi";
  plugins: string[];
  skills: string[];
  prompts: string[];
}
export interface Skill { name: string; description: string; body: string; source: string }
export interface PromptTemplate { name: string; description: string; body: string; source: string }
