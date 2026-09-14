import { describe, it, expect, beforeAll, vi } from "vitest";

// In-process backends only (no Redis, no Postgres). Backends are chosen at import time.
process.env.MESSAGING_BACKEND = "memory";
let bus: typeof import("../src/infra/pubsub.ts");
let q: typeof import("../src/infra/queue.ts");
beforeAll(async () => { bus = await import("../src/infra/pubsub.ts"); q = await import("../src/infra/queue.ts"); });

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
function deferred() { let resolve!: () => void; const p = new Promise<void>((r) => (resolve = r)); return { p, resolve }; }
const delta = (sid: string, text: string) => ({ type: "agent.message_delta" as const, session_id: sid, stream_id: "x", text });

describe("memory bus isolation", () => {
  it("subscribers only see their own session; unsubscribe stops delivery", async () => {
    const s1: string[] = [], s2: string[] = [];
    const u1 = await bus.subscribe("iso-1", (d) => s1.push(d.type === "agent.message_delta" ? d.text : d.type));
    const u2 = await bus.subscribe("iso-2", (d) => s2.push(d.type === "agent.message_delta" ? d.text : d.type));
    await bus.publish(delta("iso-2", "for-2"));
    expect(s1).toEqual([]);
    expect(s2).toEqual(["for-2"]);
    u1();
    await bus.publish(delta("iso-1", "late"));
    expect(s1).toEqual([]);
    u2();
  });

  it("an event delta is routed by delta.event.session_id", async () => {
    const got: number[] = [];
    const u = await bus.subscribe("iso-ev", (d) => { if (d.type === "event") got.push(d.event.seq); });
    await bus.publish({ type: "event", event: { id: "e", session_id: "iso-ev", seq: 9, type: "user.interrupt", payload: { type: "user.interrupt" }, created_at: "" } } as never);
    await bus.publish({ type: "event", event: { id: "e", session_id: "other", seq: 10, type: "user.interrupt", payload: { type: "user.interrupt" }, created_at: "" } } as never);
    expect(got).toEqual([9]);
    u();
  });

  it("onInterrupt fires only for its session", async () => {
    const a = vi.fn(), b = vi.fn();
    const ua = await bus.onInterrupt("int-a", a); const ub = await bus.onInterrupt("int-b", b);
    await bus.publishInterrupt("int-a");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    ua(); await bus.publishInterrupt("int-a");
    expect(a).toHaveBeenCalledTimes(1);
    ub();
  });

  it("onProvidersChanged fires and unsubscribes", async () => {
    const cb = vi.fn();
    const u = await bus.onProvidersChanged(cb);
    await bus.publishProvidersChanged();
    expect(cb).toHaveBeenCalledTimes(1);
    u(); await bus.publishProvidersChanged();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("tool results are FIFO per call id and do not cross call ids or sessions", async () => {
    const r = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: false });
    await bus.publishToolResult("tr", "c1", r("1a"));
    await bus.publishToolResult("tr", "c2", r("2a"));
    await bus.publishToolResult("tr", "c1", r("1b"));
    const text = (m: Awaited<ReturnType<typeof bus.takeToolResult>>) => (m?.content[0] as { text: string } | undefined)?.text;
    expect(await bus.takeToolResult("other", "c1")).toBeNull();
    expect(text(await bus.takeToolResult("tr", "c1"))).toBe("1a");
    expect(text(await bus.takeToolResult("tr", "c1"))).toBe("1b");
    expect(await bus.takeToolResult("tr", "c1")).toBeNull();
    expect(text(await bus.takeToolResult("tr", "c2"))).toBe("2a");
  });

  it("popSteer drains only its own session", async () => {
    await bus.pushSteer("st-1", { seq: 1, content: [] });
    await bus.pushSteer("st-2", { seq: 2, content: [] });
    expect((await bus.popSteer("st-1")).map((s) => s.seq)).toEqual([1]);
    expect((await bus.popSteer("st-2")).map((s) => s.seq)).toEqual([2]);
  });
});

describe("memory queue", () => {
  it("never exceeds the concurrency cap; all jobs run", async () => {
    const gates = Array.from({ length: 5 }, deferred);
    let active = 0, max = 0; const seen: string[] = [];
    for (let i = 0; i < 5; i++) await q.enqueueRun({ session_id: `cc-${i}`, trigger_seq: i });
    const ac = new AbortController();
    const consuming = q.consumeRuns(async (job) => {
      active++; max = Math.max(max, active); seen.push(job.session_id);
      await gates[job.trigger_seq]!.p; active--;
      if (seen.length === 5) ac.abort();
      return "done";
    }, { signal: ac.signal, concurrency: 2 });
    for (const g of gates) { await tick(); g.resolve(); }
    await consuming;
    expect(max).toBe(2);
    expect(seen.sort()).toEqual(["cc-0", "cc-1", "cc-2", "cc-3", "cc-4"]);
    expect(await q.queueDepth()).toBe(0);
  });

  it("a throwing handler does not stop the loop", async () => {
    const seen: string[] = []; const ac = new AbortController();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await q.enqueueRun({ session_id: "th-1", trigger_seq: 1 });
    await q.enqueueRun({ session_id: "th-2", trigger_seq: 1 });
    await q.consumeRuns(async (job) => { seen.push(job.session_id); if (job.session_id === "th-1") throw new Error("boom"); ac.abort(); return "done"; }, { signal: ac.signal, concurrency: 1 });
    expect(seen).toEqual(["th-1", "th-2"]);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("a handler that aborts synchronously (before its first await) still ends consume", async () => {
    const ac = new AbortController(); let n = 0;
    for (let i = 0; i < 3; i++) await q.enqueueRun({ session_id: `sync-${i}`, trigger_seq: i });
    const consuming = q.consumeRuns(async () => { if (++n === 3) ac.abort(); return "done"; }, { signal: ac.signal, concurrency: 4 });
    const winner = await Promise.race([consuming.then(() => "ended"), tick(300).then(() => "hung")]);
    expect(winner).toBe("ended");
  });

  it("aborting while idle resolves consume promptly", async () => {
    const ac = new AbortController();
    const consuming = q.consumeRuns(async () => "done", { signal: ac.signal });
    await tick();
    const t0 = Date.now(); ac.abort(); await consuming;
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it("aborting with in-flight handlers waits for them", async () => {
    const gate = deferred(); let finished = false; let resolved = false;
    const ac = new AbortController();
    await q.enqueueRun({ session_id: "inflight", trigger_seq: 1 });
    const consuming = q.consumeRuns(async () => { await gate.p; finished = true; return "done"; }, { signal: ac.signal, concurrency: 2 }).then(() => { resolved = true; });
    await tick(); ac.abort(); await tick(20);
    expect(resolved).toBe(false);
    gate.resolve(); await consuming;
    expect(finished && resolved).toBe(true);
  });

  // Regression: retry re-pushes onto `pending` without emitting "job"; with spare capacity the consumer parks
  // on the signal and the retried job is stranded until an unrelated enqueue.
  it("a retried job is re-run with spare capacity and no further enqueue", async () => {
    let calls = 0; const ac = new AbortController();
    await q.enqueueRun({ session_id: "retry-once", trigger_seq: 1 });
    const consuming = q.consumeRuns(async () => { calls++; return calls === 1 ? "retry" : "done"; }, { signal: ac.signal, concurrency: 2 });
    await tick(50);
    const n = calls;
    ac.abort(); await consuming;
    expect(n).toBe(2);
  });

  // Regression: at concurrency 1 an always-retry handler is re-invoked in a tight loop (no backoff). The handler
  // yields a macrotask per call; a purely synchronous one would starve the event loop entirely.
  it("an always-retry job is not hot-spun (bounded invocations over 20ms)", async () => {
    let calls = 0; const ac = new AbortController();
    await q.enqueueRun({ session_id: "retry-spin", trigger_seq: 1 });
    const consuming = q.consumeRuns(async () => { calls++; await new Promise((r) => setImmediate(r)); return "retry"; }, { signal: ac.signal, concurrency: 1 });
    await tick(20);
    const n = calls;
    ac.abort(); await consuming;
    await q.consumeRuns(async () => "done", { signal: AbortSignal.abort() }); // leave nothing behind
    expect(n).toBeLessThanOrEqual(5);
  });
});
