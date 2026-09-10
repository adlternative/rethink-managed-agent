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
  SandboxService,
  SessionEvent,
  SessionEventPayload,
  SessionId,
  SessionResource,
  StopReason,
  StreamDelta,
  WorkspaceId,
  WorkspaceRef,
  WorkspaceResource,
} from "../shared/types.ts";
import type { PromptTemplate, Skill } from "../plugins/api.ts";
import type { Capabilities, PluginHost } from "../plugins/client.ts";
import type { SessionInfo } from "../plugins/protocol.ts";
import { foldEvents, toContentBlocks } from "./fold.ts";
import { resolveModel } from "./models.ts";
import { createTools, truncateOutput, type ToolContext } from "./tools.ts";

export type Unsubscribe = () => void | Promise<void>;

/** A user message persisted while the session was running. */
export interface SteerMessage {
  seq: number;
  content: ContentBlock[];
}

/** Plugins resolved for an agent: a running host (or none) plus package content. */
export interface AgentPlugins {
  host: PluginHost | null;
  skills: Skill[];
  prompts: PromptTemplate[];
}

/** Everything runSession needs from the outside world; no DB/Redis code lives here. */
export interface RunDeps {
  models: Models;
  sandboxes: SandboxService;
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
  const workspace = await deps.getWorkspace(session.workspace_id);
  if (!workspace) throw new Error(`Workspace not found: ${session.workspace_id}`);
  const environment = await deps.getEnvironment(session.environment_id);
  if (!environment) throw new Error(`Environment not found: ${session.environment_id}`);

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

  // Held in an object because the lease is set from inside a closure and read in `finally`.
  const held: { lease: SandboxLease | null; acquiring: Promise<SandboxLease> | null } = { lease: null, acquiring: null };
  const ctx: ToolContext = {
    signal: abort.signal,
    sandbox: async () => {
      held.acquiring ??= deps.sandboxes
        .acquire({ workspaceId: workspace.id, workspaceRef: workspace.ref, image: environment.image, affinity: workspace.id })
        .then(
          async (l) => {
            held.lease = l;
            await emit({ type: "sandbox.acquired", sandbox_id: l.sandbox.id, provider: l.sandbox.provider });
            return l;
          },
          (e) => {
            held.acquiring = null; // let a later tool call retry instead of replaying this rejection
            throw e;
          },
        );
      return (await held.acquiring).sandbox;
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
  let plugins: AgentPlugins = { host: null, skills: [], prompts: [] };

  try {
    const { messages, lastSeq } = foldEvents(await deps.listEvents(sessionId));
    consumedSeq = lastSeq;
    const model = resolveModel(deps.models, session.agent.model);
    plugins = await deps.pluginsFor(session.agent);
    const host = plugins.host;
    const builtinTools = createTools(session.agent.tools, ctx);

    // ---- capabilities plugins may call back into (all scoped to this session) ----
    const caps: Capabilities = {
      async sandboxExec(command, opts) {
        const sb = await ctx.sandbox();
        let stdout = "", stderr = "", code = -1;
        for await (const c of sb.exec(command, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? env.BASH_TIMEOUT_MS, signal: abort.signal })) {
          if (c.type === "stdout") stdout += c.data;
          else if (c.type === "stderr") stderr += c.data;
          else code = c.code ?? -1;
        }
        return { stdout: truncateOutput(stdout), stderr: truncateOutput(stderr), code };
      },
      async sandboxRead(p) { return new TextDecoder().decode(await (await ctx.sandbox()).readFile(p)); },
      async sandboxWrite(p, content) { await (await ctx.sandbox()).writeFile(p, new TextEncoder().encode(content)); },
      storeGet: (key, scope) => deps.pluginStore.get(scope, scope === "agent" ? session.agent.id : workspace.id, key),
      storeSet: (key, scope, value) => deps.pluginStore.set(scope, scope === "agent" ? session.agent.id : workspace.id, key, value),
      async modelComplete(prompt, opts) {
        const user: UserMessage = { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() };
        const r = await deps.models.complete(model, { systemPrompt: opts.system, messages: [user] }, { maxTokens: opts.maxTokens, signal: abort.signal });
        if (r.stopReason === "error") throw new Error(r.errorMessage ?? "model error");
        return blocksText(r.content);
      },
      async agentRun(task, opts) {
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
            return { role: "user", content: textBlocks(s.content), timestamp: Date.now() };
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
      prepareNextTurn: async ({ context: c }) => (host?.hooks.has("context") ? { context: { ...c, systemPrompt: await systemPromptFor(c.messages.length) } } : undefined),
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
        case "message_update":
          if (ev.assistantMessageEvent.type === "text_delta") {
            await deps.publish({ type: "agent.message_delta", session_id: sessionId, text: ev.assistantMessageEvent.delta });
          }
          break;
        case "tool_execution_start":
          await emit({ type: "agent.tool_use", tool_use_id: ev.toolCallId, name: ev.toolName, input: ev.args });
          break;
        case "message_end": {
          const m = ev.message;
          if (m.role === "assistant") {
            await emit({ type: "agent.message", content: toContentBlocks(m), pi: m });
            // pi-ai reports "error" (not "aborted") when the signal was already aborted before the
            // request started — e.g. an interrupt that landed during the previous tool call.
            if (m.stopReason === "aborted" || (m.stopReason === "error" && abort.signal.aborted)) {
              if (stopReason === "end_turn") stopReason = "interrupted";
            } else if (m.stopReason === "error") {
              stopReason = "error";
              await emit({ type: "session.error", error: { type: "model_error", message: m.errorMessage ?? "unknown model error" } });
            }
          } else if (m.role === "toolResult") {
            await emit({ type: "agent.tool_result", tool_use_id: m.toolCallId, content: textBlocks(m.content), is_error: m.isError, pi: m });
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
    await plugins.host?.emit(info, { type: "session_end", sessionId, stopReason }).catch(() => {});
    detachPlugins?.();
    if (stopReason === "error" && abort.signal.aborted) {
      await emit({ type: "session.error", error: { type: "run_timeout", message: `run exceeded RUN_TIMEOUT_MS (${env.RUN_TIMEOUT_MS})` } });
    }
    // An acquire still in flight when the loop ended must be awaited so its lease gets released.
    const lease = held.lease ?? (await held.acquiring?.catch(() => null)) ?? null;
    if (lease) {
      try {
        const ref = await deps.sandboxes.capture(lease.sandbox, workspace.ref);
        await emit({ type: "workspace.captured", ref: redactRef(ref) });
        if (!(await deps.updateWorkspaceRef(workspace.id, ref, workspace.ref))) {
          await emit({ type: "session.error", error: { type: "capture_conflict", message: "workspace ref changed during the run (another session captured first); this run's capture was not saved" } });
        }
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        await emit({ type: "session.error", error: { type: "capture_failed", message: e.message } });
      } finally {
        await lease.release();
        await emit({ type: "sandbox.released", sandbox_id: lease.sandbox.id });
      }
    }
  }
  // Stragglers (user messages steered after the last pop) are detected by seq inside finishRun;
  // whatever is left in the steer list is deduped by seq on the next run.
  const finished = await deps.finishRun(sessionId, stopReason, consumedSeq);
  await publishAll(finished.events);
  return { status: "done", stopReason, unconsumedSeq: finished.unconsumedSeq };
}
