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

// ---------- hook events (modelled on pi's extension events; every one is optional) ----------
/** A user message is about to enter the session (trigger, steering, or sub-agent brief). Rewrite or swallow it. */
export interface InputEvent { type: "input"; text: string; source: "user" | "steer" | "subagent" }
export interface InputResult { text?: string; /** drop the message: nothing is sent to the model */ cancel?: boolean }
/** Once per run, before the first model request. */
export interface BeforeAgentStartEvent { type: "before_agent_start"; systemPrompt: string; messageCount: number; trigger: string }
export interface BeforeAgentStartResult { systemPrompt?: string; appendSystemPrompt?: string; /** extra user message placed right before the trigger */ injectMessage?: string }
/** Before every model request; may add text to the system prompt for this request only. */
export interface ContextEvent { type: "context"; systemPrompt: string; messageCount: number; contextTokens: number; contextWindow: number }
export interface ContextResult { appendSystemPrompt?: string }
export interface ModelRequestStartEvent { type: "model_request_start"; model: string; messageCount: number; contextTokens: number }
export interface ModelRequestEndEvent { type: "model_request_end"; model: string; stopReason: string; usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }; contextTokens: number; contextWindow: number }
/** The assistant produced a message (text + tool calls it wants to make). Read-only. */
export interface MessageEndEvent { type: "message_end"; text: string; thinking?: string; toolCalls: { id: string; name: string; input: unknown }[]; stopReason: string }
export interface ToolCallEvent { type: "tool_call"; toolName: string; input: unknown; toolCallId: string }
export interface ToolCallResult { block?: boolean; reason?: string; /** replace the arguments the tool runs with */ input?: unknown }
export interface ToolResultEvent { type: "tool_result"; toolName: string; input: unknown; toolCallId: string; content: string; isError: boolean }
export interface ToolResultResult { content?: string; isError?: boolean }
export interface TurnEvent { type: "turn_start" | "turn_end"; turn: number; /** turn_end only */ toolCalls?: number }
export interface TurnEndResult { /** stop the run after this turn */ stop?: boolean; reason?: string }
export interface SessionEvent { type: "session_start" | "session_end"; sessionId: string; stopReason?: string; turns?: number }
export interface BeforeCompactEvent { type: "before_compact"; contextTokens: number; contextWindow: number; messageCount: number }
export interface BeforeCompactResult { /** skip this compaction */ cancel?: boolean; /** extra focus for the summarizer */ instructions?: string }
export interface AfterCompactEvent { type: "after_compact"; summary: string; tokensBefore: number; tokensAfter: number }
export interface SandboxEvent { type: "sandbox_acquired" | "sandbox_released"; sandboxId: string; provider: string; env: string; origin?: string }
export interface WorkspaceCapturedEvent { type: "workspace_captured"; env: string; workspaceId: string; refKind: string }
export interface ErrorEvent { type: "error"; errorType: string; message: string }

export type HookEvent =
  | InputEvent | BeforeAgentStartEvent | ContextEvent | ModelRequestStartEvent | ModelRequestEndEvent | MessageEndEvent
  | ToolCallEvent | ToolResultEvent | TurnEvent | SessionEvent | BeforeCompactEvent | AfterCompactEvent | SandboxEvent
  | WorkspaceCapturedEvent | ErrorEvent;
export type HookResultFor<E extends HookEvent> =
  E extends InputEvent ? InputResult
  : E extends BeforeAgentStartEvent ? BeforeAgentStartResult
  : E extends ContextEvent ? ContextResult
  : E extends ToolCallEvent ? ToolCallResult
  : E extends ToolResultEvent ? ToolResultResult
  : E extends TurnEvent ? TurnEndResult
  : E extends BeforeCompactEvent ? BeforeCompactResult
  : void;
export type HookName = HookEvent["type"];

/** `/name args` in a user message dispatches to a registered command instead of the model. */
export interface CommandSpec {
  name: string;
  description: string;
  /** Return text to show the user (persisted as plugin.message) and/or `send` a rewritten prompt to the model. */
  handler(args: string, ctx: PluginContext): Promise<{ reply?: string; send?: string } | string | void>;
}

// ---------- capabilities (all mediated by the runner) ----------
export interface SandboxCapability {
  /** Run a shell command in one of the session's sandboxes (`env` = attached environment key, default "main"). */
  exec(command: string, opts?: { cwd?: string; timeoutMs?: number; env?: string }): Promise<{ stdout: string; stderr: string; code: number }>;
  readFile(path: string, opts?: { env?: string }): Promise<string>;
  writeFile(path: string, content: string, opts?: { env?: string }): Promise<void>;
  /** Keys of the environments attached to this session ("main" first). */
  envs(): Promise<string[]>;
}
export interface StoreCapability {
  /** JSON document store, persisted in Postgres, scoped per agent (default), per workspace, or per principal (tenant-wide). */
  get<T = unknown>(key: string, scope?: "agent" | "workspace" | "principal"): Promise<T | null>;
  set(key: string, value: unknown, scope?: "agent" | "workspace" | "principal"): Promise<void>;
}
export interface ModelCapability {
  /** One-shot completion with the session's model (no tools). */
  complete(prompt: string, opts?: { system?: string; maxTokens?: number }): Promise<string>;
}
export interface AgentCapability {
  /**
   * Run a sub-agent. Default: an inline loop in the same sandbox (own context, builtin tools) that
   * returns its final text. `isolated: true`: a real child session on a *fork* of the workspace with
   * its own sandbox, run by any runner; returns the child's report and, for git workspaces, the
   * patch it produced (the parent decides whether to apply it). The parent session records
   * session.thread_created / agent.thread_message_received.
   */
  run(task: string, opts?: { system?: string; maxTurns?: number; tools?: string[]; isolated?: boolean; env?: string }): Promise<string | { report: string; patch?: string; sessionId: string }>;
}
/** Multi-agent: child sessions as first-class handles (parallel, steerable, joinable). */
export interface ChildHandle { sessionId: string; name?: string; role?: string }
export interface ChildStatus { sessionId: string; status: "idle" | "running" | "terminated"; finished: boolean; stopReason?: string; lastReport?: string; updates: string[]; pendingQuestion?: { id: string; text: string } }
export interface SpawnOptions {
  /** system prompt for the child (else the parent's) */
  system?: string;
  /** model override "provider/id" */
  model?: string;
  /** builtin tool subset */
  tools?: string[];
  /** attached environment key whose workspace is forked (default main) */
  env?: string;
  /** share the parent's workspace instead of forking (no parallel writes: the sandbox lease is exclusive) */
  shareWorkspace?: boolean;
  /** free-form label; shows up in events and in `agents.list()` */
  name?: string;
  role?: string;
  maxTurns?: number;
}
export interface AgentsCapability {
  /** Start a child session (does not wait). */
  spawn(task: string, opts?: SpawnOptions): Promise<ChildHandle>;
  /** Wait until the child is idle/terminated (or a question is pending when `untilQuestion`); returns its status. */
  wait(child: ChildHandle | string, opts?: { timeoutMs?: number; untilQuestion?: boolean }): Promise<ChildStatus>;
  status(child: ChildHandle | string): Promise<ChildStatus>;
  /** Send a message to a running child (steer) or an idle one (starts its next turn). */
  steer(child: ChildHandle | string, text: string): Promise<void>;
  /** Answer a child's pending question. */
  reply(child: ChildHandle | string, questionId: string, text: string): Promise<void>;
  stop(child: ChildHandle | string): Promise<void>;
  /** Children of this session with their status. */
  list(): Promise<ChildStatus[]>;
  /** The git patch a finished child produced on its forked workspace, if any. */
  patch(child: ChildHandle | string): Promise<string | undefined>;
}

export interface FetchCapability {
  /** HTTP via the runner; the agent's allowlist (env PLUGIN_FETCH_ALLOW) is enforced there. */
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, string>; body: string }>;
}

export interface SessionCapability {
  /** Persist a plugin-authored note on the session (event plugin.message; shown to the user, not sent to the model). */
  note(text: string): Promise<void>;
  /** Queue a user-role message for the model: steers the current run or starts the next one. */
  send(text: string): Promise<void>;
  /** Interrupt the current run. */
  interrupt(): Promise<void>;
}

export interface PluginContext {
  sessionId: string;
  agentId: string;
  workspaceId: string;
  /** name of the plugin (its package source) — used to attribute notes */
  plugin: string;
  session: SessionCapability;
  sandbox: SandboxCapability;
  store: StoreCapability;
  model: ModelCapability;
  agent: AgentCapability;
  agents: AgentsCapability;
  fetch: FetchCapability;
  log(...args: unknown[]): void;
}

export interface PluginAPI {
  registerTool<T extends TSchema>(tool: ToolSpec<T>): void;
  registerCommand(cmd: CommandSpec): void;
  on<E extends HookEvent>(event: E["type"], handler: (event: E, ctx: PluginContext) => Promise<HookResultFor<E> | undefined | void> | HookResultFor<E> | undefined | void): void;
}
export type PluginFactory = (api: PluginAPI) => void | Promise<void>;

// ---------- package manifest ----------
export interface PackageManifest {
  /** absolute install dir */
  dir: string;
  source: string;
  /** package.json name (used to attribute notes and warnings) */
  name?: string;
  kind: "pma" | "pi";
  plugins: string[];
  skills: string[];
  prompts: string[];
}
export interface Skill { name: string; description: string; body: string; source: string }
export interface PromptTemplate { name: string; description: string; body: string; source: string }
