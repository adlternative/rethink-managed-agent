import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { listEvents } from "../../../infra/events.ts";
import { subscribe } from "../../../infra/pubsub.ts";
import type { ContentBlock, SessionId, StreamDelta } from "../../../shared/types.ts";

const blocksText = (content: ContentBlock[]) => content.map((b) => (b.type === "text" ? b.text : "")).join("");

/** Map one rethink StreamDelta to an OpenAI Agents API stream event, or null to skip it. */
export function toOpenAiEvent(delta: StreamDelta, sessionId: string): { event: string; data: Record<string, unknown> } | null {
  const base = (type: string, extra: Record<string, unknown>) => ({ event: type, data: { type, session_id: sessionId, ...extra } });
  if (delta.type === "agent.message_delta") return base("response.output_text.delta", { output_text_delta: delta.text, delta: delta.text });
  if (delta.type === "agent.thinking_delta") return base("response.reasoning.delta", { delta: delta.text });
  if (delta.type !== "event") return null;
  const p = delta.event.payload;
  switch (p.type) {
    case "session.status_running": return base("session.turn.created", { turn_id: `turn_${delta.event.seq}` });
    case "agent.tool_use": return base("session.turn.item.added", { item: { type: "function_call", call_id: p.tool_use_id, name: p.name, arguments: p.input }, function_call: { call_id: p.tool_use_id, name: p.name, arguments: p.input } });
    case "agent.client_tool_pending": return base("agent.session.action_required", { required_action: { turn_id: p.turn_id, call_id: p.tool_use_id, type: "function_call", name: p.name, arguments: p.input } });
    case "agent.message": return base("session.turn.item.done", { item: { type: "message", role: "assistant", text: blocksText(p.content) } });
    case "agent.tool_result": return base("session.turn.item.done", { item: { type: "function_call_output", call_id: p.tool_use_id, is_error: p.is_error } });
    case "session.status_idle":
      if (p.stop_reason === "interrupted") return base("turn.cancelled", {});
      if (p.stop_reason === "error") return base("turn.failed", {});
      return base("agent.session.turn.completed", { stop_reason: p.stop_reason });
    case "session.status_terminated": return base("session.completed", { reason: p.reason });
    case "session.error": return base("session.failed", { error: p.error });
    default: return null;
  }
}

/** True once this delta ends the current turn (the compat stream closes here). */
function isTurnEnd(delta: StreamDelta): boolean {
  return delta.type === "event" && (delta.event.payload.type === "session.status_idle" || delta.event.payload.type === "session.status_terminated");
}

/**
 * SSE stream of OpenAI-named events for one session turn: replay stored events after `since`, then
 * live deltas, closing when the turn ends. A thin re-encode over the native event stream.
 */
export function streamOpenAiEvents(c: Context, sessionId: SessionId, since: number, opts: { synthCreated?: Record<string, unknown> } = {}) {
  return streamSSE(c, async (stream) => {
    let last = since;
    let done = false;
    const send = async (m: { event: string; data: Record<string, unknown> } | null) => { if (m) await stream.writeSSE({ event: m.event, data: JSON.stringify(m.data) }); };

    if (opts.synthCreated) await send({ event: "session.created", data: { type: "session.created", session_id: sessionId, ...opts.synthCreated } });

    let chain: Promise<void> = Promise.resolve();
    const pump = (delta: StreamDelta) => {
      chain = chain.then(async () => {
        if (done) return;
        if (delta.type === "event") { if (delta.event.seq <= last) return; last = delta.event.seq; }
        await send(toOpenAiEvent(delta, sessionId));
        if (isTurnEnd(delta)) { done = true; }
      }).catch((e) => console.error("[compat sse] send failed", e));
    };

    const unsub = await subscribe(sessionId, pump);
    stream.onAbort(() => { done = true; void unsub(); });
    // Replay anything already stored past the cursor, then let live deltas continue.
    for (const ev of await listEvents(sessionId, { since: last })) pump({ type: "event", event: ev });

    // Wait until the turn ends (or the client disconnects).
    while (!done) { await stream.sleep(500); }
    await chain;
    void unsub();
  });
}
