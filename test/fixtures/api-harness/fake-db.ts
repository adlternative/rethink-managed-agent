/**
 * In-memory stand-in for src/infra/db.ts used by the api-* route tests. It mirrors the SQL semantics
 * the routes depend on: a scoped read (`scope` object present) only matches rows whose owner_id equals
 * scope.owner (so `{owner: undefined}` matches nothing, like `owner_id = NULL`), an unscoped read sees
 * everything, and the few inputs Postgres would reject (LIMIT NaN, a non-timestamp cursor, a duplicate
 * primary key) throw the same way. Every write is logged in `store.ops` so tests can assert which rows
 * were (not) created.
 */
import { createHash, randomBytes } from "node:crypto";
import { newId } from "../../../src/shared/ids.ts";
import { seal } from "../../../src/infra/secrets.ts";

type Row = Record<string, any>;
type Scope = { owner: string } | undefined;

export const store = {
  principals: new Map<string, Row>(),
  apiKeys: new Map<string, { id: string; principal_id: string }>(),
  providers: new Map<string, Row>(),
  agents: new Map<string, Row>(),
  environments: new Map<string, Row>(),
  workspaces: new Map<string, Row>(),
  sessions: new Map<string, Row>(),
  events: new Map<string, Row[]>(),
  files: new Map<string, Row>(),
  skills: new Map<string, Row>(),
  memoryStores: new Map<string, Row>(),
  vaults: new Map<string, Row>(),
  creds: new Map<string, Row>(),
  schedules: new Map<string, Row>(),
  sandboxes: new Map<string, Row>(),
  toolOutputs: new Map<string, Row>(),
  ops: [] as string[],
  /** Test hooks: awaited inside reads so a test can force two requests to interleave deterministically. */
  hooks: {} as { sessionGet?: () => Promise<void>; providerGet?: () => Promise<void>; beforeMark?: (id: string) => void; listThrow?: string },
  pollCalls: [] as { envId: string; workerId: string; ids: string[] }[],
  results: [] as unknown[],
  alive: new Set<string>(),
};

let clock = Date.parse("2026-01-01T00:00:00.000Z");
const now = () => new Date(clock++).toISOString();
const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));
const vis = (r: Row | undefined, sc: Scope) => !!r && (!sc || r.owner_id === sc.owner);
const get = (m: Map<string, Row>, id: string, sc: Scope) => { const r = m.get(id); return vis(r, sc) ? clone(r!) : null; };
const list = (m: Map<string, Row>, sc: Scope) => [...m.values()].filter((r) => vis(r, sc)).map(clone);

export function reset(): void {
  for (const v of Object.values(store)) if (v instanceof Map || v instanceof Set) v.clear();
  store.ops.length = 0; store.pollCalls.length = 0; store.results.length = 0; store.hooks = {};
}

/** Seed helpers (bypass the op log). */
export const seed = {
  principal: (id: string) => { const p = { id, kind: "user", handle: null, display_name: id, created_at: now() }; store.principals.set(id, p); return p; },
  agent: (owner: string, extra: Row = {}) => { const a = { id: newId("agent"), owner_id: owner, name: "a", model: { provider: "qoder", id: "auto" }, system: null, tools: ["bash"], packages: [], skills: [], created_at: now(), ...extra }; store.agents.set(a.id, a); return a; },
  environment: (owner: string, extra: Row = {}) => { const e = { id: newId("env"), owner_id: owner, name: "e", provider: "local", image: null, network: "none", plugin_host: "runner", worker_key: null, workspace: { kind: "empty" }, created_at: now(), ...extra }; store.environments.set(e.id, e); return e; },
  workspace: (owner: string, ref: Row = { kind: "empty" }, spec: Row = { kind: "empty" }) => { const w = { id: newId("ws"), owner_id: owner, spec, ref, created_at: now(), updated_at: now() }; store.workspaces.set(w.id, w); return w; },
  session: (owner: string, extra: Row = {}) => {
    const agent = seed.agent(owner); const env = seed.environment(owner); const ws = seed.workspace(owner);
    const s = { id: newId("sess"), owner_id: owner, agent_id: agent.id, environment_id: env.id, workspace_id: ws.id, environments: [{ key: "main", environment_id: env.id, workspace_id: ws.id }], parent_id: null, container_group: null, memory_stores: [], vault_ids: [], status: "idle", agent: { ...agent }, usage: {}, context: null, created_at: now(), updated_at: now(), ...extra };
    store.sessions.set(s.id, s); store.events.set(s.id, []); return s;
  },
  events: (sessionId: string, payloads: Row[]) => { const arr = store.events.get(sessionId) ?? []; for (const p of payloads) arr.push({ id: newId("evt"), session_id: sessionId, seq: arr.length + 1, type: p.type, payload: p, created_at: now() }); store.events.set(sessionId, arr); return arr; },
  skill: (owner: string, extra: Row = {}) => { const s = { id: newId("skill"), owner_id: owner, type: "skill", source: "custom", display_title: "s", name: "s", description: "d", body: "b", latest_version: "1", created_at: now(), updated_at: now(), ...extra }; store.skills.set(s.id, s); return s; },
  memoryStore: (owner: string, name: string) => { const m = { id: newId("mem"), owner_id: owner, type: "memory_store", name, description: "", ref: { kind: "empty" }, created_at: now(), updated_at: now() }; store.memoryStores.set(m.id, m); return m; },
  provider: (owner: string, id: string, extra: Row = {}) => { const p = { id, owner_id: owner, name: id, api: "openai-completions", base_url: "http://x", headers: {}, auth: { type: "none" }, models: [{ id: "m1", context_window: 1000 }], enabled: true, created_at: now(), updated_at: now(), ...extra }; store.providers.set(id, p); return p; },
  vault: (owner: string) => { const v = { id: newId("vault"), owner_id: owner, name: "v", metadata: {}, created_at: now() }; store.vaults.set(v.id, v); return v; },
  schedule: (owner: string, extra: Row = {}) => {
    const s = {
      id: newId("sched"), owner_id: owner, name: "s", cron: "0 * * * *", timezone: "UTC", enabled: true,
      action: { type: "session.create", agent_id: "agent_x", environment_id: "env_x", message: "hi" },
      next_run_at: now(), last_run_at: null, last_run_status: null, last_run_error: null, last_run_session_id: null,
      created_at: now(), updated_at: now(), ...extra,
    };
    store.schedules.set(s.id, s); return s;
  },
  sandbox: (owner: string, status: string, extra: Row = {}) => { const s = { id: newId("sbx"), owner_id: owner, provider: "local", status, created_at: now(), ...extra }; store.sandboxes.set(s.id, s); return s; },
};

const client = { query: async (sql: string, params: unknown[] = []) => pool.query(sql, params), release() {} };
export const pool = {
  async query(sql: string, params: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> {
    store.ops.push(`sql:${sql}`);
    // worker.ts resumeEnvironment: idle sessions of the env whose newest disconnect is newer than their newest run start
    if (/FROM sessions s\s+WHERE s\.environment_id=\$1 AND s\.status='idle'/.test(sql)) {
      const maxSeq = (evs: Row[], type?: string) => evs.filter((e) => !type || e.type === type).reduce<number | null>((m, e) => (m === null || e.seq > m ? e.seq : m), null);
      const rows = [...store.sessions.values()].filter((s) => s.environment_id === params[0] && s.status === "idle").flatMap((s) => {
        const evs = store.events.get(s.id) ?? []; const disc = maxSeq(evs, "session.environment_disconnected");
        return disc !== null && disc > (maxSeq(evs, "session.status_running") ?? 0) ? [{ id: s.id, owner_id: s.owner_id, last_seq: String(maxSeq(evs)) }] : [];
      });
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  },
  async connect() { return client; },
  on() {},
  async end() {},
};
export async function tx<T>(fn: (c: typeof client) => Promise<T>): Promise<T> { return fn(client); }

export const principals = {
  async get(id: string) { return clone(store.principals.get(id)) ?? null; },
  async upsert(input: Row) { const id = input.id ?? newId("prc"); store.ops.push(`principals.upsert:${id}`); const p = { ...(store.principals.get(id) ?? { created_at: now() }), id, kind: input.kind ?? "user", handle: input.handle ?? null, display_name: input.display_name ?? "" }; store.principals.set(id, p); return clone(p); },
  async list() { return [...store.principals.values()].map(clone); },
};

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
export const apiKeys = {
  async create(principalId: string, _name = "") { const token = `pma_${randomBytes(24).toString("base64url")}`; const id = newId("key"); store.apiKeys.set(sha(token), { id, principal_id: principalId }); store.ops.push(`apiKeys.create:${principalId}`); return { id, token }; },
  async resolve(token: string) { const k = store.apiKeys.get(sha(token)); return k ? principals.get(k.principal_id) : null; },
};

export const repos = {
  providers: {
    async upsert(p: Row) {
      store.ops.push(`providers.upsert:${p.id}`);
      const prev = store.providers.get(p.id);
      // ON CONFLICT (id) DO UPDATE ... WHERE providers.owner_id = EXCLUDED.owner_id: another owner's row is untouched
      if (prev && prev.owner_id !== p.owner_id) return null;
      const row = { ...p, owner_id: prev?.owner_id ?? p.owner_id, created_at: prev?.created_at ?? now(), updated_at: now() };
      store.providers.set(p.id, clone(row)); return clone(row);
    },
    async get(id: string, sc?: Scope) { const r = get(store.providers, id, sc); if (store.hooks.providerGet) await store.hooks.providerGet(); return r; },
    async list(sc?: Scope) { return list(store.providers, sc); },
    async delete(id: string, sc?: Scope) { if (!vis(store.providers.get(id), sc)) return false; store.ops.push(`providers.delete:${id}`); return store.providers.delete(id); },
  },
  agents: {
    async create(input: Row) { const a = { ...clone(input), id: newId("agent"), created_at: now() }; store.agents.set(a.id, a); store.ops.push(`agents.create:${a.id}`); return clone(a); },
    async get(id: string, sc?: Scope) { return get(store.agents, id, sc); },
    async update(id: string, patch: Row, sc?: Scope) { const a = store.agents.get(id); if (!vis(a, sc)) return null; Object.assign(a!, clone(patch)); return clone(a!); },
    async list(sc?: Scope) { if (store.hooks.listThrow) throw new Error(store.hooks.listThrow); return list(store.agents, sc); },
  },
  environments: {
    async create(input: Row) { const e = { ...clone(input), id: newId("env"), created_at: now() }; store.environments.set(e.id, e); store.ops.push(`environments.create:${e.id}`); return clone(e); },
    async get(id: string, sc?: Scope) { return get(store.environments, id, sc); },
    async list(sc?: Scope) { return list(store.environments, sc); },
  },
  workspaces: {
    async create(spec: Row, ref: Row, owner_id: string) { const w = { id: newId("ws"), owner_id, spec: clone(spec), ref: clone(ref), created_at: now(), updated_at: now() }; store.workspaces.set(w.id, w); store.ops.push(`workspaces.create:${w.id}`); return clone(w); },
    async get(id: string, sc?: Scope) { return get(store.workspaces, id, sc); },
    async updateRef() { return true; },
  },
  sessions: {
    async create(input: Row) {
      const envs = input.environments?.length ? input.environments : [{ key: "main", environment_id: input.environment_id, workspace_id: input.workspace_id }];
      const s = { id: newId("sess"), owner_id: input.owner_id, agent_id: input.agent_id, environment_id: input.environment_id, workspace_id: input.workspace_id, agent: clone(input.agent), parent_id: input.parent_id ?? null, memory_stores: clone(input.memory_stores ?? []), vault_ids: input.vault_ids ?? [], container_group: null, status: "idle", usage: {}, context: null, environments: clone(envs), created_at: now(), updated_at: now() };
      store.sessions.set(s.id, s); store.events.set(s.id, []); store.ops.push(`sessions.create:${s.id}`);
      return clone(s);
    },
    async attachEnvironment(sessionId: string, e: Row) {
      const s = store.sessions.get(sessionId)!;
      if (s.environments.some((x: Row) => x.key === e.key)) return false; // ON CONFLICT DO NOTHING
      s.environments.push(clone(e)); store.ops.push(`sessions.attachEnvironment:${e.key}`); return true;
    },
    async environments(id: string) { return clone(store.sessions.get(id)?.environments ?? []); },
    async get(id: string, sc?: Scope) { const r = get(store.sessions, id, sc); if (store.hooks.sessionGet) await store.hooks.sessionGet(); return r; },
    async list(sc?: Scope) { return list(store.sessions, sc); },
    async childrenOf() { return []; },
    async listPage(sc: Scope, opts: { limit?: number; cursor?: string } = {}) {
      const lim = Math.min(Math.max(opts.limit ?? 50, 1), 200);
      if (!Number.isFinite(lim)) throw new Error(`syntax error at or near "NaN"`); // `LIMIT ${lim + 1}` is interpolated into the SQL
      const [ts, cid] = (opts.cursor ?? "").split("|");
      if (opts.cursor && Number.isNaN(Date.parse(ts!))) throw new Error(`invalid input syntax for type timestamp with time zone: "${opts.cursor}"`);
      const key = (r: Row) => `${r.created_at}|${r.id}`; const bound = opts.cursor ? `${new Date(ts!).toISOString()}|${cid ?? ""}` : null;
      const rows = list(store.sessions, sc).filter((r) => !bound || key(r) < bound).sort((a, b) => (key(a) < key(b) ? 1 : -1)).slice(0, lim + 1);
      const has_more = rows.length > lim; const data = rows.slice(0, lim);
      return { data, has_more, next_cursor: has_more ? key(data[data.length - 1]!) : null };
    },
    async setStatus(id: string, status: string) { const s = store.sessions.get(id); if (s) s.status = status; },
    async delete(id: string) { store.sessions.delete(id); },
  },
};

export const pluginStore = { async get() { return null; }, async set() {} };
export const toolOutputs = {
  async put(sid: string, tid: string, tool_name: string, content: string) { store.toolOutputs.set(`${sid}/${tid}`, { tool_name, content, bytes: content.length }); },
  async get(sid: string, tid: string) { return clone(store.toolOutputs.get(`${sid}/${tid}`)) ?? null; },
};

const fileShape = (r: Row) => { const { data: _d, ...meta } = r; return { ...clone(meta), type: "file", downloadable: true }; };
export const files = {
  async create(input: Row) { const id = newId("file"); const r = { id, owner_id: input.owner_id, filename: input.filename, mime_type: input.mime_type, size_bytes: input.data.length, sha256: sha(input.data), data: Buffer.from(input.data), created_at: now() }; store.files.set(id, r); store.ops.push(`files.create:${id}`); return fileShape(r); },
  shape: fileShape,
  async get(id: string, sc?: Scope) { const r = store.files.get(id); return vis(r, sc) ? fileShape(r!) : null; },
  async content(id: string, sc?: Scope) { const r = store.files.get(id); return vis(r, sc) ? { meta: fileShape(r!), data: Buffer.from(r!.data) } : null; },
  async list(sc?: Scope) { return [...store.files.values()].filter((r) => vis(r, sc)).map(fileShape); },
  async delete(id: string, sc?: Scope) { if (!vis(store.files.get(id), sc)) return false; return store.files.delete(id); },
};

export const skills = {
  async upsert(input: Row) {
    const id = input.id ?? newId("skill"); const prev = store.skills.get(id);
    const r = { type: "skill", source: "custom", ...(prev ?? { created_at: now(), latest_version: "0" }), id, owner_id: prev?.owner_id ?? input.owner_id, display_title: input.display_title ?? input.name, name: input.name, description: input.description, body: input.body, updated_at: now() };
    r.latest_version = prev ? String(Number(prev.latest_version) + 1) : "1";
    store.skills.set(id, r); store.ops.push(`skills.upsert:${id}`); return clone(r);
  },
  shape: (r: Row) => r,
  async get(id: string, sc?: Scope) { return get(store.skills, id, sc); },
  async getMany(ids: string[], sc?: Scope) { return ids.map((i) => get(store.skills, i, sc)).filter(Boolean); },
  async list(sc?: Scope) { return list(store.skills, sc); },
  async delete(id: string, sc?: Scope) { if (!vis(store.skills.get(id), sc)) return false; return store.skills.delete(id); },
};

export const memoryStores = {
  async create(input: Row) { const m = { id: newId("mem"), owner_id: input.owner_id, type: "memory_store", name: input.name, description: input.description ?? "", ref: { kind: "empty" }, created_at: now(), updated_at: now() }; store.memoryStores.set(m.id, m); return clone(m); },
  shape: (r: Row) => r,
  async get(id: string, sc?: Scope) { return get(store.memoryStores, id, sc); },
  async getMany(ids: string[], sc?: Scope) { return ids.map((i) => get(store.memoryStores, i, sc)).filter(Boolean); },
  async list(sc?: Scope) { return list(store.memoryStores, sc); },
  async updateRef() {},
  async delete(id: string, sc?: Scope) { if (!vis(store.memoryStores.get(id), sc)) return false; return store.memoryStores.delete(id); },
};

export const sessionConfig = {
  async setSystem(id: string, system: string | null) { store.sessions.get(id)!.agent.system = system; },
  async recordSystemPrompt(id: string, p: string) { store.sessions.get(id)!.last_system_prompt = p; },
  async lastSystemPrompt(id: string) { return store.sessions.get(id)?.last_system_prompt ?? null; },
  async setMemoryStores(id: string, mounts: Row[]) { store.sessions.get(id)!.memory_stores = clone(mounts); store.ops.push(`sessionConfig.setMemoryStores:${id}`); },
  async setSkills(id: string, refs: Row[]) { store.sessions.get(id)!.agent.skills = clone(refs); store.ops.push(`sessionConfig.setSkills:${id}`); },
  async addSkill(id: string, ref: Row) { const a = store.sessions.get(id)!.agent; const cur = a.skills ?? []; if (cur.some((r: Row) => r.skill_id === ref.skill_id)) return null; a.skills = [...cur, clone(ref)]; store.ops.push(`sessionConfig.setSkills:${id}`); return clone(a.skills); },
  async addPackage(id: string, source: string) { const a = store.sessions.get(id)!.agent; const cur = a.packages ?? []; if (cur.includes(source)) return null; a.packages = [...cur, source]; store.ops.push(`sessionConfig.setPackages:${id}`); return clone(a.packages); },
  async removePackage(id: string, source: string) { const a = store.sessions.get(id)!.agent; const cur = a.packages ?? []; if (!cur.includes(source)) return null; a.packages = cur.filter((p: string) => p !== source); store.ops.push(`sessionConfig.setPackages:${id}`); return clone(a.packages); },
  async removeSkill(id: string, skillId: string) { const a = store.sessions.get(id)!.agent; const cur = a.skills ?? []; if (!cur.some((r: Row) => r.skill_id === skillId)) return null; a.skills = cur.filter((r: Row) => r.skill_id !== skillId); store.ops.push(`sessionConfig.setSkills:${id}`); return clone(a.skills); },
  async addMemoryStore(id: string, m: Row) { const s = store.sessions.get(id)!; if (s.memory_stores.some((x: Row) => x.memory_store_id === m.memory_store_id || x.mount_path === m.mount_path)) return null; s.memory_stores = [...s.memory_stores, clone(m)]; store.ops.push(`sessionConfig.setMemoryStores:${id}`); return clone(s.memory_stores); },
  async removeMemoryStore(id: string, storeId: string) { const s = store.sessions.get(id)!; if (!s.memory_stores.some((x: Row) => x.memory_store_id === storeId)) return null; s.memory_stores = s.memory_stores.filter((x: Row) => x.memory_store_id !== storeId); store.ops.push(`sessionConfig.setMemoryStores:${id}`); return clone(s.memory_stores); },
};

export const vaults = {
  async create(input: Row) { const v = { id: newId("vault"), owner_id: input.owner_id, name: input.name ?? null, metadata: input.metadata ?? {}, created_at: now() }; store.vaults.set(v.id, v); return clone(v); },
  async get(id: string, sc?: Scope) { return get(store.vaults, id, sc); },
  async list(sc?: Scope) { return list(store.vaults, sc); },
  async delete(id: string, sc?: Scope) { if (!vis(store.vaults.get(id), sc)) return false; return store.vaults.delete(id); },
};

export const schedules = {
  async create(input: Row) {
    const s = {
      id: newId("sched"), owner_id: input.owner_id, name: input.name ?? null, cron: input.cron, timezone: input.timezone,
      enabled: input.enabled ?? true, action: clone(input.action),
      next_run_at: input.next_run_at instanceof Date ? input.next_run_at.toISOString() : String(input.next_run_at),
      last_run_at: null, last_run_status: null, last_run_error: null, last_run_session_id: null,
      created_at: now(), updated_at: now(),
    };
    store.schedules.set(s.id, s); store.ops.push(`schedules.create:${s.id}`); return clone(s);
  },
  async get(id: string, sc?: Scope) { return get(store.schedules, id, sc); },
  async list(sc?: Scope) { return list(store.schedules, sc); },
  async update(id: string, patch: Row, sc?: Scope) {
    const s = store.schedules.get(id); if (!vis(s, sc)) return null;
    const next = { ...s!, ...clone(patch), updated_at: now() };
    if (patch.next_run_at instanceof Date) next.next_run_at = patch.next_run_at.toISOString();
    if (patch.action) next.action = clone(patch.action);
    store.schedules.set(id, next); store.ops.push(`schedules.update:${id}`); return clone(next);
  },
  async delete(id: string, sc?: Scope) { if (!vis(store.schedules.get(id), sc)) return false; store.ops.push(`schedules.delete:${id}`); return store.schedules.delete(id); },
  async claimDue(claimedBy: string, _claimMs: number, limit = 16) {
    const nowIso = new Date().toISOString();
    const due = [...store.schedules.values()]
      .filter((s) => s.enabled && s.next_run_at <= nowIso && (!s.claim_until || s.claim_until < nowIso))
      .sort((a, b) => (a.next_run_at < b.next_run_at ? -1 : 1))
      .slice(0, limit);
    for (const s of due) { s.claim_until = new Date(Date.now() + 60_000).toISOString(); s.claimed_by = claimedBy; store.ops.push(`schedules.claim:${s.id}`); }
    return due.map(clone);
  },
  async complete(id: string, result: Row) {
    const s = store.schedules.get(id); if (!s) return;
    s.next_run_at = result.next_run_at instanceof Date ? result.next_run_at.toISOString() : String(result.next_run_at);
    s.last_run_at = now(); s.last_run_status = result.status; s.last_run_error = result.error ?? null;
    s.last_run_session_id = result.session_id ?? null; s.claim_until = null; s.claimed_by = null; s.updated_at = now();
    store.ops.push(`schedules.complete:${id}:${result.status}`);
  },
};

export const vaultCredentials = {
  async put(vaultId: string, input: Row) {
    const { name, value, metadata, ...rest } = input as { name: string; value: string; metadata?: Row };
    store.ops.push(`vaultCredentials.put:${vaultId}/${name}`);
    const r = { id: newId("cred"), vault_id: vaultId, name, kind: "environment_variable", mcp_server_url: null, ...rest, secret: seal(value), metadata: metadata ?? {}, created_at: now() };
    store.creds.set(`${vaultId}/${name}`, r); const { secret: _s, refresh: _r, ...pub } = r as Row; return clone(pub);
  },
  async list(vaultId: string) { return [...store.creds.values()].filter((c) => c.vault_id === vaultId).map(({ secret: _s, refresh: _r, ...pub }) => clone(pub)); },
  async get(vaultId: string, name: string) { const r = store.creds.get(`${vaultId}/${name}`); if (!r) return null; const { secret: _s, refresh: _r, ...pub } = r; return clone(pub); },
  async byId(id: string, vaultIds: string[]) { const r = [...store.creds.values()].find((c) => c.id === id && vaultIds.includes(c.vault_id)); if (!r) return null; const { secret: _s, refresh: _r, ...pub } = r; return clone(pub); },
  async delete(vaultId: string, nameOrId: string) {
    if (store.creds.delete(`${vaultId}/${nameOrId}`)) return true;
    for (const [k, c] of store.creds) if (c.vault_id === vaultId && c.id === nameOrId) return store.creds.delete(k);
    return false;
  },
};
export async function vaultSecrets() { return {}; }
