import pg from "pg";
import { env } from "../shared/env.ts";
import { newId } from "../shared/ids.ts";
import type {
  ProviderResource,
  SessionEnvironment,
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
  providers: {
    async upsert(p: Omit<ProviderResource, "created_at" | "updated_at">): Promise<ProviderResource> {
      const row = await one<ProviderResource>(
        pool,
        `INSERT INTO providers (id, name, api, base_url, headers, auth, models, enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, api=EXCLUDED.api, base_url=EXCLUDED.base_url, headers=EXCLUDED.headers,
           auth=EXCLUDED.auth, models=EXCLUDED.models, enabled=EXCLUDED.enabled, updated_at=now()
         RETURNING *`,
        [p.id, p.name, p.api, p.base_url, JSON.stringify(p.headers), JSON.stringify(p.auth), JSON.stringify(p.models), p.enabled],
      );
      return iso(row)!;
    },
    async get(id: string): Promise<ProviderResource | null> {
      return iso(await one<ProviderResource>(pool, `SELECT * FROM providers WHERE id=$1`, [id]));
    },
    async list(): Promise<ProviderResource[]> {
      return isoAll(await many<ProviderResource>(pool, `SELECT * FROM providers ORDER BY created_at`));
    },
    async delete(id: string): Promise<boolean> {
      const r = await pool.query(`DELETE FROM providers WHERE id=$1`, [id]);
      return (r.rowCount ?? 0) > 0;
    },
  },
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
        `INSERT INTO environments (id, name, provider, image, network, plugin_host, workspace) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [newId("env"), input.name, input.provider, input.image, input.network ?? "none", input.plugin_host ?? "runner", JSON.stringify(input.workspace)],
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
    /**
     * Creates the session plus its environment rows in one tx. `environments[0]` must be "main"
     * (or is created from environment_id/workspace_id when omitted).
     */
    async create(input: {
      agent_id: string;
      environment_id: string;
      workspace_id: string;
      agent: SessionResource["agent"];
      environments?: SessionEnvironment[];
      parent_id?: string | null;
    }): Promise<SessionResource> {
      const envs: SessionEnvironment[] = input.environments?.length
        ? input.environments
        : [{ key: "main", environment_id: input.environment_id, workspace_id: input.workspace_id }];
      const main = envs.find((e) => e.key === "main");
      if (!main) throw new Error("session environments must include key 'main'");
      return tx(async (c) => {
        const row = await one<SessionResource>(
          c,
          `INSERT INTO sessions (id, agent_id, environment_id, workspace_id, agent, parent_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [newId("sess"), input.agent_id, main.environment_id, main.workspace_id, JSON.stringify(input.agent), input.parent_id ?? null],
        );
        for (const e of envs) {
          await c.query(`INSERT INTO session_environments (session_id, key, environment_id, workspace_id) VALUES ($1,$2,$3,$4)`, [row!.id, e.key, e.environment_id, e.workspace_id]);
        }
        return { ...iso(row)!, environments: envs };
      });
    },
    async attachEnvironment(sessionId: string, e: SessionEnvironment): Promise<void> {
      await pool.query(`INSERT INTO session_environments (session_id, key, environment_id, workspace_id) VALUES ($1,$2,$3,$4)`, [sessionId, e.key, e.environment_id, e.workspace_id]);
    },
    async environments(sessionId: string): Promise<SessionEnvironment[]> {
      const rows = await many<SessionEnvironment & { created_at: string }>(pool, `SELECT key, environment_id, workspace_id FROM session_environments WHERE session_id=$1 ORDER BY (key <> 'main'), created_at`, [sessionId]);
      return rows.map(({ key, environment_id, workspace_id }) => ({ key, environment_id, workspace_id }));
    },
    async get(id: string): Promise<SessionResource | null> {
      const row = iso(await one<SessionResource>(pool, `SELECT * FROM sessions WHERE id=$1`, [id]));
      return row ? { ...row, environments: await repos.sessions.environments(id) } : null;
    },
    async list(): Promise<SessionResource[]> {
      const rows = isoAll(await many<SessionResource>(pool, `SELECT * FROM sessions ORDER BY created_at`));
      const envs = await many<SessionEnvironment & { session_id: string }>(pool, `SELECT session_id, key, environment_id, workspace_id FROM session_environments ORDER BY (key <> 'main'), created_at`);
      return rows.map((r) => ({ ...r, environments: envs.filter((e) => e.session_id === r.id).map(({ key, environment_id, workspace_id }) => ({ key, environment_id, workspace_id })) }));
    },
    async setStatus(id: string, status: SessionStatus): Promise<void> {
      await pool.query(`UPDATE sessions SET status=$2, updated_at=now() WHERE id=$1`, [id, status]);
    },
    async delete(id: string): Promise<void> {
      await pool.query(`DELETE FROM sessions WHERE id=$1`, [id]);
    },
  },
};

export const pluginStore = {
  async get(scope: string, owner: string, key: string): Promise<unknown> {
    const r = await pool.query<{ value: unknown }>(`SELECT value FROM plugin_store WHERE scope=$1 AND owner=$2 AND key=$3`, [scope, owner, key]);
    return r.rows[0]?.value ?? null;
  },
  async set(scope: string, owner: string, key: string, value: unknown): Promise<void> {
    await pool.query(
      `INSERT INTO plugin_store (scope, owner, key, value) VALUES ($1,$2,$3,$4)
       ON CONFLICT (scope, owner, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [scope, owner, key, JSON.stringify(value)],
    );
  },
};

export const toolOutputs = {
  async put(sessionId: string, toolUseId: string, toolName: string, content: string): Promise<void> {
    await pool.query(
      `INSERT INTO tool_outputs (session_id, tool_use_id, tool_name, content, bytes) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (session_id, tool_use_id) DO UPDATE SET content=EXCLUDED.content, bytes=EXCLUDED.bytes`,
      [sessionId, toolUseId, toolName, content, Buffer.byteLength(content)],
    );
  },
  async get(sessionId: string, toolUseId: string): Promise<{ tool_name: string; content: string; bytes: number } | null> {
    const r = await pool.query<{ tool_name: string; content: string; bytes: number }>(`SELECT tool_name, content, bytes FROM tool_outputs WHERE session_id=$1 AND tool_use_id=$2`, [sessionId, toolUseId]);
    return r.rows[0] ?? null;
  },
};
