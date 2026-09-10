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
import { Type } from "typebox";
import { env } from "../shared/env.ts";
import type {
  ContentBlock,
  EnvironmentResource,
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
} from "../shared/types.ts";
import type { PackageManifest, PromptTemplate, Skill } from "../plugins/api.ts";
import { PluginHost, type Capabilities } from "../plugins/client.ts";
import type { HostBundle } from "../plugins/bundle.ts";
import type { SessionInfo } from "../plugins/protocol.ts";
import { foldEvents, toContentBlocks } from "./fold.ts";
import { compactMessages, contextTokens, needsCompaction, settingsFromEnv } from "./compaction.ts";
import { resolveModel } from "./models.ts";
import { createTools, truncateOutput, type ToolContext } from "./tools.ts";

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
/** A child session created for `ctx.agent.run({ isolated: true })`. */
export interface ChildSpawn {
  /** Fork the env's workspace, create the child session (parent_id set), post the task, enqueue it. */
  spawn(parent: SessionResource, env: SessionEnvironment, task: string, system?: string): Promise<SessionResource>;
  /** Resolve when the child is idle/terminated (polls); rejects on abort. */
  wait(childId: SessionId, signal: AbortSignal): Promise<SessionResource>;
}

export interface RunDeps {
  models: Models;
  /** Sandbox service for a provider; a session's environments may span providers. */
  sandboxFor(provider: SandboxProviderName): SandboxService;
  children: ChildSpawn;
  /** Plugin host + content for this agent (cached by the runner). */
  pluginsFor(agent: SessionResource["agent"]): Promise<AgentPlugins>;
  pluginStore: { get(scope: string, owner: string, key: string): Promise<unknown>; set(scope: string, owner: string, key: string, value: unknown): Promise<void> };
  /** Append events (seq assigned by the store). Must NOT publish; runSession publishes each appended event. */
  appendEvents(sessionId: SessionId, payloads: SessionEventPayload[]): Promise<SessionEvent[]>;
  /** The whole log, untruncated. */
  listEvents(sessionId: SessionId): Promise<SessionEvent[]>;
  publish(delta: StreamDelta): void | Promise<void>;
  /** Subscribe to interrupt requests for this session; resolves once live; returns an unsubscribe. */
  onInterrupt(sessionId: SessionId, handler: () => void): Unsubscribe | Promise<Unsubscribe>;
  /** Drain user messages queued while the session is running (already persisted as events by the API). */
  popSteer(sessionId: SessionId): Promise<SteerMessage[]>;
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
}

export type RunOutcome = { status: "busy" } | { status: "done"; stopReason: StopReason; unconsumedSeq: number | null };

const DEFAULT_SYSTEM_PROMPT =
  "You are a coding agent working inside a sandboxed workspace. Use the available tools to inspect and change files and to run commands. All paths are relative to the workspace root. Be concise.";

const LLM_ROLES = new Set(["user", "assistant", "toolResult"]);
const convertToLlm = (messages: AgentMessage[]): Message[] => messages.filter((m): m is Message => LLM_ROLES.has(m.role));

function textBlocks(content: { type: string; text?: string }[]): ContentBlock[] {
  return content.flatMap((c) => (c.type === "text" && c.text !== undefined ? [{ type: "text" as const, text: c.text }] : []));
}
const blocksText = (content: { type: string; text?: string }[]) => textBlocks(content).map((b) => b.text).join("");

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

function skillsPrompt(skills: Skill[], prompts: PromptTemplate[]): string {
  const lines: string[] = [];
  if (skills.length) lines.push("Available skills (load one with the `skill` tool before using it):", ...skills.map((s) => `- ${s.name}: ${s.description}`));
  if (prompts.length) lines.push("Available prompt templates (load with the `skill` tool):", ...prompts.map((p) => `- ${p.name}: ${p.description}`));
  return lines.join("\n");
}

function isAllowedUrl(url: string): boolean {
  const allow = env.PLUGIN_FETCH_ALLOW.split(",").map((s) => s.trim()).filter(Boolean);
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
    sandbox: async (key = "main") => {
      const e = envs.get(key);
      if (!e) throw new Error(`no environment ${JSON.stringify(key)} attached to this session (have: ${[...envs.keys()].join(", ")})`);
      let h = held.get(key);
      if (!h) { h = { lease: null, acquiring: null }; held.set(key, h); }
      const slot = h;
      slot.acquiring ??= deps
        .sandboxFor(e.environment.provider)
        .acquire({ workspaceId: e.workspace.id, workspaceRef: e.workspace.ref, image: e.environment.image, network: e.environment.network, affinity: e.workspace.id })
        .then(
          async (l) => {
            slot.lease = l;
            await emit({ type: "sandbox.acquired", sandbox_id: l.sandbox.id, provider: l.sandbox.provider, env: key, origin: l.origin });
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
  let host: PluginHost | null = null;
  let ownHost = false; // sandbox-hosted: started for this run, stopped with it

  try {
    const folded = foldEvents(await deps.listEvents(sessionId));
    const { seqOf } = folded;
    let messages = folded.messages;
    let lastSummary = folded.summary;
    consumedSeq = folded.lastSeq;
    const model = resolveModel(deps.models, session.agent.model);
    const compaction = settingsFromEnv();

    /** Compact `msgs` if over budget; persists the event and returns the new message list (or the same one). */
    const maybeCompact = async (msgs: AgentMessage[]): Promise<AgentMessage[]> => {
      if (!needsCompaction(msgs, model, compaction)) return msgs;
      console.log(`[compaction ${sessionId}] ${contextTokens(msgs)} tokens > ${model.contextWindow} - ${compaction.reserveTokens}; compacting ${msgs.length} messages`);
      const r = await compactMessages({ messages: msgs, model, streamFn: deps.models.streamSimple.bind(deps.models), settings: compaction, previousSummary: lastSummary, signal: abort.signal }).catch((e) => {
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
      return r.messages;
    };
    // History may already be over budget (long session resumed): compact before the first request.
    messages = await maybeCompact(messages);
    const plugins = await deps.pluginsFor(session.agent);
    const builtinTools = createTools(session.agent.tools, ctx);
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

    // ---- capabilities plugins may call back into (all scoped to this session) ----
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
      storeGet: (key, scope) => deps.pluginStore.get(scope, scope === "agent" ? session.agent.id : workspace.id, key),
      storeSet: (key, scope, value) => deps.pluginStore.set(scope, scope === "agent" ? session.agent.id : workspace.id, key, value),
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
          const child = await deps.children.spawn(session, { key: e.key, environment_id: e.environment.id, workspace_id: e.workspace.id }, task, opts.system);
          await emit({ type: "session.thread_created", child_session_id: child.id, env: e.key, task });
          const done = await deps.children.wait(child.id, abort.signal);
          const childEvents = await deps.listEvents(child.id);
          const lastMsg = [...childEvents].reverse().find((ev) => ev.type === "agent.message");
          const report = lastMsg && lastMsg.payload.type === "agent.message" ? blocksText(lastMsg.payload.content) : "(no report)";
          const idle = [...childEvents].reverse().find((ev) => ev.type === "session.status_idle");
          const stop: StopReason = idle && idle.payload.type === "session.status_idle" ? idle.payload.stop_reason : done.status === "terminated" ? "error" : "end_turn";
          const childWs = await deps.getWorkspace(child.workspace_id);
          const patch = childWs?.ref.kind === "git" ? childWs.ref.patch : undefined;
          await emit({ type: "agent.thread_message_received", child_session_id: child.id, content: [{ type: "text", text: report }], stop_reason: stop, patch });
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
          if (ev.type === "tool_execution_start") await deps.publish({ type: "agent.message_delta", session_id: sessionId, text: "" });
        }, abort.signal, deps.models.streamSimple.bind(deps.models));
        return last;
      },
      async fetch(url, init) {
        if (!isAllowedUrl(url)) throw new Error(`fetch blocked by PLUGIN_FETCH_ALLOW: ${url}`);
        const r = await globalThis.fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) });
        const headers: Record<string, string> = {};
        r.headers.forEach((v, k) => { headers[k] = v; });
        return { status: r.status, headers, body: truncateOutput(await r.text(), 200_000) };
      },
      log: (args) => console.log(`[plugin ${sessionId}]`, ...args),
    };
    detachPlugins = host?.attach(info, caps) ?? null;

    const tools: AgentTool[] = [...builtinTools, ...(host?.agentTools(info) ?? [])];
    const st = skillTool(plugins.skills, plugins.prompts);
    if (st) tools.push(st);
    const baseSystemPrompt = [session.agent.system ?? DEFAULT_SYSTEM_PROMPT, skillsPrompt(plugins.skills, plugins.prompts)].filter(Boolean).join("\n\n");

    const systemPromptFor = async (messageCount: number): Promise<string> => {
      const r = await host?.emit(info, { type: "context", systemPrompt: baseSystemPrompt, messageCount });
      return r?.appendSystemPrompt ? `${baseSystemPrompt}\n\n${r.appendSystemPrompt}` : baseSystemPrompt;
    };

    await host?.emit(info, { type: "session_start", sessionId });
    const context: AgentContext = { systemPrompt: await systemPromptFor(messages.length), messages, tools };
    let turns = 0;
    const config: AgentLoopConfig = {
      model,
      convertToLlm,
      toolExecution: "sequential",
      getSteeringMessages: async () =>
        (await deps.popSteer(sessionId))
          .filter((s) => s.seq > consumedSeq) // already in the folded log (stale entry from an earlier run)
          .map((s): UserMessage => {
            consumedSeq = Math.max(consumedSeq, s.seq);
            const m: UserMessage = { role: "user", content: textBlocks(s.content), timestamp: Date.now() };
            seqOf.set(m, s.seq);
            return m;
          }),
      beforeToolCall: async ({ toolCall, args }) => {
        const r = await host?.emit(info, { type: "tool_call", toolName: toolCall.name, toolCallId: toolCall.id, input: args });
        return r?.block ? { block: true, reason: r.reason ?? `blocked by plugin` } : undefined;
      },
      afterToolCall: async ({ toolCall, args, result, isError }) => {
        const r = await host?.emit(info, { type: "tool_result", toolName: toolCall.name, toolCallId: toolCall.id, input: args, content: blocksText(result.content), isError });
        if (!r || (r.content === undefined && r.isError === undefined)) return undefined;
        return { content: r.content !== undefined ? [{ type: "text", text: r.content }] : undefined, isError: r.isError };
      },
      prepareNextTurn: async ({ context: c }) => {
        const compacted = await maybeCompact(c.messages);
        const systemPrompt = host?.hooks.has("context") ? await systemPromptFor(compacted.length) : c.systemPrompt;
        return compacted !== c.messages || systemPrompt !== c.systemPrompt ? { context: { ...c, messages: compacted, systemPrompt } } : undefined;
      },
      shouldStopAfterTurn: async ({ toolResults }) => {
        turns++;
        await host?.emit(info, { type: "turn_end", turn: turns });
        if (toolResults.length > 0 && turns >= env.MAX_TURNS) {
          stopReason = "max_turns";
          return true;
        }
        if (toolResults.length > 0) await host?.emit(info, { type: "turn_start", turn: turns + 1 });
        return false;
      },
    };

    const sink = async (ev: AgentEvent) => {
      switch (ev.type) {
        case "message_update": {
          const e = ev.assistantMessageEvent;
          // Stream-only previews (never persisted): text, reasoning, and tool-call argument fragments.
          if (e.type === "text_delta") await deps.publish({ type: "agent.message_delta", session_id: sessionId, text: e.delta });
          else if (e.type === "thinking_delta") await deps.publish({ type: "agent.thinking_delta", session_id: sessionId, text: e.delta });
          else if (e.type === "toolcall_start") {
            const block = e.partial.content[e.contentIndex];
            await deps.publish({ type: "agent.tool_use_start", session_id: sessionId, index: e.contentIndex, name: block?.type === "toolCall" ? block.name : "tool" });
          } else if (e.type === "toolcall_delta") await deps.publish({ type: "agent.tool_use_delta", session_id: sessionId, index: e.contentIndex, text: e.delta });
          break;
        }
        case "tool_execution_start":
          await emit({ type: "agent.tool_use", tool_use_id: ev.toolCallId, name: ev.toolName, input: ev.args });
          break;
        case "message_end": {
          const m = ev.message;
          if (m.role === "assistant") {
            const [ev2] = await deps.appendEvents(sessionId, [{ type: "agent.message", content: toContentBlocks(m), pi: m }]);
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
            }
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
    const nothingToDo = messages.length > 0 && messages[messages.length - 1]!.role === "assistant";
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
    }
  } finally {
    loopDone = true;
    clearTimeout(wallClock);
    await unsubscribe();
    await host?.emit(info, { type: "session_end", sessionId, stopReason }).catch(() => {});
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
      try {
        const ref = await deps.sandboxFor(e.environment.provider).capture(lease.sandbox, e.workspace.ref);
        await emit({ type: "workspace.captured", ref: redactRef(ref), workspace_id: e.workspace.id, env: key });
        if (!(await deps.updateWorkspaceRef(e.workspace.id, ref, e.workspace.ref))) {
          await emit({ type: "session.error", error: { type: "capture_conflict", message: `workspace ${e.workspace.id} (${key}) changed during the run (another session captured first); this run's capture was not saved` } });
        }
      } catch (err) {
        const err2 = err instanceof Error ? err : new Error(String(err));
        await emit({ type: "session.error", error: { type: "capture_failed", message: `${key}: ${err2.message}` } });
      } finally {
        await lease.release();
        await emit({ type: "sandbox.released", sandbox_id: lease.sandbox.id, env: key });
      }
    }
  }
  // Stragglers (user messages steered after the last pop) are detected by seq inside finishRun;
  // whatever is left in the steer list is deduped by seq on the next run.
  const finished = await deps.finishRun(sessionId, stopReason, consumedSeq);
  await publishAll(finished.events);
  return { status: "done", stopReason, unconsumedSeq: finished.unconsumedSeq };
}
