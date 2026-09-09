import type pg from "pg";
import { pool, tx } from "./db.ts";
import { publish } from "./pubsub.ts";
import { newId } from "../shared/ids.ts";
import type { SessionEvent, SessionEventPayload, SessionStatus } from "../shared/types.ts";

type Row = Omit<SessionEvent, "seq" | "created_at"> & { seq: string | number; created_at: Date | string };

function toEvent(r: Row): SessionEvent {
  return {
    ...r,
    seq: Number(r.seq),
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  };
}

export interface LockedSession {
  status: SessionStatus;
  /** ms since the row was last written (runner heartbeat while running) */
  idle_ms: number;
}

/**
 * Runs `fn` in a tx holding a row lock on the session. Everything that decides on
 * `sessions.status` (steer vs enqueue, run claim/finish) goes through here so the
 * decision and the events it produces commit atomically.
 */
export async function withSession<T>(sessionId: string, fn: (c: pg.PoolClient, s: LockedSession) => Promise<T>): Promise<T> {
  return tx(async (c) => {
    const r = await c.query(
      `SELECT status, EXTRACT(EPOCH FROM (now() - updated_at)) * 1000 AS idle_ms FROM sessions WHERE id=$1 FOR UPDATE`,
      [sessionId],
    );
    if (r.rowCount === 0) throw new Error(`session not found: ${sessionId}`);
    return fn(c, { status: r.rows[0].status, idle_ms: Number(r.rows[0].idle_ms) });
  });
}

/** Append events on an already-locked session (seq assigned under that lock). */
export async function appendIn(c: pg.PoolClient, sessionId: string, payloads: SessionEventPayload[]): Promise<SessionEvent[]> {
  const { rows } = await c.query(`SELECT COALESCE(MAX(seq),0) AS max FROM events WHERE session_id=$1`, [sessionId]);
  let seq = Number(rows[0].max);
  const out: SessionEvent[] = [];
  for (const payload of payloads) {
    seq += 1;
    const r = await c.query(
      `INSERT INTO events (id, session_id, seq, type, payload) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [newId("evt"), sessionId, seq, payload.type, JSON.stringify(payload)],
    );
    out.push(toEvent(r.rows[0] as Row));
  }
  return out;
}

export async function setStatusIn(c: pg.PoolClient, sessionId: string, status: SessionStatus): Promise<void> {
  await c.query(`UPDATE sessions SET status=$2, updated_at=now() WHERE id=$1`, [sessionId, status]);
}

/**
 * Append events in one tx; optionally flip `sessions.status` in that same tx.
 * Publishes each committed event to pubsub unless `opts.publish === false`
 * (the runner publishes itself so it can interleave deltas with events).
 */
export async function appendEvents(
  sessionId: string,
  payloads: SessionEventPayload[],
  opts: { publish?: boolean; status?: SessionStatus } = {},
): Promise<SessionEvent[]> {
  if (payloads.length === 0) return [];
  const events = await withSession(sessionId, async (c) => {
    const out = await appendIn(c, sessionId, payloads);
    if (opts.status) await setStatusIn(c, sessionId, opts.status);
    return out;
  });
  if (opts.publish !== false) for (const event of events) await publish({ type: "event", event });
  return events;
}

export async function listEvents(
  sessionId: string,
  opts: { since?: number; limit?: number } = {},
): Promise<SessionEvent[]> {
  const { rows } = await pool.query(
    `SELECT * FROM events WHERE session_id=$1 AND seq>$2 ORDER BY seq ASC LIMIT $3`,
    [sessionId, opts.since ?? 0, opts.limit ?? 10000],
  );
  return (rows as Row[]).map(toEvent);
}

/** Whole log, paged — the fold must never see a truncated tail. */
export async function listAllEvents(sessionId: string, pageSize = 5000): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for (;;) {
    const page = await listEvents(sessionId, { since: out.at(-1)?.seq ?? 0, limit: pageSize });
    out.push(...page);
    if (page.length < pageSize) return out;
  }
}
