import { pool } from "./db.ts";
import { appendIn, setStatusIn, withSession } from "./events.ts";
import type { SessionEvent, SessionEventPayload, StopReason } from "../shared/types.ts";

/** A `running` session whose runner has not heartbeated for this long is considered dead. */
export const RUN_STALE_MS = 90_000;
export const HEARTBEAT_MS = 20_000;

/**
 * Atomically move the session idle -> running and append `session.status_running`.
 * A `running` session with a stale heartbeat is taken over (its runner died mid-run);
 * a live one (or a terminated session) yields null and the caller must not run.
 */
export async function claimRun(sessionId: string): Promise<SessionEvent[] | null> {
  return withSession(sessionId, async (c, s) => {
    const payloads: SessionEventPayload[] = [];
    if (s.status === "running" && s.idle_ms > RUN_STALE_MS) {
      payloads.push({ type: "session.error", error: { type: "run_lost", message: "previous runner stopped heartbeating; resuming" } });
    } else if (s.status !== "idle") return null;
    payloads.push({ type: "session.status_running" });
    const events = await appendIn(c, sessionId, payloads);
    await setStatusIn(c, sessionId, "running");
    return events;
  });
}

/**
 * Atomically append `session.status_idle` and flip the column. Under the same lock, detect
 * user messages that arrived while running but were never consumed (`seq > consumedSeq`) —
 * the API steered them instead of enqueueing, so the caller must enqueue a follow-up run.
 */
export async function finishRun(
  sessionId: string,
  stopReason: StopReason,
  consumedSeq: number,
): Promise<{ events: SessionEvent[]; unconsumedSeq: number | null }> {
  return withSession(sessionId, async (c, s) => {
    const events = await appendIn(c, sessionId, [{ type: "session.status_idle", stop_reason: stopReason }]);
    // A session archived mid-run stays terminated.
    if (s.status !== "terminated") await setStatusIn(c, sessionId, "idle");
    const r = await c.query(`SELECT MAX(seq) AS max FROM events WHERE session_id=$1 AND type='user.message' AND seq>$2`, [sessionId, consumedSeq]);
    const max = r.rows[0]?.max;
    return { events, unconsumedSeq: max == null || s.status === "terminated" ? null : Number(max) };
  });
}

export async function heartbeat(sessionId: string): Promise<void> {
  await pool.query(`UPDATE sessions SET updated_at=now() WHERE id=$1 AND status='running'`, [sessionId]);
}
