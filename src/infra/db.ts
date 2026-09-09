import pg from "pg";
import { env } from "../shared/env.ts";
import { newId } from "../shared/ids.ts";
import type {
  AgentResource,
  EnvironmentResource,
  SessionResource,
  SessionStatus,
  WorkspaceRef,
  WorkspaceResource,
  WorkspaceSpec,
} from "../shared/types.ts";

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

type Queryable = Pick<pg.Pool, "query">;

async function one<T>(q: Queryable, sql: string, params: unknown[]): Promise<T | null> {
  const r = await q.query(sql, params);
  return (r.rows[0] as T) ?? null;
}
async function many<T>(q: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await q.query(sql, params);
  return r.rows as T[];
}

// Timestamps come back as Date objects; normalize to ISO strings.
function iso<T>(row: T | null): T | null {
  if (!row) return null;
  const r = row as Record<string, unknown>;
  for (const k of ["created_at", "updated_at", "last_used_at"]) {
    if (r[k] instanceof Date) r[k] = (r[k] as Date).toISOString();
  }
  return row;
}
const isoAll = <T>(rows: T[]) => rows.map((r) => iso(r) as T);

export const repos = {
  agents: {
    async create(input: Omit<AgentResource, "id" | "created_at">): Promise<AgentResource> {
      const row = await one<AgentResource>(
        pool,
        `INSERT INTO agents (id, name, model, system, tools, packages) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [newId("agent"), input.name, JSON.stringify(input.model), input.system, JSON.stringify(input.tools), JSON.stringify(input.packages ?? [])],
      );
      return iso(row)!;
    },
    async get(id: string): Promise<AgentResource | null> {
      return iso(await one<AgentResource>(pool, `SELECT * FROM agents WHERE id=$1`, [id]));
    },
    async list(): Promise<AgentResource[]> {
      return isoAll(await many<AgentResource>(pool, `SELECT * FROM agents ORDER BY created_at`));
    },
  },
  environments: {
    async create(input: Omit<EnvironmentResource, "id" | "created_at">): Promise<EnvironmentResource> {
      const row = await one<EnvironmentResource>(
        pool,
        `INSERT INTO environments (id, name, provider, image, workspace) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [newId("env"), input.name, input.provider, input.image, JSON.stringify(input.workspace)],
      );
      return iso(row)!;
    },
    async get(id: string): Promise<EnvironmentResource | null> {
      return iso(await one<EnvironmentResource>(pool, `SELECT * FROM environments WHERE id=$1`, [id]));
    },
    async list(): Promise<EnvironmentResource[]> {
      return isoAll(await many<EnvironmentResource>(pool, `SELECT * FROM environments ORDER BY created_at`));
    },
  },
  workspaces: {
    async create(spec: WorkspaceSpec, ref: WorkspaceRef): Promise<WorkspaceResource> {
      const row = await one<WorkspaceResource>(
        pool,
        `INSERT INTO workspaces (id, spec, ref) VALUES ($1,$2,$3) RETURNING *`,
        [newId("ws"), JSON.stringify(spec), JSON.stringify(ref)],
      );
      return iso(row)!;
    },
    async get(id: string): Promise<WorkspaceResource | null> {
      return iso(await one<WorkspaceResource>(pool, `SELECT * FROM workspaces WHERE id=$1`, [id]));
    },
    /** Optimistic: only replaces `expected` (the ref this run started from). Returns false on a lost race. */
    async updateRef(id: string, ref: WorkspaceRef, expected: WorkspaceRef): Promise<boolean> {
      const r = await pool.query(`UPDATE workspaces SET ref=$2, updated_at=now() WHERE id=$1 AND ref=$3::jsonb`, [id, JSON.stringify(ref), JSON.stringify(expected)]);
      return (r.rowCount ?? 0) > 0;
    },
  },
  sessions: {
    async create(input: {
      agent_id: string;
      environment_id: string;
      workspace_id: string;
      agent: SessionResource["agent"];
    }): Promise<SessionResource> {
      const row = await one<SessionResource>(
        pool,
        `INSERT INTO sessions (id, agent_id, environment_id, workspace_id, agent) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [newId("sess"), input.agent_id, input.environment_id, input.workspace_id, JSON.stringify(input.agent)],
      );
      return iso(row)!;
    },
    async get(id: string): Promise<SessionResource | null> {
      return iso(await one<SessionResource>(pool, `SELECT * FROM sessions WHERE id=$1`, [id]));
    },
    async list(): Promise<SessionResource[]> {
      return isoAll(await many<SessionResource>(pool, `SELECT * FROM sessions ORDER BY created_at`));
    },
    async setStatus(id: string, status: SessionStatus): Promise<void> {
      await pool.query(`UPDATE sessions SET status=$2, updated_at=now() WHERE id=$1`, [id, status]);
    },
    async delete(id: string): Promise<void> {
      await pool.query(`DELETE FROM sessions WHERE id=$1`, [id]);
    },
  },
};
