import {
  runAgentLoop,
  runAgentLoopContinue,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import type { Message, Models, UserMessage } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import { env } from "../shared/env.ts";
import type {
  ContentBlock,
  EnvironmentResource,
  FunctionToolDecl,
  McpServerDecl,
  SandboxLease,
  SandboxProviderName,
  SandboxService,
  SessionEnvironment,
  SessionEvent,
  SessionEventPayload,
  SessionId,
  SessionResource,
  StopReason,
  StreamDelta,
  WorkspaceId,
  WorkspaceRef,
  WorkspaceResource,
  Usage,
  ContextSize,
  MemoryMount,
  SkillRef,
} from "../shared/types.ts";
import type { PackageManifest, PromptTemplate, Skill } from "../plugins/api.ts";
import { PluginHost, type Capabilities } from "../plugins/client.ts";
import type { HostBundle } from "../plugins/bundle.ts";
import type { SessionInfo } from "../plugins/protocol.ts";
import { foldEvents, toContentBlocks, type FoldFiles } from "./fold.ts";
import { mountMemories, syncMemoriesBack, writeAttachments, type Mounted } from "./mounts.ts";
import { DEFAULT_SYSTEM_PROMPT, renderSystemPrompt, type PromptSections } from "./system-prompt.ts";
import { compactMessages, contextTokens, needsCompaction, settingsFromEnv } from "./compaction.ts";
import { resolveModel } from "./models.ts";
import { createTools, truncateOutput, type ToolContext } from "./tools.ts";
import { McpHttpClient } from "./mcp.ts";

export type Unsubscribe = () => void | Promise<void>;

/** A user message persisted while the session was running. */
export interface SteerMessage {
  seq: number;
  content: ContentBlock[];
}

/** Plugins resolved for an agent: package content plus lazy host factories for either placement. */
export interface AgentPlugins {
  manifests: PackageManifest[];
  skills: Skill[];
  prompts: PromptTemplate[];
  /** Shared, long-lived host on the runner (permission-restricted). */
  runnerHost(): Promise<PluginHost>;
  /** Bundle for starting a host inside a sandbox. */
  bundle(): Promise<HostBundle>;
}

/** Everything runSession needs from the outside world; no DB/Redis code lives here. */
/** Child sessions (sub-agents) as seen by the harness. Implemented by the runner on top of the DB + queue. */
export interface ChildSpawnOptions { system?: string; model?: { provider: string; id: string }; tools?: string[]; shareWorkspace?: boolean; name?: string; role?: string; maxTurns?: number }
export interface ChildSpawn {
  /** Fork the env's workspace (or share it), create the child session (parent_id set), post the task, enqueue it. */
  spawn(parent: SessionResource, env: SessionEnvironment, task: string, opts?: ChildSpawnOptions): Promise<SessionResource>;
  /** Resolve when the child is idle/terminated (polls); rejects on abort. */
  wait(childId: SessionId, signal: AbortSignal, opts?: { timeoutMs?: number; untilQuestion?: boolean }): Promise<SessionResource>;
  /** Children of a session. */
  list(parentId: SessionId): Promise<SessionResource[]>;
  /** Post a user-role message to a child (steer if running, else starts its next turn). */
  message(childId: SessionId, text: string): Promise<void>;
  /** Interrupt + archive a child. */
  stop(childId: SessionId): Promise<void>;
}

export interface RunDeps {
  models: Models;
  /** Sandbox service for a provider; a session's environments may span providers. */
  sandboxFor(provider: SandboxProviderName): SandboxService;
  children: ChildSpawn;
  /** Plugin host + content for this agent (cached by the runner). */
  pluginsFor(agent: SessionResource["agent"]): Promise<AgentPlugins>;
  pluginStore: { get(scope: string, owner: string, key: string): Promise<unknown>; set(scope: string, owner: string, key: string, value: unknown): Promise<void> };
  /** The owning principal's plugin fetch allowlist (comma list or "*"); null/absent -> deployment default. */
  principalFetchAllow?(ownerId: string): Promise<string | null>;
  /** Wait for a client/function tool result posted by the API caller; null on timeout. Honors the signal (interrupt). */
  awaitToolResult(sessionId: SessionId, callId: string, signal: AbortSignal, timeoutMs: number): Promise<{ content: ContentBlock[]; isError: boolean } | null>;
  /** Append events (seq assigned by the store). Must NOT publish; runSession publishes each appended event. */
  appendEvents(sessionId: SessionId, payloads: SessionEventPayload[]): Promise<SessionEvent[]>;
  /** The whole log, untruncated. */
  listEvents(sessionId: SessionId): Promise<SessionEvent[]>;
  publish(delta: StreamDelta): void | Promise<void>;
  /** Subscribe to interrupt requests for this session; resolves once live; returns an unsubscribe. */
  onInterrupt(sessionId: SessionId, handler: () => void): Unsubscribe | Promise<Unsubscribe>;
  /** Drain user messages queued while the session is running (already persisted as events by the API). */
  popSteer(sessionId: SessionId): Promise<SteerMessage[]>;
  /** Persist a user message on behalf of a plugin and queue it for the running loop (or the next run). */
  pushSteer(sessionId: SessionId, text: string): Promise<void>;
  getSession(id: SessionId): Promise<SessionResource | null>;
  getWorkspace(id: WorkspaceId): Promise<WorkspaceResource | null>;
  getEnvironment(id: string): Promise<EnvironmentResource | null>;
  /** Replace the ref only if it still equals `expected`; false means another run captured first. */
  updateWorkspaceRef(id: WorkspaceId, ref: WorkspaceRef, expected: WorkspaceRef): Promise<boolean>;
  /** Atomically idle -> running (+ status_running event, not published). null = another run owns the session. */
  claimRun(sessionId: SessionId): Promise<SessionEvent[] | null>;
  /**
   * Atomically running -> idle (+ status_idle event, not published). `unconsumedSeq` is the newest
   * user.message this run never saw (seq > consumedSeq); the caller should enqueue a follow-up run.
   */
  finishRun(sessionId: SessionId, stopReason: StopReason, consumedSeq: number): Promise<{ events: SessionEvent[]; unconsumedSeq: number | null }>;
  /** Accumulate one model request's usage on the session row. */
  recordUsage(sessionId: SessionId, usage: Omit<Usage, "requests">, context: ContextSize): Promise<Usage>;
  /** Store the system prompt actually sent this run (GET /v1/sessions/:id/system_prompt). */
  recordSystemPrompt(sessionId: SessionId, prompt: string): Promise<void>;
  /** Uploaded files (for image blocks and document attachments). */
  files: FoldFiles;
  /** Skill resources referenced by the agent / session. */
  getSkills(refs: SkillRef[]): Promise<Skill[]>;
  /** Memory stores mounted into the session, resolved to store + mount path. */
  getMemoryStores(mounts: MemoryMount[]): Promise<Mounted[]>;
  updateMemoryRef(id: string, ref: WorkspaceRef): Promise<void>;
  /** Spill store for oversized tool outputs. */
  toolOutputs: { put(sessionId: SessionId, toolUseId: string, toolName: string, content: string): Promise<void>; get(sessionId: SessionId, toolUseId: string): Promise<{ tool_name: string; content: string; bytes: number } | null> };
}

export type RunOutcome = { status: "busy" } | { status: "done"; stopReason: StopReason; unconsumedSeq: number | null };


const LLM_ROLES = new Set(["user", "assistant", "toolResult"]);
const convertToLlm = (messages: AgentMessage[]): Message[] => messages.filter((m): m is Message => LLM_ROLES.has(m.role));

function textBlocks(content: { type: string; text?: string }[]): Extract<ContentBlock, { type: "text" }>[] {
  return content.flatMap((c) => (c.type === "text" && c.text !== undefined ? [{ type: "text" as const, text: c.text }] : []));
}
const blocksText = (content: { type: string; text?: string }[]) => textBlocks(content).map((b) => b.text).join("");
const userText = (m: AgentMessage): string => {
  const c = (m as { content: unknown }).content;
  return typeof c === "string" ? c : blocksText(c as { type: string; text?: string }[]);
};
const thinkingText = (m: { content: { type: string; thinking?: string }[] }) => m.content.filter((c) => c.type === "thinking").map((c) => c.thinking ?? "").join("\n");

/** Credentials embedded in a remote URL must not land in the event log. */
export function redactRef(ref: WorkspaceRef): WorkspaceRef {
  if (ref.kind !== "git") return ref;
  try {
    const u = new URL(ref.remote);
    if (!u.username && !u.password) return ref;
    u.username = "";
    u.password = "";
    return { ...ref, remote: u.toString() };
  } catch {
    return ref;
  }
}

/**
 * Child sessions get `report_to_parent`: progress updates, a final report, or a question that ends
 * the child's turn until the parent replies (the reply arrives as the child's next user message).
 */
function reportToParentTool(parentId: SessionId, emit: (p: SessionEventPayload) => Promise<void>, endTurn: () => void): AgentTool {
  return {
    name: "report_to_parent",
    label: "report_to_parent",
    description: "Send a message to the parent agent that delegated this task. kind=update: progress note (continue working). kind=report: your final result (then stop). kind=question: you are blocked on a decision; the turn ends and the parent's answer arrives as your next message.",
    parameters: Type.Object({ kind: Type.Union([Type.Literal("update"), Type.Literal("report"), Type.Literal("question")]), text: Type.String() }),
    executionMode: "sequential",
    execute: async (_id, params) => {
      const { kind, text } = params as { kind: "update" | "report" | "question"; text: string };
      const question_id = kind === "question" ? Math.random().toString(36).slice(2, 10) : undefined;
      await emit({ type: "agent.thread_message_sent", to_session_id: parentId, kind, content: [{ type: "text", text }], question_id });
      if (kind === "question") { setTimeout(endTurn, 50); return { content: [{ type: "text", text: `question ${question_id} sent; this turn ends here — the parent's reply will arrive as your next message.` }], details: {} }; }
      return { content: [{ type: "text", text: kind === "report" ? "report delivered; you may stop now." : "update delivered." }], details: {} };
    },
  };
}

/**
 * A client/function tool (OpenAI Agents API style): the agent calls it, but the result is supplied
 * by the API caller, not the sandbox. execute() records the pending call (so retrieve/SSE can show a
 * required_action) then blocks in-turn on a durable per-call result channel until the caller POSTs a
 * tool_result, the wait times out, or the run is interrupted. Modeled on report_to_parent: it always
 * returns a real AgentToolResult, so pi's loop stays valid and the sandbox lease unwinds normally —
 * never the deadlocking "never-settle + abort" pattern.
 */
function clientTool(
  decl: FunctionToolDecl,
  awaitResult: (callId: string, signal: AbortSignal) => Promise<{ content: ContentBlock[]; isError: boolean } | null>,
): AgentTool {
  return {
    name: decl.name,
    label: decl.name,
    description: decl.description ?? `Client tool ${decl.name}; its result is supplied by the calling application.`,
    parameters: decl.parameters as TSchema,
    executionMode: "sequential",
    // The engine treats this as an ordinary tool whose result arrives from outside; it holds no
    // "pending"/"approval" concept. The loop already logs agent.tool_use for this call, from which
    // the OpenAI-compat adapter derives required_actions (agent.tool_use minus agent.tool_result).
    execute: async (toolCallId, params, signal) => {
      const r = await awaitResult(toolCallId, signal ?? new AbortController().signal);
      if (r) { const t = textBlocks(r.content); return { content: t.length ? t : [{ type: "text", text: JSON.stringify(r.content) }], details: { client_tool: decl.name } }; }
      return { content: [{ type: "text", text: `No tool_result received for ${decl.name} (call ${toolCallId}) within the wait window.` }], details: { client_tool: decl.name, timed_out: true } };
    },
  };
}

/** One tool from a remote MCP server, namespaced by server label. Runs server-side (runner). */
function mcpTool(label: string, info: { name: string; description?: string; inputSchema: Record<string, unknown> }, client: McpHttpClient): AgentTool {
  return {
    name: `${label}__${info.name}`,
    label: `${label}.${info.name}`,
    description: info.description ?? `MCP tool ${info.name} from ${label}`,
    parameters: info.inputSchema as TSchema,
    executionMode: "sequential",
    execute: async (_id, params) => {
      const r = await client.callTool(info.name, params);
      const t = textBlocks(r.content);
      return { content: t.length ? t : [{ type: "text", text: JSON.stringify(r.content) }], details: { mcp: label, isError: r.isError } };
    },
  };
}

/** Connect to each declared MCP server (fetch-allowlist gated, fails soft) and return its tools. */
async function mcpTools(servers: McpServerDecl[], fetchAllow: string[], allowUrl: (u: string, a: string[]) => boolean, emit: (p: SessionEventPayload) => Promise<void>): Promise<AgentTool[]> {
  const out: AgentTool[] = [];
  for (const server of servers) {
    if (!allowUrl(server.url, fetchAllow)) { await emit({ type: "plugin.message", plugin: `mcp:${server.label}`, content: [{ type: "text", text: `MCP server ${server.label} (${server.url}) blocked by the fetch allowlist` }] }); continue; }
    const client = new McpHttpClient(server.url, { authorization: server.authorization, headers: server.headers });
    try {
      await client.connect();
      const allow = server.allowed_tools ? new Set(server.allowed_tools) : null;
      for (const t of await client.listTools()) if (!allow || allow.has(t.name)) out.push(mcpTool(server.label, t, client));
    } catch (e) {
      await emit({ type: "plugin.message", plugin: `mcp:${server.label}`, content: [{ type: "text", text: `MCP server ${server.label} unavailable: ${(e as Error)?.message ?? e}` }] });
    }
  }
  return out;
}

/** Skills/prompt templates are listed in the system prompt and fetched on demand with the `skill` tool. */
function skillTool(skills: Skill[], prompts: PromptTemplate[]): AgentTool | null {
  if (skills.length === 0 && prompts.length === 0) return null;
  return {
    name: "skill",
    label: "skill",
    description: "Load the full instructions of a skill or prompt template listed in the system prompt, by name. Call it before following that skill.",
    parameters: Type.Object({ name: Type.String({ description: "skill or template name" }) }),
    executionMode: "sequential",
    execute: async (_id, params) => {
      const { name } = params as { name: string };
      const s = skills.find((x) => x.name === name) ?? prompts.find((x) => x.name === name);
      if (!s) throw new Error(`unknown skill ${name}; available: ${[...skills, ...prompts].map((x) => x.name).join(", ")}`);
      return { content: [{ type: "text", text: s.body }], details: {} };
    },
  };
}

function isAllowedUrl(url: string, allow: string[]): boolean {
  if (allow.includes("*")) return true;
  let host: string;
  try { host = new URL(url).hostname; } catch { return false; }
  return allow.some((a) => host === a || host.endsWith("." + a));
}

/** Run one session turn: claim, fold events, run the pi loop (with plugins), persist events, capture + release the sandbox. */
export async function runSession(sessionId: SessionId, deps: RunDeps): Promise<RunOutcome> {
  const session = await deps.getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  // Every attached environment (main first); each gets its own lazily leased sandbox.
  const attached = session.environments?.length ? session.environments : [{ key: "main", environment_id: session.environment_id, workspace_id: session.workspace_id }];
  const envs = new Map<string, { key: string; environment: EnvironmentResource; workspace: WorkspaceResource }>();
  for (const e of attached) {
    const workspace = await deps.getWorkspace(e.workspace_id);
    if (!workspace) throw new Error(`Workspace not found: ${e.workspace_id}`);
    const environment = await deps.getEnvironment(e.environment_id);
    if (!environment) throw new Error(`Environment not found: ${e.environment_id}`);
    envs.set(e.key, { key: e.key, environment, workspace });
  }
  const main = envs.get("main")!;
  const workspace = main.workspace;
  const environment = main.environment;

  const publishAll = async (events: SessionEvent[]) => {
    for (const event of events) await deps.publish({ type: "event", event });
  };
  const emit = async (payload: SessionEventPayload) => publishAll(await deps.appendEvents(sessionId, [payload]));

  const abort = new AbortController();
  let stopReason: StopReason = "end_turn";
  let loopDone = false;
  // Subscribe before claiming so an interrupt sent right after status_running is never lost.
  const unsubscribe = await deps.onInterrupt(sessionId, () => {
    if (loopDone) return;
    stopReason = "interrupted";
    abort.abort();
  });

  const claimed = await deps.claimRun(sessionId);
  if (!claimed) {
    await unsubscribe();
    return { status: "busy" };
  }
  await publishAll(claimed);

  // One lazily leased sandbox per attached environment; read in `finally` for capture + release.
  const held = new Map<string, { lease: SandboxLease | null; acquiring: Promise<SandboxLease> | null }>();
  const ctx: ToolContext = {
    signal: abort.signal,
    envKeys: [...envs.keys()],
    spill: {
      put: (toolUseId, toolName, content) => deps.toolOutputs.put(sessionId, toolUseId, toolName, content),
      get: (toolUseId) => deps.toolOutputs.get(sessionId, toolUseId),
    },
    sandbox: async (key = "main") => {
      const e = envs.get(key);
      if (!e) throw new Error(`no environment ${JSON.stringify(key)} attached to this session (have: ${[...envs.keys()].join(", ")})`);
      let h = held.get(key);
      if (!h) { h = { lease: null, acquiring: null }; held.set(key, h); }
      const slot = h;
      slot.acquiring ??= deps
        .sandboxFor(e.environment.provider)
        .acquire({ owner_id: session.owner_id, environmentId: e.environment.id, containerKey: `${session.owner_id}/${session.container_group}/${e.environment.id}`, workspaceId: e.workspace.id, workspaceRef: e.workspace.ref, image: e.environment.image, network: e.environment.network, affinity: e.workspace.id })
        .then(
          async (l) => {
            slot.lease = l;
            await emit({ type: "sandbox.acquired", sandbox_id: l.sandbox.id, provider: l.sandbox.provider, env: key, origin: l.origin });
            await hostRef.current?.emit(info, { type: "sandbox_acquired", sandboxId: l.sandbox.id, provider: l.sandbox.provider, env: key, origin: l.origin }).catch(() => {});
            return l;
          },
          (err) => {
            slot.acquiring = null; // let a later tool call retry instead of replaying this rejection
            throw err;
          },
        );
      return (await slot.acquiring).sandbox;
    },
  };

  // Newest user.message seq this run has seen (folded or steered); finishRun uses it to spot stragglers.
  let consumedSeq = 0;
  const wallClock = setTimeout(() => {
    if (loopDone) return;
    stopReason = "error";
    abort.abort();
  }, env.RUN_TIMEOUT_MS);

  const info: SessionInfo = { sessionId, agentId: session.agent.id, workspaceId: workspace.id };
  let detachPlugins: (() => void) | null = null;
  let turns = 0;
  let memoryStores: Mounted[] = [];
  let host: PluginHost | null = null;
  const hostRef: { current: PluginHost | null } = { current: null };
  let ownHost = false; // sandbox-hosted: started for this run, stopped with it

  try {
    const folded = await foldEvents(await deps.listEvents(sessionId), deps.files);
    const { seqOf } = folded;
    let messages = folded.messages;
    let lastSummary = folded.summary;
    consumedSeq = folded.lastSeq;
    const model = resolveModel(deps.models, session.agent.model);
    const compaction = settingsFromEnv();

    /** Compact `msgs` if over budget; persists the event and returns the new message list (or the same one). */
    const maybeCompact = async (msgs: AgentMessage[]): Promise<AgentMessage[]> => {
      if (!needsCompaction(msgs, model, compaction)) return msgs;
      const pre = await hostRef.current?.emit(info, { type: "before_compact", contextTokens: contextTokens(msgs), contextWindow: model.contextWindow, messageCount: msgs.length });
      if (pre?.cancel) return msgs;
      console.log(`[compaction ${sessionId}] ${contextTokens(msgs)} tokens > ${model.contextWindow} - ${compaction.reserveTokens}; compacting ${msgs.length} messages`);
      // before_compact override: a plugin may supply the summary and/or the keep budget.
      const settings = pre?.keepRecentTokens ? { ...compaction, keepRecentTokens: pre.keepRecentTokens } : compaction;
      const r = await compactMessages({ messages: msgs, model, streamFn: deps.models.streamSimple.bind(deps.models), settings, previousSummary: lastSummary, signal: abort.signal, instructions: pre?.instructions, summaryOverride: pre?.summary }).catch((e) => {
        console.warn(`[compaction ${sessionId}] failed: ${e instanceof Error ? e.message : e}`);
        return null;
      });
      if (!r) return msgs;
      const firstKept = msgs[r.firstKeptIndex]!;
      const firstKeptSeq = seqOf.get(firstKept);
      if (firstKeptSeq === undefined) { console.warn(`[compaction ${sessionId}] first kept message has no seq; skipping`); return msgs; }
      const [ev] = await deps.appendEvents(sessionId, [{ type: "agent.thread_context_compacted", summary: r.summary, first_kept_seq: firstKeptSeq, tokens_before: r.tokensBefore, tokens_after: r.tokensAfter }]);
      await deps.publish({ type: "event", event: ev! });
      seqOf.set(r.messages[0]!, ev!.seq);
      lastSummary = r.summary;
      console.log(`[compaction ${sessionId}] ${r.tokensBefore} -> ${r.tokensAfter} tokens, kept from seq ${firstKeptSeq}`);
      await hostRef.current?.emit(info, { type: "after_compact", summary: r.summary, tokensBefore: r.tokensBefore, tokensAfter: r.tokensAfter });
      return r.messages;
    };
    // History may already be over budget (long session resumed): compact before the first request.
    messages = await maybeCompact(messages);
    const plugins = await deps.pluginsFor(session.agent);
    const builtinTools = createTools(session.agent.tools, ctx);

    /** Fold a child's event log into a status: finished?, last report, progress updates, pending question. */
    const childStatus = async (childId: SessionId) => {
      const c = await deps.getSession(childId);
      if (!c) throw new Error(`child session ${childId} not found`);
      const evs = await deps.listEvents(childId);
      let lastReport: string | undefined; const updates: string[] = []; let pendingQuestion: { id: string; text: string } | undefined; let stopReason: string | undefined; let ran = false;
      for (const ev of evs) {
        const p = ev.payload;
        if (p.type === "session.status_running") ran = true;
        if (p.type === "session.status_idle") stopReason = p.stop_reason;
        if (p.type === "agent.thread_message_sent" && p.to_session_id === sessionId) {
          const text = blocksText(p.content);
          if (p.kind === "report") lastReport = text;
          else if (p.kind === "update") updates.push(text);
          else if (p.kind === "question") pendingQuestion = { id: p.question_id ?? "", text };
        }
        if (p.type === "user.message" && pendingQuestion && blocksText(p.content).startsWith(`[reply to question ${pendingQuestion.id}]`)) pendingQuestion = undefined;
        if (p.type === "agent.message" && !lastReport) { const t = blocksText(p.content); if (t) lastReport = t; }
      }
      const finished = c.status === "terminated" || (c.status === "idle" && ran);
      return { sessionId: childId, status: c.status, finished, stopReason, lastReport, updates, pendingQuestion };
    };
    if (plugins.manifests.length > 0) {
      if (environment.plugin_host === "sandbox" && environment.provider !== "local") {
        // Plugins live in the sandbox: lease it now (the host needs a process to run in).
        const sb = await ctx.sandbox("main");
        host = await PluginHost.startInSandbox(sb, await plugins.bundle(), { agentId: session.agent.id });
        ownHost = true;
        for (const w of host.warnings) console.warn(`[plugins ${sessionId}] ${w}`);
      } else {
        if (environment.plugin_host === "sandbox") console.warn(`[plugins ${sessionId}] plugin_host=sandbox ignored for the local provider (no isolation); using the runner host`);
        host = await plugins.runnerHost();
      }
    }
    hostRef.current = host;

    // Skill resources (DB) join package skills; memories and document attachments need the main
    // sandbox, so they force an early lease when present.
    const dbSkills = await deps.getSkills(session.agent.skills ?? []);
    memoryStores = await deps.getMemoryStores(session.memory_stores ?? []);
    if (folded.attachments.length > 0 || memoryStores.length > 0) {
      const sb = await ctx.sandbox("main");
      if (folded.attachments.length > 0) await writeAttachments(sb, folded.attachments, deps.files);
      if (memoryStores.length > 0) await mountMemories(sb, memoryStores);
    }

    // ---- capabilities plugins may call back into (all scoped to this session) ----
    // Plugin store owner per scope: per-agent (default), per-workspace, or per-principal (tenant-wide).
    const storeOwner = (scope: string) => (scope === "workspace" ? workspace.id : scope === "principal" ? session.owner_id : session.agent.id);
    // Plugin fetch allowlist: the owning principal's policy if set, else the deployment default.
    const fetchAllow = ((await deps.principalFetchAllow?.(session.owner_id)) ?? env.PLUGIN_FETCH_ALLOW).split(",").map((s) => s.trim()).filter(Boolean);
    const caps: Capabilities = {
      sandboxEnvs: () => [...envs.keys()],
      async sandboxExec(command, opts) {
        const sb = await ctx.sandbox(opts.env);
        let stdout = "", stderr = "", code = -1;
        for await (const c of sb.exec(command, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? env.BASH_TIMEOUT_MS, signal: abort.signal })) {
          if (c.type === "stdout") stdout += c.data;
          else if (c.type === "stderr") stderr += c.data;
          else code = c.code ?? -1;
        }
        return { stdout: truncateOutput(stdout), stderr: truncateOutput(stderr), code };
      },
      async sandboxRead(p, envKey) { return new TextDecoder().decode(await (await ctx.sandbox(envKey)).readFile(p)); },
      async sandboxWrite(p, content, envKey) { await (await ctx.sandbox(envKey)).writeFile(p, new TextEncoder().encode(content)); },
      storeGet: (key, scope) => deps.pluginStore.get(scope, storeOwner(scope), key),
      storeSet: (key, scope, value) => deps.pluginStore.set(scope, storeOwner(scope), key, value),
      // Read a slice of the durable event log — this session, or another owned by the same principal.
      eventsGet: async (opts) => {
        const sid = opts.sessionId ?? sessionId;
        if (sid !== sessionId) {
          const other = await deps.getSession(sid);
          if (!other || other.owner_id !== session.owner_id) throw new Error(`session ${sid} not found for this owner`);
        }
        let evs = await deps.listEvents(sid);
        if (typeof opts.since === "number") evs = evs.filter((e) => e.seq > opts.since!);
        if (typeof opts.limit === "number") evs = evs.slice(-opts.limit);
        return evs.map((e) => ({ seq: e.seq, type: e.type, payload: e.payload }));
      },
      async modelComplete(prompt, opts) {
        const user: UserMessage = { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() };
        const r = await deps.models.complete(model, { systemPrompt: opts.system, messages: [user] }, { maxTokens: opts.maxTokens, signal: abort.signal });
        if (r.stopReason === "error") throw new Error(r.errorMessage ?? "model error");
        return blocksText(r.content);
      },
      async agentRun(task, opts) {
        if (opts.isolated) {
          // A real child session on a forked workspace with its own sandbox; runs on any runner slot.
          const e = envs.get(opts.env ?? "main");
          if (!e) throw new Error(`no environment ${opts.env} attached`);
          const child = await deps.children.spawn(session, { key: e.key, environment_id: e.environment.id, workspace_id: e.workspace.id }, task, { system: opts.system, tools: opts.tools, maxTurns: opts.maxTurns });
          await emit({ type: "session.thread_created", child_session_id: child.id, env: e.key, task });
          const done = await deps.children.wait(child.id, abort.signal);
          const childEvents = await deps.listEvents(child.id);
          const lastMsg = [...childEvents].reverse().find((ev) => ev.type === "agent.message");
          const report = lastMsg && lastMsg.payload.type === "agent.message" ? blocksText(lastMsg.payload.content) : "(no report)";
          const idle = [...childEvents].reverse().find((ev) => ev.type === "session.status_idle");
          const stop: StopReason = idle && idle.payload.type === "session.status_idle" ? idle.payload.stop_reason : done.status === "terminated" ? "error" : "end_turn";
          const childWs = await deps.getWorkspace(child.workspace_id);
          const patch = childWs?.ref.kind === "git" ? childWs.ref.patch : undefined;
          await emit({ type: "agent.thread_message_received", child_session_id: child.id, from_session_id: child.id, kind: "report", content: [{ type: "text", text: report }], stop_reason: stop, patch });
          return { report, patch, sessionId: child.id };
        }
        // A nested loop in the same sandbox with the builtin tools only (no plugin tools: no recursion).
        const allowed = opts.tools ? builtinTools.filter((t) => opts.tools!.includes(t.name)) : builtinTools;
        const sub: AgentContext = { systemPrompt: opts.system ?? DEFAULT_SYSTEM_PROMPT, messages: [], tools: allowed };
        let turns = 0;
        let last = "";
        const cfg: AgentLoopConfig = {
          model,
          convertToLlm,
          toolExecution: "sequential",
          shouldStopAfterTurn: ({ toolResults }) => { turns++; return toolResults.length > 0 && turns >= (opts.maxTurns ?? 10); },
        };
        const prompt: UserMessage = { role: "user", content: [{ type: "text", text: task }], timestamp: Date.now() };
        await runAgentLoop([prompt], sub, cfg, async (ev) => {
          if (ev.type === "message_end" && ev.message.role === "assistant") last = blocksText(ev.message.content);
        }, abort.signal, deps.models.streamSimple.bind(deps.models));
        return last;
      },
      async fetch(url, init) {
        if (!isAllowedUrl(url, fetchAllow)) throw new Error(`fetch blocked by the principal's fetch allowlist: ${url}`);
        const r = await globalThis.fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) });
        const headers: Record<string, string> = {};
        r.headers.forEach((v, k) => { headers[k] = v; });
        return { status: r.status, headers, body: truncateOutput(await r.text(), 200_000) };
      },
      log: (args) => console.log(`[plugin ${sessionId}]`, ...args),
      // ---- multi-agent: children as handles ----
      agentsSpawn: async (task, o) => {
        const e = envs.get((o.env as string | undefined) ?? "main");
        if (!e) throw new Error(`no environment ${String(o.env)} attached`);
        const model = typeof o.model === "string" ? { provider: o.model.split("/")[0]!, id: o.model.split("/").slice(1).join("/") } : undefined;
        const child = await deps.children.spawn(session, { key: e.key, environment_id: e.environment.id, workspace_id: e.workspace.id }, task, { system: o.system as string | undefined, model, tools: o.tools as string[] | undefined, shareWorkspace: !!o.shareWorkspace, name: o.name as string | undefined, role: o.role as string | undefined, maxTurns: o.maxTurns as number | undefined });
        await emit({ type: "session.thread_created", child_session_id: child.id, env: e.key, task, role: o.role as string | undefined, name: o.name as string | undefined });
        return { sessionId: child.id, name: o.name as string | undefined, role: o.role as string | undefined };
      },
      agentsWait: async (child, o) => { await deps.children.wait(child, abort.signal, o); return childStatus(child); },
      agentsStatus: (child) => childStatus(child),
      agentsSteer: async (child, text) => {
        await deps.children.message(child, text);
        await emit({ type: "agent.thread_message_sent", to_session_id: child, kind: "steer", content: [{ type: "text", text }] });
      },
      agentsReply: async (child, questionId, text) => {
        await deps.children.message(child, `[reply to question ${questionId}] ${text}`);
        await emit({ type: "agent.thread_message_sent", to_session_id: child, kind: "reply", content: [{ type: "text", text }], question_id: questionId });
      },
      agentsStop: (child) => deps.children.stop(child),
      agentsList: async () => Promise.all((await deps.children.list(sessionId)).map((c) => childStatus(c.id))),
      agentsPatch: async (child) => { const c = await deps.getSession(child); const ws = c ? await deps.getWorkspace(c.workspace_id) : null; return ws?.ref.kind === "git" ? ws.ref.patch ?? null : null; },
      sessionNote: async (plugin, text) => { await emit({ type: "plugin.message", plugin, content: [{ type: "text", text }] }); },
      sessionSend: async (text) => { await deps.pushSteer(sessionId, text); },
      sessionInterrupt: async () => { stopReason = "interrupted"; abort.abort(); },
    };
    detachPlugins = host?.attach(info, caps) ?? null;

    const tools: AgentTool[] = [...builtinTools, ...(host?.agentTools(info) ?? [])];
    if (session.parent_id) tools.push(reportToParentTool(session.parent_id, emit, () => { stopReason = "end_turn"; abort.abort(); }));
    // Client/function tools (OpenAI Agents API): results supplied by the API caller via tool_result.
    for (const decl of session.agent.client_tools ?? []) {
      tools.push(clientTool(decl, (callId, sig) => deps.awaitToolResult(sessionId, callId, sig, env.CLIENT_TOOL_WAIT_MS)));
    }
    // Remote MCP servers: connect and register their tools (server-side; gated by the fetch allowlist).
    if (session.agent.mcp_servers?.length) tools.push(...(await mcpTools(session.agent.mcp_servers, fetchAllow, isAllowedUrl, emit)));
    const allSkills = [...plugins.skills, ...dbSkills];
    const st = skillTool(allSkills, plugins.prompts);
    if (st) tools.push(st);
    // The prompt is the user's text plus minimal sections; plugins contribute through {{plugins}}.
    const sections: PromptSections = {
      skills: allSkills.map((x) => ({ name: x.name, description: x.description })),
      prompts: plugins.prompts.map((x) => ({ name: x.name, description: x.description })),
      memory: memoryStores.map((m) => ({ mount_path: m.mount_path, description: m.store.description || undefined })),
    };
    let userSystem: string = session.agent.system ?? "";
    let pluginText = ""; // from before_agent_start (whole run)
    const baseSystemPrompt = renderSystemPrompt(userSystem, sections);
    const systemPromptFor = async (msgs: AgentMessage[]): Promise<string> => {
      const r = await host?.emit(info, { type: "context", systemPrompt: baseSystemPrompt, messageCount: msgs.length, contextTokens: contextTokens(msgs), contextWindow: model.contextWindow });
      const plug = [pluginText, r?.appendSystemPrompt ?? ""].filter(Boolean).join("\n\n");
      return renderSystemPrompt(userSystem, { ...sections, plugins: plug });
    };

    await host?.emit(info, { type: "session_start", sessionId });

    // The trigger (last user message) passes through `input` hooks and slash-command dispatch.
    // A command answers the user directly (plugin.message) and may or may not send a prompt on.
    const trigger = messages[messages.length - 1];
    let skipModel = false;
    if (trigger?.role === "user") {
      let text = userText(trigger);
      const cmd = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
      if (cmd && host?.commands.some((c) => c.name === cmd[1])) {
        const r = await host.runCommand(info, cmd[1]!, cmd[2] ?? "");
        if (r.reply) await emit({ type: "plugin.message", plugin: `/${cmd[1]}`, content: [{ type: "text", text: r.reply }] });
        if (r.send) text = r.send; else skipModel = true;
      }
      if (!skipModel) {
        const r = await host?.emit(info, { type: "input", text, source: "user" });
        if (r?.cancel) skipModel = true;
        else if (r?.text !== undefined && r.text !== text) text = r.text;
      }
      if (!skipModel && text !== userText(trigger)) {
        const rewritten: UserMessage = { role: "user", content: [{ type: "text", text }], timestamp: trigger.timestamp };
        const seq = seqOf.get(trigger);
        if (seq !== undefined) seqOf.set(rewritten, seq);
        messages = [...messages.slice(0, -1), rewritten];
      }
      if (!skipModel) {
        const pre = await host?.emit(info, { type: "before_agent_start", systemPrompt: baseSystemPrompt, messageCount: messages.length, trigger: text });
        if (pre?.systemPrompt) userSystem = pre.systemPrompt;
        if (pre?.appendSystemPrompt) pluginText = pre.appendSystemPrompt;
        if (pre?.injectMessage) {
          const injected: UserMessage = { role: "user", content: [{ type: "text", text: pre.injectMessage }], timestamp: Date.now() };
          const seq = seqOf.get(messages[messages.length - 1]!);
          if (seq !== undefined) seqOf.set(injected, seq);
          messages = [...messages.slice(0, -1), injected, messages[messages.length - 1]!];
        }
      }
    }
    const context: AgentContext = { systemPrompt: await systemPromptFor(messages), messages, tools };
    await deps.recordSystemPrompt(sessionId, context.systemPrompt);
    const config: AgentLoopConfig = {
      model,
      convertToLlm,
      toolExecution: "sequential",
      getSteeringMessages: async () => {
        const out: UserMessage[] = [];
        for (const st of (await deps.popSteer(sessionId)).filter((x) => x.seq > consumedSeq)) {
          consumedSeq = Math.max(consumedSeq, st.seq);
          let text = blocksText(textBlocks(st.content));
          const r = await host?.emit(info, { type: "input", text, source: "steer" });
          if (r?.cancel) continue;
          if (r?.text !== undefined) text = r.text;
          const m: UserMessage = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
          seqOf.set(m, st.seq);
          out.push(m);
        }
        return out;
      },
      beforeToolCall: async ({ toolCall, args }) => {
        const r = await host?.emit(info, { type: "tool_call", toolName: toolCall.name, toolCallId: toolCall.id, input: args });
        if (r?.block) return { block: true, reason: r.reason ?? `blocked by plugin` };
        // pi-agent-core validates args before this hook and passes the object by reference:
        // mutate it in place so a rewritten input reaches the tool.
        if (r?.input && typeof r.input === "object" && args && typeof args === "object") {
          for (const k of Object.keys(args as object)) delete (args as Record<string, unknown>)[k];
          Object.assign(args as object, r.input as object);
        }
        return undefined;
      },
      afterToolCall: async ({ toolCall, args, result, isError }) => {
        // The hook sees and may rewrite the full structured result (text + inline image blocks), not
        // a flattened string; text round-trips into the persisted event, images reach the model.
        const r = await host?.emit(info, { type: "tool_result", toolName: toolCall.name, toolCallId: toolCall.id, input: args, content: result.content, isError });
        if (!r || (r.content === undefined && r.isError === undefined)) return undefined;
        return { content: r.content, isError: r.isError };
      },
      prepareNextTurn: async ({ context: c }) => {
        const compacted = await maybeCompact(c.messages);
        const systemPrompt = host?.hooks.has("context") ? await systemPromptFor(compacted) : c.systemPrompt;
        return compacted !== c.messages || systemPrompt !== c.systemPrompt ? { context: { ...c, messages: compacted, systemPrompt } } : undefined;
      },
      shouldStopAfterTurn: async ({ toolResults }) => {
        turns++;
        const te = await host?.emit(info, { type: "turn_end", turn: turns, toolCalls: toolResults.length });
        if (te?.stop) {
          await emit({ type: "plugin.message", plugin: "hook:turn_end", content: [{ type: "text", text: `run stopped by plugin${te.reason ? `: ${te.reason}` : ""}` }] });
          return true;
        }
        if (toolResults.length > 0 && turns >= env.MAX_TURNS) {
          stopReason = "max_turns";
          return true;
        }
        if (toolResults.length > 0) await host?.emit(info, { type: "turn_start", turn: turns + 1 });
        return false;
      },
    };

    // Every assistant message gets a stream id: its deltas and its persisted agent.message share it,
    // so a client that reconnects mid-stream can attach late deltas and finalize the right message.
    let streamSeq = 0;
    let streamId = "";
    const sink = async (ev: AgentEvent) => {
      switch (ev.type) {
        case "message_start":
          if (ev.message.role === "assistant") {
            streamId = `${sessionId}:${Date.now().toString(36)}:${++streamSeq}`;
            await host?.emit(info, { type: "model_request_start", model: `${model.provider}/${model.id}`, messageCount: context.messages.length, contextTokens: contextTokens(context.messages) }).catch(() => {});
          }
          break;
        case "message_update": {
          const e = ev.assistantMessageEvent;
          // Stream-only previews (never persisted): text, reasoning, and tool-call argument fragments.
          if (e.type === "text_delta") await deps.publish({ type: "agent.message_delta", session_id: sessionId, stream_id: streamId, text: e.delta });
          else if (e.type === "thinking_delta") await deps.publish({ type: "agent.thinking_delta", session_id: sessionId, stream_id: streamId, text: e.delta });
          else if (e.type === "toolcall_start") {
            const block = e.partial.content[e.contentIndex];
            await deps.publish({ type: "agent.tool_use_start", session_id: sessionId, stream_id: streamId, index: e.contentIndex, name: block?.type === "toolCall" ? block.name : "tool" });
          } else if (e.type === "toolcall_delta") await deps.publish({ type: "agent.tool_use_delta", session_id: sessionId, stream_id: streamId, index: e.contentIndex, text: e.delta });
          break;
        }
        case "tool_execution_start":
          await emit({ type: "agent.tool_use", tool_use_id: ev.toolCallId, name: ev.toolName, input: ev.args });
          break;
        case "message_end": {
          const m = ev.message;
          if (m.role === "assistant") {
            const [ev2] = await deps.appendEvents(sessionId, [{ type: "agent.message", content: toContentBlocks(m), pi: m, stream_id: streamId, thinking: thinkingText(m) || undefined }]);
            seqOf.set(m, ev2!.seq);
            await publishAll([ev2!]);
            // Usage is first-class: one span per model request, cumulative counters on the session.
            const u = (m as { usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens?: number } }).usage;
            if (u && (u.input || u.output || u.cacheRead)) {
              const carried = u.totalTokens && u.totalTokens > 0 ? u.totalTokens : u.input + u.cacheRead + u.cacheWrite + u.output;
              const usage = { input: u.input, output: u.output, cache_read: u.cacheRead, cache_write: u.cacheWrite, total_tokens: carried };
              const context: ContextSize = { tokens: carried, window: model.contextWindow, ratio: model.contextWindow ? Math.min(1, carried / model.contextWindow) : 0, model: `${model.provider}/${model.id}` };
              await deps.recordUsage(sessionId, usage, context);
              await emit({ type: "span.model_request_end", model: context.model, usage, context, stop_reason: m.stopReason });
              await host?.emit(info, { type: "model_request_end", model: context.model, stopReason: m.stopReason, usage: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, totalTokens: carried }, contextTokens: carried, contextWindow: model.contextWindow }).catch(() => {});
            }
            await host?.emit(info, { type: "message_end", text: blocksText(m.content), thinking: thinkingText(m) || undefined, toolCalls: m.content.flatMap((c) => (c.type === "toolCall" ? [{ id: c.id, name: c.name, input: c.arguments }] : [])), stopReason: m.stopReason }).catch(() => {});
            // pi-ai reports "error" (not "aborted") when the signal was already aborted before the
            // request started — e.g. an interrupt that landed during the previous tool call.
            if (m.stopReason === "aborted" || (m.stopReason === "error" && abort.signal.aborted)) {
              if (stopReason === "end_turn") stopReason = "interrupted";
            } else if (m.stopReason === "error") {
              stopReason = "error";
              await emit({ type: "session.error", error: { type: "model_error", message: m.errorMessage ?? "unknown model error" } });
            }
          } else if (m.role === "toolResult") {
            const [ev2] = await deps.appendEvents(sessionId, [{ type: "agent.tool_result", tool_use_id: m.toolCallId, content: textBlocks(m.content), is_error: m.isError, pi: m }]);
            seqOf.set(m, ev2!.seq);
            await publishAll([ev2!]);
          }
          break;
        }
      }
    };

    // A log ending in an assistant message has nothing to continue from (duplicate job for an
    // already-answered message): end the turn quietly instead of letting pi throw.
    const nothingToDo = skipModel || (messages.length > 0 && messages[messages.length - 1]!.role === "assistant");
    if (!nothingToDo) {
      await host?.emit(info, { type: "turn_start", turn: 1 });
      await runAgentLoopContinue(context, config, sink, abort.signal, deps.models.streamSimple.bind(deps.models));
    }
  } catch (err) {
    if (abort.signal.aborted) {
      if (stopReason === "end_turn") stopReason = "interrupted";
    } else {
      stopReason = "error";
      const e = err instanceof Error ? err : new Error(String(err));
      await emit({ type: "session.error", error: { type: e.name, message: e.message } });
      await hostRef.current?.emit(info, { type: "error", errorType: e.name, message: e.message }).catch(() => {});
    }
  } finally {
    loopDone = true;
    clearTimeout(wallClock);
    await unsubscribe();
    await host?.emit(info, { type: "session_end", sessionId, stopReason, turns }).catch(() => {});
    detachPlugins?.();
    if (ownHost) host?.stop();
    if (stopReason === "error" && abort.signal.aborted) {
      await emit({ type: "session.error", error: { type: "run_timeout", message: `run exceeded RUN_TIMEOUT_MS (${env.RUN_TIMEOUT_MS})` } });
    }
    // Every environment that leased a sandbox: capture its workspace, then release. An acquire
    // still in flight when the loop ended must be awaited so its lease gets released too.
    for (const [key, slot] of held) {
      const lease = slot.lease ?? (await slot.acquiring?.catch(() => null)) ?? null;
      if (!lease) continue;
      const e = envs.get(key)!;
      if (key === "main" && memoryStores.length > 0) {
        try {
          for (const { id, ref } of await syncMemoriesBack(lease.sandbox, memoryStores)) await deps.updateMemoryRef(id, ref);
        } catch (err) {
          await emit({ type: "session.error", error: { type: "memory_sync_failed", message: err instanceof Error ? err.message : String(err) } });
        }
      }
      try {
        const ref = await deps.sandboxFor(e.environment.provider).capture(lease.sandbox, e.workspace.ref);
        await emit({ type: "workspace.captured", ref: redactRef(ref), workspace_id: e.workspace.id, env: key });
        await hostRef.current?.emit(info, { type: "workspace_captured", env: key, workspaceId: e.workspace.id, refKind: ref.kind }).catch(() => {});
        if (!(await deps.updateWorkspaceRef(e.workspace.id, ref, e.workspace.ref))) {
          await emit({ type: "session.error", error: { type: "capture_conflict", message: `workspace ${e.workspace.id} (${key}) changed during the run (another session captured first); this run's capture was not saved` } });
        }
      } catch (err) {
        const err2 = err instanceof Error ? err : new Error(String(err));
        await emit({ type: "session.error", error: { type: "capture_failed", message: `${key}: ${err2.message}` } });
      } finally {
        await lease.release();
        await emit({ type: "sandbox.released", sandbox_id: lease.sandbox.id, env: key });
        await hostRef.current?.emit(info, { type: "sandbox_released", sandboxId: lease.sandbox.id, provider: lease.sandbox.provider, env: key }).catch(() => {});
      }
    }
  }
  // Stragglers (user messages steered after the last pop) are detected by seq inside finishRun;
  // whatever is left in the steer list is deduped by seq on the next run.
  const finished = await deps.finishRun(sessionId, stopReason, consumedSeq);
  await publishAll(finished.events);
  return { status: "done", stopReason, unconsumedSeq: finished.unconsumedSeq };
}
