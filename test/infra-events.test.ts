import { describe, it, expect, vi, beforeEach } from "vitest";

// Hermetic: pg is a scripted fake; the bus is the in-process memory backend so publish is observable.
process.env.MESSAGING_BACKEND = "memory";
type Call = { sql: string; params: unknown[]; via: "pool" | "client" };
const calls: Call[] = [];
let connects = 0, releases = 0;
let script: (sql: string, params: unknown[]) => unknown[] | undefined = () => undefined;
const run = (via: Call["via"]) => async (sql: string, params: unknown[] = []) => {
  calls.push({ sql, params, via });
  const rows = script(sql, params) ?? [];
  return { rows, rowCount: rows.length };
};
vi.mock("pg", () => {
  class Pool {
    query = run("pool");
    connect = async () => { connects++; return { query: run("client"), release() { releases++; } }; };
  }
  return { default: { Pool }, Pool };
});

const events = await import("../src/infra/events.ts");
const bus = await import("../src/infra/pubsub.ts");

const lockRow = (sql: string) => (sql.includes("FOR UPDATE") ? [{ status: "idle", idle_ms: "5" }] : undefined);
const echoInsert = (sql: string, params: unknown[]) => sql.includes("COALESCE(MAX(seq),0)") ? [{ max: "0" }] : (sql.includes("INSERT INTO events") ? [{ id: params[0], session_id: params[1], seq: String(params[2]), type: params[3], payload: JSON.parse(params[4] as string), created_at: new Date("2026-01-01T00:00:00Z") }] : undefined);
const ev = (seq: number) => ({ id: `e${seq}`, session_id: "s1", seq: String(seq), type: "user.message", payload: {}, created_at: new Date(seq * 1000) });

beforeEach(() => { calls.length = 0; connects = 0; releases = 0; script = () => undefined; });

describe("appendIn / appendEvents / withSession", () => {
  it("assigns consecutive numeric seqs after MAX(seq) under the lock", async () => {
    script = (sql, p) => lockRow(sql) ?? (sql.includes("COALESCE(MAX(seq),0)") ? [{ max: "41" }] : echoInsert(sql, p));
    const out = await events.appendEvents("s1", [{ type: "user.interrupt" }, { type: "session.status_running" }, { type: "user.interrupt" }], { publish: false });
    expect(out.map((e) => e.seq)).toEqual([42, 43, 44]);
    expect(out.every((e) => typeof e.seq === "number")).toBe(true);
    expect(out[0]!.created_at).toBe("2026-01-01T00:00:00.000Z");
    const order = calls.map((c) => c.sql.trim().split(/\s+/).slice(0, 2).join(" "));
    expect(order[0]).toBe("BEGIN");
    expect(calls.findIndex((c) => c.sql.includes("FOR UPDATE"))).toBeLessThan(calls.findIndex((c) => c.sql.includes("MAX(seq)")));
    expect(order.at(-1)).toBe("COMMIT");
    expect(calls.every((c) => c.via === "client")).toBe(true);
    expect(releases).toBe(1);
  });

  it("appendEvents([]) returns [] without touching the pool", async () => {
    expect(await events.appendEvents("s1", [])).toEqual([]);
    expect(connects).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("opts.status updates sessions on the same tx client before COMMIT", async () => {
    script = (sql, p) => lockRow(sql) ?? echoInsert(sql, p);
    await events.appendEvents("s1", [{ type: "session.status_terminated" }], { publish: false, status: "terminated" });
    const upd = calls.findIndex((c) => c.sql.includes("UPDATE sessions SET status"));
    expect(upd).toBeGreaterThan(0);
    expect(calls[upd]!.via).toBe("client");
    expect(calls[upd]!.params).toEqual(["s1", "terminated"]);
    expect(upd).toBeLessThan(calls.findIndex((c) => c.sql === "COMMIT"));
  });

  it("publishes each committed event unless publish === false", async () => {
    script = (sql, p) => lockRow(sql) ?? echoInsert(sql, p);
    const got: number[] = [];
    const unsub = await bus.subscribe("s1", (d) => { if (d.type === "event") got.push(d.event.seq); });
    await events.appendEvents("s1", [{ type: "user.interrupt" }, { type: "user.interrupt" }], { publish: false });
    expect(got).toEqual([]);
    await events.appendEvents("s1", [{ type: "user.interrupt" }, { type: "user.interrupt" }]);
    expect(got).toEqual([1, 2]);
    unsub();
  });

  it("an fn throw rolls back, releases, and propagates", async () => {
    script = lockRow;
    await expect(events.withSession("s1", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(calls.map((c) => c.sql)).toContain("ROLLBACK");
    expect(calls.map((c) => c.sql)).not.toContain("COMMIT");
    expect(releases).toBe(1);
  });

  it("withSession hands fn the locked status and a numeric idle_ms; missing row rejects", async () => {
    script = lockRow;
    const s = await events.withSession("s1", async (_c, s) => s);
    expect(s).toEqual({ status: "idle", idle_ms: 5 });
    script = () => [];
    await expect(events.withSession("gone", async () => 1)).rejects.toThrow(/session not found: gone/);
    expect(releases).toBe(2);
  });
});

describe("listEvents / listAllEvents paging", () => {
  function pagedLog(total: number) {
    script = (sql, p) => {
      if (!sql.includes("FROM events")) return undefined;
      const [, since, limit] = p as [string, number, number];
      return Array.from({ length: total }, (_, i) => ev(i + 1)).filter((e) => Number(e.seq) > since).slice(0, limit);
    };
  }

  it("exact multiple of the page size: 4 events at pageSize 2 -> 3 queries, all 4 in order", async () => {
    pagedLog(4);
    const out = await events.listAllEvents("s1", 2);
    expect(out.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(calls.map((c) => c.params)).toEqual([["s1", 0, 2], ["s1", 2, 2], ["s1", 4, 2]]);
  });

  it("3 events at pageSize 2 -> 2 queries", async () => {
    pagedLog(3);
    expect((await events.listAllEvents("s1", 2)).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(calls.map((c) => c.params)).toEqual([["s1", 0, 2], ["s1", 2, 2]]);
  });

  it("empty log -> one query, []", async () => {
    pagedLog(0);
    expect(await events.listAllEvents("s1", 2)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("listEvents defaults since 0 / limit 10000 and normalizes seq and created_at", async () => {
    script = () => [ev(7)];
    const [e] = await events.listEvents("s1");
    expect(calls[0]!.params).toEqual(["s1", 0, 10000]);
    expect(e!.seq).toBe(7);
    expect(e!.created_at).toBe(new Date(7000).toISOString());
  });
});
