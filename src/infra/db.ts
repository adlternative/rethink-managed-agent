import pg from "pg";
import { env } from "../shared/env.ts";
import { newId } from "../shared/ids.ts";
import type {
  FileResource,
  MemoryMount,
  MemoryStoreResource,
  SkillRef,
  SkillResource,
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
        `INSERT INTO agents (id, name, model, system, tools, packages, skills) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [newId("agent"), input.name, JSON.stringify(input.model), input.system, JSON.stringify(input.tools), JSON.stringify(input.packages ?? []), JSON.stringify(input.skills ?? [])],
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
        `INSERT INTO environments (id, name, provider, image, network, plugin_host, worker_key, workspace) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [newId("env"), input.name, input.provider, input.image, input.network ?? "none", input.plugin_host ?? "runner", input.worker_key ?? null, JSON.stringify(input.workspace)],
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
      memory_stores?: MemoryMount[];
    }): Promise<SessionResource> {
      const envs: SessionEnvironment[] = input.environments?.length
        ? input.environments
        : [{ key: "main", environment_id: input.environment_id, workspace_id: input.workspace_id }];
      const main = envs.find((e) => e.key === "main");
      if (!main) throw new Error("session environments must include key 'main'");
      return tx(async (c) => {
        const row = await one<SessionResource>(
          c,
          `INSERT INTO sessions (id, agent_id, environment_id, workspace_id, agent, parent_id, memory_stores) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [newId("sess"), input.agent_id, main.environment_id, main.workspace_id, JSON.stringify(input.agent), input.parent_id ?? null, JSON.stringify(input.memory_stores ?? [])],
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

export const files = {
  /** Store bytes in the blob store when configured (key files/<id>), else inline in Postgres. */
  async create(input: { filename: string; mime_type: string; data: Buffer }): Promise<FileResource> {
    const { createHash } = await import("node:crypto");
    const { blobsConfigured, putBlob } = await import("./blobs.ts");
    const id = newId("file");
    const sha256 = createHash("sha256").update(input.data).digest("hex");
    let blobKey: string | null = null;
    if (blobsConfigured()) { blobKey = `files/${id}`; await putBlob(blobKey, input.data, input.mime_type); }
    const row = await one<FileResource>(
      pool,
      `INSERT INTO files (id, filename, mime_type, size_bytes, sha256, blob_key, data) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, filename, mime_type, size_bytes, sha256, created_at`,
      [id, input.filename, input.mime_type, input.data.length, sha256, blobKey, blobKey ? null : input.data],
    );
    return files.shape(row!);
  },
  shape(r: Partial<FileResource> & { id: string }): FileResource {
    return { ...(iso(r) as FileResource), type: "file", downloadable: true };
  },
  async get(id: string): Promise<FileResource | null> {
    const r = await one<FileResource>(pool, `SELECT id, filename, mime_type, size_bytes, sha256, created_at FROM files WHERE id=$1`, [id]);
    return r ? files.shape(r) : null;
  },
  async content(id: string): Promise<{ meta: FileResource; data: Buffer } | null> {
    const r = await one<FileResource & { data: Buffer | null; blob_key: string | null }>(pool, `SELECT * FROM files WHERE id=$1`, [id]);
    if (!r) return null;
    const { data, blob_key, ...meta } = r;
    let bytes = data;
    if (blob_key) { const { getBlob } = await import("./blobs.ts"); bytes = await getBlob(blob_key); }
    if (!bytes) return null;
    return { meta: files.shape(meta), data: Buffer.from(bytes) };
  },
  async list(): Promise<FileResource[]> {
    return (await many<FileResource>(pool, `SELECT id, filename, mime_type, size_bytes, sha256, created_at FROM files ORDER BY created_at DESC`)).map((r) => files.shape(r));
  },
  async delete(id: string): Promise<boolean> {
    const r = await one<{ blob_key: string | null }>(pool, `DELETE FROM files WHERE id=$1 RETURNING blob_key`, [id]);
    if (!r) return false;
    if (r.blob_key) { const { deleteBlob } = await import("./blobs.ts"); await deleteBlob(r.blob_key).catch(() => {}); }
    return true;
  },
};

export const skills = {
  async upsert(input: { id?: string; display_title?: string; name: string; description: string; body: string }): Promise<SkillResource> {
    const row = await one<SkillResource>(
      pool,
      `INSERT INTO skills (id, display_title, name, description, body) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET display_title=EXCLUDED.display_title, name=EXCLUDED.name, description=EXCLUDED.description, body=EXCLUDED.body,
         latest_version=(skills.latest_version::int + 1)::text, updated_at=now() RETURNING *`,
      [input.id ?? newId("skill"), input.display_title ?? input.name, input.name, input.description, input.body],
    );
    return skills.shape(row!);
  },
  shape(r: SkillResource): SkillResource { return { ...(iso(r) as SkillResource), type: "skill", source: "custom" }; },
  async get(id: string): Promise<SkillResource | null> { const r = await one<SkillResource>(pool, `SELECT * FROM skills WHERE id=$1`, [id]); return r ? skills.shape(r) : null; },
  async getMany(ids: string[]): Promise<SkillResource[]> {
    if (ids.length === 0) return [];
    return (await many<SkillResource>(pool, `SELECT * FROM skills WHERE id = ANY($1::text[])`, [ids])).map((r) => skills.shape(r));
  },
  async list(): Promise<SkillResource[]> { return (await many<SkillResource>(pool, `SELECT * FROM skills ORDER BY display_title`)).map((r) => skills.shape(r)); },
  async delete(id: string): Promise<boolean> { return ((await pool.query(`DELETE FROM skills WHERE id=$1`, [id])).rowCount ?? 0) > 0; },
};

export const memoryStores = {
  async create(input: { name: string; description?: string }): Promise<MemoryStoreResource> {
    const row = await one<MemoryStoreResource>(pool, `INSERT INTO memory_stores (id, name, description) VALUES ($1,$2,$3) RETURNING *`, [newId("mem"), input.name, input.description ?? ""]);
    return memoryStores.shape(row!);
  },
  shape(r: MemoryStoreResource): MemoryStoreResource { return { ...(iso(r) as MemoryStoreResource), type: "memory_store" }; },
  async get(id: string): Promise<MemoryStoreResource | null> { const r = await one<MemoryStoreResource>(pool, `SELECT * FROM memory_stores WHERE id=$1`, [id]); return r ? memoryStores.shape(r) : null; },
  async getMany(ids: string[]): Promise<MemoryStoreResource[]> {
    if (ids.length === 0) return [];
    return (await many<MemoryStoreResource>(pool, `SELECT * FROM memory_stores WHERE id = ANY($1::text[])`, [ids])).map((r) => memoryStores.shape(r));
  },
  async list(): Promise<MemoryStoreResource[]> { return (await many<MemoryStoreResource>(pool, `SELECT * FROM memory_stores ORDER BY name`)).map((r) => memoryStores.shape(r)); },
  async updateRef(id: string, ref: WorkspaceRef): Promise<void> { await pool.query(`UPDATE memory_stores SET ref=$2, updated_at=now() WHERE id=$1`, [id, JSON.stringify(ref)]); },
  async delete(id: string): Promise<boolean> { return ((await pool.query(`DELETE FROM memory_stores WHERE id=$1`, [id])).rowCount ?? 0) > 0; },
};

/** Mid-session configuration changes (mounts / skills). Applied by the runner from the next run. */
export const sessionConfig = {
  async setMemoryStores(id: string, mounts: MemoryMount[]): Promise<void> {
    await pool.query(`UPDATE sessions SET memory_stores=$2, updated_at=now() WHERE id=$1`, [id, JSON.stringify(mounts)]);
  },
  async setSkills(id: string, refs: SkillRef[]): Promise<void> {
    await pool.query(`UPDATE sessions SET agent = jsonb_set(agent, '{skills}', $2::jsonb), updated_at=now() WHERE id=$1`, [id, JSON.stringify(refs)]);
  },
};
