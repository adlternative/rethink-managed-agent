import { describe, it, expect, vi, beforeEach } from "vitest";

// Redis Streams run queue against an in-memory stand-in for one stream + one consumer group
// (hermetic). Implements just the commands queue.ts uses plus XLEN / XINFO GROUPS for a depth fix.
process.env.MESSAGING_BACKEND = "redis";

type Entry = [string, string[]];
const state = {
  entries: [] as Entry[],
  lastDelivered: 0,
  pending: new Map<string, { consumer: string; deliveredAt: number }>(),
  seq: 0,
  groupCreated: false,
  commands: [] as string[],
};
const idNum = (id: string) => Number(id.split("-")[0]);

vi.mock("ioredis", () => {
  class Redis {
    constructor(..._a: unknown[]) {}
    on() { return this; }
    disconnect() {}
    async quit() {}
    async xgroup() { state.commands.push("xgroup"); if (state.groupCreated) throw new Error("BUSYGROUP Consumer Group name already exists"); state.groupCreated = true; return "OK"; }
    async xadd(_s: string, _id: string, ...fields: string[]) { const id = `${++state.seq}-0`; state.entries.push([id, fields]); return id; }
    async xlen() { return state.entries.length; }
    async xinfo(sub: string) { if (sub !== "GROUPS") return []; const lag = state.entries.filter(([id]) => idNum(id) > state.lastDelivered).length; return [["name", "runners", "consumers", 1, "pending", state.pending.size, "last-delivered-id", `${state.lastDelivered}-0`, "entries-read", state.lastDelivered, "lag", lag]]; }
    async xpending() { return [state.pending.size, null, null, null]; }
    async xack(_s: string, _g: string, id: string) { state.commands.push(`xack ${id}`); return state.pending.delete(id) ? 1 : 0; }
    async xdel(_s: string, id: string) { state.commands.push(`xdel ${id}`); const n = state.entries.length; state.entries = state.entries.filter(([x]) => x !== id); return n - state.entries.length; }
    async xautoclaim(_s: string, _g: string, consumer: string, minIdle: number, _start: string, _c: string, count: number) {
      state.commands.push(`xautoclaim ${count}`);
      const now = Date.now(); const out: Entry[] = [];
      for (const [id, p] of state.pending) {
        if (out.length >= count) break;
        if (now - p.deliveredAt >= minIdle) { p.consumer = consumer; p.deliveredAt = now; const e = state.entries.find(([x]) => x === id); if (e) out.push(e); }
      }
      return ["0-0", out, []];
    }
    async xreadgroup(...args: (string | number)[]) {
      const count = Number(args[args.indexOf("COUNT") + 1]); const block = Number(args[args.indexOf("BLOCK") + 1]);
      state.commands.push(`xreadgroup ${count}`);
      const take = () => state.entries.filter(([id]) => idNum(id) > state.lastDelivered).slice(0, count);
      let got = take();
      // Emulate BLOCK briefly (capped so tests stay fast).
      for (let waited = 0; !got.length && waited < Math.min(block, 30); waited += 5) { await new Promise((r) => setTimeout(r, 5)); got = take(); }
      if (!got.length) return null;
      for (const [id] of got) { state.lastDelivered = idNum(id); state.pending.set(id, { consumer: String(args[2]), deliveredAt: Date.now() }); }
      return [["runs", got]];
    }
    multi() { return this; }
  }
  return { Redis, default: Redis };
});

const q = await import("../src/infra/queue.ts");
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => { state.entries = []; state.lastDelivered = 0; state.pending.clear(); state.seq = 0; state.commands = []; });

describe("redis run queue (mocked ioredis)", () => {
  it("enqueue XADDs the JSON job; done XACKs; retry leaves the entry pending", async () => {
    await q.enqueueRun({ session_id: "a", trigger_seq: 1, owner_id: "prc_a" });
    await q.enqueueRun({ session_id: "b", trigger_seq: 2 });
    expect(JSON.parse(state.entries[0]![1][1]!)).toEqual({ session_id: "a", trigger_seq: 1, owner_id: "prc_a" });
    const ac = new AbortController(); const seen: string[] = [];
    await q.consumeRuns(async (job) => { seen.push(job.session_id); if (seen.length === 2) ac.abort(); return job.session_id === "a" ? "done" : "retry"; }, { signal: ac.signal, concurrency: 1 });
    expect(seen).toEqual(["a", "b"]);
    expect([...state.pending.keys()]).toEqual(["2-0"]);
    expect(state.commands).toContain("xack 1-0");
    // the finished entry is removed from the stream (no unbounded growth); the retried one stays for reclaim
    expect(state.commands.indexOf("xdel 1-0")).toBeGreaterThan(state.commands.indexOf("xack 1-0"));
    expect(state.entries.map(([id]) => id)).toEqual(["2-0"]);
  });

  it("depth still counts the undelivered backlog after finished entries are deleted", async () => {
    for (let i = 0; i < 4; i++) await q.enqueueRun({ session_id: `x${i}`, trigger_seq: 1 });
    const ac = new AbortController(); let n = 0;
    await q.consumeRuns(async () => { if (++n === 2) ac.abort(); return "done"; }, { signal: ac.signal, concurrency: 1 });
    await tick(10);
    expect(state.entries).toHaveLength(2);
    expect(await q.queueDepth()).toBe(2);
  });

  it("a malformed entry (no job field) is acked and skipped", async () => {
    state.entries.push([`${++state.seq}-0`, ["other", "x"]]);
    await q.enqueueRun({ session_id: "ok", trigger_seq: 1 });
    const ac = new AbortController(); const seen: string[] = [];
    await q.consumeRuns(async (job) => { seen.push(job.session_id); ac.abort(); return "done"; }, { signal: ac.signal, concurrency: 2 });
    await tick(10);
    expect(seen).toEqual(["ok"]);
    expect(state.pending.size).toBe(0);
  });

  // Regression: depth() reads XPENDING (delivered but unacked), not the undelivered backlog.
  it("depth reports the undelivered backlog", async () => {
    for (let i = 0; i < 3; i++) await q.enqueueRun({ session_id: `d${i}`, trigger_seq: 1 });
    expect(await q.queueDepth()).toBe(3);
  });

  // Regression: after XAUTOCLAIM fills every free slot, XREADGROUP still reads COUNT max(1, ...) = 1 and
  // starts one more handler, exceeding the concurrency cap.
  it("never runs more handlers than the concurrency cap when a stale entry is reclaimed", async () => {
    await q.enqueueRun({ session_id: "stale", trigger_seq: 1 });
    state.lastDelivered = 1; state.pending.set("1-0", { consumer: "dead-runner", deliveredAt: 0 }); // idle far beyond STALE_MS
    await q.enqueueRun({ session_id: "fresh", trigger_seq: 1 });
    const ac = new AbortController(); let active = 0, max = 0, done = 0;
    await q.consumeRuns(async () => { active++; max = Math.max(max, active); await tick(20); active--; if (++done === 2) ac.abort(); return "done"; }, { signal: ac.signal, concurrency: 1 });
    expect(max).toBe(1);
  });
});
