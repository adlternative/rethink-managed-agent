import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hermetic: real routes over in-memory fakes; the memory event bus is real but wrapped so calls can be observed.
vi.hoisted(() => { process.env.MESSAGING_BACKEND = "memory"; process.env.LOG_LEVEL = "error"; });
vi.mock("@hono/node-server", () => ({ serve: () => {} }));
vi.mock("../src/infra/migrate.ts", () => ({ migrate: async () => {} }));
vi.mock("../src/infra/db.ts", () => import("./fixtures/api-harness/fake-db.ts"));
vi.mock("../src/infra/events.ts", async () => (await import("./fixtures/api-harness/fakes.ts")).events);
vi.mock("../src/infra/queue.ts", async () => (await import("./fixtures/api-harness/fakes.ts")).queue);
vi.mock("../src/infra/byoc.ts", async () => (await import("./fixtures/api-harness/fakes.ts")).byoc);
vi.mock("../src/infra/blobs.ts", async () => (await import("./fixtures/api-harness/fakes.ts")).blobs);
vi.mock("../src/sandbox/lease-store.ts", async () => (await import("./fixtures/api-harness/fakes.ts")).leaseStore);
const subs = vi.hoisted(() => ({ active: 0, gate: null as Promise<void> | null }));
vi.mock("../src/infra/pubsub.ts", async (importOriginal) => {
  const m = await importOriginal<typeof import("../src/infra/pubsub.ts")>();
  return {
    ...m,
    pushSteer: vi.fn(m.pushSteer),
    publishInterrupt: vi.fn(m.publishInterrupt),
    publishToolResult: vi.fn(m.publishToolResult),
    // counts live subscriptions; `gate` lets a test hold subscribe() pending
    subscribe: vi.fn(async (sid: string, cb: (d: never) => void) => {
      if (subs.gate) await subs.gate;
      const unsub = await m.subscribe(sid, cb);
      subs.active++;
      let done = false;
      return () => { if (!done) { done = true; subs.active--; } unsub(); };
    }),
  };
});

const { app } = await import("../src/api/main.ts");
const { validateUserEvents, sendUserEvents } = await import("../src/api/routes/events.ts");
const pubsub = await import("../src/infra/pubsub.ts");
const { store, reset, seed } = await import("./fixtures/api-harness/fake-db.ts");
const { queue, events: fakeEvents } = await import("./fixtures/api-harness/fakes.ts");

beforeEach(() => { reset(); queue.jobs.length = 0; subs.active = 0; subs.gate = null; vi.mocked(pubsub.pushSteer).mockClear(); vi.mocked(pubsub.publishInterrupt).mockClear(); vi.mocked(pubsub.publishToolResult).mockClear(); });
afterEach(() => { vi.restoreAllMocks(); });

const OWNER = "prc_local"; // AUTH_REQUIRED=false default principal
const text = (t: string) => ({ type: "user.message", content: [{ type: "text", text: t }] });

describe("validateUserEvents", () => {
  const bad = (v: unknown) => expect(() => validateUserEvents(v)).toThrow(expect.objectContaining({ status: 400 }));

  it("rejects non-arrays and empty arrays", () => { bad(undefined); bad({}); bad([]); });
  it("accepts user.message text and user.interrupt", () => {
    expect(validateUserEvents([text("hi"), { type: "user.interrupt" }])).toHaveLength(2);
  });
  it("rejects user.message with empty or missing content", () => { bad([{ type: "user.message", content: [] }]); bad([{ type: "user.message" }]); });
  it("rejects unknown event types and null entries", () => { bad([{ type: "bogus" }]); bad([null]); });
  it("tool_result requires tool_use_id and non-empty content; is_error is coerced to boolean", () => {
    bad([{ type: "tool_result", content: [{ type: "text", text: "x" }] }]);
    bad([{ type: "tool_result", tool_use_id: "", content: [{ type: "text", text: "x" }] }]);
    bad([{ type: "tool_result", tool_use_id: "call_1", content: [] }]);
    const [a] = validateUserEvents([{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "x" }], is_error: "yes" }]) as any[];
    expect(a.is_error).toBe(true);
    const [b] = validateUserEvents([{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "x" }] }]) as any[];
    expect(b.is_error).toBe(false);
  });
  it("normalizes the short image/document form to a file source", () => {
    const [e] = validateUserEvents([{ type: "user.message", content: [{ type: "image", file_id: "file_abc" }, { type: "document", source: { type: "file", file_id: "file_d-1" } }] }]) as any[];
    expect(e.content).toEqual([{ type: "image", source: { type: "file", file_id: "file_abc" } }, { type: "document", source: { type: "file", file_id: "file_d-1" } }]);
  });
  it("rejects file ids that are not file_ ids (path characters, wrong prefix)", () => {
    bad([{ type: "user.message", content: [{ type: "image", file_id: "file_../etc" }] }]);
    bad([{ type: "user.message", content: [{ type: "image", file_id: "file_a/b" }] }]);
    bad([{ type: "user.message", content: [{ type: "document", source: { type: "url", url: "http://x" } }] }]);
    bad([{ type: "user.message", content: [{ type: "text", text: 5 }] }]);
  });
  it("one invalid block rejects the whole batch", () => {
    bad([text("ok"), { type: "user.message", content: [{ type: "text", text: "ok" }, { type: "video" }] }]);
  });
});

describe("sendUserEvents", () => {
  it("running: steers each user.message and does not enqueue", async () => {
    const s = seed.session(OWNER, { status: "running" });
    const out = await sendUserEvents(s as never, [text("a"), text("b")] as never);
    expect(out.map((e) => e.seq)).toEqual([1, 2]);
    expect(vi.mocked(pubsub.pushSteer).mock.calls.map((c) => c[1].seq)).toEqual([1, 2]);
    expect(queue.jobs).toEqual([]);
  });

  it("idle: one enqueueRun with trigger_seq = the last message seq and the owner", async () => {
    const s = seed.session(OWNER);
    seed.events(s.id, [{ type: "session.status_idle", stop_reason: "end_turn" }]);
    await sendUserEvents(s as never, [text("a"), text("b")] as never);
    expect(queue.jobs).toEqual([{ session_id: s.id, trigger_seq: 3, owner_id: OWNER }]);
    expect(pubsub.pushSteer).not.toHaveBeenCalled();
  });

  it("interrupt only: publishes the interrupt, appends it, and does not enqueue", async () => {
    const s = seed.session(OWNER);
    const out = await sendUserEvents(s as never, [{ type: "user.interrupt" }] as never);
    expect(out.map((e) => e.type)).toEqual(["user.interrupt"]);
    expect(pubsub.publishInterrupt).toHaveBeenCalledWith(s.id);
    expect(queue.jobs).toEqual([]);
  });

  it("tool_result is delivered on the per-call channel and never appended", async () => {
    const s = seed.session(OWNER, { status: "running" });
    const out = await sendUserEvents(s as never, [{ type: "tool_result", tool_use_id: "call_9", content: [{ type: "text", text: "r" }], is_error: true }] as never);
    expect(out).toEqual([]);
    expect(store.events.get(s.id)).toEqual([]);
    expect(pubsub.publishToolResult).toHaveBeenCalledWith(s.id, "call_9", { content: [{ type: "text", text: "r" }], isError: true });
    expect(queue.jobs).toEqual([]);
  });

  // Regression: a terminated session silently appends the message; neither steer nor enqueue happens.
  it("terminated: rejects instead of silently appending", async () => {
    const s = seed.session(OWNER, { status: "terminated" });
    await expect(sendUserEvents(s as never, [text("hi")] as never)).rejects.toBeTruthy();
    expect(store.events.get(s.id)).toEqual([]);
  });
});

describe("POST/GET /v1/sessions/:id/events", () => {
  it("POST appends and returns the events; foreign owner -> 404", async () => {
    const s = seed.session(OWNER);
    const r = await app.request(`/v1/sessions/${s.id}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [text("hi")] }) });
    expect(r.status).toBe(200);
    expect((await r.json() as { events: unknown[] }).events).toHaveLength(1);
    const other = seed.session("prc_other");
    expect((await app.request(`/v1/sessions/${other.id}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [text("hi")] }) })).status).toBe(404);
    expect(store.events.get(other.id)).toEqual([]);
  });

  // Regression (same root cause as sendUserEvents): the route does not use a live-session check.
  it("POST on a terminated session -> 400 and nothing appended", async () => {
    const s = seed.session(OWNER, { status: "terminated" });
    const r = await app.request(`/v1/sessions/${s.id}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [text("hi")] }) });
    expect(r.status).toBe(400);
    expect(store.events.get(s.id)).toEqual([]);
  });

  it("GET pages with since/limit; has_more is false when exactly `limit` remain", async () => {
    const s = seed.session(OWNER);
    seed.events(s.id, Array.from({ length: 5 }, (_, i) => text(String(i))));
    const p1 = await (await app.request(`/v1/sessions/${s.id}/events?limit=2`)).json() as { data: { seq: number }[]; has_more: boolean };
    expect(p1.data.map((e) => e.seq)).toEqual([1, 2]);
    expect(p1.has_more).toBe(true);
    const p2 = await (await app.request(`/v1/sessions/${s.id}/events?since=2&limit=3`)).json() as { data: { seq: number }[]; has_more: boolean };
    expect(p2.data.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(p2.has_more).toBe(false);
  });

  it("GET clamps limit to 1000", async () => {
    const s = seed.session(OWNER);
    seed.events(s.id, Array.from({ length: 1005 }, () => text("x")));
    const p = await (await app.request(`/v1/sessions/${s.id}/events?limit=5000`)).json() as { data: unknown[]; has_more: boolean };
    expect(p.data).toHaveLength(1000);
    expect(p.has_more).toBe(true);
  });

  it("GET on a foreign-owner session -> 404", async () => {
    const other = seed.session("prc_other");
    expect((await app.request(`/v1/sessions/${other.id}/events`)).status).toBe(404);
  });

  // Regression: since/limit are forwarded unvalidated (NaN reaches Postgres -> 500; limit=-1 yields data:[] with has_more:true).
  for (const q of ["since=abc", "limit=abc", "limit=-1"]) {
    it(`GET ?${q} -> 400`, async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const s = seed.session(OWNER);
      expect((await app.request(`/v1/sessions/${s.id}/events?${q}`)).status).toBe(400);
    });
  }

  // Regression: limit=0 returns data:[] with has_more:true forever (infinite client paging).
  it("GET ?limit=0 does not report has_more with an empty page", async () => {
    const s = seed.session(OWNER);
    seed.events(s.id, [text("a")]);
    const r = await app.request(`/v1/sessions/${s.id}/events?limit=0`);
    const body = r.status === 200 ? await r.json() as { data: unknown[]; has_more: boolean } : null;
    expect(r.status === 400 || (body !== null && !(body.data.length === 0 && body.has_more))).toBe(true);
  });
});

/** Background SSE reader: collects parsed events, exposes `waitFor` and `ended`. */
function readSse(res: Response) {
  const got: { event: string; data: any }[] = [];
  let ended = false; let buf = "";
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const loop = (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) { ended = true; return; }
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(chunk)?.[1]; const data = /^data: (.*)$/m.exec(chunk)?.[1];
        if (ev && data) got.push({ event: ev, data: JSON.parse(data) });
      }
    }
  })();
  const waitFor = async (pred: () => boolean, ms = 2000) => {
    const t0 = Date.now();
    while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timeout; got ${got.length} events, ended=${ended}`); await new Promise((r) => setTimeout(r, 5)); }
  };
  return { got, get ended() { return ended; }, waitFor, cancel: () => reader.cancel().catch(() => {}), loop };
}
const seqs = (got: { data: any }[]) => got.filter((g) => typeof g.data?.seq === "number").map((g) => g.data.seq);
const liveEvent = (sessionId: string, seq: number, payload: Record<string, unknown>) => ({ id: `evt_${seq}`, session_id: sessionId, seq, type: payload.type, payload, created_at: new Date().toISOString() });

describe("GET /v1/sessions/:id/events/stream (SSE)", () => {
  it("replays past REPLAY_PAGE (2500 stored events) in order", async () => {
    const s = seed.session(OWNER);
    seed.events(s.id, Array.from({ length: 2500 }, (_, i) => text(String(i))));
    const sse = readSse(await app.request(`/v1/sessions/${s.id}/events/stream`));
    await sse.waitFor(() => sse.got.length >= 2500, 10000);
    expect(seqs(sse.got)).toEqual(Array.from({ length: 2500 }, (_, i) => i + 1));
    await sse.cancel();
  });

  it("honors since (only later events are replayed)", async () => {
    const s = seed.session(OWNER);
    seed.events(s.id, [text("a"), text("b"), text("c")]);
    const sse = readSse(await app.request(`/v1/sessions/${s.id}/events/stream?since=2`));
    await sse.waitFor(() => sse.got.length >= 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(seqs(sse.got)).toEqual([3]);
    await sse.cancel();
  });

  it("a live event past last+1 fills the gap from the store; duplicates via replay and live are dropped", async () => {
    const s = seed.session(OWNER);
    seed.events(s.id, [text("1"), text("2")]);
    const sse = readSse(await app.request(`/v1/sessions/${s.id}/events/stream`));
    await sse.waitFor(() => sse.got.length >= 2);
    await pubsub.publish({ type: "event", event: liveEvent(s.id, 2, text("2")) } as never); // duplicate of a replayed event
    const stored = seed.events(s.id, [text("3"), text("4")]);
    await pubsub.publish({ type: "event", event: stored[3] } as never); // seq 4 arrives before 3
    await sse.waitFor(() => sse.got.length >= 4);
    await pubsub.publish({ type: "event", event: stored[2] } as never); // late seq 3
    await new Promise((r) => setTimeout(r, 30));
    expect(seqs(sse.got)).toEqual([1, 2, 3, 4]);
    await sse.cancel();
  });

  it("forwards non-event deltas (message previews) as their own SSE event type", async () => {
    const s = seed.session(OWNER);
    const sse = readSse(await app.request(`/v1/sessions/${s.id}/events/stream`));
    await new Promise((r) => setTimeout(r, 20));
    await pubsub.publish({ type: "agent.message_delta", session_id: s.id, stream_id: "st", text: "he" } as never);
    await sse.waitFor(() => sse.got.length >= 1);
    expect(sse.got[0]).toMatchObject({ event: "agent.message_delta", data: { text: "he" } });
    await sse.cancel();
  });

  it("session.status_terminated closes the stream", async () => {
    const s = seed.session(OWNER);
    const sse = readSse(await app.request(`/v1/sessions/${s.id}/events/stream`));
    await new Promise((r) => setTimeout(r, 20));
    const [ev] = seed.events(s.id, [{ type: "session.status_terminated", reason: "archived" }]);
    await pubsub.publish({ type: "event", event: ev } as never);
    await sse.waitFor(() => sse.ended);
    expect(sse.got.map((g) => g.event)).toEqual(["session.status_terminated"]);
    expect(subs.active).toBe(0);
  });

  it("a terminated event found during replay closes the stream", async () => {
    const s = seed.session(OWNER, { status: "terminated" });
    seed.events(s.id, [text("a"), { type: "session.status_terminated" }]);
    const sse = readSse(await app.request(`/v1/sessions/${s.id}/events/stream`));
    await sse.waitFor(() => sse.ended);
    expect(seqs(sse.got)).toEqual([1, 2]);
  });

  it("client disconnect after subscribe releases the subscription", async () => {
    const s = seed.session(OWNER);
    const sse = readSse(await app.request(`/v1/sessions/${s.id}/events/stream`));
    await sse.waitFor(() => subs.active === 1);
    await sse.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(subs.active).toBe(0);
  });

  it("foreign-owner session -> 404 before streaming", async () => {
    const other = seed.session("prc_other");
    expect((await app.request(`/v1/sessions/${other.id}/events/stream`)).status).toBe(404);
  });

  // Regression: abort before subscribe() resolves calls the placeholder unsub; the real one is never called.
  it("client abort before subscribe() resolves leaves zero subscriptions", async () => {
    const s = seed.session(OWNER);
    let release!: () => void;
    subs.gate = new Promise<void>((r) => { release = r; });
    const res = await app.request(`/v1/sessions/${s.id}/events/stream`);
    await new Promise((r) => setTimeout(r, 10));
    await res.body!.cancel();
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(subs.active).toBe(0);
  });

  // Regression: termination is only detected by seeing the terminated event, so since >= its seq heartbeats forever.
  it("connecting with since >= the terminated seq on a terminated session ends the stream", async () => {
    const s = seed.session(OWNER, { status: "terminated" });
    seed.events(s.id, [text("a"), { type: "session.status_terminated" }]);
    const sse = readSse(await app.request(`/v1/sessions/${s.id}/events/stream?since=2`));
    try { await sse.waitFor(() => sse.ended, 500); } finally { await sse.cancel(); }
    expect(sse.ended).toBe(true);
  });

  it("listEvents fake mirrors Postgres on NaN since (sanity for the 400 tests above)", async () => {
    await expect(fakeEvents.listEvents("sess_x", { since: NaN })).rejects.toThrow(/bigint/);
  });
});
