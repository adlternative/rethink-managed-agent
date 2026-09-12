import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { listEvents } from "../../../infra/events.ts";
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
    case "session.error":
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
    const send = async (e: Ev) => { await stream.writeSSE({ data: JSON.stringify(e) }); if (isTerminal(e)) done = true; };
    let chain: Promise<void> = Promise.resolve();
    const pump = (delta: StreamDelta) => {
      chain = chain.then(async () => {
        if (done) return;
        if (delta.type === "event") { if (delta.event.seq <= last) return; last = delta.event.seq; }
        for (const e of projectDelta(delta, session, ctx)) { if (!done) await send(e); }
      }).catch((e) => console.error("[openai-stream] send failed", e));
    };
    const unsub = await subscribe(session.id, pump);
    stream.onAbort(() => { done = true; void unsub(); });
    for (const ev of await listEvents(session.id, { since: last })) pump({ type: "event", event: ev });
    while (!done) await stream.sleep(500);
    await chain;
    void unsub();
  });
}
