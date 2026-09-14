import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type pg from "pg";
import { randomLog } from "./fixtures/event-queries/random-log.ts";
import { foldSinceOf, lastSeqOf, latestOfTypesIn, stateFilter, windowOf } from "./fixtures/event-queries/index.ts";

// Integration (PMA_IT=1): the bounded event-log queries and the reworked repo reads against real Postgres, checked
// against their in-memory mirrors (the mirrors are what the hermetic equivalence tests use). Everything runs in
// ONE outer transaction rolled back at the end (inner BEGIN/COMMIT become savepoints), so a live stack never sees it.
process.env.MESSAGING_BACKEND = "memory";

describe.skipIf(!process.env.PMA_IT)("it: perf queries against Postgres", () => {
  let db: typeof import("../src/infra/db.ts");
  let events: typeof import("../src/infra/events.ts");
  let client: pg.PoolClient;
  const tag = `it_perf_${randomBytes(4).toString("hex")}`;
  const owner = `prc_${tag}`, other = `prc_${tag}_o`;
  const logs = new Map<string, ReturnType<typeof randomLog>>();
  let n = 0;
  let q: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;

  async function session(opts: { status?: string; parent?: string; env?: string; own?: string } = {}): Promise<string> {
    const id = `sess_${tag}_${++n}`;
    await q(`INSERT INTO sessions (id, owner_id, agent_id, environment_id, workspace_id, status, agent, parent_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,'{}',$7, now() - ($8::int * interval '1 second'))`,
      [id, opts.own ?? owner, `agent_${tag}`, opts.env ?? `env_${tag}`, `ws_${tag}`, opts.status ?? "idle", opts.parent ?? null, 1000 - n]);
    await q(`INSERT INTO session_environments (session_id, key, environment_id, workspace_id) VALUES ($1,'main',$2,$3)`, [id, opts.env ?? `env_${tag}`, `ws_${tag}`]);
    return id;
  }
  async function withLog(id: string, log: { type: string; payload: unknown }[]): Promise<void> {
    await q(`INSERT INTO events (id, session_id, seq, type, payload) SELECT 'evt_' || $1 || '_' || s, $1, s, t, p::jsonb FROM unnest($2::bigint[], $3::text[], $4::text[]) AS u(s, t, p)`,
      [id, log.map((_, i) => i + 1), log.map((e) => e.type), log.map((e) => JSON.stringify(e.payload))]);
    logs.set(id, log.map((e, i) => ({ ...(e as never), seq: i + 1, session_id: id })));
  }
  const strip = (evs: { seq: number; type: string; payload: unknown }[]) => evs.map((e) => ({ seq: e.seq, type: e.type, payload: e.payload }));

  beforeAll(async () => {
    db = await import("../src/infra/db.ts");
    events = await import("../src/infra/events.ts");
    client = await db.pool.connect();
    await client.query("BEGIN");
    const raw = client.query.bind(client) as (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
    let sp = 0;
    const wrapped = {
      query: (sql: string, params?: unknown[]) => {
        if (sql === "BEGIN") return raw(`SAVEPOINT sp${++sp}`);
        if (sql === "COMMIT") return raw(`RELEASE SAVEPOINT sp${sp--}`);
        if (sql === "ROLLBACK") return raw(`ROLLBACK TO SAVEPOINT sp${sp--}`);
        return raw(sql, params);
      },
      release: () => {},
    };
    q = wrapped.query;
    vi.spyOn(db.pool, "query").mockImplementation(((sql: string, params?: unknown[]) => wrapped.query(sql, params)) as never);
    vi.spyOn(db.pool, "connect").mockImplementation((async () => wrapped) as never);
    await q(`INSERT INTO principals (id, kind, handle, display_name) VALUES ($1,'user',NULL,'it'), ($2,'user',NULL,'it')`, [owner, other]);
    await q(`INSERT INTO agents (id, owner_id, name, model) VALUES ($1,$2,'it','{}')`, [`agent_${tag}`, owner]);
    await q(`INSERT INTO environments (id, owner_id, name, provider, workspace) VALUES ($1,$2,'it','byoc','{}'), ($3,$2,'it','byoc','{}')`, [`env_${tag}`, owner, `env_${tag}_b`]);
    await q(`INSERT INTO workspaces (id, owner_id, spec, ref) VALUES ($1,$2,'{}','{}')`, [`ws_${tag}`, owner]);
  });
  afterAll(async () => { vi.restoreAllMocks(); if (client) { await client.query("ROLLBACK"); client.release(); await db.pool.end(); } });

  it("lastSeq, latestOfTypes, latestMatching, listEventsWindow, foldSince match their mirrors on random logs", async () => {
    for (const seed of [3, 17, 101, 4242, 90001]) {
      const id = await session();
      const log = randomLog(seed, 300);
      await withLog(id, log);
      const mirror = logs.get(id)!;
      expect(await events.lastSeq(id)).toBe(lastSeqOf(mirror));
      const types = ["user.message", "session.status_idle", "agent.thread_context_compacted", "never.logged"];
      expect(strip(await events.latestOfTypes(id, types))).toEqual(strip(latestOfTypesIn(mirror, types)));
      const question = [...mirror].reverse().find((e) => e.type === "agent.thread_message_sent" && (e.payload as { kind?: string }).kind === "question");
      expect((await events.latestMatching(id, "agent.thread_message_sent", { kind: "question" }))?.seq ?? null).toBe(question?.seq ?? null);
      for (const w of [{}, { limit: 7 }, { since: 50 }, { since: 50, limit: 3 }, { since: 290, limit: 50 }, { limit: 0 }, { since: 2.5, limit: 4 }]) {
        const got = strip(await events.listEventsWindow(id, w));
        const want = strip(windowOf(mirror, { since: Number.isInteger(w.since) ? w.since : 0, limit: w.limit }));
        expect(got, `${seed} ${JSON.stringify(w)}`).toEqual(want);
      }
      expect(await events.foldSince(id)).toBe(foldSinceOf(mirror));
      expect(await events.lastSeq(`${id}_missing`)).toBe(0);
    }
  });

  it("listEventsForState matches the in-memory filter (with and without client tool names)", async () => {
    for (const seed of [5, 77, 1234]) {
      const id = await session();
      await withLog(id, randomLog(seed, 300));
      const mirror = logs.get(id)!;
      const types = ["session.status_running", "session.error", "session.environment_disconnected"];
      expect(strip(await events.listEventsForState(id, types, ["client_fn"]))).toEqual(strip(stateFilter(mirror, types, ["client_fn"])));
      expect(strip(await events.listEventsForState(id, types))).toEqual(strip(stateFilter(mirror, types)));
      const items = ["user.message", "agent.message", "agent.tool_use", "agent.tool_result", "session.status_running", "session.status_idle"];
      expect(strip(await events.listEventsForState(id, items))).toEqual(strip(stateFilter(mirror, items)));
    }
  });

  it("resumeEnvironment re-enqueues exactly the idle sessions whose environmentActions are pending, at their last seq", async () => {
    const { environmentActions } = await import("../src/api/routes/compat/required-actions.ts");
    const queue = await import("../src/infra/queue.ts");
    const envId = `env_${tag}_b`;
    const expected: { session_id: string; trigger_seq: number; owner_id: string }[] = [];
    const mk = async (status: string, types: string[]) => {
      const id = await session({ status, env: envId });
      await withLog(id, types.map((type) => ({ type, payload: { type, environment_id: envId } })));
      const mirror = logs.get(id)!;
      if (status === "idle" && environmentActions(mirror as never).length) expected.push({ session_id: id, trigger_seq: lastSeqOf(mirror), owner_id: owner });
    };
    await mk("idle", ["user.message", "session.status_running", "session.status_idle", "user.message", "session.environment_disconnected"]);
    await mk("idle", ["session.environment_disconnected", "session.status_running", "session.status_idle"]);
    await mk("idle", ["user.message", "session.status_idle"]);
    await mk("idle", ["session.environment_disconnected"]);
    await mk("running", ["session.environment_disconnected"]);
    await mk("idle", ["session.environment_disconnected", "session.status_running", "session.environment_disconnected", "plugin.message"]);
    const { resumeEnvironment } = await import("../src/api/routes/worker.ts");
    const count = await resumeEnvironment(envId);
    expect(count).toBe(expected.length);
    // drain the memory queue (MESSAGING_BACKEND=memory) to see the enqueued jobs
    const jobs: unknown[] = [];
    const ac = new AbortController();
    await queue.consumeRuns(async (job) => { jobs.push(job); if (jobs.length === expected.length) setTimeout(() => ac.abort(), 0); return "done"; }, { signal: ac.signal });
    const byId = (a: any, b: any) => a.session_id.localeCompare(b.session_id);
    expect(jobs.sort(byId)).toEqual(expected.sort(byId));
    expect(expected).toHaveLength(3);
  });

  it("sessions.list scopes its environment join and keeps main first; children come back like the old full-list filter", async () => {
    const parent = await session();
    const kids = [await session({ parent }), await session({ parent })];
    await q(`INSERT INTO session_environments (session_id, key, environment_id, workspace_id, created_at) VALUES ($1,'aux',$2,$3, now() - interval '1 day')`, [kids[0], `env_${tag}_b`, `ws_${tag}`]);
    const foreign = await session({ own: other });
    const mine = await db.repos.sessions.list({ owner });
    expect(mine.some((s) => s.id === foreign)).toBe(false);
    const k0 = mine.find((s) => s.id === kids[0])!;
    expect(k0.environments.map((e) => e.key)).toEqual(["main", "aux"]);
    const viaChildren = await db.repos.sessions.childrenOf(parent);
    const viaFilter = (await db.repos.sessions.list()).filter((s) => s.parent_id === parent);
    expect(viaChildren).toEqual(viaFilter);
    expect(viaChildren.map((s) => s.id)).toEqual(kids);
  });

  it("apiKeys.resolve returns the principal and touches last_used_at at most once a minute", async () => {
    const { token, id } = await db.apiKeys.create(owner, "it");
    const p = await db.apiKeys.resolve(token);
    expect(p).toMatchObject({ id: owner, kind: "user" });
    expect(typeof p!.created_at).toBe("string");
    const first = (await q(`SELECT last_used_at FROM api_keys WHERE id=$1`, [id])).rows[0].last_used_at as Date;
    expect(first).toBeInstanceOf(Date);
    await q(`UPDATE api_keys SET last_used_at = now() - interval '10 seconds' WHERE id=$1`, [id]);
    const recent = (await q(`SELECT last_used_at FROM api_keys WHERE id=$1`, [id])).rows[0].last_used_at as Date;
    await db.apiKeys.resolve(token);
    expect(((await q(`SELECT last_used_at FROM api_keys WHERE id=$1`, [id])).rows[0].last_used_at as Date).getTime()).toBe(recent.getTime());
    await q(`UPDATE api_keys SET last_used_at = now() - interval '2 minutes' WHERE id=$1`, [id]);
    const stale = (await q(`SELECT last_used_at FROM api_keys WHERE id=$1`, [id])).rows[0].last_used_at as Date;
    await db.apiKeys.resolve(token);
    expect(((await q(`SELECT last_used_at FROM api_keys WHERE id=$1`, [id])).rows[0].last_used_at as Date).getTime()).toBeGreaterThan(stale.getTime());
    expect(await db.apiKeys.resolve("pma_not_a_key")).toBeNull();
  });
});
