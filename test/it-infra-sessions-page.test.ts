import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type pg from "pg";

// Integration (PMA_IT=1): real timestamptz precision. All writes happen inside one outer transaction that
// is rolled back at the end, so the live stack never sees them.
process.env.MESSAGING_BACKEND = "memory";

describe.skipIf(!process.env.PMA_IT)("it: sessions.listPage cursor", () => {
  let db: typeof import("../src/infra/db.ts");
  let client: pg.PoolClient;
  const tag = `it_page_${randomBytes(4).toString("hex")}`;
  const owner = `prc_${tag}`;

  beforeAll(async () => {
    db = await import("../src/infra/db.ts");
    client = await db.pool.connect();
    await client.query("BEGIN");
    const q = client.query.bind(client) as (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
    vi.spyOn(db.pool, "query").mockImplementation(((sql: string, params?: unknown[]) => q(sql, params)) as never);
    await q(`INSERT INTO principals (id, kind, handle, display_name) VALUES ($1,'user',NULL,'it')`, [owner]);
    await q(`INSERT INTO agents (id, owner_id, name, model) VALUES ($1,$2,'it','{}')`, [`agent_${tag}`, owner]);
    await q(`INSERT INTO environments (id, owner_id, name, provider, workspace) VALUES ($1,$2,'it','local','{}')`, [`env_${tag}`, owner]);
    await q(`INSERT INTO workspaces (id, owner_id, spec, ref) VALUES ($1,$2,'{}','{}')`, [`ws_${tag}`, owner]);
    // Three sessions in the same millisecond with different microseconds.
    for (const [id, ts] of [["x", "2026-01-01T12:00:00.123456Z"], ["y", "2026-01-01T12:00:00.123100Z"], ["z", "2026-01-01T12:00:00.122000Z"]]) {
      await q(`INSERT INTO sessions (id, owner_id, agent_id, environment_id, workspace_id, agent, created_at) VALUES ($1,$2,$3,$4,$5,'{}',$6::timestamptz)`, [`sess_${tag}_${id}`, owner, `agent_${tag}`, `env_${tag}`, `ws_${tag}`, ts]);
    }
  });
  afterAll(async () => { vi.restoreAllMocks(); if (client) { await client.query("ROLLBACK"); client.release(); await db.pool.end(); } });

  it("a single page returns all three newest first", async () => {
    const p = await db.repos.sessions.listPage({ owner }, { limit: 10 });
    expect(p.data.map((s) => s.id)).toEqual(["x", "y", "z"].map((s) => `sess_${tag}_${s}`));
    expect(p.has_more).toBe(false);
  });

  // Regression: next_cursor is serialized at millisecond precision; 'created_at < cursor' then skips rows in the
  // same millisecond as the last kept row (here y).
  it("paging with limit 1 returns every session exactly once", async () => {
    const seen: string[] = []; let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const p = await db.repos.sessions.listPage({ owner }, { limit: 1, cursor });
      seen.push(...p.data.map((s) => s.id));
      if (!p.next_cursor) break; cursor = p.next_cursor;
    }
    expect(seen).toEqual(["x", "y", "z"].map((s) => `sess_${tag}_${s}`));
  });
});
