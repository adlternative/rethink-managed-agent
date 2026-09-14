import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type pg from "pg";

// Integration (PMA_IT=1): real Postgres. Every statement runs inside ONE outer transaction that is rolled
// back at the end, so nothing is ever visible to a live stack (e.g. a runner's reconciler). Inner
// BEGIN/COMMIT/ROLLBACK from tx() are mapped to savepoints on the same connection.
process.env.MESSAGING_BACKEND = "memory";

describe.skipIf(!process.env.PMA_IT)("it: runs against Postgres", () => {
  let db: typeof import("../src/infra/db.ts");
  let runs: typeof import("../src/infra/runs.ts");
  let events: typeof import("../src/infra/events.ts");
  let client: pg.PoolClient;
  const tag = `it_runs_${randomBytes(4).toString("hex")}`;
  const owner = `prc_${tag}`;
  let n = 0;

  beforeAll(async () => {
    db = await import("../src/infra/db.ts");
    runs = await import("../src/infra/runs.ts");
    events = await import("../src/infra/events.ts");
    client = await db.pool.connect();
    await client.query("BEGIN");
    const q = client.query.bind(client) as (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
    let sp = 0;
    const wrapped = {
      query: (sql: string, params?: unknown[]) => {
        if (sql === "BEGIN") return q(`SAVEPOINT sp${++sp}`);
        if (sql === "COMMIT") return q(`RELEASE SAVEPOINT sp${sp--}`);
        if (sql === "ROLLBACK") return q(`ROLLBACK TO SAVEPOINT sp${sp--}`);
        return q(sql, params);
      },
      release: () => {},
    };
    vi.spyOn(db.pool, "query").mockImplementation(((sql: string, params?: unknown[]) => wrapped.query(sql, params)) as never);
    vi.spyOn(db.pool, "connect").mockImplementation((async () => wrapped) as never);
    await q(`INSERT INTO principals (id, kind, handle, display_name) VALUES ($1,'user',NULL,'it')`, [owner]);
    await q(`INSERT INTO agents (id, owner_id, name, model) VALUES ($1,$2,'it','{}')`, [`agent_${tag}`, owner]);
    await q(`INSERT INTO environments (id, owner_id, name, provider, workspace) VALUES ($1,$2,'it','local','{}')`, [`env_${tag}`, owner]);
    await q(`INSERT INTO workspaces (id, owner_id, spec, ref) VALUES ($1,$2,'{}','{}')`, [`ws_${tag}`, owner]);
  });
  afterAll(async () => { vi.restoreAllMocks(); if (client) { await client.query("ROLLBACK"); client.release(); await db.pool.end(); } });

  /** A session with a scripted log: [type, secondsAgo] per event, seq assigned in order. */
  async function sessionWith(status: string, log: [string, number][]): Promise<string> {
    const id = `sess_${tag}_${++n}`;
    await client.query(`INSERT INTO sessions (id, owner_id, agent_id, environment_id, workspace_id, status, agent) VALUES ($1,$2,$3,$4,$5,$6,'{}')`, [id, owner, `agent_${tag}`, `env_${tag}`, `ws_${tag}`, status]);
    let seq = 0;
    for (const [type, ago] of log) await client.query(`INSERT INTO events (id, session_id, seq, type, payload, created_at) VALUES ($1,$2,$3,$4,$5, now() - ($6::int * interval '1 second'))`, [`evt_${id}_${++seq}`, id, seq, type, JSON.stringify({ type }), ago]);
    return id;
  }
  const stranded = async () => (await runs.findStrandedSessions(30_000)).filter((s) => s.session_id.includes(tag));

  it("detects an idle session whose newest user.message is past the grace window", async () => {
    const past = await sessionWith("idle", [["session.status_idle", 120], ["user.message", 60]]);
    const fresh = await sessionWith("idle", [["session.status_idle", 120], ["user.message", 1]]);
    const running = await sessionWith("running", [["user.message", 60]]);
    const consumed = await sessionWith("idle", [["user.message", 90], ["session.status_running", 80]]);
    const found = await stranded();
    expect(found).toContainEqual({ session_id: past, trigger_seq: 2, owner_id: owner });
    const ids = found.map((s) => s.session_id);
    for (const id of [fresh, running, consumed]) expect(ids).not.toContain(id);
  });

  // Regression: a BYOC pause (session.environment_disconnected) is not treated as consuming the message, so
  // the reconciler re-enqueues it every tick and each run appends another disconnected event.
  it("a session paused by environment_disconnected is not re-detected as stranded", async () => {
    const paused = await sessionWith("idle", [["session.status_idle", 300], ["user.message", 120], ["session.environment_disconnected", 110]]);
    expect((await stranded()).map((s) => s.session_id)).not.toContain(paused);
  });

  it("claimRun / finishRun round-trip on a real row lock", async () => {
    const id = await sessionWith("idle", [["user.message", 5]]);
    const claimed = await runs.claimRun(id);
    expect(claimed?.map((e) => [e.seq, e.type])).toEqual([[2, "session.status_running"]]);
    expect(await runs.claimRun(id)).toBeNull(); // live run: fresh updated_at
    await events.appendEvents(id, [{ type: "user.message", content: [] }], { publish: false });
    const fin = await runs.finishRun(id, "end_turn", 1);
    expect(fin.events.map((e) => e.type)).toEqual(["session.usage", "session.status_idle"]);
    expect(fin.unconsumedSeq).toBe(3);
    expect((await db.repos.sessions.get(id))?.status).toBe("idle");
    const usage = await runs.recordUsage(id, { input: 2, output: 3, cache_read: 0, cache_write: 0, total_tokens: 5 } as never, { tokens: 5 } as never);
    expect(Number(usage.input)).toBe(2);
    expect(Number(usage.requests)).toBe(1);
  });
});
