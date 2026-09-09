import { pool, tx } from "./db.ts";
import { publish } from "./pubsub.ts";
import { newId } from "../shared/ids.ts";
import type { SessionEvent, SessionEventPayload } from "../shared/types.ts";

type Row = Omit<SessionEvent, "seq" | "created_at"> & { seq: string | number; created_at: Date | string };

function toEvent(r: Row): SessionEvent {
  return {
    ...r,
    seq: Number(r.seq),
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  };
}

/**
 * Append events in one tx (seq assigned under a row lock on the session).
 * Publishes each committed event to pubsub unless `opts.publish === false`
 * (the runner publishes itself so it can interleave deltas with events).
 */
export async function appendEvents(
  sessionId: string,
  payloads: SessionEventPayload[],
  opts: { publish?: boolean } = {},
): Promise<SessionEvent[]> {
  if (payloads.length === 0) return [];
  const events = await tx(async (c) => {
    const lock = await c.query(`SELECT id FROM sessions WHERE id=$1 FOR UPDATE`, [sessionId]);
    if (lock.rowCount === 0) throw new Error(`session not found: ${sessionId}`);
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

export async function lastSeq(sessionId: string): Promise<number> {
  const { rows } = await pool.query(`SELECT COALESCE(MAX(seq),0) AS max FROM events WHERE session_id=$1`, [sessionId]);
  return Number(rows[0].max);
}
