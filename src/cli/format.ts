/** Terminal rendering: tables, event summaries, the live event printer and the `send --wait` end condition. */

export interface Out { write(s: string): void; log(s: string): void }

export function table(rows: string[][]): string {
  if (rows.length <= 1) return rows.length ? `${rows[0]!.join("  ")}\n(none)` : "(none)";
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd()).join("\n");
}

export const textOf = (content: unknown) => (Array.isArray(content) ? content.map((b: any) => (typeof b?.text === "string" ? b.text : b?.type && b.type !== "text" ? `[${b.type}]` : "")).join("") : "");
const tok = (n: unknown) => (typeof n !== "number" ? "-" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
export const ctx = (c: any) => (c && typeof c.tokens === "number" ? `${tok(c.tokens)}/${tok(c.window)}` : "-");

/** One-line description of a persisted event for `events` tables. */
export function summarize(e: any): string {
  const p = e?.payload ?? {};
  const s = e.type === "user.message" || e.type === "agent.message" || e.type === "agent.tool_result" ? textOf(p.content)
    : e.type === "agent.tool_use" ? `${p.name} ${JSON.stringify(p.input)}`
    : e.type === "session.status_idle" ? `${p.stop_reason ?? ""}${typeof p.consumed_seq === "number" ? ` (consumed ${p.consumed_seq})` : ""}`
    : e.type === "session.status_terminated" ? String(p.reason ?? "")
    : e.type === "sandbox.acquired" ? `${p.provider ?? ""} ${p.sandbox_id ?? ""}`
    : e.type === "span.model_request_end" ? `${p.model ?? ""} in ${tok(p.usage?.input)} out ${tok(p.usage?.output)}`
    : e.type === "session.usage" ? `total ${tok(p.usage?.total_tokens)} tokens · ctx ${ctx(p.context)}`
    : e.type === "session.error" ? `${p.error?.type}: ${p.error?.message}` : "";
  return s.replace(/\s+/g, " ").slice(0, 100);
}

/** Stream-only previews that are noise on a terminal (the persisted events carry the same information). */
const QUIET = new Set(["agent.thinking_delta", "agent.tool_use_start", "agent.tool_use_delta"]);

/** An event printer; it remembers which messages were already streamed as deltas so they are not printed twice. */
export function makePrinter(out: Out = { write: (s) => process.stdout.write(s), log: (s) => console.log(s) }) {
  const streamed = new Set<string>();
  return (type: string, data: any): void => {
    if (QUIET.has(type)) return;
    if (type === "agent.message_delta") { if (data?.stream_id) streamed.add(data.stream_id); out.write(String(data?.text ?? "")); return; }
    const p = data?.payload ?? data ?? {};
    switch (type) {
      case "agent.message":
        if (p.stream_id && streamed.has(p.stream_id)) { out.write("\n"); return; }
        if (Array.isArray(p.content) && p.content.length && !textOf(p.content).trim()) return; // a tool-call-only turn
        return out.log(`\n[agent] ${textOf(p.content)}`);
      case "agent.tool_use":
        return out.log(`\n[tool_use ${p.name}] ${JSON.stringify(p.input)}`);
      case "agent.tool_result":
        return out.log(`[tool_result${p.is_error ? " ERROR" : ""}] ${textOf(p.content).slice(0, 2000)}`);
      case "user.message":
        return out.log(`\n> ${textOf(p.content)}`);
      case "session.status_running":
        return out.log("[running]");
      case "session.status_idle":
        return out.log(`\n[idle ${p.stop_reason ?? ""}]`);
      case "span.model_request_end":
        return out.log(`[model ${p.model ?? ""}] in ${tok(p.usage?.input)} out ${tok(p.usage?.output)} · ctx ${ctx(p.context)}`);
      case "session.usage":
        return out.log(`[usage] ${summarize({ type, payload: p })}`);
      default:
        return out.log(`\n[${type}] ${JSON.stringify(p)}`);
    }
  };
}

/**
 * For `send --wait`: the outcome once the run that answers message `seq` is over, else null. An idle
 * from the run that was already in progress does not count if that run never consumed the message
 * (a follow-up run answers it); a terminated session ends the wait as a failure.
 */
export function waitOutcome(type: string, data: any, seq: number): { ok: boolean; reason: string } | null {
  const p = data?.payload ?? data ?? {};
  if (type === "session.status_terminated") return { ok: false, reason: `session terminated${p.reason ? ` (${p.reason})` : ""}` };
  if (type !== "session.status_idle") return null;
  if (typeof p.consumed_seq === "number" && p.consumed_seq < seq) return null;
  return p.stop_reason === "error" ? { ok: false, reason: "run ended with an error" } : { ok: true, reason: String(p.stop_reason ?? "idle") };
}
