import type { SessionEvent, SessionEventPayload } from "../../../src/shared/types.ts";
import { call, text } from "../harness-fakes/deps.ts";

export function rng(seed: number) { return (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; }; }

/** A random but engine-shaped log: runs with tool calls (some client tools, some dangling), steers, rewrites, errors, disconnects, compactions, files. */
export function randomLog(seed: number, n = 400): SessionEvent[] {
  const r = rng(seed);
  const payloads: SessionEventPayload[] = [];
  const messageSeqs: number[] = [];
  const userSeqs: number[] = [];
  let call_ = 0;
  const push = (p: SessionEventPayload) => { payloads.push(p); return payloads.length; };
  while (payloads.length < n) {
    const u = push(r(5) === 0
      ? { type: "user.message", content: [{ type: "text", text: `u${payloads.length}` }, { type: r(2) ? "image" : "document", source: { type: "file", file_id: `file_${r(4)}` } }] as never }
      : { type: "user.message", content: [{ type: "text", text: `u${payloads.length}` }] });
    messageSeqs.push(u); userSeqs.push(u);
    if (r(6) === 0) { push({ type: "session.environment_disconnected", environment_id: "env" }); continue; }
    push({ type: "session.status_running" });
    for (let k = r(4); k > 0; k--) {
      const id = `c${call_++}`;
      const name = r(4) === 0 ? "client_fn" : r(2) ? "bash" : "read";
      const a = push({ type: "agent.message", content: [], pi: call(id, name, {}) as never }); messageSeqs.push(a);
      push({ type: "agent.tool_use", tool_use_id: id, name, input: { k } });
      if (r(3) === 0) { const s = push({ type: "user.message", content: [{ type: "text", text: "steer" }] }); messageSeqs.push(s); userSeqs.push(s); }
      if (r(5) !== 0) { const t = push({ type: "agent.tool_result", tool_use_id: id, content: [{ type: "text", text: "out" }], is_error: r(7) === 0, pi: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "out" }], isError: false, timestamp: 1 } as never }); messageSeqs.push(t); }
      push({ type: "span.model_request_end", model: "m", usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, total_tokens: 2 }, context: { tokens: 1, window: 2 } as never });
    }
    if (r(8) === 0) push({ type: "session.error", error: { type: r(2) ? "run_lost" : "model_error", message: "boom" } });
    const m = push({ type: "agent.message", content: [{ type: "text", text: "answer" }], pi: text(`a${payloads.length}`) as never }); messageSeqs.push(m);
    if (r(6) === 0 && userSeqs.length) push({ type: "user.message_rewritten", target_seq: userSeqs[r(userSeqs.length)]!, text: "rewritten" });
    if (r(5) === 0) push({ type: "agent.thread_message_sent", to_session_id: "parent", kind: r(2) ? "question" : "report", content: [{ type: "text", text: "q" }], question_id: "q" });
    if (r(9) === 0 && messageSeqs.length > 3) push({ type: "agent.thread_context_compacted", summary: `sum${payloads.length}`, first_kept_seq: messageSeqs[messageSeqs.length - 1 - r(3)]!, tokens_before: 10, tokens_after: 5 });
    push({ type: "session.usage", usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, total_tokens: 2, requests: 1 }, context: null });
    if (r(10) !== 0) push({ type: "session.status_idle", stop_reason: (["end_turn", "interrupted", "error"] as const)[r(3)]!, consumed_seq: userSeqs.at(-1)! - r(2) });
    if (r(40) === 0) push({ type: "session.status_terminated", reason: "stop" });
  }
  return payloads.map((payload, i) => ({ id: `evt_${i + 1}`, session_id: "s", seq: i + 1, type: payload.type, payload, created_at: new Date(1_700_000_000_000 + i * 1000).toISOString() }));
}

