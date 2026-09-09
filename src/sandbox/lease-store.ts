import { pool } from "../infra/db.ts";
import type { SandboxId, SandboxProviderName, SandboxRow } from "../shared/types.ts";

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

export async function listIdle(provider: SandboxProviderName, olderThanMs: number): Promise<SandboxRow[]> {
  const r = await pool.query<SandboxRow>(
    `SELECT * FROM sandboxes WHERE provider=$1 AND status='ready' AND last_used_at < now() - ($2::bigint * interval '1 millisecond')`,
    [provider, olderThanMs],
  );
  return r.rows;
}
