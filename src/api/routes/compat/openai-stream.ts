import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { listEvents } from "../../../infra/events.ts";
import { repos } from "../../../infra/db.ts";
import { subscribe } from "../../../infra/pubsub.ts";
import type { ContentBlock, SessionId, SessionResource, StreamDelta } from "../../../shared/types.ts";

/**
 * Project rethink's native event stream into the OFFICIAL OpenAI Agents API SSE event sequence
 * (`agent.session.turn.*`), the shape `client.beta.agents.sessions.stream()` consumes. The SDK's
 * TurnState drives on exactly three things, which this projection guarantees:
 *   - `agent.session.turn.created` (turn.subagent_id === null) sets the turn id,
 *   - `agent.session.turn.item.added` with `item.type === 'function_call'` is a pending tool call,
 *   - a turn `completed` followed by `agent.session.idle` (or `agent.session.failed`) is terminal.
 * A client/function tool call therefore surfaces as a function_call item the SDK's toolHandlers run;
 * the result is submitted back through POST .../events, which unblocks the waiting turn.
 */

import { clientToolSet, itemKindOf, toolUseItem } from "./items.ts";

const text = (content: ContentBlock[]) => content.map((b) => (b.type === "text" ? b.text : "")).join("");
const nowSec = () => Math.floor(Date.now() / 1000);

export interface TurnCtx {
  turnId?: string;
  n: number;
  /** open tool calls by tool_use_id, so the result event can close the item it belongs to */
  calls?: Map<string, { seq: number; name: string; input?: unknown; kind: ReturnType<typeof itemKindOf> }>;
  /** whether an output_text content part is currently open (the SDK brackets text with part events) */
  partOpen?: boolean;
  /** item id of the assistant message being streamed */
  messageItem?: string;
}
export const newTurnCtx = (): TurnCtx => ({ n: 0, calls: new Map() });

type Ev = Record<string, unknown>;

/** The SDK's Turn object as the stream carries it. */
const turnOf = (id: string, session: SessionResource, status: string) => ({
  id, object: "agent.session.turn", subagent_id: null, agent_id: session.agent.id, session_id: session.id,
  status, created_at: nowSec(), started_at: nowSec(), completed_at: status === "in_progress" ? null : nowSec(), error: null, usage: null,
});

/** Project one native delta into zero or more official AgentSessionEvents (in order). */
export function projectDelta(delta: StreamDelta, session: SessionResource, ctx: TurnCtx): Ev[] {
  const sid = session.id;
  const evId = () => `evt_${sid}_${++ctx.n}`;
  if (delta.type === "agent.message_delta") {
    const out: Ev[] = [];
    // the SDK brackets streamed text with content_part events; open one on the first delta of a message
    if (!ctx.partOpen) {
      ctx.partOpen = true;
      ctx.messageItem = delta.stream_id;
      out.push({ type: "agent.session.turn.content_part.added", event_id: evId(), session_id: sid, turn_id: ctx.turnId ?? null, item_id: delta.stream_id, output_index: 0, content_index: 0, part: { type: "output_text", text: "" } });
    }
    out.push({ type: "agent.session.turn.output_text.delta", event_id: evId(), session_id: sid, turn_id: ctx.turnId ?? null, item_id: delta.stream_id, output_index: 0, content_index: 0, delta: delta.text });
    return out;
  }
  if (delta.type === "agent.thinking_delta") {
    return [{ type: "agent.session.turn.reasoning_summary_text.delta", event_id: evId(), session_id: sid, turn_id: ctx.turnId ?? null, item_id: delta.stream_id, output_index: 0, summary_index: 0, delta: delta.text }];
  }
  if (delta.type !== "event") return [];
  const p = delta.event.payload;
  const seq = delta.event.seq;
  switch (p.type) {
    case "session.status_running": {
      ctx.turnId = `turn_${seq}`;
      ctx.calls = new Map();
      const turn = turnOf(ctx.turnId, session, "in_progress");
      return [
        { type: "agent.session.in_progress", event_id: evId(), session_id: sid, session: { id: sid, object: "agent.session", status: "in_progress" } },
        { type: "agent.session.turn.created", event_id: evId(), session_id: sid, turn_id: ctx.turnId, turn },
        { type: "agent.session.turn.in_progress", event_id: evId(), session_id: sid, turn_id: ctx.turnId, turn },
      ];
    }
    case "agent.tool_use": {
      const kind = itemKindOf(p.name, clientToolSet(session));
      if (kind === "none") return []; // a sandbox file tool: no item type in this dialect, so nothing is claimed
      ctx.calls?.set(p.tool_use_id, { seq, name: p.name, input: p.input, kind });
      const item = toolUseItem(p, kind as Exclude<typeof kind, "none">);
      return [{ type: "agent.session.turn.item.added", event_id: evId(), session_id: sid, turn_id: ctx.turnId ?? null, output_index: 0, item: { id: `item_${seq}`, ...item, turn_id: ctx.turnId ?? "" } }];
    }
    case "agent.tool_result": {
      const call = ctx.calls?.get(p.tool_use_id);
      if (!call) return [];
      ctx.calls?.delete(p.tool_use_id);
      // a call the caller answers is closed by the caller's own tool_result, not by this one
      if (call.kind === "function_call") return [];
      const item = toolUseItem({ name: call.name, tool_use_id: p.tool_use_id, input: call.input }, call.kind as "mcp_call" | "command_execution", { content: p.content as never, is_error: p.is_error });
      return [{ type: "agent.session.turn.item.done", event_id: evId(), session_id: sid, turn_id: ctx.turnId ?? null, output_index: 0, item: { id: `item_${call.seq}`, ...item, turn_id: ctx.turnId ?? "" } }];
    }
    case "agent.message": {
      const t = text(p.content);
      if (!t) return [];
      const itemId = p.stream_id ?? ctx.messageItem ?? `item_${seq}`;
      const out: Ev[] = [];
      // the model's reasoning is persisted on the message it produced, so its summary closes here
      if (p.thinking) out.push({ type: "agent.session.turn.reasoning_summary_text.done", event_id: evId(), session_id: sid, turn_id: ctx.turnId ?? null, item_id: `item_${seq}_reasoning`, output_index: 0, summary_index: 0, text: p.thinking });
      if (ctx.partOpen) {
        out.push({ type: "agent.session.turn.content_part.done", event_id: evId(), session_id: sid, turn_id: ctx.turnId ?? null, item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text: t } });
        ctx.partOpen = false;
        ctx.messageItem = undefined;
      }
      out.push({ type: "agent.session.turn.output_text.done", event_id: evId(), session_id: sid, turn_id: ctx.turnId ?? null, item_id: itemId, output_index: 0, content_index: 0, text: t });
      out.push({
        type: "agent.session.turn.item.done", event_id: evId(), session_id: sid, turn_id: ctx.turnId ?? null, output_index: 0,
        item: { id: `item_${seq}`, type: "message", role: "assistant", content: [{ type: "output_text", text: t }], status: "completed", turn_id: ctx.turnId ?? "" },
      });
      return out;
    }

    case "session.status_idle": {
      const turnId = ctx.turnId ?? `turn_${seq}`;
      const turn = turnOf(turnId, session, "completed");
      if (p.stop_reason === "interrupted") return [{ type: "agent.session.turn.cancelled", event_id: evId(), session_id: sid, turn_id: turnId, turn }, { type: "agent.session.idle", event_id: evId(), session_id: sid, session: { id: sid, object: "agent.session", status: "idle" } }];
      if (p.stop_reason === "error") return [{ type: "agent.session.turn.failed", event_id: evId(), session_id: sid, turn_id: turnId, turn }, { type: "agent.session.failed", event_id: evId(), session_id: sid, session: { id: sid, object: "agent.session", status: "failed" } }];
      return [
        { type: "agent.session.turn.completed", event_id: evId(), session_id: sid, turn_id: turnId, turn },
        { type: "agent.session.idle", event_id: evId(), session_id: sid, session: { id: sid, object: "agent.session", status: "idle" } },
      ];
    }
    case "sandbox.acquired":
      // The session's execution environment is up and connected (a sandbox lease was obtained).
      return [{ type: "agent.session.environment.ready", event_id: evId(), session_id: sid, environment: { id: session.environment_id, status: "ready", error: null } }];
    case "session.environment_disconnected":
      // A byoc environment has no worker: the run is paused, awaiting reconnection (requires_action).
      return [
        { type: "agent.session.environment.failed", event_id: evId(), session_id: sid, environment: { id: p.environment_id, status: "failed", error: { message: "environment has no connected worker" } } },
        { type: "agent.session.requires_action", event_id: evId(), session_id: sid, session: { id: sid, object: "agent.session", status: "requires_action", required_actions: [{ type: "environment_connection", environment_id: p.environment_id }] } },
      ];
    case "session.status_terminated": {
      // archived / stopped: nothing will run again, so this is terminal for the stream
      const out: Ev[] = [];
      if (ctx.turnId) out.push({ type: "agent.session.turn.cancelled", event_id: evId(), session_id: sid, turn_id: ctx.turnId, turn: { id: ctx.turnId, object: "agent.session.turn", subagent_id: null, agent_id: session.agent.id, session_id: sid, status: "cancelled", created_at: nowSec(), completed_at: nowSec() } });
      out.push({ type: "agent.session.idle", event_id: evId(), session_id: sid, session: { id: sid, object: "agent.session", status: "idle" } });
      return out;
    }
    case "session.error":
      // run_lost is claimRun's recoverable takeover notice: the run resumes right after it
      if (p.error?.type === "run_lost") return [];
      return [{ type: "agent.session.failed", event_id: evId(), session_id: sid, session: { id: sid, object: "agent.session", status: "failed", error: p.error?.message ?? "session failed" } }];
    default:
      return [];
  }
}

/** True once this projected event ends the stream (SDK terminal: session idle or failed). */
const isTerminal = (e: Ev) => e.type === "agent.session.idle" || e.type === "agent.session.failed";

/**
 * SSE stream of official AgentSessionEvents for one session, from cursor `since` (subscribe-before-
 * input: start at the current tail so the fresh turn is not preceded by a replayed prior turn).
 */
export function streamAgentSessionEvents(c: Context, session: SessionResource, since: number) {
  return streamSSE(c, async (stream) => {
    const ctx = newTurnCtx();
    let last = since;
    let done = false;
    // Resolved when the turn ends or the client leaves: the handler parks on it instead of polling `done`.
    let wake = () => {};
    const ended = new Promise<void>((r) => { wake = r; });
    const end = () => { done = true; wake(); };
    let unsub: (() => void | Promise<void>) | null = null;
    const cleanup = () => { const u = unsub; unsub = null; if (u) void u(); }; // exactly once
    stream.onAbort(() => { end(); cleanup(); });
    const send = async (e: Ev) => { await stream.writeSSE({ data: JSON.stringify(e) }); if (isTerminal(e)) end(); };
    const sendEvent = async (delta: StreamDelta) => {
      if (delta.type === "event") { if (delta.event.seq <= last) return; last = delta.event.seq; }
      for (const e of projectDelta(delta, session, ctx)) { if (!done) await send(e); }
    };
    /** Stored events with last < seq < upTo, paged; seqs are contiguous, so this fills any gap. */
    const replay = async (upTo = Infinity) => {
      while (!done && last < upTo - 1) {
        const page = await listEvents(session.id, { since: last, limit: Math.min(REPLAY_PAGE, upTo - 1 - last) });
        for (const ev of page) if (!done) await sendEvent({ type: "event", event: ev });
        if (page.length < REPLAY_PAGE) return;
      }
    };
    // One serialized chain: the replay first, then live deltas in arrival order. A live event ahead of
    // `last` first pulls the stored events before it, so a replayed event is never skipped as "old".
    let chain: Promise<void> = Promise.resolve();
    const enqueue = (fn: () => Promise<void>) => { chain = chain.then(() => (done ? undefined : fn())).catch((e) => console.error("[openai-stream] send failed", e)); };
    const off = await subscribe(session.id, (delta) => enqueue(async () => {
      if (delta.type === "event" && delta.event.seq > last + 1) await replay(delta.event.seq);
      await sendEvent(delta);
    }));
    if (done) { void off(); return; } // the client left while subscribe() was pending
    unsub = off;
    enqueue(() => replay());
    await chain;
    // Nothing will ever end a stream on a terminated session whose terminal event is behind the cursor.
    if (!done && (await repos.sessions.get(session.id))?.status === "terminated") enqueue(() => send({ type: "agent.session.idle", event_id: `evt_${session.id}_${++ctx.n}`, session_id: session.id, session: { id: session.id, object: "agent.session", status: "idle" } }));
    await ended;
    await chain;
    cleanup();
  });
}

const REPLAY_PAGE = 1000;
