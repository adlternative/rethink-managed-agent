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
/** The polymorphic owner/actor. A user, org, or service account are all principals. */
export interface Principal {
  id: string;              // "prc_..."
  kind: "user" | "org" | "service";
  handle: string | null;
  display_name: string;
  /** per-principal plugin fetch allowlist (comma list or "*"); null -> global PLUGIN_FETCH_ALLOW */
  fetch_allow?: string | null;
  created_at: string;
}

/** A tool whose result is supplied by the API caller (OpenAI Agents API "function" tool), not executed in the sandbox. */
export interface FunctionToolDecl {
  type: "function";
  name: string;
  description?: string;
  /** JSON Schema for the arguments */
  parameters: Record<string, unknown>;
}
/** A remote MCP server whose tools the agent can call (OpenAI Agents API "mcp" tool). Connected server-side. */
export interface McpServerDecl {
  label: string;
  url: string;
  /** plaintext credentials are request input only: they are sealed into `secret` before a session is stored */
  authorization?: string;
  headers?: Record<string, string>;
  /** `{authorization, headers}` sealed with PMA_SECRET_KEY — the stored form, opened only by the runner */
  secret?: { type: "encrypted"; v: 1; iv: string; ct: string; tag: string };
  /** which credentials are sealed (values stay sealed), so API output can show what is set */
  header_names?: string[];
  has_authorization?: boolean;
  /** if set, only these tool names are exposed to the model */
  allowed_tools?: string[];
  /** tool names to hide even when allowed_tools is unset (Claude Managed Agents disables tools by name) */
  denied_tools?: string[];
  /**
   * Per-tool approval policy. "always_ask" holds the call until the caller confirms it; "always_allow"
   * runs it. Claude Managed Agents defaults MCP tools to always_ask, so the default is explicit here.
   */
  permissions?: { default?: ToolPermission; tools?: Record<string, ToolPermission> };
  /** vault credential to authenticate this server with; otherwise a credential is matched by URL */
  credential_id?: string | null;
}
/**
 * A held call and its answer travel on the same per-call channel a client tool's result uses, under a
 * namespaced id — so one durable mechanism serves both, on every messaging backend.
 */
export const confirmationCallId = (toolUseId: string) => `confirm:${toolUseId}`;

/** What happens when the agent calls a tool: run it, or hold it until the caller confirms. */
export type ToolPermission = "always_allow" | "always_ask";

export interface AgentResource {
  id: AgentId;
  /** owning principal (user/org/service) */
  owner_id: string;
  name: string;
  model: ModelRef;
  system: string | null;
  tools: BuiltinToolName[];
  /**
   * pi packages (extensions / skills / prompts) loaded into the harness for this agent:
   * "npm:<pkg>", "git:<url>", or a local path readable by the runner. See docs/PI_EXTENSIONS.md.
   */
  packages: string[];
  /** skill resources available in addition to package skills */
  skills: SkillRef[];
  /** client/function tools executed by the API caller (OpenAI Agents API style), not run in the sandbox */
  client_tools?: FunctionToolDecl[];
  /** remote MCP servers whose tools the agent can call (connected server-side by the runner) */
  mcp_servers?: McpServerDecl[];
  /** caller-supplied key/value labels (both compat dialects expose these) */
  metadata?: Record<string, string>;
  /**
   * Fields a compat dialect must echo back verbatim but the engine does not act on (the declared tool
   * list, reasoning/verbosity knobs, service tier). Keyed by dialect so one agent can be read back
   * through the surface that created it. Never interpreted by the harness.
   */
  compat?: Record<string, unknown>;
  created_at: string;
}

// ---------- Model provider (DB-configured; pi-ai createProvider under the hood) ----------
export type ProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages";
/**
 * Credentials never live in the DB in clear text: an env-var reference (operator-owned), none for
 * keyless proxies, or a user-supplied key sealed with PMA_SECRET_KEY (BYOK). API input may use
 * {type:"key", key} which the API seals before storing; reads never return ciphertext.
 */
export type ProviderAuth = { type: "none" } | { type: "env"; name: string } | { type: "encrypted"; v: 1; iv: string; ct: string; tag: string };
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
  owner_id: string;
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
export type SandboxProviderName = "local" | "docker" | "e2b" | "byoc";
export interface EnvironmentResource {
  id: EnvironmentId;
  owner_id: string;
  name: string;
  provider: SandboxProviderName;
  /** docker image (docker provider) or e2b template name (e2b provider); ignored by local / byoc */
  image: string | null;
  /**
   * byoc only: a worker you run (`pma worker --env <id> --key <key>`) executes this environment's
   * sandboxes on your own infrastructure. The key is returned once on creation; GET shows only whether it is set.
   */
  worker_key?: string | null;
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
  | { kind: "dir"; path: string } // provider-managed persistent dir (local provider default)
  | { kind: "blob"; key: string; bytes: number } // tarball in the blob store (memory stores; portable across runners)
  | { kind: "byoc"; worker: string; path: string }; // lives on a BYOC worker's disk; only that worker can materialize it

export interface WorkspaceResource {
  id: WorkspaceId;
  owner_id: string;
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
  /** owning principal (isolation boundary); prefixes container_key so containers never merge across principals */
  owner_id?: string;
  /** environment this sandbox belongs to (byoc routes requests to that environment's workers) */
  environmentId?: EnvironmentId;
  /** container grouping: mounts sharing this key (and provider) live in one container */
  containerKey?: string;
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
  /** how the lease was obtained: new container, reused mount, resumed container, or a new mount in a shared container */
  origin: "created" | "reused" | "resumed" | "shared";
}
/** A live mount (a workdir) inside a container, as seen by its provider. */
export interface SandboxHandle {
  sandbox: Sandbox;
  /** container this mount lives in (docker container name / host root / e2b id / byoc route) */
  containerRef: string;
  /** absolute workdir of this mount inside the container */
  workdir: string;
}
/**
 * Mechanism layer. A *container* is a shared runtime (one docker container, one host dir tree, one
 * e2b sandbox, one byoc worker); *mounts* are per-workspace workdirs inside it, so several agents
 * (a parent and its children) can share one container while keeping separate directories.
 * Policy (leases, reuse, reaping, container grouping) lives in SandboxManager.
 */
export interface SandboxProvider {
  name: SandboxProviderName;
  /** Start a new empty container; returns its ref. */
  openContainer(containerId: SandboxId, req: SandboxRequest): Promise<string>;
  /** True if the container is still alive and usable. */
  connectContainer(containerRef: string): Promise<boolean>;
  /** Tear down a container and everything in it; must tolerate an already-gone container. */
  destroyContainer(containerRef: string): Promise<void>;
  /** Materialize `ref` into a fresh workdir in the container; return a Sandbox bound to it. */
  addMount(containerRef: string, mountId: SandboxId, ref: WorkspaceRef, secrets?: Record<string, string>): Promise<SandboxHandle>;
  /** Re-attach a Sandbox to an existing mount; `secrets` are this lease's (a reused mount must not keep a previous run's). */
  connectMount(containerRef: string, mountId: SandboxId, workdir: string, secrets?: Record<string, string>): Promise<Sandbox | null>;
  /** Remove one mount's workdir (leaves the container). */
  removeMount(containerRef: string, mountId: SandboxId, workdir: string): Promise<void>;
  /** Capture a mount's current workspace state. */
  captureMount(containerRef: string, mountId: SandboxId, workdir: string, prev: WorkspaceRef): Promise<WorkspaceRef>;
  /** Optional idle tiers, at container granularity. connect resumes on next use. */
  pause?(containerRef: string): Promise<void>;
  resume?(containerRef: string): Promise<void>;
}

/** What the harness needs from the sandbox layer (implemented by SandboxManager.bind). */
export interface SandboxService {
  acquire(req: SandboxRequest): Promise<SandboxLease>;
  capture(sandbox: Sandbox, prev: WorkspaceRef): Promise<WorkspaceRef>;
}
export interface SandboxRow {
  id: SandboxId;
  owner_id: string | null;
  provider: SandboxProviderName;
  /**
   * busy: leased by a run · ready: idle, running · paused: idle, compute released (provider.pause) ·
   * destroying: retire on the reaper's next pass · destroyed.
   */
  status: "ready" | "busy" | "paused" | "destroying" | "destroyed";
  /** container grouping (mounts with the same key + provider share a container) */
  container_key: string | null;
  /** the container this mount lives in */
  container_ref: string | null;
  /** workdir of this mount inside the container */
  workdir: string | null;
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
  owner_id: string;
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
  /** container-sharing group (root session of the spawn tree); a whole tree shares one container per environment */
  container_group: SessionId;
  /** memory stores mounted into this session's main sandbox (mount_path is relative to the workspace root) */
  memory_stores: MemoryMount[];
  /** vaults whose secrets are injected into this session's sandboxes as env vars */
  vault_ids: string[];
  /** caller-supplied key/value labels (both compat dialects expose these) */
  metadata?: Record<string, string>;
  status: SessionStatus;
  /** snapshot of agent config at creation (Managed-Agent style) */
  agent: Omit<AgentResource, "created_at">;
  created_at: string;
  updated_at: string;
}

/** A named, per-principal container of encrypted secrets. Secret values are never returned. */
export interface VaultResource {
  id: string;
  owner_id: string;
  name: string | null;
  metadata: Record<string, string>;
  created_at: string;
}
/**
 * What a vault credential authenticates:
 * - `environment_variable`: injected into the session's sandboxes as `name=value`
 * - `static_bearer` / `mcp_oauth`: sent to the MCP server at `mcp_server_url` by the runner
 */
export type VaultCredentialKind = "environment_variable" | "static_bearer" | "mcp_oauth";
/** One secret in a vault (the ciphertext lives only in the DB; the API returns metadata only). */
export interface VaultCredentialResource {
  id: string;
  vault_id: string;
  name: string;
  kind: VaultCredentialKind;
  /** MCP credentials only: the server this credential belongs to (matched against a declared server URL) */
  mcp_server_url?: string | null;
  /** mcp_oauth only: when the stored access token expires, and whether a refresh block is stored */
  expires_at?: string | null;
  has_refresh?: boolean;
  metadata: Record<string, string>;
  created_at: string;
}

// ---------- Events (the single source of truth) ----------
/** Text, or a reference to an uploaded file: images go to the model as image blocks, documents are
 *  materialized into the workspace under .attachments/ and referenced by path. */
/** Content blocks follow Claude Managed Agents: text, or a file source for images / documents. */
export type FileSource = { type: "file"; file_id: string };
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: FileSource }
  | { type: "document"; source: FileSource };

/** Files API shape (uploads; bytes live in the blob store, or Postgres when no store is configured). */
export interface FileResource {
  id: string; // "file_xxx"
  owner_id: string;
  type: "file";
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  downloadable: true;
  created_at: string;
}
/** Skills API shape: a custom skill is a SKILL.md (frontmatter name/description) plus optional support files. */
export interface SkillResource {
  id: string; // "skill_xxx"
  owner_id: string;
  type: "skill";
  source: "custom";
  display_title: string;
  /** frontmatter name (what the model calls it) */
  name: string;
  description: string;
  body: string;
  latest_version: string;
  created_at: string;
  updated_at: string;
}
export type SkillRef = { type: "custom"; skill_id: string; version?: string };
/** Memory store: a persistent directory mounted into sessions at a mount path; shared across sessions and agents. */
export interface MemoryStoreResource {
  id: string; // "mem_xxx"
  owner_id: string;
  type: "memory_store";
  name: string;
  description: string;
  ref: WorkspaceRef;
  created_at: string;
  updated_at: string;
}
export interface MemoryMount { memory_store_id: string; mount_path: string }

export type UserEventInput =
  | { type: "user.message"; content: ContentBlock[] }
  | { type: "user.interrupt" }
  /** result for a client/function tool the agent called (OpenAI Agents API tool_result); tool_use_id is the call id */
  | { type: "tool_result"; tool_use_id: string; content: ContentBlock[]; is_error?: boolean }
  /** answer to an agent.tool_confirmation_required: let the held call run, or refuse it */
  | { type: "user.tool_confirmation"; tool_use_id: string; result: "allow" | "deny"; deny_message?: string };

/** Persisted event payloads. `seq` is per-session, monotonic. */
export type SessionEventPayload =
  | { type: "user.message"; content: ContentBlock[] }
  | { type: "user.interrupt" }
  /**
   * The agent called a tool whose permission policy is always_ask: the call is held until the caller
   * answers with user.tool_confirmation. The pair is what a dialect with an approval step projects.
   */
  | { type: "agent.tool_confirmation_required"; tool_use_id: string; name: string; mcp_server?: string }
  | { type: "user.tool_confirmation"; tool_use_id: string; result: "allow" | "deny"; deny_message?: string }
  /** a plugin rewrote the text of the user.message at `target_seq` (slash command send / input hook); folds use this text */
  | { type: "user.message_rewritten"; target_seq: number; text: string }
  | { type: "agent.message"; content: ContentBlock[]; /** full pi message for lossless refold */ pi: AgentMessage; /** matches the deltas that previewed this message */ stream_id?: string; /** reasoning text, when the model produced any */ thinking?: string }
  | { type: "agent.tool_use"; tool_use_id: string; name: string; input: unknown }
  | { type: "agent.tool_result"; tool_use_id: string; content: ContentBlock[]; is_error: boolean; /** full pi toolResult message */ pi: AgentMessage }
  | { type: "session.status_running" }
  /** `consumed_seq`: the newest user.message the finished run saw; a later one gets a follow-up run */
  | { type: "session.status_idle"; stop_reason: StopReason; consumed_seq?: number }
  | { type: "session.status_terminated"; reason?: string }
  | { type: "session.error"; error: { type: string; message: string } }
  /** A byoc environment has no live worker: the run is paused, awaiting a worker (re)connection. */
  | { type: "session.environment_disconnected"; environment_id: EnvironmentId }
  /** one model request finished: its usage and the context size it carried */
  | { type: "span.model_request_end"; model: string; usage: Omit<Usage, "requests">; context: ContextSize; stop_reason?: string }
  /** cumulative usage snapshot, emitted when a run ends */
  | { type: "session.usage"; usage: Usage; context: ContextSize | null }
  | { type: "sandbox.acquired"; sandbox_id: SandboxId; provider: SandboxProviderName; env?: string; origin?: "created" | "reused" | "resumed" | "shared" }
  | { type: "sandbox.released"; sandbox_id: SandboxId; env?: string }
  | { type: "workspace.captured"; ref: WorkspaceRef; workspace_id?: WorkspaceId; env?: string }
  /** context was compacted: message events with seq < first_kept_seq are replaced by `summary` when folding */
  | { type: "agent.thread_context_compacted"; summary: string; first_kept_seq: number; tokens_before: number; tokens_after: number }
  /** session configuration changed (mounts / skills); carries only the changed fields, applies from the next turn */
  | { type: "session.updated"; changes: Record<string, unknown> }
  /**
   * A note written by a plugin for the user (not part of the model context). `data` is an optional
   * machine-readable payload the plugin attaches so a surface can project the note into its own
   * vocabulary (an outcome evaluation, a policy decision) instead of parsing the text.
   */
  | { type: "plugin.message"; plugin: string; content: ContentBlock[]; data?: Record<string, unknown> }
  /** a sub-agent session was created for this session */
  | { type: "session.thread_created"; child_session_id: SessionId; env: string; task: string; role?: string; name?: string }
  /**
   * On the parent: a message from a child arrived (its final report, a progress update, or a
   * question that blocks the child until the parent replies). On a child: a message from the parent.
   */
  | { type: "agent.thread_message_received"; child_session_id?: SessionId; from_session_id: SessionId; kind: "report" | "update" | "question" | "reply" | "steer"; content: ContentBlock[]; stop_reason?: StopReason; patch?: string; question_id?: string }
  /** the sending side of the above */
  | { type: "agent.thread_message_sent"; to_session_id: SessionId; kind: "report" | "update" | "question" | "reply" | "steer"; content: ContentBlock[]; question_id?: string };

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
  | { type: "agent.message_delta"; session_id: SessionId; stream_id: string; text: string }
  /** reasoning tokens as they stream; the final text is persisted on agent.message.thinking */
  | { type: "agent.thinking_delta"; session_id: SessionId; stream_id: string; text: string }
  /** a tool call is being generated: name known at start, JSON argument fragments follow; the persisted agent.tool_use carries the final input */
  | { type: "agent.tool_use_start"; session_id: SessionId; stream_id: string; index: number; name: string }
  | { type: "agent.tool_use_delta"; session_id: SessionId; stream_id: string; index: number; text: string };

// ---------- Queue (MQ) ----------
export interface RunJob {
  session_id: SessionId;
  /** seq of the user event that triggered this run */
  trigger_seq: number;
  /** owning principal — lets a tenant-scoped brain runner (RUNNER_OWNERS) route only its own sessions */
  owner_id?: string;
}

// ---------- Channel integrations (Slack first) ----------
export type ChannelKind = "slack";

/** Non-secret per-integration knobs. Secrets (bot token, signing secret) live in `vault_id`. */
export interface SlackIntegrationConfig {
  /** When set, only these Slack channel ids are accepted. Empty/omitted = any channel. */
  channel_ids?: string[];
  /** Extra vaults attached to sessions this integration creates (in addition to the secrets vault). */
  session_vault_ids?: string[];
  /** Optional bot user id; when set, messages from this user are ignored (also detected via bot_id). */
  bot_user_id?: string;
}

export interface ChannelIntegrationResource {
  id: string;
  owner_id: string;
  kind: ChannelKind;
  name: string;
  agent_id: AgentId;
  environment_id: EnvironmentId;
  /** Vault holding SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET (and never returned as plaintext). */
  vault_id: string;
  config: SlackIntegrationConfig;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** Durable Slack (etc.) thread ↔ rethink session mapping. */
export interface ChannelThreadResource {
  id: string;
  owner_id: string;
  integration_id: string;
  kind: ChannelKind;
  team_id: string;
  channel_id: string;
  thread_ts: string;
  session_id: SessionId;
  created_at: string;
}
