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
  created_at: string;
}

// ---------- Environment ----------
export type SandboxProviderName = "local" | "docker" | "e2b";
export interface EnvironmentResource {
  id: EnvironmentId;
  name: string;
  provider: SandboxProviderName;
  /** docker image (docker provider) or e2b template name (e2b provider); ignored by local */
  image: string | null;
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
}
export interface SandboxRequest {
  workspaceId: WorkspaceId;
  workspaceRef: WorkspaceRef;
  image?: string | null;
  /** sessions passing the same key may share a sandbox */
  affinity?: string;
  secrets?: Record<string, string>;
}
export interface SandboxLease {
  sandbox: Sandbox;
  release(): Promise<void>;
}
export interface SandboxProvider {
  name: SandboxProviderName;
  acquire(req: SandboxRequest): Promise<SandboxLease>;
  /** capture current workspace state from a live sandbox */
  capture(sb: Sandbox, prev: WorkspaceRef): Promise<WorkspaceRef>;
  /** destroy sandboxes idle longer than ttl; returns ids destroyed */
  reap(idleTtlMs: number): Promise<SandboxId[]>;
}
export interface SandboxRow {
  id: SandboxId;
  provider: SandboxProviderName;
  status: "ready" | "busy" | "destroyed";
  workspace_id: WorkspaceId | null;
  affinity: string | null;
  external_ref: string | null; // container id / host dir
  last_used_at: string;
  created_at: string;
}

// ---------- Session ----------
export type SessionStatus = "idle" | "running" | "terminated";
export type StopReason = "end_turn" | "interrupted" | "error" | "max_turns";
export interface SessionResource {
  id: SessionId;
  agent_id: AgentId;
  environment_id: EnvironmentId;
  workspace_id: WorkspaceId;
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
  | { type: "sandbox.acquired"; sandbox_id: SandboxId; provider: SandboxProviderName }
  | { type: "sandbox.released"; sandbox_id: SandboxId }
  | { type: "workspace.captured"; ref: WorkspaceRef };

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
  | { type: "agent.message_delta"; session_id: SessionId; text: string };

// ---------- Queue (MQ) ----------
export interface RunJob {
  session_id: SessionId;
  /** seq of the user event that triggered this run */
  trigger_seq: number;
}
