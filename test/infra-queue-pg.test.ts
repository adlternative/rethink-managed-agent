import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Postgres run queue against a stateful in-memory stand-in for run_jobs (hermetic). The backend and
// the tenant filter are read at import time, so set them first.
process.env.MESSAGING_BACKEND = "postgres";
process.env.RUNNER_OWNERS = "prc_a";

type Job = { id: number; session_id: string; trigger_seq: number; owner_id: string | null; status: "pending" | "running"; claimed_by: string | null };
const calls: { sql: string; params: unknown[] }[] = [];
let jobs: Job[] = [];
let nextId = 1;
const listeners: Array<() => void> = [];

function exec(sql: string, params: unknown[] = []): { rows: unknown[]; rowCount: number } {
  calls.push({ sql, params });
  const ret = (rows: unknown[]) => ({ rows, rowCount: rows.length });
  if (sql.startsWith("INSERT INTO run_jobs")) { jobs.push({ id: nextId++, session_id: params[0] as string, trigger_seq: params[1] as number, owner_id: (params[2] as string | null) ?? null, status: "pending", claimed_by: null }); return ret([]); }
  if (sql.includes("pg_notify('pma_jobs'")) { for (const l of listeners) l(); return ret([]); }
  if (sql.includes("count(*)::int")) { const owners = params[0] as string[] | undefined; return ret([{ n: jobs.filter((j) => j.status === "pending" && (!owners || owners.includes(j.owner_id!))).length }]); }
  if (sql.includes("UPDATE run_jobs SET status='running'")) {
    const owners = sql.includes("owner_id = ANY($2::text[])") ? (params[1] as string[]) : null;
    const j = jobs.filter((x) => x.status === "pending" && (!owners || owners.includes(x.owner_id!))).sort((a, b) => a.id - b.id)[0];
    if (!j) return ret([]);
    j.status = "running"; j.claimed_by = params[0] as string;
    // Emulate RETURNING: only the listed columns come back.
    const cols = sql.slice(sql.indexOf("RETURNING") + 9).split(",").map((s) => s.trim());
    const row: Record<string, unknown> = {};
    for (const c of cols) row[c] = c === "id" || c === "trigger_seq" ? String((j as never)[c]) : (j as never)[c];
    return ret([row]);
  }
  if (sql.startsWith("DELETE FROM run_jobs")) { jobs = jobs.filter((j) => String(j.id) !== String(params[0])); return ret([]); }
  if (sql.startsWith("UPDATE run_jobs SET status='pending', claimed_by=null, claimed_at=null WHERE id=$1")) { const j = jobs.find((x) => String(x.id) === String(params[0])); if (j) { j.status = "pending"; j.claimed_by = null; } return ret([]); }
  return ret([]);
}

vi.mock("pg", () => {
  class Pool {
    query = async (sql: string, params?: unknown[]) => exec(sql, params);
    connect = async () => {
      const handlers: Record<string, (...a: unknown[]) => void> = {};
      const client = {
        query: async (sql: string, params?: unknown[]) => { if (sql === "LISTEN pma_jobs") listeners.push(() => handlers.notification?.({ channel: "pma_jobs", payload: "1" })); return exec(sql, params); },
        on: (ev: string, h: (...a: unknown[]) => void) => { handlers[ev] = h; return client; },
        release: () => {},
      };
      return client;
    };
  }
  return { default: { Pool }, Pool };
});

const q = await import("../src/infra/queue.ts");
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => { calls.length = 0; jobs = []; nextId = 1; listeners.length = 0; });
afterEach(() => { vi.useRealTimers(); });

describe("pg run queue (mocked pg)", () => {
  it("enqueue stores owner_id as $3 and notifies", async () => {
    await q.enqueueRun({ session_id: "s1", trigger_seq: 4, owner_id: "prc_a" });
    const ins = calls.find((c) => c.sql.startsWith("INSERT INTO run_jobs"))!;
    expect(ins.params).toEqual(["s1", 4, "prc_a"]);
    expect(calls.some((c) => c.sql.includes("pg_notify('pma_jobs'"))).toBe(true);
    await q.enqueueRun({ session_id: "s2", trigger_seq: 1 });
    expect(calls.filter((c) => c.sql.startsWith("INSERT")).at(-1)!.params[2]).toBeNull();
  });

  it("depth filters by RUNNER_OWNERS", async () => {
    await q.enqueueRun({ session_id: "s1", trigger_seq: 1, owner_id: "prc_a" });
    await q.enqueueRun({ session_id: "s2", trigger_seq: 1, owner_id: "prc_b" });
    expect(await q.queueDepth()).toBe(1);
    const d = calls.find((c) => c.sql.includes("count(*)"))!;
    expect(d.sql).toContain("owner_id = ANY($1::text[])");
    expect(d.params).toEqual([["prc_a"]]);
  });

  it("claims with the owner filter; done -> DELETE; retry -> back to pending; throw -> DELETE", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await q.enqueueRun({ session_id: "done", trigger_seq: 1, owner_id: "prc_a" });
    await q.enqueueRun({ session_id: "other-tenant", trigger_seq: 1, owner_id: "prc_b" });
    await q.enqueueRun({ session_id: "throws", trigger_seq: 2, owner_id: "prc_a" });
    const seen: string[] = []; const ac = new AbortController();
    let retried = false;
    await q.enqueueRun({ session_id: "retry", trigger_seq: 3, owner_id: "prc_a" });
    await q.consumeRuns(async (job) => {
      seen.push(job.session_id);
      expect(typeof job.trigger_seq).toBe("number");
      if (job.session_id === "throws") throw new Error("boom");
      if (job.session_id === "retry" && !retried) { retried = true; return "retry"; }
      if (seen.length >= 4) ac.abort();
      return "done";
    }, { consumer: "c1", signal: ac.signal, concurrency: 1 });
    const claim = calls.find((c) => c.sql.includes("UPDATE run_jobs SET status='running'"))!;
    expect(claim.sql).toContain("owner_id = ANY($2::text[])");
    expect(claim.params).toEqual(["c1", ["prc_a"]]);
    expect(seen).toEqual(["done", "throws", "retry", "retry"]);
    expect(calls.some((c) => c.sql.startsWith("UPDATE run_jobs SET status='pending', claimed_by=null, claimed_at=null"))).toBe(true);
    expect(jobs.map((j) => j.session_id)).toEqual(["other-tenant"]);
    err.mockRestore();
  });

  it("a NOTIFY wakes a sleeping consumer well before the 2s poll", async () => {
    const ac = new AbortController(); const seen: string[] = [];
    const consuming = q.consumeRuns(async (job) => { seen.push(job.session_id); ac.abort(); return "done"; }, { signal: ac.signal });
    await tick(20);
    const t0 = Date.now();
    await q.enqueueRun({ session_id: "wake", trigger_seq: 1, owner_id: "prc_a" });
    await consuming;
    expect(seen).toEqual(["wake"]);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  // Regression: claim's RETURNING omits owner_id, so the handler's job has no owner and the follow-up
  // enqueueRun({... owner_id: job.owner_id}) writes NULL, which no tenant-scoped runner ever claims.
  it("the handler receives the job's owner_id", async () => {
    await q.enqueueRun({ session_id: "own", trigger_seq: 1, owner_id: "prc_a" });
    const ac = new AbortController(); let got: unknown;
    await q.consumeRuns(async (job) => { got = job.owner_id; ac.abort(); return "done"; }, { signal: ac.signal });
    expect(got).toBe("prc_a");
  });

  // Regression: 'retry' marks the row pending and the loop re-claims it immediately (ORDER BY id), with no
  // backoff: an always-busy session spins and head-of-line blocks every newer job at concurrency 1.
  it("an always-retry job does not starve a newer job at concurrency 1", async () => {
    await q.enqueueRun({ session_id: "stuck", trigger_seq: 1, owner_id: "prc_a" });
    await q.enqueueRun({ session_id: "next", trigger_seq: 1, owner_id: "prc_a" });
    const ac = new AbortController(); let stuckCalls = 0; let nextRan = false;
    const consuming = q.consumeRuns(async (job) => {
      if (job.session_id === "stuck") { stuckCalls++; await new Promise((r) => setImmediate(r)); return "retry"; }
      nextRan = true; return "done";
    }, { signal: ac.signal, concurrency: 1 });
    await tick(100);
    ac.abort(); await consuming;
    expect(nextRan).toBe(true);
    expect(stuckCalls).toBeLessThan(10);
  });

  // Regression: the stale sweep resets any job claimed > 120s ago regardless of the session heartbeat
  // (claimed_at is never refreshed), so every run longer than 2 minutes is re-delivered.
  it("the stale sweep consults the session heartbeat, not only claimed_at", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const ac = new AbortController();
    const consuming = q.consumeRuns(async () => "done", { signal: ac.signal });
    await tick(10);
    vi.advanceTimersByTime(30_000);
    await tick(5);
    ac.abort(); await consuming;
    const sweep = calls.find((c) => c.sql.includes("status='running' AND claimed_at <"));
    expect(sweep).toBeDefined();
    expect(sweep!.sql).toMatch(/sessions|updated_at/);
  });
});
