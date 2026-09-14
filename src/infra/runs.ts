import { pool } from "./db.ts";
import { appendIn, setStatusIn, withSession } from "./events.ts";
import type { ContextSize, SessionEvent, SessionEventPayload, StopReason, Usage } from "../shared/types.ts";

/** A `running` session whose runner has not heartbeated for this long is considered dead. */
export const RUN_STALE_MS = 90_000;
export const HEARTBEAT_MS = 20_000;

/**
 * Atomically move the session idle -> running and append `session.status_running`.
 * A `running` session with a stale heartbeat is taken over (its runner died mid-run);
 * a live one yields null (retry later), a terminated one "terminated" (drop the job: it never runs again).
 */
export async function claimRun(sessionId: string): Promise<SessionEvent[] | null | "terminated"> {
  return withSession(sessionId, async (c, s) => {
    const payloads: SessionEventPayload[] = [];
    if (s.status === "terminated") return "terminated";
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
 * `claimSeq` (the seq of this run's status_running) is the run's ownership token: if a newer run
 * start exists, this runner was taken over as stale and must leave the session to the new run.
 */
export async function finishRun(
  sessionId: string,
  stopReason: StopReason,
  consumedSeq: number,
  opts: { claimSeq?: number } = {},
): Promise<{ events: SessionEvent[]; unconsumedSeq: number | null }> {
  return withSession(sessionId, async (c, s) => {
    if (opts.claimSeq !== undefined) {
      const latest = await c.query<{ max: string | number | null }>(`SELECT MAX(seq) AS max FROM events WHERE session_id=$1 AND type='session.status_running'`, [sessionId]);
      const max = latest.rows[0]?.max;
      if (max != null && Number(max) > opts.claimSeq) return { events: [], unconsumedSeq: null }; // superseded
    }
    const u = await c.query<{ usage: Usage; context: ContextSize | null }>(`SELECT usage, context FROM sessions WHERE id=$1`, [sessionId]);
    const events = await appendIn(c, sessionId, [
      { type: "session.usage", usage: u.rows[0]!.usage, context: u.rows[0]!.context },
      { type: "session.status_idle", stop_reason: stopReason, consumed_seq: consumedSeq },
    ]);
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

/**
 * Enqueue-after-commit gap: the API persists user.message in a tx and only then XADDs the run job.
 * If it dies in between (or Redis drops the entry), the session sits idle with an unanswered
 * message. Find such sessions: idle, newest user.message newer than the newest status event, and
 * older than `graceMs` so an in-flight enqueue is not double-fired.
 */
export async function findStrandedSessions(graceMs: number): Promise<{ session_id: string; trigger_seq: number; owner_id: string }[]> {
  const r = await pool.query<{ session_id: string; trigger_seq: string; owner_id: string }>(
    `SELECT s.id AS session_id, s.owner_id AS owner_id, u.seq AS trigger_seq
     FROM sessions s
     JOIN LATERAL (SELECT seq, created_at FROM events WHERE session_id = s.id AND type = 'user.message' ORDER BY seq DESC LIMIT 1) u ON true
     LEFT JOIN LATERAL (SELECT seq FROM events WHERE session_id = s.id AND type IN ('session.status_running','session.status_idle','session.status_terminated','session.environment_disconnected') ORDER BY seq DESC LIMIT 1) st ON true
     WHERE s.status = 'idle' AND (st.seq IS NULL OR u.seq > st.seq) AND u.created_at < now() - ($1::bigint * interval '1 millisecond')`,
    [graceMs],
  );
  return r.rows.map((x) => ({ session_id: x.session_id, trigger_seq: Number(x.trigger_seq), owner_id: x.owner_id }));
}

/** Add one model request's usage to the session's cumulative counters and record the context size, atomically. */
export async function recordUsage(sessionId: string, usage: Omit<Usage, "requests">, context: ContextSize): Promise<Usage> {
  const r = await pool.query<{ usage: Usage }>(
    `UPDATE sessions SET
       usage = jsonb_build_object(
         'input', (usage->>'input')::bigint + $2::bigint,
         'output', (usage->>'output')::bigint + $3::bigint,
         'cache_read', (usage->>'cache_read')::bigint + $4::bigint,
         'cache_write', (usage->>'cache_write')::bigint + $5::bigint,
         'total_tokens', (usage->>'total_tokens')::bigint + $6::bigint,
         'requests', (usage->>'requests')::bigint + 1),
       context = $7::jsonb
     WHERE id=$1 RETURNING usage`,
    [sessionId, usage.input, usage.output, usage.cache_read, usage.cache_write, usage.total_tokens, JSON.stringify(context)],
  );
  return r.rows[0]!.usage;
}
