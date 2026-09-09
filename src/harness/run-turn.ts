import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { mkdir } from "node:fs/promises";
import path from "node:path";
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
import { foldEvents, toContentBlocks } from "./fold.ts";
import { createPiSession } from "./pi-session.ts";
import { createTools, type ToolContext } from "./tools.ts";

export type Unsubscribe = () => void | Promise<void>;

/** A user message persisted while the session was running. */
export interface SteerMessage {
  seq: number;
  content: ContentBlock[];
}

/** Everything runSession needs from the outside world; no DB/Redis code lives here. */
export interface RunDeps {
  sandboxes: SandboxService;
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

const blocksText = (content: ContentBlock[]) => content.map((b) => b.text).join("");
function userText(m: AgentMessage): string {
  const c = (m as { content: unknown }).content;
  if (typeof c === "string") return c;
  return (c as { type: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
}

function textBlocks(content: { type: string; text?: string }[]): ContentBlock[] {
  return content.flatMap((c) => (c.type === "text" && c.text !== undefined ? [{ type: "text" as const, text: c.text }] : []));
}

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

/** Run one session turn: claim, fold events, run the pi loop, persist events, capture + release the sandbox. */
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

  const finish = async (): Promise<RunOutcome> => {
    loopDone = true;
    clearTimeout(wallClock);
    await unsubscribe();
    const finished = await deps.finishRun(sessionId, stopReason, consumedSeq);
    await publishAll(finished.events);
    return { status: "done", stopReason, unconsumedSeq: finished.unconsumedSeq };
  };

  let pi: Awaited<ReturnType<typeof createPiSession>> | null = null;
  let steerTimer: NodeJS.Timeout | null = null;
  try {
    const { messages, lastSeq } = foldEvents(await deps.listEvents(sessionId));
    consumedSeq = lastSeq;

    // pi's AgentSession appends the prompt itself, so seed everything before the trailing user message.
    const last = messages[messages.length - 1];
    const promptText = last?.role === "user" ? userText(last) : null;
    const history = promptText !== null ? messages.slice(0, -1) : messages;
    // A log ending in an assistant message has nothing to continue from (duplicate job for an
    // already-answered message): end the turn quietly.
    if (last?.role === "assistant") return await finish();

    // Extensions see `cwd`. The sandbox is leased lazily (maybe never), so cwd cannot be the live
    // sandbox dir: use the persisted workspace copy when it lives on this host (`dir` refs), else a
    // per-workspace scratch dir. Files there are a snapshot from the last capture, not the live tree.
    const cwd = workspace.ref.kind === "dir" ? workspace.ref.path : path.join(env.PI_AGENT_ROOT, "cwd", workspace.id);
    await mkdir(cwd, { recursive: true });
    pi = await createPiSession({
      agent: session.agent,
      cwd,
      history,
      tools: createTools(session.agent.tools, ctx),
      systemPrompt: session.agent.system ?? DEFAULT_SYSTEM_PROMPT,
    });
    if (pi.extensionTools.length) console.log(`[pi] ${sessionId}: extension tools ${pi.extensionTools.join(", ")}`);

    let turns = 0;
    let modelError: string | null = null;
    const unsub = pi.session.subscribe((ev: AgentSessionEvent) => {
      void (async () => {
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
              if (m.stopReason === "error" && !abort.signal.aborted) {
                // pi retries transient provider errors itself; persist only the fact, as one
                // session.error at the end, instead of an empty agent.message per attempt.
                modelError = m.errorMessage ?? "unknown model error";
                break;
              }
              modelError = null;
              await emit({ type: "agent.message", content: toContentBlocks(m), pi: m });
              if (m.stopReason === "aborted" || (m.stopReason === "error" && abort.signal.aborted)) {
                if (stopReason === "end_turn") stopReason = "interrupted";
              }
            } else if (m.role === "toolResult") {
              await emit({ type: "agent.tool_result", tool_use_id: m.toolCallId, content: textBlocks(m.content), is_error: m.isError, pi: m });
            }
            break;
          }
          case "turn_end":
            turns++;
            if (ev.toolResults.length > 0 && turns >= env.MAX_TURNS && stopReason === "end_turn") {
              stopReason = "max_turns";
              void pi?.session.abort();
            }
            break;
          case "compaction_end":
            if (!ev.aborted && ev.result) console.log(`[pi] ${sessionId}: context compacted (${ev.reason})`);
            break;
        }
      })().catch((e) => console.error(`[pi] ${sessionId}: event handler failed`, e));
    });

    // Interrupt from the API -> pi abort. Steered user messages -> pi steer (deduped by seq).
    const onAbort = () => void pi?.session.abort();
    abort.signal.addEventListener("abort", onAbort, { once: true });
    const drainSteer = async () => {
      for (const s of await deps.popSteer(sessionId)) {
        if (s.seq <= consumedSeq) continue;
        consumedSeq = Math.max(consumedSeq, s.seq);
        await pi?.session.steer(blocksText(s.content));
      }
    };
    steerTimer = setInterval(() => void drainSteer().catch(() => {}), 1000);

    try {
      if (promptText !== null) await pi.session.prompt(promptText, { expandPromptTemplates: true, source: "extension" });
      else await pi.session.prompt("(continue)", { expandPromptTemplates: false, source: "extension" });
      await drainSteer();
    } finally {
      unsub();
      abort.signal.removeEventListener("abort", onAbort);
    }
    if (modelError !== null && stopReason === "end_turn") {
      stopReason = "error";
      await emit({ type: "session.error", error: { type: "model_error", message: modelError } });
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
    if (steerTimer) clearInterval(steerTimer);
    pi?.dispose();
    await unsubscribe();
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
