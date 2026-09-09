import { runAgentLoopContinue, type AgentContext, type AgentEvent, type AgentLoopConfig, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, Models, UserMessage } from "@earendil-works/pi-ai";
import { env } from "../shared/env.ts";
import type {
  ContentBlock,
  EnvironmentResource,
  SandboxLease,
  SandboxProvider,
  SessionEvent,
  SessionEventPayload,
  SessionId,
  SessionResource,
  SessionStatus,
  StopReason,
  StreamDelta,
  WorkspaceId,
  WorkspaceRef,
  WorkspaceResource,
} from "../shared/types.ts";
import { foldEvents, toContentBlocks } from "./fold.ts";
import { resolveModel } from "./models.ts";
import { createTools, type ToolContext } from "./tools.ts";

export type Unsubscribe = () => void | Promise<void>;

/** Everything runSession needs from the outside world; no DB/Redis code lives here. */
export interface RunDeps {
  models: Models;
  provider: SandboxProvider;
  /** Append events (seq assigned by the store). Must NOT publish; runSession publishes each appended event. */
  appendEvents(sessionId: SessionId, payloads: SessionEventPayload[]): Promise<SessionEvent[]>;
  listEvents(sessionId: SessionId): Promise<SessionEvent[]>;
  publish(delta: StreamDelta): void | Promise<void>;
  /** Subscribe to interrupt requests for this session; returns an unsubscribe. */
  onInterrupt(sessionId: SessionId, handler: () => void): Unsubscribe | Promise<Unsubscribe>;
  /** Drain user messages queued while the session is running (already persisted as events by the API). */
  popSteer(sessionId: SessionId): Promise<ContentBlock[][]>;
  getSession(id: SessionId): Promise<SessionResource | null>;
  getWorkspace(id: WorkspaceId): Promise<WorkspaceResource | null>;
  getEnvironment(id: string): Promise<EnvironmentResource | null>;
  updateWorkspaceRef(id: WorkspaceId, ref: WorkspaceRef): Promise<void>;
  setSessionStatus(id: SessionId, status: SessionStatus): Promise<void>;
}

const DEFAULT_SYSTEM_PROMPT =
  "You are a coding agent working inside a sandboxed workspace. Use the available tools to inspect and change files and to run commands. All paths are relative to the workspace root. Be concise.";

const LLM_ROLES = new Set(["user", "assistant", "toolResult"]);
const convertToLlm = (messages: AgentMessage[]): Message[] => messages.filter((m): m is Message => LLM_ROLES.has(m.role));

function textBlocks(content: { type: string; text?: string }[]): ContentBlock[] {
  return content.flatMap((c) => (c.type === "text" && c.text !== undefined ? [{ type: "text" as const, text: c.text }] : []));
}

/** Run one session turn: fold events, run the pi loop, persist events, capture + release the sandbox. */
export async function runSession(sessionId: SessionId, deps: RunDeps): Promise<void> {
  const session = await deps.getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  const workspace = await deps.getWorkspace(session.workspace_id);
  if (!workspace) throw new Error(`Workspace not found: ${session.workspace_id}`);
  const environment = await deps.getEnvironment(session.environment_id);
  if (!environment) throw new Error(`Environment not found: ${session.environment_id}`);

  const emit = async (payload: SessionEventPayload) => {
    const [event] = await deps.appendEvents(sessionId, [payload]);
    if (event) await deps.publish({ type: "event", event });
  };

  await emit({ type: "session.status_running" });
  await deps.setSessionStatus(sessionId, "running");

  const abort = new AbortController();
  let stopReason: StopReason = "end_turn";
  // Held in an object because the lease is set from inside a closure and read in `finally`.
  const held: { lease: SandboxLease | null; acquiring: Promise<SandboxLease> | null } = { lease: null, acquiring: null };
  const ctx: ToolContext = {
    signal: abort.signal,
    sandbox: async () => {
      held.acquiring ??= deps.provider
        .acquire({ workspaceId: workspace.id, workspaceRef: workspace.ref, image: environment.image, affinity: workspace.id })
        .then(async (l) => {
          held.lease = l;
          await emit({ type: "sandbox.acquired", sandbox_id: l.sandbox.id, provider: l.sandbox.provider });
          return l;
        });
      return (await held.acquiring).sandbox;
    },
  };

  const unsubscribe = await deps.onInterrupt(sessionId, () => {
    stopReason = "interrupted";
    abort.abort();
  });

  try {
    const { messages } = foldEvents(await deps.listEvents(sessionId));
    const context: AgentContext = {
      systemPrompt: session.agent.system ?? DEFAULT_SYSTEM_PROMPT,
      messages,
      tools: createTools(session.agent.tools, ctx),
    };
    let turns = 0;
    const config: AgentLoopConfig = {
      model: resolveModel(deps.models, session.agent.model),
      convertToLlm,
      toolExecution: "sequential",
      getSteeringMessages: async () =>
        (await deps.popSteer(sessionId)).map((content): UserMessage => ({ role: "user", content: textBlocks(content), timestamp: Date.now() })),
      shouldStopAfterTurn: ({ toolResults }) => {
        turns++;
        if (toolResults.length > 0 && turns >= env.MAX_TURNS) {
          stopReason = "max_turns";
          return true;
        }
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
            if (m.stopReason === "aborted") stopReason = "interrupted";
            if (m.stopReason === "error") {
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

    await runAgentLoopContinue(context, config, sink, abort.signal, deps.models.streamSimple.bind(deps.models));
  } catch (err) {
    stopReason = "error";
    const e = err instanceof Error ? err : new Error(String(err));
    await emit({ type: "session.error", error: { type: e.name, message: e.message } });
  } finally {
    await unsubscribe();
    const lease = held.lease;
    if (lease) {
      try {
        const ref = await deps.provider.capture(lease.sandbox, workspace.ref);
        await emit({ type: "workspace.captured", ref });
        await deps.updateWorkspaceRef(workspace.id, ref);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        await emit({ type: "session.error", error: { type: "capture_failed", message: e.message } });
      } finally {
        await lease.release();
        await emit({ type: "sandbox.released", sandbox_id: lease.sandbox.id });
      }
    }
    await emit({ type: "session.status_idle", stop_reason: stopReason });
    await deps.setSessionStatus(sessionId, "idle");
  }
}
