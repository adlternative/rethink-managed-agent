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

/** Whole log after `since` (default: all of it), paged — the fold must never see a truncated tail. */
export async function listAllEvents(sessionId: string, pageSize = 5000, since = 0): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for (;;) {
    const page = await listEvents(sessionId, { since: out.at(-1)?.seq ?? since, limit: pageSize });
    out.push(...page);
    if (page.length < pageSize) return out;
  }
}

/** Events with seq > `since`; with `limit`, only the newest `limit` of them. Seq order either way. */
export async function listEventsWindow(sessionId: string, opts: { since?: number; limit?: number } = {}): Promise<SessionEvent[]> {
  // Non-integer cursors (plugin input) are not pushed down: read wider and let the caller filter.
  const since = Number.isInteger(opts.since) && opts.since! > 0 ? opts.since! : 0;
  if (!Number.isInteger(opts.limit)) return listAllEvents(sessionId, 5000, since);
  if (opts.limit! <= 0) return [];
  const { rows } = await pool.query(`SELECT * FROM (SELECT * FROM events WHERE session_id=$1 AND seq>$2 ORDER BY seq DESC LIMIT $3) t ORDER BY seq ASC`, [sessionId, since, opts.limit]);
  return (rows as Row[]).map(toEvent);
}

/** Newest seq in the log (0 when empty). A primary-key probe, not a log read. */
export async function lastSeq(sessionId: string): Promise<number> {
  const { rows } = await pool.query(`SELECT COALESCE(MAX(seq),0) AS max FROM events WHERE session_id=$1`, [sessionId]);
  return Number(rows[0]?.max ?? 0);
}

/** The newest event of each of `types` (types never logged are absent), in seq order. One index probe per type. */
export async function latestOfTypes(sessionId: string, types: string[]): Promise<SessionEvent[]> {
  const { rows } = await pool.query(
    `SELECT e.* FROM unnest($2::text[]) AS t(type) CROSS JOIN LATERAL (SELECT * FROM events WHERE session_id=$1 AND type=t.type ORDER BY seq DESC LIMIT 1) e ORDER BY e.seq`,
    [sessionId, types],
  );
  return (rows as Row[]).map(toEvent);
}

/** The newest event of `type` whose payload contains `match` (jsonb @>), or null. */
export async function latestMatching(sessionId: string, type: string, match: Record<string, unknown>): Promise<SessionEvent | null> {
  const { rows } = await pool.query(`SELECT * FROM events WHERE session_id=$1 AND type=$2 AND payload @> $3::jsonb ORDER BY seq DESC LIMIT 1`, [sessionId, type, JSON.stringify(match)]);
  return rows[0] ? toEvent(rows[0] as Row) : null;
}

/**
 * The events a projection needs instead of the whole log, in seq order: every event of `types`, plus
 * (when `toolNames` is non-empty) the agent.tool_use calls to those tools and the agent.tool_result
 * rows answering them. The filter runs in Postgres, so unrelated rows (other tools' outputs, messages,
 * spans) are never shipped or parsed. `payload.pi` (the full model message kept for the fold, which
 * duplicates `content`) is left out: projections never read it.
 */
const PROJECTED = `id, session_id, seq, type, payload - 'pi' AS payload, created_at`;
export async function listEventsForState(sessionId: string, types: string[], toolNames: string[] = []): Promise<SessionEvent[]> {
  const { rows } = toolNames.length
    ? await pool.query(
        `SELECT ${PROJECTED} FROM events WHERE session_id=$1 AND (type = ANY($2::text[])
           OR (type='agent.tool_use' AND payload->>'name' = ANY($3::text[]))
           OR (type='agent.tool_result' AND payload->>'tool_use_id' IN (SELECT payload->>'tool_use_id' FROM events WHERE session_id=$1 AND type='agent.tool_use' AND payload->>'name' = ANY($3::text[]))))
         ORDER BY seq`,
        [sessionId, types, toolNames])
    : await pool.query(`SELECT ${PROJECTED} FROM events WHERE session_id=$1 AND type = ANY($2::text[]) ORDER BY seq`, [sessionId, types]);
  return (rows as Row[]).map(toEvent);
}

/**
 * Cursor a fold can start after: everything before the latest compaction's first kept message is
 * replaced by its summary, so the fold reads from min(first_kept_seq, the compaction's own seq). 0 when
 * the session was never compacted (read the whole log).
 */
export async function foldSince(sessionId: string): Promise<number> {
  const { rows } = await pool.query(`SELECT seq, payload->'first_kept_seq' AS first_kept FROM events WHERE session_id=$1 AND type='agent.thread_context_compacted' ORDER BY seq DESC LIMIT 1`, [sessionId]);
  const r = rows[0] as { seq: string | number; first_kept: unknown } | undefined;
  if (!r) return 0;
  const firstKept = typeof r.first_kept === "number" && Number.isFinite(r.first_kept) ? r.first_kept : 0;
  return Math.max(0, Math.min(firstKept, Number(r.seq)) - 1);
}
