import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type pg from "pg";

// Integration (PMA_IT=1): the Postgres run queue against the real run_jobs table. The runner is scoped
// to a unique owner (RUNNER_OWNERS) and all statements share one outer transaction that is rolled back,
// so no other consumer can see or claim these jobs.
const tag = `it_q_${randomBytes(4).toString("hex")}`;
const owner = `prc_${tag}`;
process.env.MESSAGING_BACKEND = "postgres";
process.env.RUNNER_OWNERS = owner;

describe.skipIf(!process.env.PMA_IT)("it: pg run queue", () => {
  let db: typeof import("../src/infra/db.ts");
  let q: typeof import("../src/infra/queue.ts");
  let client: pg.PoolClient;

  beforeAll(async () => {
    db = await import("../src/infra/db.ts");
    client = await db.pool.connect();
    await client.query("BEGIN");
    const run = client.query.bind(client) as (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
    const wrapped = { query: (sql: string, params?: unknown[]) => (sql.startsWith("LISTEN") ? Promise.resolve({ rows: [] }) : run(sql, params)), on: () => wrapped, release: () => {} };
    vi.spyOn(db.pool, "query").mockImplementation(((sql: string, params?: unknown[]) => run(sql, params)) as never);
    vi.spyOn(db.pool, "connect").mockImplementation((async () => wrapped) as never);
    q = await import("../src/infra/queue.ts");
  });
  afterAll(async () => { vi.restoreAllMocks(); if (client) { await client.query("ROLLBACK"); client.release(); await db.pool.end(); } });

  it("enqueue -> depth -> consume deletes the row; the handler sees the owner", async () => {
    await q.enqueueRun({ session_id: `sess_${tag}_a`, trigger_seq: 3, owner_id: owner });
    expect(await q.queueDepth()).toBe(1);
    const ac = new AbortController(); const seen: unknown[] = [];
    await q.consumeRuns(async (job) => { seen.push(job); ac.abort(); return "done"; }, { signal: ac.signal, consumer: tag });
    expect(seen[0]).toMatchObject({ session_id: `sess_${tag}_a`, trigger_seq: 3 });
    expect(await q.queueDepth()).toBe(0);
    expect((await client.query(`SELECT count(*)::int AS n FROM run_jobs WHERE owner_id=$1`, [owner])).rows[0].n).toBe(0);
  });

  // Regression: claim's RETURNING omits owner_id, so a follow-up enqueue from the handler loses the tenant.
  it("the claimed job carries owner_id", async () => {
    await q.enqueueRun({ session_id: `sess_${tag}_o`, trigger_seq: 1, owner_id: owner });
    const ac = new AbortController(); let got: unknown;
    await q.consumeRuns(async (job) => { got = job.owner_id; ac.abort(); return "done"; }, { signal: ac.signal });
    expect(got).toBe(owner);
  });

  // Regression: retry has no backoff and ORDER BY id re-claims the same row, head-of-line blocking newer jobs.
  it("a retried job does not starve a newer job at concurrency 1", async () => {
    await client.query(`DELETE FROM run_jobs WHERE owner_id=$1`, [owner]);
    await q.enqueueRun({ session_id: `sess_${tag}_busy`, trigger_seq: 1, owner_id: owner });
    await q.enqueueRun({ session_id: `sess_${tag}_next`, trigger_seq: 1, owner_id: owner });
    const ac = new AbortController(); let busyCalls = 0; let nextAt = 0; const t0 = Date.now();
    const consuming = q.consumeRuns(async (job) => {
      if (job.session_id.endsWith("_busy")) { busyCalls++; return "retry"; }
      nextAt = Date.now() - t0; ac.abort(); return "done";
    }, { signal: ac.signal, concurrency: 1 });
    const timer = setTimeout(() => ac.abort(), 1000);
    await consuming; clearTimeout(timer);
    expect(nextAt).toBeGreaterThan(0);
    expect(busyCalls).toBeLessThan(10);
  }, 10_000);
});
