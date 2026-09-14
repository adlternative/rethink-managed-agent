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

const text = (content: ContentBlock[]) => content.map((b) => (b.type === "text" ? b.text : "")).join("");
const nowSec = () => Math.floor(Date.now() / 1000);

export interface TurnCtx { turnId?: string; n: number }
export const newTurnCtx = (): TurnCtx => ({ n: 0 });

type Ev = Record<string, unknown>;

/** Project one native delta into zero or more official AgentSessionEvents (in order). */
export function projectDelta(delta: StreamDelta, session: SessionResource, ctx: TurnCtx): Ev[] {
  const sid = session.id;
  const evId = () => `evt_${sid}_${++ctx.n}`;
  if (delta.type === "agent.message_delta") {
    return [{ type: "agent.session.turn.output_text.delta", event_id: evId(), session_id: sid, turn_id: ctx.turnId ?? null, item_id: delta.stream_id, output_index: 0, content_index: 0, delta: delta.text }];
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
      const turn = { id: ctx.turnId, object: "agent.session.turn", subagent_id: null, agent_id: session.agent.id, session_id: sid, status: "in_progress", created_at: nowSec(), completed_at: null };
      return [{ type: "agent.session.turn.created", event_id: evId(), session_id: sid, turn_id: ctx.turnId, turn }];
    }
    case "agent.tool_use":
      return [{
        type: "agent.session.turn.item.added", event_id: evId(), session_id: sid, turn_id: ctx.turnId ?? null, output_index: 0,
        item: { id: `item_${seq}`, type: "function_call", call_id: p.tool_use_id, name: p.name, arguments: p.input, status: "in_progress", turn_id: ctx.turnId ?? "" },
      }];
    case "agent.message": {
      const t = text(p.content);
      if (!t) return [];
      return [{ type: "agent.session.turn.output_text.done", event_id: evId(), session_id: sid, turn_id: ctx.turnId ?? null, item_id: p.stream_id ?? `item_${seq}`, output_index: 0, content_index: 0, text: t }];
    }
    case "session.status_idle": {
      const turnId = ctx.turnId ?? `turn_${seq}`;
      const turn = { id: turnId, object: "agent.session.turn", subagent_id: null, agent_id: session.agent.id, session_id: sid, status: "completed", created_at: nowSec(), completed_at: nowSec() };
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
