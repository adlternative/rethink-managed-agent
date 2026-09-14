import { describe, it, expect, vi, beforeEach } from "vitest";

// BYOC transport over an in-memory Redis stand-in (hermetic): lists, string keys with TTLs, and a
// BRPOP that polls until its timeout. Every connection shares the same keyspace.
const lists = new Map<string, string[]>();
const strings = new Map<string, string>();
const ttls = new Map<string, number>();
const log: string[] = [];
const zsets = new Map<string, Map<string, number>>();

const match = (pattern: string) => { const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`); return [...strings.keys()].filter((k) => re.test(k)); };
vi.mock("ioredis", () => {
  class Redis {
    constructor(..._a: unknown[]) {}
    on() { return this; }
    disconnect() {}
    async quit() {}
    async lpush(k: string, v: string) { const l = lists.get(k) ?? []; l.unshift(v); lists.set(k, l); return l.length; }
    async expire(k: string, s: number) { log.push(`expire ${k} ${s}`); ttls.set(k, s); return 1; }
    async del(k: string) { log.push(`del ${k}`); lists.delete(k); strings.delete(k); return 1; }
    async set(k: string, v: string, ex?: string, s?: number) { log.push(`set ${k} ${v}${ex ? ` ${ex} ${s}` : ""}`); strings.set(k, v); if (s) ttls.set(k, s); return "OK"; }
    async get(k: string) { return strings.get(k) ?? null; }
    async exists(k: string) { return strings.has(k) ? 1 : 0; }
    async zadd(k: string, score: number, m: string) { const z = zsets.get(k) ?? new Map(); z.set(m, score); zsets.set(k, z); log.push(`zadd ${k} ${m}`); return 1; }
    async zcount(k: string, min: number, _max: string) { return [...(zsets.get(k)?.values() ?? [])].filter((v) => v >= min).length; }
    async zremrangebyscore(k: string, _min: string, max: string) { const bound = Number(max.replace("(", "")); const z = zsets.get(k); let n = 0; for (const [m, v] of z ?? []) if (v < bound) { z!.delete(m); n++; } return n; }
    async scan(_cursor: string, _match: string, pattern: string) { log.push(`scan ${pattern}`); return ["0", match(pattern)]; }
    multi() { const ops: (() => Promise<unknown>)[] = []; const chain: any = new Proxy({}, { get: (_t, name: string) => name === "exec" ? async () => { const out = []; for (const op of ops) out.push([null, await op()]); return out; } : (...a: unknown[]) => { ops.push(() => (this as any)[name](...a)); return chain; } }); return chain; }
    async keys(pattern: string) { log.push(`keys ${pattern}`); return match(pattern); }
    async brpop(...args: (string | number)[]) {
      const timeout = Number(args.pop()); const keys = args as string[];
      const end = Date.now() + timeout * 1000;
      for (;;) {
        for (const k of keys) { const l = lists.get(k); if (l?.length) { const v = l.pop()!; if (!l.length) lists.delete(k); return [k, v]; } }
        if (Date.now() >= end) return null;
        await new Promise((r) => setTimeout(r, 2));
      }
    }
  }
  return { Redis, default: Redis };
});

const byoc = await import("../src/infra/byoc.ts");
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => { lists.clear(); strings.clear(); ttls.clear(); zsets.clear(); log.length = 0; });

describe("byoc runner side", () => {
  it("enqueue routes create to the env queue and other ops to the sandbox queue, with a TTL", async () => {
    await byoc.enqueue("env1", { req_id: "r1", op: "create", sandbox_id: "sbx1", workspace_ref: null });
    await byoc.enqueue("env1", { req_id: "r2", op: "exec", sandbox_id: "sbx1", command: "ls" });
    expect(JSON.parse(lists.get("byoc:env:env1:create")![0]!)).toMatchObject({ req_id: "r1" });
    expect(JSON.parse(lists.get("byoc:sbx:sbx1:req")![0]!)).toMatchObject({ req_id: "r2" });
    expect(ttls.get("byoc:env:env1:create")).toBe(3600);
    expect(ttls.get("byoc:sbx:sbx1:req")).toBe(3600);
  });

  it("awaitResult forwards chunks in push order, resolves on done, and deletes the result key", async () => {
    const chunks: string[] = [];
    const p = byoc.awaitResult("req1", { timeoutMs: 2000, onChunk: (s, d) => chunks.push(`${s}:${d}`) });
    await byoc.pushResult({ req_id: "req1", type: "chunk", stream: "stdout", data: "a" });
    await byoc.pushResult({ req_id: "req1", type: "chunk", stream: "stderr", data: "b" });
    await byoc.pushResult({ req_id: "req1", type: "done", ok: true, result: { code: 0 } });
    expect(await p).toEqual({ req_id: "req1", type: "done", ok: true, result: { code: 0 } });
    expect(chunks).toEqual(["stdout:a", "stderr:b"]);
    expect(log).toContain("del byoc:res:req1");
    expect(ttls.get("byoc:res:req1")).toBe(600);
  });

  it("a failed done is returned, not thrown", async () => {
    await byoc.pushResult({ req_id: "req2", type: "done", ok: false, error: "no space" });
    expect(await byoc.awaitResult("req2", { timeoutMs: 1000 })).toMatchObject({ ok: false, error: "no space" });
  });

  it("rejects when the worker does not answer in time", async () => {
    await expect(byoc.awaitResult("silent", { timeoutMs: 1000 })).rejects.toThrow(/did not answer within 1000ms/);
  }, 10_000);

  it("a pre-aborted signal rejects 'aborted' immediately", async () => {
    await expect(byoc.awaitResult("x", { timeoutMs: 5000, signal: AbortSignal.abort() })).rejects.toThrow("aborted");
  });

  // Regression: abort is only checked between BRPOPs (up to 5s each), so cancelling a tool call takes seconds.
  it("aborting during a blocking wait rejects promptly", async () => {
    const ac = new AbortController();
    const p = byoc.awaitResult("slow", { timeoutMs: 60_000, signal: ac.signal });
    await tick(20); ac.abort();
    const winner = await Promise.race([p.then(() => "resolved", () => "rejected"), tick(500).then(() => "still waiting")]);
    expect(winner).toBe("rejected");
  });

  it("worker liveness: markWorkerAlive, isWorkerAlive, anyWorkerAlive, workerFor", async () => {
    expect(await byoc.anyWorkerAlive("env1")).toBe(false);
    await byoc.markWorkerAlive("env1", "w1");
    expect(ttls.get("byoc:env:env1:worker:w1")).toBe(byoc.WORKER_TTL_S);
    expect(await byoc.isWorkerAlive("env1", "w1")).toBe(true);
    expect(await byoc.isWorkerAlive("env1", "w2")).toBe(false);
    expect(await byoc.anyWorkerAlive("env1")).toBe(true);
    expect(await byoc.anyWorkerAlive("env2")).toBe(false);
    expect(await byoc.workerFor("sbx9")).toBeNull();
    expect(byoc.newReqId()).toMatch(/^req_/);
  });

  it("anyWorkerAlive answers from the per-env worker set, never with KEYS", async () => {
    await byoc.markWorkerAlive("env1", "w1");
    log.length = 0;
    expect(await byoc.anyWorkerAlive("env1")).toBe(true);
    expect(log.filter((l) => l.startsWith("scan") || l.startsWith("keys"))).toEqual([]); // live: one ZCOUNT, no keyspace walk
    expect(await byoc.anyWorkerAlive("env2")).toBe(false);
    expect(log.some((l) => l.startsWith("keys"))).toBe(false);
  });

  it("a lapsed worker in the set is not alive; a worker marked only by its key (rolling deploy) still is", async () => {
    zsets.set("byoc:env:env1:workers", new Map([["gone", Date.now() - 1000]]));
    expect(await byoc.anyWorkerAlive("env1")).toBe(false);
    await byoc.markWorkerAlive("env1", "w2");
    expect([...zsets.get("byoc:env:env1:workers")!.keys()]).toEqual(["w2"]); // the lapsed member is trimmed on the next heartbeat
    strings.set("byoc:env:env3:worker:old", "1"); // heartbeat written without the set
    expect(await byoc.anyWorkerAlive("env3")).toBe(true);
  });
});

describe("byoc API side (worker long-poll)", () => {
  it("pollForWorker heartbeats, refreshes sandbox ownership TTLs, and binds a created sandbox to the worker", async () => {
    await byoc.enqueue("env1", { req_id: "r1", op: "create", sandbox_id: "sbxA", workspace_ref: null });
    const req = await byoc.pollForWorker("env1", "w1", ["sbxOld"], 1);
    expect(req).toMatchObject({ op: "create", sandbox_id: "sbxA" });
    expect(log).toContain(`set byoc:env:env1:worker:w1 1 EX ${byoc.WORKER_TTL_S}`);
    expect(log).toContain(`expire byoc:sbx:sbxOld:worker ${byoc.WORKER_TTL_S * 2}`);
    expect(await byoc.workerFor("sbxA")).toBe("w1");
    expect(ttls.get("byoc:sbx:sbxA:worker")).toBe(byoc.WORKER_TTL_S * 2);
  });

  it("pollForWorker serves its sandbox queues and returns null on an empty wait", async () => {
    await byoc.enqueue("env1", { req_id: "r2", op: "read", sandbox_id: "sbxB", path: "/a" });
    expect(await byoc.pollForWorker("env1", "w1", ["sbxA"], 1)).toBeNull(); // not its sandbox
    expect(await byoc.pollForWorker("env1", "w1", ["sbxB"], 1)).toMatchObject({ req_id: "r2", op: "read" });
    expect(await byoc.workerFor("sbxB")).toBeNull(); // only create binds
  }, 10_000);

  it("requests are served FIFO", async () => {
    await byoc.enqueue("env1", { req_id: "first", op: "exec", sandbox_id: "s", command: "1" });
    await byoc.enqueue("env1", { req_id: "second", op: "exec", sandbox_id: "s", command: "2" });
    expect((await byoc.pollForWorker("env1", "w", ["s"], 1))?.req_id).toBe("first");
    expect((await byoc.pollForWorker("env1", "w", ["s"], 1))?.req_id).toBe("second");
  });
});
