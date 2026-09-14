import pg from "pg";
import { env } from "../shared/env.ts";
import { newId } from "../shared/ids.ts";
import { parseSessionCursor } from "../shared/cursor.ts";
import { seal, open, type Sealed } from "./secrets.ts";
import type {
  FileResource,
  MemoryMount,
  MemoryStoreResource,
  VaultResource,
  VaultCredentialResource,
  Principal,
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

/** Ownership scope passed to reads: when present, rows are filtered to this principal. Runner/system calls omit it. */
export type Scope = { owner: string } | undefined;

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

export const principals = {
  async get(id: string): Promise<Principal | null> {
    return iso(await one<Principal>(pool, `SELECT * FROM principals WHERE id=$1`, [id]));
  },
  async upsert(input: { id?: string; kind?: Principal["kind"]; handle?: string | null; display_name?: string }): Promise<Principal> {
    const row = await one<Principal>(
      pool,
      `INSERT INTO principals (id, kind, handle, display_name) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET handle=EXCLUDED.handle, display_name=EXCLUDED.display_name RETURNING *`,
      [input.id ?? newId("prc"), input.kind ?? "user", input.handle ?? null, input.display_name ?? ""],
    );
    return iso(row)!;
  },
  async list(): Promise<Principal[]> {
    return isoAll(await many<Principal>(pool, `SELECT * FROM principals ORDER BY created_at`));
  },
};

/** Minimum interval between last_used_at writes for one API key. */
const API_KEY_TOUCH_S = 60;
export const apiKeys = {
  /** Create a key for a principal; returns the plaintext token exactly once (only its hash is stored). */
  async create(principalId: string, name = ""): Promise<{ id: string; token: string }> {
    const { randomBytes, createHash } = await import("node:crypto");
    const token = `pma_${randomBytes(24).toString("base64url")}`;
    const id = newId("key");
    await pool.query(`INSERT INTO api_keys (id, principal_id, token_sha256, name) VALUES ($1,$2,$3,$4)`, [id, principalId, createHash("sha256").update(token).digest("hex"), name]);
    return { id, token };
  },
  /**
   * Resolve a bearer token to its principal, or null, in one round trip. Touches last_used_at at most once a
   * minute per key (minute precision), so steady traffic on one key does not write + row-lock on every request.
   */
  async resolve(token: string): Promise<Principal | null> {
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(token).digest("hex");
    return iso(await one<Principal>(pool,
      `WITH k AS (SELECT id, principal_id, last_used_at FROM api_keys WHERE token_sha256=$1),
       touch AS (UPDATE api_keys a SET last_used_at=now() FROM k WHERE a.id = k.id AND (k.last_used_at IS NULL OR k.last_used_at < now() - interval '${API_KEY_TOUCH_S} seconds'))
       SELECT p.* FROM k JOIN principals p ON p.id = k.principal_id`, [hash]));
  },
};

export const repos = {
  providers: {
    /** Insert, or update the row with this id when it belongs to the same owner. null: the id is taken by another owner. */
    async upsert(p: Omit<ProviderResource, "created_at" | "updated_at">): Promise<ProviderResource | null> {
      const row = await one<ProviderResource>(
        pool,
        `INSERT INTO providers (id, owner_id, name, api, base_url, headers, auth, models, enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, api=EXCLUDED.api, base_url=EXCLUDED.base_url, headers=EXCLUDED.headers,
           auth=EXCLUDED.auth, models=EXCLUDED.models, enabled=EXCLUDED.enabled, updated_at=now()
         WHERE providers.owner_id = EXCLUDED.owner_id
         RETURNING *`,
        [p.id, p.owner_id, p.name, p.api, p.base_url, JSON.stringify(p.headers), JSON.stringify(p.auth), JSON.stringify(p.models), p.enabled],
      );
      return iso(row);
    },
    async get(id: string, scope?: Scope): Promise<ProviderResource | null> {
      return iso(await one<ProviderResource>(pool, `SELECT * FROM providers WHERE id=$1${scope ? " AND owner_id=$2" : ""}`, scope ? [id, scope.owner] : [id]));
    },
    async list(scope?: Scope): Promise<ProviderResource[]> {
      return isoAll(await many<ProviderResource>(pool, `SELECT * FROM providers${scope ? " WHERE owner_id=$1" : ""} ORDER BY created_at`, scope ? [scope.owner] : []));
    },
    async delete(id: string, scope?: Scope): Promise<boolean> {
      const r = await pool.query(`DELETE FROM providers WHERE id=$1${scope ? " AND owner_id=$2" : ""}`, scope ? [id, scope.owner] : [id]);
      return (r.rowCount ?? 0) > 0;
    },
  },
  agents: {
    async create(input: Omit<AgentResource, "id" | "created_at">): Promise<AgentResource> {
      const row = await one<AgentResource>(
        pool,
        `INSERT INTO agents (id, owner_id, name, model, system, tools, packages, skills) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [newId("agent"), input.owner_id, input.name, JSON.stringify(input.model), input.system, JSON.stringify(input.tools), JSON.stringify(input.packages ?? []), JSON.stringify(input.skills ?? [])],
      );
      return iso(row)!;
    },
    async get(id: string, scope?: Scope): Promise<AgentResource | null> {
      return iso(await one<AgentResource>(pool, `SELECT * FROM agents WHERE id=$1${scope ? " AND owner_id=$2" : ""}`, scope ? [id, scope.owner] : [id]));
    },
    async update(id: string, patch: Partial<Omit<AgentResource, "id" | "created_at">>, scope?: Scope): Promise<AgentResource | null> {
      const row = await one<AgentResource>(
        pool,
        `UPDATE agents SET name=COALESCE($2,name), model=COALESCE($3::jsonb,model), system=CASE WHEN $8 THEN $4 ELSE system END,
           tools=COALESCE($5::jsonb,tools), packages=COALESCE($6::jsonb,packages), skills=COALESCE($7::jsonb,skills) WHERE id=$1${scope ? " AND owner_id=$9" : ""} RETURNING *`,
        scope
          ? [id, patch.name ?? null, patch.model ? JSON.stringify(patch.model) : null, patch.system ?? null, patch.tools ? JSON.stringify(patch.tools) : null, patch.packages ? JSON.stringify(patch.packages) : null, patch.skills ? JSON.stringify(patch.skills) : null, "system" in patch, scope.owner]
          : [id, patch.name ?? null, patch.model ? JSON.stringify(patch.model) : null, patch.system ?? null, patch.tools ? JSON.stringify(patch.tools) : null, patch.packages ? JSON.stringify(patch.packages) : null, patch.skills ? JSON.stringify(patch.skills) : null, "system" in patch],
      );
      return iso(row);
    },
    async list(scope?: Scope): Promise<AgentResource[]> {
      return isoAll(await many<AgentResource>(pool, `SELECT * FROM agents${scope ? " WHERE owner_id=$1" : ""} ORDER BY created_at`, scope ? [scope.owner] : []));
    },
  },
  environments: {
    async create(input: Omit<EnvironmentResource, "id" | "created_at">): Promise<EnvironmentResource> {
      const row = await one<EnvironmentResource>(
        pool,
        `INSERT INTO environments (id, owner_id, name, provider, image, network, plugin_host, worker_key, workspace) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [newId("env"), input.owner_id, input.name, input.provider, input.image, input.network ?? "none", input.plugin_host ?? "runner", input.worker_key ?? null, JSON.stringify(input.workspace)],
      );
      return iso(row)!;
    },
    async get(id: string, scope?: Scope): Promise<EnvironmentResource | null> {
      return iso(await one<EnvironmentResource>(pool, `SELECT * FROM environments WHERE id=$1${scope ? " AND owner_id=$2" : ""}`, scope ? [id, scope.owner] : [id]));
    },
    async list(scope?: Scope): Promise<EnvironmentResource[]> {
      return isoAll(await many<EnvironmentResource>(pool, `SELECT * FROM environments${scope ? " WHERE owner_id=$1" : ""} ORDER BY created_at`, scope ? [scope.owner] : []));
    },
  },
  workspaces: {
    async create(spec: WorkspaceSpec, ref: WorkspaceRef, owner_id: string): Promise<WorkspaceResource> {
      const row = await one<WorkspaceResource>(
        pool,
        `INSERT INTO workspaces (id, owner_id, spec, ref) VALUES ($1,$2,$3,$4) RETURNING *`,
        [newId("ws"), owner_id, JSON.stringify(spec), JSON.stringify(ref)],
      );
      return iso(row)!;
    },
    async get(id: string, scope?: Scope): Promise<WorkspaceResource | null> {
      return iso(await one<WorkspaceResource>(pool, `SELECT * FROM workspaces WHERE id=$1${scope ? " AND owner_id=$2" : ""}`, scope ? [id, scope.owner] : [id]));
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
      owner_id: string;
      agent_id: string;
      environment_id: string;
      workspace_id: string;
      agent: SessionResource["agent"];
      environments?: SessionEnvironment[];
      parent_id?: string | null;
      memory_stores?: MemoryMount[];
      vault_ids?: string[];
      /** container-sharing group; children inherit the parent's so a spawn tree shares a container */
      container_group?: string | null;
    }): Promise<SessionResource> {
      const envs: SessionEnvironment[] = input.environments?.length
        ? input.environments
        : [{ key: "main", environment_id: input.environment_id, workspace_id: input.workspace_id }];
      const main = envs.find((e) => e.key === "main");
      if (!main) throw new Error("session environments must include key 'main'");
      return tx(async (c) => {
        const row = await one<SessionResource>(
          c,
          `INSERT INTO sessions (id, owner_id, agent_id, environment_id, workspace_id, agent, parent_id, memory_stores, container_group, vault_ids)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9, $1), $10) RETURNING *`,
          [newId("sess"), input.owner_id, input.agent_id, main.environment_id, main.workspace_id, JSON.stringify(input.agent), input.parent_id ?? null, JSON.stringify(input.memory_stores ?? []), input.container_group ?? null, input.vault_ids ?? []],
        );
        for (const e of envs) {
          await c.query(`INSERT INTO session_environments (session_id, key, environment_id, workspace_id) VALUES ($1,$2,$3,$4)`, [row!.id, e.key, e.environment_id, e.workspace_id]);
        }
        return { ...iso(row)!, environments: envs };
      });
    },
    /** false when the key is already attached (a concurrent attach won). */
    async attachEnvironment(sessionId: string, e: SessionEnvironment): Promise<boolean> {
      const r = await pool.query(`INSERT INTO session_environments (session_id, key, environment_id, workspace_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [sessionId, e.key, e.environment_id, e.workspace_id]);
      return (r.rowCount ?? 0) > 0;
    },
    async environments(sessionId: string): Promise<SessionEnvironment[]> {
      const rows = await many<SessionEnvironment & { created_at: string }>(pool, `SELECT key, environment_id, workspace_id FROM session_environments WHERE session_id=$1 ORDER BY (key <> 'main'), created_at`, [sessionId]);
      return rows.map(({ key, environment_id, workspace_id }) => ({ key, environment_id, workspace_id }));
    },
    async get(id: string, scope?: Scope): Promise<SessionResource | null> {
      const row = iso(await one<SessionResource>(pool, `SELECT * FROM sessions WHERE id=$1${scope ? " AND owner_id=$2" : ""}`, scope ? [id, scope.owner] : [id]));
      return row ? { ...row, environments: await repos.sessions.environments(id) } : null;
    },
    async list(scope?: Scope): Promise<SessionResource[]> {
      const rows = isoAll(await many<SessionResource>(pool, `SELECT * FROM sessions${scope ? " WHERE owner_id=$1" : ""} ORDER BY created_at`, scope ? [scope.owner] : []));
      return withEnvironments(rows);
    },
    /** Child (sub-agent) sessions of a parent, oldest first. */
    async childrenOf(parentId: string, scope?: Scope): Promise<SessionResource[]> {
      const rows = isoAll(await many<SessionResource>(pool, `SELECT * FROM sessions WHERE parent_id=$1${scope ? " AND owner_id=$2" : ""} ORDER BY created_at`, scope ? [parentId, scope.owner] : [parentId]));
      return withEnvironments(rows);
    },
    /**
     * Cursor-paginated, newest first. cursor = the previous page's next_cursor, `<created_at ISO, microseconds>|<id>`
     * (a bare ISO timestamp is still accepted); `after` = a session id to continue after (the OpenAI-style cursor).
     * (created_at, id) is the sort key, so rows sharing a timestamp are neither skipped nor repeated.
     */
    async listPage(scope: Scope, opts: { limit?: number; cursor?: string; after?: string } = {}): Promise<{ data: SessionResource[]; has_more: boolean; next_cursor: string | null }> {
      const lim = Math.min(Math.max(opts.limit ?? 50, 1), 200);
      const params: unknown[] = []; const where: string[] = [];
      if (scope) { params.push(scope.owner); where.push(`owner_id=$${params.length}`); }
      if (opts.cursor) {
        const [ts, id] = parseSessionCursor(opts.cursor);
        params.push(ts); where.push(id === undefined ? `created_at < $${params.length}::timestamptz` : `(created_at, id) < ($${params.length}::timestamptz, $${params.push(id)})`);
      }
      if (opts.after) { params.push(opts.after); where.push(`(created_at, id) < (SELECT created_at, id FROM sessions WHERE id=$${params.length})`); }
      const rows = isoAll(await many<SessionResource & { cursor_ts?: string }>(pool, `SELECT *, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts FROM sessions${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ${lim + 1}`, params));
      const has_more = rows.length > lim;
      const page = rows.slice(0, lim);
      const last = page[page.length - 1];
      const next_cursor = has_more && last ? `${last.cursor_ts ?? last.created_at}|${last.id}` : null;
      const data = await withEnvironments(page.map(({ cursor_ts: _t, ...r }) => r as SessionResource));
      return { data, has_more, next_cursor };
    },
    async setStatus(id: string, status: SessionStatus): Promise<void> {
      await pool.query(`UPDATE sessions SET status=$2, updated_at=now() WHERE id=$1`, [id, status]);
    },
    async delete(id: string): Promise<void> {
      await pool.query(`DELETE FROM sessions WHERE id=$1`, [id]);
    },
  },
};

/** Attach each session's environment rows (one query for the whole batch). */
async function withEnvironments(rows: SessionResource[]): Promise<SessionResource[]> {
  const ids = rows.map((r) => r.id);
  const envs = ids.length ? await many<SessionEnvironment & { session_id: string }>(pool, `SELECT session_id, key, environment_id, workspace_id FROM session_environments WHERE session_id = ANY($1::text[]) ORDER BY (key <> 'main'), created_at`, [ids]) : [];
  const bySession = new Map<string, SessionEnvironment[]>(); // grouped in query order, so each list keeps the ORDER BY
  for (const { session_id, key, environment_id, workspace_id } of envs) (bySession.get(session_id) ?? bySession.set(session_id, []).get(session_id)!).push({ key, environment_id, workspace_id });
  return rows.map((r) => ({ ...r, environments: bySession.get(r.id) ?? [] }));
}

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
  async create(input: { owner_id: string; filename: string; mime_type: string; data: Buffer }): Promise<FileResource> {
    const { createHash } = await import("node:crypto");
    const { blobsConfigured, putBlob } = await import("./blobs.ts");
    const id = newId("file");
    const sha256 = createHash("sha256").update(input.data).digest("hex");
    let blobKey: string | null = null;
    if (blobsConfigured()) { blobKey = `files/${id}`; await putBlob(blobKey, input.data, input.mime_type); }
    const row = await one<FileResource>(
      pool,
      `INSERT INTO files (id, owner_id, filename, mime_type, size_bytes, sha256, blob_key, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, filename, mime_type, size_bytes, sha256, created_at`,
      [id, input.owner_id, input.filename, input.mime_type, input.data.length, sha256, blobKey, blobKey ? null : input.data],
    );
    return files.shape(row!);
  },
  shape(r: Partial<FileResource> & { id: string }): FileResource {
    return { ...(iso(r) as FileResource), type: "file", downloadable: true };
  },
  async get(id: string, scope?: Scope): Promise<FileResource | null> {
    const r = await one<FileResource>(pool, `SELECT id, filename, mime_type, size_bytes, sha256, created_at FROM files WHERE id=$1${scope ? " AND owner_id=$2" : ""}`, scope ? [id, scope.owner] : [id]);
    return r ? files.shape(r) : null;
  },
  async content(id: string, scope?: Scope): Promise<{ meta: FileResource; data: Buffer } | null> {
    const r = await one<FileResource & { data: Buffer | null; blob_key: string | null }>(pool, `SELECT * FROM files WHERE id=$1${scope ? " AND owner_id=$2" : ""}`, scope ? [id, scope.owner] : [id]);
    if (!r) return null;
    const { data, blob_key, ...meta } = r;
    let bytes = data;
    if (blob_key) { const { getBlob } = await import("./blobs.ts"); bytes = await getBlob(blob_key); }
    if (!bytes) return null;
    return { meta: files.shape(meta), data: Buffer.from(bytes) };
  },
  async list(scope?: Scope): Promise<FileResource[]> {
    return (await many<FileResource>(pool, `SELECT id, filename, mime_type, size_bytes, sha256, created_at FROM files${scope ? " WHERE owner_id=$1" : ""} ORDER BY created_at DESC`, scope ? [scope.owner] : [])).map((r) => files.shape(r));
  },
  async delete(id: string, scope?: Scope): Promise<boolean> {
    const r = await one<{ blob_key: string | null }>(pool, `DELETE FROM files WHERE id=$1${scope ? " AND owner_id=$2" : ""} RETURNING blob_key`, scope ? [id, scope.owner] : [id]);
    if (!r) return false;
    if (r.blob_key) { const { deleteBlob } = await import("./blobs.ts"); await deleteBlob(r.blob_key).catch(() => {}); }
    return true;
  },
};

export const skills = {
  async upsert(input: { id?: string; owner_id: string; display_title?: string; name: string; description: string; body: string }): Promise<SkillResource> {
    const row = await one<SkillResource>(
      pool,
      `INSERT INTO skills (id, owner_id, display_title, name, description, body) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET display_title=EXCLUDED.display_title, name=EXCLUDED.name, description=EXCLUDED.description, body=EXCLUDED.body,
         latest_version=(skills.latest_version::int + 1)::text, updated_at=now() RETURNING *`,
      [input.id ?? newId("skill"), input.owner_id, input.display_title ?? input.name, input.name, input.description, input.body],
    );
    return skills.shape(row!);
  },
  shape(r: SkillResource): SkillResource { return { ...(iso(r) as SkillResource), type: "skill", source: "custom" }; },
  async get(id: string, scope?: Scope): Promise<SkillResource | null> { const r = await one<SkillResource>(pool, `SELECT * FROM skills WHERE id=$1${scope ? " AND owner_id=$2" : ""}`, scope ? [id, scope.owner] : [id]); return r ? skills.shape(r) : null; },
  async getMany(ids: string[], scope?: Scope): Promise<SkillResource[]> {
    if (ids.length === 0) return [];
    return (await many<SkillResource>(pool, `SELECT * FROM skills WHERE id = ANY($1::text[])${scope ? " AND owner_id=$2" : ""}`, scope ? [ids, scope.owner] : [ids])).map((r) => skills.shape(r));
  },
  async list(scope?: Scope): Promise<SkillResource[]> { return (await many<SkillResource>(pool, `SELECT * FROM skills${scope ? " WHERE owner_id=$1" : ""} ORDER BY display_title`, scope ? [scope.owner] : [])).map((r) => skills.shape(r)); },
  async delete(id: string, scope?: Scope): Promise<boolean> { return ((await pool.query(`DELETE FROM skills WHERE id=$1${scope ? " AND owner_id=$2" : ""}`, scope ? [id, scope.owner] : [id])).rowCount ?? 0) > 0; },
};

export const memoryStores = {
  async create(input: { owner_id: string; name: string; description?: string }): Promise<MemoryStoreResource> {
    const row = await one<MemoryStoreResource>(pool, `INSERT INTO memory_stores (id, owner_id, name, description) VALUES ($1,$2,$3,$4) RETURNING *`, [newId("mem"), input.owner_id, input.name, input.description ?? ""]);
    return memoryStores.shape(row!);
  },
  shape(r: MemoryStoreResource): MemoryStoreResource { return { ...(iso(r) as MemoryStoreResource), type: "memory_store" }; },
  async get(id: string, scope?: Scope): Promise<MemoryStoreResource | null> { const r = await one<MemoryStoreResource>(pool, `SELECT * FROM memory_stores WHERE id=$1${scope ? " AND owner_id=$2" : ""}`, scope ? [id, scope.owner] : [id]); return r ? memoryStores.shape(r) : null; },
  async getMany(ids: string[], scope?: Scope): Promise<MemoryStoreResource[]> {
    if (ids.length === 0) return [];
    return (await many<MemoryStoreResource>(pool, `SELECT * FROM memory_stores WHERE id = ANY($1::text[])${scope ? " AND owner_id=$2" : ""}`, scope ? [ids, scope.owner] : [ids])).map((r) => memoryStores.shape(r));
  },
  async list(scope?: Scope): Promise<MemoryStoreResource[]> { return (await many<MemoryStoreResource>(pool, `SELECT * FROM memory_stores${scope ? " WHERE owner_id=$1" : ""} ORDER BY name`, scope ? [scope.owner] : [])).map((r) => memoryStores.shape(r)); },
  async updateRef(id: string, ref: WorkspaceRef): Promise<void> { await pool.query(`UPDATE memory_stores SET ref=$2, updated_at=now() WHERE id=$1`, [id, JSON.stringify(ref)]); },
  async delete(id: string, scope?: Scope): Promise<boolean> { return ((await pool.query(`DELETE FROM memory_stores WHERE id=$1${scope ? " AND owner_id=$2" : ""}`, scope ? [id, scope.owner] : [id])).rowCount ?? 0) > 0; },
};

/** Mid-session configuration changes (mounts / skills). Applied by the runner from the next run. */
export const sessionConfig = {
  async setSystem(id: string, system: string | null): Promise<void> {
    await pool.query(`UPDATE sessions SET agent = jsonb_set(agent, '{system}', $2::jsonb), updated_at=now() WHERE id=$1`, [id, JSON.stringify(system)]);
  },
  async recordSystemPrompt(id: string, prompt: string): Promise<void> {
    await pool.query(`UPDATE sessions SET last_system_prompt=$2 WHERE id=$1`, [id, prompt]);
  },
  async lastSystemPrompt(id: string): Promise<string | null> {
    const r = await pool.query<{ last_system_prompt: string | null }>(`SELECT last_system_prompt FROM sessions WHERE id=$1`, [id]);
    return r.rows[0]?.last_system_prompt ?? null;
  },
  async setMemoryStores(id: string, mounts: MemoryMount[]): Promise<void> {
    await pool.query(`UPDATE sessions SET memory_stores=$2, updated_at=now() WHERE id=$1`, [id, JSON.stringify(mounts)]);
  },
  async setSkills(id: string, refs: SkillRef[]): Promise<void> {
    await pool.query(`UPDATE sessions SET agent = jsonb_set(agent, '{skills}', $2::jsonb), updated_at=now() WHERE id=$1`, [id, JSON.stringify(refs)]);
  },
  // Single-statement add/remove (no read-modify-write), so concurrent changes never lose an update.
  /** Append a skill ref unless one with that skill_id is attached. Returns the new list, or null when already attached. */
  async addSkill(id: string, ref: SkillRef): Promise<SkillRef[] | null> {
    const r = await pool.query<{ v: SkillRef[] }>(
      `UPDATE sessions SET agent = jsonb_set(agent, '{skills}', COALESCE(agent->'skills', '[]'::jsonb) || $2::jsonb), updated_at=now()
       WHERE id=$1 AND NOT COALESCE(agent->'skills', '[]'::jsonb) @> $3::jsonb RETURNING agent->'skills' AS v`,
      [id, JSON.stringify([ref]), JSON.stringify([{ skill_id: ref.skill_id }])]);
    return r.rows[0]?.v ?? null;
  },
  /** Remove a skill by id. Returns the new list, or null when it was not attached. */
  async removeSkill(id: string, skillId: string): Promise<SkillRef[] | null> {
    const r = await pool.query<{ v: SkillRef[] }>(
      `UPDATE sessions SET agent = jsonb_set(agent, '{skills}', (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(agent->'skills') e WHERE e->>'skill_id' <> $2)), updated_at=now()
       WHERE id=$1 AND COALESCE(agent->'skills', '[]'::jsonb) @> $3::jsonb RETURNING agent->'skills' AS v`,
      [id, skillId, JSON.stringify([{ skill_id: skillId }])]);
    return r.rows[0]?.v ?? null;
  },
  /** Append a mount unless the same store or mount_path is mounted. Returns the new list, or null on a clash. */
  async addMemoryStore(id: string, mount: MemoryMount): Promise<MemoryMount[] | null> {
    const r = await pool.query<{ v: MemoryMount[] }>(
      `UPDATE sessions SET memory_stores = memory_stores || $2::jsonb, updated_at=now()
       WHERE id=$1 AND NOT memory_stores @> $3::jsonb AND NOT memory_stores @> $4::jsonb RETURNING memory_stores AS v`,
      [id, JSON.stringify([mount]), JSON.stringify([{ memory_store_id: mount.memory_store_id }]), JSON.stringify([{ mount_path: mount.mount_path }])]);
    return r.rows[0]?.v ?? null;
  },
  /** Unmount a store. Returns the new list, or null when it was not mounted. */
  async removeMemoryStore(id: string, storeId: string): Promise<MemoryMount[] | null> {
    const r = await pool.query<{ v: MemoryMount[] }>(
      `UPDATE sessions SET memory_stores = (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(memory_stores) e WHERE e->>'memory_store_id' <> $2), updated_at=now()
       WHERE id=$1 AND memory_stores @> $3::jsonb RETURNING memory_stores AS v`,
      [id, storeId, JSON.stringify([{ memory_store_id: storeId }])]);
    return r.rows[0]?.v ?? null;
  },
};

/** Vaults: per-principal encrypted secrets. Secret values are write-only (never returned). */
export const vaults = {
  async create(input: { owner_id: string; name?: string | null; metadata?: Record<string, string> }): Promise<VaultResource> {
    const r = await one<VaultResource>(pool, `INSERT INTO vaults (id, owner_id, name, metadata) VALUES ($1,$2,$3,$4) RETURNING id, owner_id, name, metadata, created_at`, [newId("vault"), input.owner_id, input.name ?? null, JSON.stringify(input.metadata ?? {})]);
    return iso(r)!;
  },
  async get(id: string, scope?: Scope): Promise<VaultResource | null> {
    return iso(await one<VaultResource>(pool, `SELECT id, owner_id, name, metadata, created_at FROM vaults WHERE id=$1${scope ? " AND owner_id=$2" : ""}`, scope ? [id, scope.owner] : [id]));
  },
  async list(scope?: Scope): Promise<VaultResource[]> {
    return (await many<VaultResource>(pool, `SELECT id, owner_id, name, metadata, created_at FROM vaults${scope ? " WHERE owner_id=$1" : ""} ORDER BY id DESC`, scope ? [scope.owner] : [])).map((r) => iso(r)!);
  },
  async delete(id: string, scope?: Scope): Promise<boolean> {
    return ((await pool.query(`DELETE FROM vaults WHERE id=$1${scope ? " AND owner_id=$2" : ""}`, scope ? [id, scope.owner] : [id])).rowCount ?? 0) > 0;
  },
};

/** Credentials in a vault. The plaintext is sealed with PMA_SECRET_KEY and never leaves the DB. */
export const vaultCredentials = {
  /** Store (or replace) a named secret. `value` is the plaintext, sealed before it is written. */
  async put(vaultId: string, name: string, value: string, metadata?: Record<string, string>): Promise<VaultCredentialResource> {
    const r = await one<VaultCredentialResource>(pool,
      `INSERT INTO vault_credentials (id, vault_id, name, secret, metadata) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (vault_id, name) DO UPDATE SET secret=EXCLUDED.secret, metadata=EXCLUDED.metadata
       RETURNING id, vault_id, name, metadata, created_at`,
      [newId("cred"), vaultId, name, JSON.stringify(seal(value)), JSON.stringify(metadata ?? {})]);
    return iso(r)!;
  },
  async list(vaultId: string): Promise<VaultCredentialResource[]> {
    return (await many<VaultCredentialResource>(pool, `SELECT id, vault_id, name, metadata, created_at FROM vault_credentials WHERE vault_id=$1 ORDER BY name`, [vaultId])).map((r) => iso(r)!);
  },
  async get(vaultId: string, name: string): Promise<VaultCredentialResource | null> {
    return iso(await one<VaultCredentialResource>(pool, `SELECT id, vault_id, name, metadata, created_at FROM vault_credentials WHERE vault_id=$1 AND name=$2`, [vaultId, name]));
  },
  async delete(vaultId: string, name: string): Promise<boolean> {
    return ((await pool.query(`DELETE FROM vault_credentials WHERE vault_id=$1 AND name=$2`, [vaultId, name])).rowCount ?? 0) > 0;
  },
};

/**
 * Decrypt the secrets of the given vaults (owner-scoped) into an env map for sandbox injection.
 * A later vault's key wins on a name clash. Skips vaults not owned by `ownerId`.
 */
export async function vaultSecrets(ownerId: string, vaultIds: string[]): Promise<Record<string, string>> {
  if (!vaultIds?.length) return {};
  const rows = await many<{ name: string; secret: Sealed; vault_id: string }>(pool,
    `SELECT c.name, c.secret, c.vault_id FROM vault_credentials c JOIN vaults v ON v.id = c.vault_id
     WHERE c.vault_id = ANY($1::text[]) AND v.owner_id = $2 ORDER BY array_position($1::text[], c.vault_id)`,
    [vaultIds, ownerId]);
  const out: Record<string, string> = {};
  for (const r of rows) { try { out[r.name] = open(r.secret); } catch { /* skip unreadable */ } }
  return out;
}
