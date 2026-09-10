/**
 * Shared contract for every module. Agents implementing modules MUST code against
 * these types and MUST NOT change them without updating ARCHITECTURE.md.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

// ---------- Ids ----------
export type AgentId = string; // "agent_xxx"
export type EnvironmentId = string; // "env_xxx"
export type SessionId = string; // "sess_xxx"
export type WorkspaceId = string; // "ws_xxx"
export type SandboxId = string; // "sbx_xxx"

// ---------- Agent (Managed-Agent-like resource) ----------
export interface ModelRef {
  /** pi-ai provider id, e.g. "qoder" | "anthropic" */
  provider: string;
  /** model id within provider, e.g. "ultimate" | "claude-sonnet-4-6" */
  id: string;
}
export type BuiltinToolName = "bash" | "read" | "write" | "edit";
export interface AgentResource {
  id: AgentId;
  name: string;
  model: ModelRef;
  system: string | null;
  tools: BuiltinToolName[];
  /**
   * pi packages (extensions / skills / prompts) loaded into the harness for this agent:
   * "npm:<pkg>", "git:<url>", or a local path readable by the runner. See docs/PI_EXTENSIONS.md.
   */
  packages: string[];
  created_at: string;
}

// ---------- Model provider (DB-configured; pi-ai createProvider under the hood) ----------
export type ProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages";
/** Credentials never live in the DB in clear text: an env-var reference, or none for keyless proxies. */
export type ProviderAuth = { type: "none" } | { type: "env"; name: string };
export interface ProviderModel {
  id: string;
  name?: string;
  context_window: number;
  max_tokens?: number;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: { input: number; output: number; cache_read?: number; cache_write?: number };
  /** pi-ai compat flags, e.g. { supportsDeveloperRole: false } */
  compat?: Record<string, unknown>;
}
export interface ProviderResource {
  /** stable id used in agent.model.provider, e.g. "qoder", "anthropic", "my-gateway" */
  id: string;
  name: string;
  api: ProviderApi;
  base_url: string;
  headers: Record<string, string>;
  auth: ProviderAuth;
  models: ProviderModel[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

// ---------- Environment ----------
export type SandboxProviderName = "local" | "docker" | "e2b";
export interface EnvironmentResource {
  id: EnvironmentId;
  name: string;
  provider: SandboxProviderName;
  /** docker image (docker provider) or e2b template name (e2b provider); ignored by local */
  image: string | null;
  /** docker network for sandboxes: "none" (default, no egress) or "bridge" (internet). e2b always has egress. */
  network: "none" | "bridge";
  /**
   * Where plugin code runs. "runner": a permission-restricted process on the runner (no fs/net of its
   * own). "sandbox": inside the leased sandbox — plugins use fs/net directly, confined by the sandbox.
   */
  plugin_host: "runner" | "sandbox";
  /** default workspace spec for sessions created in this env (may be overridden per session) */
  workspace: WorkspaceSpec;
  created_at: string;
}

// ---------- Workspace (persistent state) ----------
/** How to obtain workspace content. */
export type WorkspaceSpec =
  | { kind: "empty" }
  | { kind: "git"; remote: string; ref?: string }
  | { kind: "local"; path: string }; // host path, local provider only (bind-mounted for docker)

/** Concrete captured state — what is written into events at suspend time. */
export type WorkspaceRef =
  | { kind: "empty" }
  | { kind: "git"; remote: string; base: string; patch?: string } // base = commit sha, patch = git diff text (may be large)
  | { kind: "local"; path: string }
  | { kind: "dir"; path: string }; // provider-managed persistent dir (local provider default)

export interface WorkspaceResource {
  id: WorkspaceId;
  spec: WorkspaceSpec;
  ref: WorkspaceRef; // latest captured state
  created_at: string;
  updated_at: string;
}

// ---------- Sandbox (ephemeral compute) ----------
export interface ExecChunk {
  type: "stdout" | "stderr" | "exit";
  data?: string;
  code?: number;
}
export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface Sandbox {
  id: SandboxId;
  provider: SandboxProviderName;
  /** absolute path of the workspace root inside the sandbox */
  workdir: string;
  exec(cmd: string, opts?: ExecOptions): AsyncIterable<ExecChunk>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Long-lived process with stdin (used to run a plugin host inside the sandbox). Optional per provider. */
  spawn?(cmd: string, opts?: { cwd?: string; env?: Record<string, string> }): Promise<SandboxProcess>;
}
export interface SandboxProcess {
  write(data: string): void;
  /** close stdin */
  end(): void;
  onStdout(cb: (chunk: string) => void): void;
  onStderr(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}
export interface SandboxRequest {
  workspaceId: WorkspaceId;
  workspaceRef: WorkspaceRef;
  image?: string | null;
  network?: "none" | "bridge";
  /** sessions passing the same key may share a sandbox */
  affinity?: string;
  secrets?: Record<string, string>;
}
export interface SandboxLease {
  sandbox: Sandbox;
  release(): Promise<void>;
  /** how the lease was obtained */
  origin: "created" | "reused" | "resumed";
}
/** A live sandbox as seen by its provider. `externalRef` is what `connect`/`destroy` need later (dir, container, remote id). */
export interface SandboxHandle {
  sandbox: Sandbox;
  externalRef: string;
}
/**
 * Mechanism layer: how to start, re-attach to, destroy and move files for ONE kind of sandbox.
 * Policy (lease table, affinity reuse, conflict rejection, reaping) lives in SandboxManager.
 */
export interface SandboxProvider {
  name: SandboxProviderName;
  /** Start a fresh sandbox with this id and materialize `req.workspaceRef` into it. */
  create(id: SandboxId, req: SandboxRequest): Promise<SandboxHandle>;
  /** Re-attach to a sandbox created earlier (possibly by another runner); null when it is gone. */
  connect(id: SandboxId, externalRef: string): Promise<SandboxHandle | null>;
  /** Tear down; must tolerate an already-gone sandbox. */
  destroy(id: SandboxId, externalRef: string | null): Promise<void>;
  /**
   * Optional idle tiers: pause frees compute but keeps the sandbox's filesystem (installed deps,
   * build caches) so resume is fast; connect() must accept a paused sandbox and resume it.
   */
  pause?(id: SandboxId, externalRef: string): Promise<void>;
  resume?(id: SandboxId, externalRef: string): Promise<void>;
  /** Capture the current workspace state from a live sandbox. */
  capture(handle: SandboxHandle, prev: WorkspaceRef): Promise<WorkspaceRef>;
}
/** What the harness needs from the sandbox layer (implemented by SandboxManager.bind). */
export interface SandboxService {
  acquire(req: SandboxRequest): Promise<SandboxLease>;
  capture(sandbox: Sandbox, prev: WorkspaceRef): Promise<WorkspaceRef>;
}
export interface SandboxRow {
  id: SandboxId;
  provider: SandboxProviderName;
  /**
   * busy: leased by a run · ready: idle, running · paused: idle, compute released (provider.pause) ·
   * destroying: retire on the reaper's next pass · destroyed.
   */
  status: "ready" | "busy" | "paused" | "destroying" | "destroyed";
  workspace_id: WorkspaceId | null;
  affinity: string | null;
  external_ref: string | null; // container id / host dir
  last_used_at: string;
  created_at: string;
}

// ---------- Session ----------
export type SessionStatus = "idle" | "running" | "terminated";
export type StopReason = "end_turn" | "interrupted" | "error" | "max_turns";
/** One environment attached to a session. `main` is the primary (default tool target, capture subject). */
export interface SessionEnvironment {
  key: string;
  environment_id: EnvironmentId;
  workspace_id: WorkspaceId;
}
/** Token accounting. Cumulative on the session; per request on span.model_request_end. */
export interface Usage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  /** context size the request carried (input + cache) or, cumulatively, the sum of per-request totals */
  total_tokens: number;
  requests: number;
}
/** Where the context stands right now (from the latest model request). */
export interface ContextSize {
  tokens: number;
  window: number;
  /** tokens / window, 0..1 */
  ratio: number;
  model: string;
}
export interface SessionResource {
  id: SessionId;
  agent_id: AgentId;
  /** cumulative token usage across all runs */
  usage: Usage;
  /** context size after the most recent model request; null before the first */
  context: ContextSize | null;
  /** primary environment / workspace (== environments[key="main"]) */
  environment_id: EnvironmentId;
  workspace_id: WorkspaceId;
  /** all attached environments, main first */
  environments: SessionEnvironment[];
  /** set for sub-agent sessions spawned by another session */
  parent_id: SessionId | null;
  status: SessionStatus;
  /** snapshot of agent config at creation (Managed-Agent style) */
  agent: Omit<AgentResource, "created_at">;
  created_at: string;
  updated_at: string;
}

// ---------- Events (the single source of truth) ----------
export type ContentBlock = { type: "text"; text: string };

export type UserEventInput =
  | { type: "user.message"; content: ContentBlock[] }
  | { type: "user.interrupt" };

/** Persisted event payloads. `seq` is per-session, monotonic. */
export type SessionEventPayload =
  | { type: "user.message"; content: ContentBlock[] }
  | { type: "user.interrupt" }
  | { type: "agent.message"; content: ContentBlock[]; /** full pi message for lossless refold */ pi: AgentMessage }
  | { type: "agent.tool_use"; tool_use_id: string; name: string; input: unknown }
  | { type: "agent.tool_result"; tool_use_id: string; content: ContentBlock[]; is_error: boolean; /** full pi toolResult message */ pi: AgentMessage }
  | { type: "session.status_running" }
  | { type: "session.status_idle"; stop_reason: StopReason }
  | { type: "session.status_terminated"; reason?: string }
  | { type: "session.error"; error: { type: string; message: string } }
  /** one model request finished: its usage and the context size it carried */
  | { type: "span.model_request_end"; model: string; usage: Omit<Usage, "requests">; context: ContextSize; stop_reason?: string }
  /** cumulative usage snapshot, emitted when a run ends */
  | { type: "session.usage"; usage: Usage; context: ContextSize | null }
  | { type: "sandbox.acquired"; sandbox_id: SandboxId; provider: SandboxProviderName; env?: string; origin?: "created" | "reused" | "resumed" }
  | { type: "sandbox.released"; sandbox_id: SandboxId; env?: string }
  | { type: "workspace.captured"; ref: WorkspaceRef; workspace_id?: WorkspaceId; env?: string }
  /** context was compacted: message events with seq < first_kept_seq are replaced by `summary` when folding */
  | { type: "agent.thread_context_compacted"; summary: string; first_kept_seq: number; tokens_before: number; tokens_after: number }
  /** a sub-agent session was created for this session */
  | { type: "session.thread_created"; child_session_id: SessionId; env: string; task: string }
  /** a sub-agent session finished; its report (and patch, if any) for the parent */
  | { type: "agent.thread_message_received"; child_session_id: SessionId; content: ContentBlock[]; stop_reason: StopReason; patch?: string };

export interface SessionEvent {
  id: string; // "evt_xxx"
  session_id: SessionId;
  seq: number;
  type: SessionEventPayload["type"];
  payload: SessionEventPayload;
  created_at: string;
}

// ---------- Streaming deltas (not persisted; pub/sub only) ----------
export type StreamDelta =
  | { type: "event"; event: SessionEvent }
  | { type: "agent.message_delta"; session_id: SessionId; text: string }
  /** reasoning tokens as they stream; never persisted */
  | { type: "agent.thinking_delta"; session_id: SessionId; text: string }
  /** a tool call is being generated: name known at start, JSON argument fragments follow; the persisted agent.tool_use carries the final input */
  | { type: "agent.tool_use_start"; session_id: SessionId; index: number; name: string }
  | { type: "agent.tool_use_delta"; session_id: SessionId; index: number; text: string };

// ---------- Queue (MQ) ----------
export interface RunJob {
  session_id: SessionId;
  /** seq of the user event that triggered this run */
  trigger_seq: number;
}
