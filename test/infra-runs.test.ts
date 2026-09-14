import { describe, it, expect, vi, beforeEach } from "vitest";

// Hermetic: pg is replaced by a scripted fake. Each query is recorded; `script` maps a SQL fragment to
// the rows it returns, so we can drive the lock row (status, idle_ms) and MAX(seq) lookups.
process.env.MESSAGING_BACKEND = "memory";
type Call = { sql: string; params: unknown[]; via: "pool" | "client" };
const calls: Call[] = [];
let script: (sql: string, params: unknown[]) => unknown[] | undefined = () => undefined;
const run = (via: Call["via"]) => async (sql: string, params: unknown[] = []) => {
  calls.push({ sql, params, via });
  const rows = script(sql, params) ?? [];
  return { rows, rowCount: rows.length };
};
vi.mock("pg", () => {
  class Pool {
    query = run("pool");
    connect = async () => ({ query: run("client"), release() {} });
  }
  return { default: { Pool }, Pool };
});

const runs = await import("../src/infra/runs.ts");

let insertSeq: number[] = [];
/** A session lock row + event log stand-in: MAX(seq) starts at `maxSeq`, INSERTs echo back what was written. */
function session(opts: { status?: string; idle_ms?: number; missing?: boolean; maxSeq?: string | number; userMax?: string | number | null; usage?: unknown; context?: unknown }) {
  script = (sql, params) => {
    if (sql.includes("FOR UPDATE")) return opts.missing ? [] : [{ status: opts.status ?? "idle", idle_ms: String(opts.idle_ms ?? 0) }];
    if (sql.includes("COALESCE(MAX(seq),0)")) return [{ max: opts.maxSeq ?? "0" }];
    if (sql.includes("INSERT INTO events")) { insertSeq.push(params[2] as number); return [{ id: params[0], session_id: params[1], seq: String(params[2]), type: params[3], payload: JSON.parse(params[4] as string), created_at: new Date(0) }]; }
    if (sql.includes("SELECT usage, context")) return [{ usage: opts.usage ?? { input: 1 }, context: opts.context ?? null }];
    if (sql.includes("MAX(seq) AS max") && sql.includes("user.message")) return [{ max: opts.userMax ?? null }];
    return undefined;
  };
}
const has = (frag: string) => calls.some((c) => c.sql.includes(frag));
const statusUpdates = () => calls.filter((c) => c.sql.includes("UPDATE sessions SET status"));

beforeEach(() => { calls.length = 0; insertSeq = []; script = () => undefined; });

describe("claimRun decision table", () => {
  it("idle -> appends session.status_running and flips the column to running", async () => {
    session({ status: "idle", maxSeq: "3" });
    const ev = await runs.claimRun("s1");
    expect(ev?.map((e) => e.type)).toEqual(["session.status_running"]);
    expect(ev?.[0]!.seq).toBe(4);
    expect(statusUpdates().map((c) => c.params)).toEqual([["s1", "running"]]);
    expect(has("COMMIT")).toBe(true);
  });

  it("running with a stale heartbeat (idle_ms 90001) -> run_lost error, then status_running", async () => {
    session({ status: "running", idle_ms: 90_001 });
    const ev = await runs.claimRun("s1");
    expect(ev?.map((e) => e.type)).toEqual(["session.error", "session.status_running"]);
    expect(ev?.[0]!.payload).toMatchObject({ error: { type: "run_lost" } });
    expect(ev?.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("running exactly at the stale threshold is still live (strictly greater than RUN_STALE_MS)", async () => {
    session({ status: "running", idle_ms: runs.RUN_STALE_MS });
    expect(await runs.claimRun("s1")).toBeNull();
  });

  it("running with a fresh heartbeat -> null, no INSERT and no status change", async () => {
    session({ status: "running", idle_ms: 1000 });
    expect(await runs.claimRun("s1")).toBeNull();
    expect(has("INSERT INTO events")).toBe(false);
    expect(statusUpdates()).toHaveLength(0);
  });

  it("terminated -> no events and no status change", async () => {
    session({ status: "terminated" });
    const r = await runs.claimRun("s1");
    expect(Array.isArray(r) && r.length > 0).toBe(false); // never a claim
    expect(has("INSERT INTO events")).toBe(false);
    expect(statusUpdates()).toHaveLength(0);
  });

  // Regression: claimRun returns the same null for a terminated session as for a live one, so the runner maps
  // it to "busy" -> "retry" and the job is retried forever (hot loop on Postgres, never acked on Redis).
  it("terminated is distinguishable from busy so the queue can drop the job", async () => {
    session({ status: "running", idle_ms: 1000 });
    const busy = await runs.claimRun("s1");
    session({ status: "terminated" });
    const terminated = await runs.claimRun("s1");
    expect(terminated).not.toEqual(busy);
  });

  it("missing session -> rejects /session not found/ and rolls back", async () => {
    session({ missing: true });
    await expect(runs.claimRun("nope")).rejects.toThrow(/session not found: nope/);
    expect(has("ROLLBACK")).toBe(true);
    expect(has("COMMIT")).toBe(false);
  });
});

describe("finishRun", () => {
  it("idle/running: appends usage then status_idle with consecutive seqs, flips idle, unconsumedSeq is a number", async () => {
    session({ status: "running", maxSeq: "10", userMax: "7", usage: { input: 5, output: 2 }, context: { tokens: 9 } });
    const r = await runs.finishRun("s1", "end_turn", 3);
    expect(r.events.map((e) => e.type)).toEqual(["session.usage", "session.status_idle"]);
    expect(r.events.map((e) => e.seq)).toEqual([11, 12]);
    expect(r.events[0]!.payload).toMatchObject({ usage: { input: 5, output: 2 }, context: { tokens: 9 } });
    expect(r.events[1]!.payload).toMatchObject({ stop_reason: "end_turn" });
    expect(statusUpdates().map((c) => c.params)).toEqual([["s1", "idle"]]);
    expect(r.unconsumedSeq).toBe(7);
    expect(typeof r.unconsumedSeq).toBe("number");
    const q = calls.find((c) => c.sql.includes("type='user.message'"))!;
    expect(q.params).toEqual(["s1", 3]);
  });

  it("MAX null -> unconsumedSeq null", async () => {
    session({ status: "idle", userMax: null });
    expect((await runs.finishRun("s1", "end_turn", 3)).unconsumedSeq).toBeNull();
  });

  it("terminated (archived mid-run): no status UPDATE and unconsumedSeq null even if a user message is pending", async () => {
    session({ status: "terminated", userMax: 7 });
    const r = await runs.finishRun("s1", "error", 3);
    expect(statusUpdates()).toHaveLength(0);
    expect(r.unconsumedSeq).toBeNull();
    expect(r.events.map((e) => e.type)).toEqual(["session.usage", "session.status_idle"]);
  });

  // Regression: finishRun carries no run-ownership token. After runner B took over a stale run (claimRun wrote
  // run_lost + status_running at a higher seq), the superseded runner A can still flip the session idle.
  // Modelled here: the lock row shows a live run (fresh heartbeat by B) and the log's newest
  // status_running (seq 9) is newer than anything A consumed (seq 3); A's finish must not touch status.
  it("a superseded runner's finishRun does not flip a live taken-over session to idle", async () => {
    session({ status: "running", idle_ms: 500, maxSeq: 9, userMax: null });
    const prev = script;
    script = (sql, params) => (sql.includes("session.status_running") ? [{ max: 9, seq: 9 }] : prev(sql, params));
    await (runs.finishRun as (...a: unknown[]) => Promise<unknown>)("s1", "end_turn", 3, { claimSeq: 1 });
    expect(statusUpdates()).toHaveLength(0);
  });
});

describe("heartbeat / recordUsage / findStrandedSessions SQL", () => {
  it("heartbeat only refreshes a running session", async () => {
    await runs.heartbeat("s1");
    expect(calls[0]!.sql).toMatch(/UPDATE sessions SET updated_at=now\(\) WHERE id=\$1 AND status='running'/);
    expect(calls[0]!.params).toEqual(["s1"]);
  });

  it("recordUsage passes counters in column order and the JSON context; returns rows[0].usage", async () => {
    script = (sql) => (sql.includes("RETURNING usage") ? [{ usage: { input: 11, requests: 2 } }] : undefined);
    const u = await runs.recordUsage("s1", { input: 1, output: 2, cache_read: 3, cache_write: 4, total_tokens: 10 } as never, { tokens: 7 } as never);
    expect(calls[0]!.params).toEqual(["s1", 1, 2, 3, 4, 10, JSON.stringify({ tokens: 7 })]);
    expect(calls[0]!.sql).toContain("'requests', (usage->>'requests')::bigint + 1");
    expect(u).toEqual({ input: 11, requests: 2 });
  });

  it("findStrandedSessions maps trigger_seq to a number and passes the grace window", async () => {
    script = () => [{ session_id: "s1", owner_id: "prc_a", trigger_seq: "12" }];
    expect(await runs.findStrandedSessions(30_000)).toEqual([{ session_id: "s1", trigger_seq: 12, owner_id: "prc_a" }]);
    expect(calls[0]!.params).toEqual([30_000]);
    expect(calls[0]!.sql).toContain("s.status = 'idle'");
  });

  // Regression: a BYOC pause appends session.environment_disconnected (not a status event), so the reconciler
  // re-detects the session every tick and appends another disconnected event each time.
  it("findStrandedSessions treats session.environment_disconnected as consuming the user message", async () => {
    await runs.findStrandedSessions(30_000);
    expect(calls[0]!.sql).toContain("session.environment_disconnected");
  });
});
