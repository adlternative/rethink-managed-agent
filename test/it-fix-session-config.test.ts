import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type pg from "pg";

// Integration (PMA_IT=1): the single-statement session config updates, the provider upsert owner guard,
// the `after` session cursor and the duplicate-key environment attach, against real Postgres. Everything
// runs inside one outer transaction that is rolled back.
process.env.MESSAGING_BACKEND = "memory";

describe.skipIf(!process.env.PMA_IT)("it: session config, providers and pagination SQL", () => {
  let db: typeof import("../src/infra/db.ts");
  let client: pg.PoolClient;
  const tag = `it_fix_${randomBytes(4).toString("hex")}`;
  const owner = `prc_${tag}`;
  const other = `prc_${tag}_b`;
  const sid = (n: string) => `sess_${tag}_${n}`;

  beforeAll(async () => {
    db = await import("../src/infra/db.ts");
    client = await db.pool.connect();
    await client.query("BEGIN");
    const q = client.query.bind(client) as (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
    let sp = 0;
    const wrapped = {
      query: (sql: string, params?: unknown[]) => (sql === "BEGIN" ? q(`SAVEPOINT sp${++sp}`) : sql === "COMMIT" ? q(`RELEASE SAVEPOINT sp${sp--}`) : sql === "ROLLBACK" ? q(`ROLLBACK TO SAVEPOINT sp${sp--}`) : q(sql, params)),
      release: () => {},
    };
    vi.spyOn(db.pool, "query").mockImplementation(((sql: string, params?: unknown[]) => wrapped.query(sql, params)) as never);
    vi.spyOn(db.pool, "connect").mockImplementation((async () => wrapped) as never);
    for (const p of [owner, other]) await q(`INSERT INTO principals (id, kind, handle, display_name) VALUES ($1,'user',NULL,'it')`, [p]);
    await q(`INSERT INTO agents (id, owner_id, name, model) VALUES ($1,$2,'it','{}')`, [`agent_${tag}`, owner]);
    await q(`INSERT INTO environments (id, owner_id, name, provider, workspace) VALUES ($1,$2,'it','local','{}')`, [`env_${tag}`, owner]);
    await q(`INSERT INTO workspaces (id, owner_id, spec, ref) VALUES ($1,$2,'{}','{}')`, [`ws_${tag}`, owner]);
    for (const [n, ts] of [["x", "2026-01-01T12:00:00.123456Z"], ["y", "2026-01-01T12:00:00.123456Z"], ["z", "2026-01-01T12:00:00.100000Z"]]) {
      await q(`INSERT INTO sessions (id, owner_id, agent_id, environment_id, workspace_id, agent, created_at) VALUES ($1,$2,$3,$4,$5,'{"skills":[]}',$6::timestamptz)`, [sid(n), owner, `agent_${tag}`, `env_${tag}`, `ws_${tag}`, ts]);
    }
  });
  afterAll(async () => { vi.restoreAllMocks(); if (client) { await client.query("ROLLBACK"); client.release(); await db.pool.end(); } });

  it("addSkill / removeSkill are single statements that refuse duplicates and missing ids", async () => {
    const c = db.sessionConfig;
    expect(await c.addSkill(sid("x"), { type: "custom", skill_id: "skill_a" })).toEqual([{ type: "custom", skill_id: "skill_a" }]);
    expect(await c.addSkill(sid("x"), { type: "custom", skill_id: "skill_b" })).toHaveLength(2);
    expect(await c.addSkill(sid("x"), { type: "custom", skill_id: "skill_a" })).toBeNull();
    expect(await c.removeSkill(sid("x"), "skill_a")).toEqual([{ type: "custom", skill_id: "skill_b" }]);
    expect(await c.removeSkill(sid("x"), "skill_a")).toBeNull();
    expect(await c.removeSkill(sid("x"), "skill_b")).toEqual([]);
  });

  it("addMemoryStore / removeMemoryStore refuse the same store or mount path", async () => {
    const c = db.sessionConfig;
    expect(await c.addMemoryStore(sid("y"), { memory_store_id: "mem_1", mount_path: "memories/a" })).toHaveLength(1);
    expect(await c.addMemoryStore(sid("y"), { memory_store_id: "mem_1", mount_path: "other" })).toBeNull();
    expect(await c.addMemoryStore(sid("y"), { memory_store_id: "mem_2", mount_path: "memories/a" })).toBeNull();
    expect(await c.removeMemoryStore(sid("y"), "mem_1")).toEqual([]);
    expect(await c.removeMemoryStore(sid("y"), "mem_1")).toBeNull();
  });

  it("providers.upsert never overwrites another owner's row", async () => {
    const base = { name: "n", api: "openai-completions" as const, headers: {}, auth: { type: "none" as const }, models: [], enabled: true };
    const id = `p${randomBytes(4).toString("hex")}`;
    expect((await db.repos.providers.upsert({ id, owner_id: owner, base_url: "https://a", ...base }))?.base_url).toBe("https://a");
    expect(await db.repos.providers.upsert({ id, owner_id: other, base_url: "https://evil", ...base })).toBeNull();
    expect((await db.repos.providers.get(id))!.base_url).toBe("https://a");
    expect((await db.repos.providers.upsert({ id, owner_id: owner, base_url: "https://a2", ...base }))?.base_url).toBe("https://a2");
  });

  it("pages sessions sharing one created_at exactly once, by cursor and by `after` id", async () => {
    const byCursor: string[] = []; let cursor: string | undefined;
    for (let i = 0; i < 5; i++) { const p = await db.repos.sessions.listPage({ owner }, { limit: 1, cursor }); byCursor.push(...p.data.map((s) => s.id)); if (!p.next_cursor) break; cursor = p.next_cursor; }
    expect([...byCursor].sort()).toEqual([sid("x"), sid("y"), sid("z")].sort());
    expect(byCursor).toHaveLength(3);
    const first = await db.repos.sessions.listPage({ owner }, { limit: 2 });
    const rest = await db.repos.sessions.listPage({ owner }, { limit: 2, after: first.data.at(-1)!.id });
    expect([...first.data, ...rest.data].map((s) => s.id).sort()).toEqual([sid("x"), sid("y"), sid("z")].sort());
  });

  it("attachEnvironment reports a key that is already attached instead of throwing", async () => {
    const e = { key: "side", environment_id: `env_${tag}`, workspace_id: `ws_${tag}` };
    expect(await db.repos.sessions.attachEnvironment(sid("z"), e)).toBe(true);
    expect(await db.repos.sessions.attachEnvironment(sid("z"), e)).toBe(false);
  });
});
