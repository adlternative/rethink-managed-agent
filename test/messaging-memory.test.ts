import { describe, it, expect, beforeAll } from "vitest";

// Select the in-process backend BEFORE importing the modules (they pick a backend at load).
process.env.MESSAGING_BACKEND = "memory";
let bus: typeof import("../src/infra/pubsub.ts");
let q: typeof import("../src/infra/queue.ts");
beforeAll(async () => { bus = await import("../src/infra/pubsub.ts"); q = await import("../src/infra/queue.ts"); });

describe("memory messaging backend (no Redis)", () => {
  it("bus: publish reaches subscribers; steer & tool-result lists drain FIFO", async () => {
    const got: string[] = [];
    const unsub = await bus.subscribe("s1", (d) => got.push(d.type === "agent.message_delta" ? d.text : d.type));
    await bus.publish({ type: "agent.message_delta", session_id: "s1", stream_id: "x", text: "hi" });
    await new Promise((r) => setTimeout(r, 5));
    expect(got).toEqual(["hi"]);
    await unsub();

    await bus.pushSteer("s1", { seq: 1, content: [{ type: "text", text: "a" }] });
    await bus.pushSteer("s1", { seq: 2, content: [{ type: "text", text: "b" }] });
    const drained = await bus.popSteer("s1");
    expect(drained.map((s) => s.seq)).toEqual([1, 2]);
    expect(await bus.popSteer("s1")).toEqual([]); // drained

    await bus.publishToolResult("s1", "call_1", { content: [{ type: "text", text: "r" }], isError: false });
    expect((await bus.takeToolResult("s1", "call_1"))?.content[0]).toMatchObject({ type: "text", text: "r" });
    expect(await bus.takeToolResult("s1", "call_1")).toBeNull(); // taken once
  });

  it("queue: enqueue -> consume runs the handler; depth reflects backlog", async () => {
    await q.enqueueRun({ session_id: "z1", trigger_seq: 1 });
    await q.enqueueRun({ session_id: "z2", trigger_seq: 1 });
    expect(await q.queueDepth()).toBe(2);
    const seen: string[] = [];
    const ac = new AbortController();
    const consuming = q.consumeRuns(async (job) => { seen.push(job.session_id); if (seen.length >= 2) ac.abort(); return "done"; }, { signal: ac.signal, concurrency: 1 });
    await consuming;
    expect(seen.sort()).toEqual(["z1", "z2"]);
  });
});
