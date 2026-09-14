import { pool, tx } from "../infra/db.ts";
import { env } from "../shared/env.ts";
import type { SandboxId, SandboxProviderName, SandboxRow } from "../shared/types.ts";

/** A `busy` row older than this was left behind by a crashed runner (runs are capped at RUN_TIMEOUT_MS). */
const ABANDONED_MS = env.RUN_TIMEOUT_MS + 5 * 60_000;

/**
 * Insert a mount row. A busy row with an affinity is the workspace's exclusive lease: under an advisory
 * lock on (provider, affinity) it is only inserted if no other live lease holds that workspace, so two
 * concurrent acquires cannot both win the check-then-insert race.
 */
export async function insert(row: Omit<SandboxRow, "last_used_at" | "created_at">): Promise<void> {
  const params = [row.id, row.owner_id ?? null, row.provider, row.status, row.workspace_id, row.affinity, row.external_ref, row.container_key, row.container_ref, row.workdir];
  const sql = `INSERT INTO sandboxes (id, owner_id, provider, status, workspace_id, affinity, external_ref, container_key, container_ref, workdir) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;
  if (row.status !== "busy" || !row.affinity) { await pool.query(sql, params); return; }
  await tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`sandbox:${row.provider}:${row.affinity}`]);
    const busy = await c.query(
      `SELECT 1 FROM sandboxes WHERE provider=$1 AND affinity=$2 AND status='busy' AND id<>$3 AND last_used_at > now() - ($4::bigint * interval '1 millisecond') LIMIT 1`,
      [row.provider, row.affinity, row.id, ABANDONED_MS],
    );
    if (busy.rowCount) throw new Error(`workspace ${row.affinity} is in use by another running session; retry when it is idle`);
    await c.query(sql, params);
  });
}

/** Record the container + workdir a mount landed in (after addMount). */
export async function setMount(id: SandboxId, containerRef: string, workdir: string): Promise<void> {
  await pool.query(`UPDATE sandboxes SET container_ref=$2, workdir=$3, last_used_at=now() WHERE id=$1`, [id, containerRef, workdir]);
}

/** A live (ready/busy/paused) mount whose container we can reuse for a new mount with the same key. */
export async function findContainer(provider: SandboxProviderName, containerKey: string): Promise<SandboxRow | null> {
  const r = await pool.query<SandboxRow>(
    `SELECT * FROM sandboxes WHERE provider=$1 AND container_key=$2 AND status IN ('ready','busy','paused') AND container_ref IS NOT NULL ORDER BY last_used_at DESC LIMIT 1`,
    [provider, containerKey],
  );
  return r.rows[0] ?? null;
}

/** All non-destroyed mounts in a container. */
export async function mountsOf(containerRef: string): Promise<SandboxRow[]> {
  return (await pool.query<SandboxRow>(`SELECT * FROM sandboxes WHERE container_ref=$1 AND status <> 'destroyed'`, [containerRef])).rows;
}

export async function setStatus(id: SandboxId, status: SandboxRow["status"]): Promise<void> {
  await pool.query(`UPDATE sandboxes SET status=$2, last_used_at=now() WHERE id=$1`, [id, status]);
}

export async function touch(id: SandboxId): Promise<void> {
  await pool.query(`UPDATE sandboxes SET last_used_at=now() WHERE id=$1`, [id]);
}

/**
 * Atomically claims an idle (ready or paused) sandbox with matching affinity, marking it busy.
 * The returned row's `status` is the state it was in *before* the claim, so the caller knows
 * whether to resume it.
 */
export async function findReadyByAffinity(provider: SandboxProviderName, affinity: string): Promise<SandboxRow | null> {
  const r = await pool.query<SandboxRow & { prev_status: SandboxRow["status"] }>(
    `WITH pick AS (
       SELECT id, status AS prev_status FROM sandboxes
       WHERE provider=$1 AND affinity=$2 AND status IN ('ready','paused')
       ORDER BY (status <> 'ready'), last_used_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED)
     UPDATE sandboxes s SET status='busy', last_used_at=now() FROM pick
     WHERE s.id = pick.id RETURNING s.*, pick.prev_status`,
    [provider, affinity],
  );
  const row = r.rows[0];
  return row ? { ...row, status: row.prev_status } : null;
}

/** A live lease on the same affinity (another session is running in that workspace right now). */
export async function findBusyByAffinity(provider: SandboxProviderName, affinity: string): Promise<SandboxRow | null> {
  const r = await pool.query<SandboxRow>(
    `SELECT * FROM sandboxes WHERE provider=$1 AND affinity=$2 AND status='busy' AND last_used_at > now() - ($3::bigint * interval '1 millisecond') LIMIT 1`,
    [provider, affinity, ABANDONED_MS],
  );
  return r.rows[0] ?? null;
}

/** Ready sandboxes idle past the ttl (candidates to pause, or destroy without pause support). */
export async function listIdle(provider: SandboxProviderName, olderThanMs: number): Promise<SandboxRow[]> {
  const r = await pool.query<SandboxRow>(
    `SELECT * FROM sandboxes WHERE provider=$1 AND status='ready' AND last_used_at < now() - ($2::bigint * interval '1 millisecond')`,
    [provider, olderThanMs],
  );
  return r.rows;
}

/** Sandboxes to destroy: paused past the ttl, marked 'destroying', or busy but abandoned by a dead runner. */
export async function listToDestroy(provider: SandboxProviderName, pausedTtlMs: number): Promise<SandboxRow[]> {
  const r = await pool.query<SandboxRow>(
    `SELECT * FROM sandboxes WHERE provider=$1 AND (
       status='destroying'
       OR (status='paused' AND last_used_at < now() - ($2::bigint * interval '1 millisecond'))
       OR (status='busy' AND last_used_at < now() - ($3::bigint * interval '1 millisecond')))`,
    [provider, pausedTtlMs, ABANDONED_MS],
  );
  return r.rows;
}

export async function setExternalRef(id: SandboxId, externalRef: string): Promise<void> {
  await pool.query(`UPDATE sandboxes SET external_ref=$2, last_used_at=now() WHERE id=$1`, [id, externalRef]);
}

export async function getScoped(id: SandboxId, owner: string): Promise<SandboxRow | null> {
  return (await pool.query<SandboxRow>(`SELECT * FROM sandboxes WHERE id=$1 AND owner_id=$2`, [id, owner])).rows[0] ?? null;
}
export async function get(id: SandboxId): Promise<SandboxRow | null> {
  const r = await pool.query<SandboxRow>(`SELECT * FROM sandboxes WHERE id=$1`, [id]);
  return r.rows[0] ?? null;
}

export async function list(opts: { includeDestroyed?: boolean; owner?: string } = {}): Promise<SandboxRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!opts.includeDestroyed) where.push(`status <> 'destroyed'`);
  if (opts.owner) { params.push(opts.owner); where.push(`owner_id=$${params.length}`); }
  const r = await pool.query<SandboxRow>(`SELECT * FROM sandboxes${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`, params);
  return r.rows;
}

/**
 * Ask the reaper to destroy a ready sandbox on its next pass (the API process has no docker socket /
 * SDK state, so it never destroys directly). Returns false if the sandbox is busy or already gone.
 */
export async function markForDestroy(id: SandboxId): Promise<boolean> {
  const r = await pool.query(`UPDATE sandboxes SET status='destroying' WHERE id=$1 AND status IN ('ready','paused')`, [id]);
  return (r.rowCount ?? 0) > 0;
}

/** Ask the reaper to pause a ready sandbox on its next pass. */
export async function markForPause(id: SandboxId): Promise<boolean> {
  const r = await pool.query(`UPDATE sandboxes SET last_used_at = to_timestamp(0) WHERE id=$1 AND status='ready'`, [id]);
  return (r.rowCount ?? 0) > 0;
}
