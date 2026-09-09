import { pool } from "../infra/db.ts";
import { env } from "../shared/env.ts";
import type { SandboxId, SandboxProviderName, SandboxRow } from "../shared/types.ts";

/** A `busy` row older than this was left behind by a crashed runner (runs are capped at RUN_TIMEOUT_MS). */
const ABANDONED_MS = env.RUN_TIMEOUT_MS + 5 * 60_000;

export async function insert(row: Omit<SandboxRow, "last_used_at" | "created_at">): Promise<void> {
  await pool.query(
    `INSERT INTO sandboxes (id, provider, status, workspace_id, affinity, external_ref) VALUES ($1,$2,$3,$4,$5,$6)`,
    [row.id, row.provider, row.status, row.workspace_id, row.affinity, row.external_ref],
  );
}

export async function setStatus(id: SandboxId, status: SandboxRow["status"]): Promise<void> {
  await pool.query(`UPDATE sandboxes SET status=$2, last_used_at=now() WHERE id=$1`, [id, status]);
}

export async function touch(id: SandboxId): Promise<void> {
  await pool.query(`UPDATE sandboxes SET last_used_at=now() WHERE id=$1`, [id]);
}

/** Atomically claims a ready sandbox with matching affinity (marks it busy). */
export async function findReadyByAffinity(provider: SandboxProviderName, affinity: string): Promise<SandboxRow | null> {
  const r = await pool.query<SandboxRow>(
    `UPDATE sandboxes SET status='busy', last_used_at=now()
     WHERE id = (SELECT id FROM sandboxes WHERE provider=$1 AND affinity=$2 AND status='ready'
                 ORDER BY last_used_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [provider, affinity],
  );
  return r.rows[0] ?? null;
}

/** A live lease on the same affinity (another session is running in that workspace right now). */
export async function findBusyByAffinity(provider: SandboxProviderName, affinity: string): Promise<SandboxRow | null> {
  const r = await pool.query<SandboxRow>(
    `SELECT * FROM sandboxes WHERE provider=$1 AND affinity=$2 AND status='busy' AND last_used_at > now() - ($3::bigint * interval '1 millisecond') LIMIT 1`,
    [provider, affinity, ABANDONED_MS],
  );
  return r.rows[0] ?? null;
}

/** Sandboxes to destroy: ready ones idle past the ttl, plus busy ones abandoned by a dead runner. */
export async function listIdle(provider: SandboxProviderName, olderThanMs: number): Promise<SandboxRow[]> {
  const r = await pool.query<SandboxRow>(
    `SELECT * FROM sandboxes WHERE provider=$1 AND (
       (status='ready' AND last_used_at < now() - ($2::bigint * interval '1 millisecond'))
       OR (status='busy' AND last_used_at < now() - ($3::bigint * interval '1 millisecond')))`,
    [provider, olderThanMs, ABANDONED_MS],
  );
  return r.rows;
}

export async function setExternalRef(id: SandboxId, externalRef: string): Promise<void> {
  await pool.query(`UPDATE sandboxes SET external_ref=$2, last_used_at=now() WHERE id=$1`, [id, externalRef]);
}

export async function get(id: SandboxId): Promise<SandboxRow | null> {
  const r = await pool.query<SandboxRow>(`SELECT * FROM sandboxes WHERE id=$1`, [id]);
  return r.rows[0] ?? null;
}

export async function list(opts: { includeDestroyed?: boolean } = {}): Promise<SandboxRow[]> {
  const r = await pool.query<SandboxRow>(
    opts.includeDestroyed ? `SELECT * FROM sandboxes ORDER BY created_at DESC` : `SELECT * FROM sandboxes WHERE status <> 'destroyed' ORDER BY created_at DESC`,
  );
  return r.rows;
}

/**
 * Ask the reaper to destroy a ready sandbox on its next pass (the API process has no docker socket /
 * SDK state, so it never destroys directly). Returns false if the sandbox is busy or already gone.
 */
export async function markForDestroy(id: SandboxId): Promise<boolean> {
  const r = await pool.query(`UPDATE sandboxes SET last_used_at = to_timestamp(0) WHERE id=$1 AND status='ready'`, [id]);
  return (r.rowCount ?? 0) > 0;
}
