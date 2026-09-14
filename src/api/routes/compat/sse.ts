import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { listEvents } from "../../../infra/events.ts";
import { repos } from "../../../infra/db.ts";
import { subscribe } from "../../../infra/pubsub.ts";
import type { ContentBlock, SessionId, StreamDelta } from "../../../shared/types.ts";

const blocksText = (content: ContentBlock[]) => content.map((b) => (b.type === "text" ? b.text : "")).join("");

/**
 * Map one rethink StreamDelta to an OpenAI Agents API stream event, or null to skip it. `clientTools`
 * is the set of the session's client/function tool names, used to tell a caller-fulfilled tool call
 * (-> action_required) from a sandbox tool call (-> item.added). The engine carries no such flag.
 */
export function toOpenAiEvent(delta: StreamDelta, sessionId: string, clientTools: Set<string>): { event: string; data: Record<string, unknown> } | null {
  const base = (type: string, extra: Record<string, unknown>) => ({ event: type, data: { type, session_id: sessionId, ...extra } });
  if (delta.type === "agent.message_delta") return base("response.output_text.delta", { output_text_delta: delta.text, delta: delta.text });
  if (delta.type === "agent.thinking_delta") return base("response.reasoning.delta", { delta: delta.text });
  if (delta.type !== "event") return null;
  const p = delta.event.payload;
  switch (p.type) {
    case "session.status_running": return base("session.turn.created", { turn_id: `turn_${delta.event.seq}` });
    case "agent.tool_use":
      if (clientTools.has(p.name)) return base("agent.session.action_required", { required_action: { turn_id: `turn_${delta.event.seq}`, call_id: p.tool_use_id, type: "function_call", name: p.name, arguments: p.input } });
      return base("session.turn.item.added", { item: { type: "function_call", call_id: p.tool_use_id, name: p.name, arguments: p.input }, function_call: { call_id: p.tool_use_id, name: p.name, arguments: p.input } });
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

const REPLAY_PAGE = 1000;

/** True once this delta ends the current turn (the compat stream closes here). */
function isTurnEnd(delta: StreamDelta): boolean {
  return delta.type === "event" && (delta.event.payload.type === "session.status_idle" || delta.event.payload.type === "session.status_terminated");
}

/**
 * SSE stream of OpenAI-named events for one session turn: replay stored events after `since`, then
 * live deltas, closing when the turn ends. A thin re-encode over the native event stream.
 */
export function streamOpenAiEvents(c: Context, sessionId: SessionId, since: number, opts: { synthCreated?: Record<string, unknown>; clientTools?: Iterable<string> } = {}) {
  const clientTools = new Set(opts.clientTools ?? []);
  return streamSSE(c, async (stream) => {
    let last = since;
    let done = false;
    // Resolved when the turn ends or the client leaves: the handler parks on it instead of polling `done`.
    let wake = () => {};
    const ended = new Promise<void>((r) => { wake = r; });
    const end = () => { done = true; wake(); };
    const send = async (m: { event: string; data: Record<string, unknown> } | null) => { if (m) await stream.writeSSE({ event: m.event, data: JSON.stringify(m.data) }); };

    if (opts.synthCreated) await send({ event: "session.created", data: { type: "session.created", session_id: sessionId, ...opts.synthCreated } });

    let unsub: (() => void | Promise<void>) | null = null;
    const cleanup = () => { const u = unsub; unsub = null; if (u) void u(); }; // exactly once
    stream.onAbort(() => { end(); cleanup(); });
    const sendDelta = async (delta: StreamDelta) => {
      if (delta.type === "event") { if (delta.event.seq <= last) return; last = delta.event.seq; }
      await send(toOpenAiEvent(delta, sessionId, clientTools));
      if (isTurnEnd(delta)) end();
    };
    /** Stored events with last < seq < upTo, paged (seqs are contiguous, so this also fills gaps). */
    const replay = async (upTo = Infinity) => {
      while (!done && last < upTo - 1) {
        const page = await listEvents(sessionId, { since: last, limit: Math.min(REPLAY_PAGE, upTo - 1 - last) });
        for (const ev of page) if (!done) await sendDelta({ type: "event", event: ev });
        if (page.length < REPLAY_PAGE) return;
      }
    };
    // One serialized chain: replay first, then live deltas; a live event ahead of `last` pulls the stored ones before it.
    let chain: Promise<void> = Promise.resolve();
    const enqueue = (fn: () => Promise<void>) => { chain = chain.then(() => (done ? undefined : fn())).catch((e) => console.error("[compat sse] send failed", e)); };
    const off = await subscribe(sessionId, (delta) => enqueue(async () => {
      if (delta.type === "event" && delta.event.seq > last + 1) await replay(delta.event.seq);
      await sendDelta(delta);
    }));
    if (done) { void off(); return; } // the client left while subscribe() was pending
    unsub = off;
    enqueue(() => replay());
    await chain;
    // a terminated session whose terminal event is behind the cursor would otherwise never end the stream
    if (!done && (await repos.sessions.get(sessionId))?.status === "terminated") enqueue(async () => { await send({ event: "session.completed", data: { type: "session.completed", session_id: sessionId, reason: "terminated" } }); end(); });

    // Wait until the turn ends (or the client disconnects).
    await ended;
    await chain;
    cleanup();
  });
}
