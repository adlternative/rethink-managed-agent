import { describe, it, expect, vi, beforeEach } from "vitest";

// Postgres event bus against a fake pg (hermetic): pool.query captures pg_notify and serves event rows;
// pool.connect yields a LISTEN client whose "notification" handler we drive directly.
process.env.MESSAGING_BACKEND = "postgres";

const notifies: { channel: string; payload: string }[] = [];
let connectFailures = 0;
let eventQuery: (sid: string, seq: number) => Promise<unknown[]> = async (sid, seq) => [{ id: `e${seq}`, session_id: sid, seq: String(seq), type: "user.interrupt", payload: {}, created_at: new Date(seq * 1000) }];
let notifyHandler: ((n: { channel: string; payload: string }) => void) | null = null;
let connects = 0;

vi.mock("pg", () => {
  class Pool {
    query = async (sql: string, params: unknown[] = []) => {
      if (sql.includes("pg_notify")) {
        const payload = params[1] as string;
        if (Buffer.byteLength(payload, "utf8") >= 8000) throw new Error("payload string too long");
        notifies.push({ channel: params[0] as string, payload }); return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM events")) { const rows = await eventQuery(params[0] as string, params[1] as number); return { rows, rowCount: rows.length }; }
      return { rows: [], rowCount: 0 };
    };
    connect = async () => {
      connects++;
      if (connectFailures > 0) { connectFailures--; throw new Error("ECONNREFUSED"); }
      const client = {
        on: (ev: string, h: (n: { channel: string; payload: string }) => void) => { if (ev === "notification") notifyHandler = h; return client; },
        query: async () => ({ rows: [], rowCount: 0 }),
        release: () => {},
      };
      return client;
    };
  }
  return { default: { Pool }, Pool };
});

const bus = await import("../src/infra/pubsub.ts");
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const deliver = (channel: string, payload: unknown) => notifyHandler!({ channel, payload: JSON.stringify(payload) });
const delta = (sid: string, text: string) => ({ type: "agent.message_delta" as const, session_id: sid, stream_id: "x", text });

beforeEach(() => { notifies.length = 0; });

describe("pg bus publish", () => {
  it("an event delta sends only {sid, seq}", async () => {
    await bus.publish({ type: "event", event: { id: "e", session_id: "s1", seq: 4, type: "agent.message", payload: { big: "x".repeat(20000) }, created_at: "" } } as never);
    expect(notifies).toEqual([{ channel: "pma_bus", payload: JSON.stringify({ sid: "s1", seq: 4 }) }]);
  });

  it("a small delta rides inline; an oversized ASCII delta is dropped", async () => {
    await bus.publish(delta("s1", "hi"));
    expect(JSON.parse(notifies[0]!.payload)).toEqual({ sid: "s1", d: delta("s1", "hi") });
    await bus.publish(delta("s1", "a".repeat(8000)));
    expect(notifies).toHaveLength(1);
  });

  // Regression: the size guard counts UTF-16 units, but NOTIFY's limit is 8000 bytes; a multi-byte delta under
  // 7500 chars is sent and pg rejects it, so publish() throws instead of dropping the preview.
  it("a multi-byte delta over the byte limit is dropped, not rejected", async () => {
    await expect(bus.publish(delta("s1", "中".repeat(3000)))).resolves.toBeUndefined();
  });
});

describe("pg bus subscribe", () => {
  it("filters by sid, embeds small deltas, and reads event rows back by seq", async () => {
    const got: unknown[] = [];
    const unsub = await bus.subscribe("s1", (d) => got.push(d.type === "event" ? ["event", d.event.seq, d.event.created_at] : ["delta", (d as { text: string }).text]));
    deliver("pma_bus", { sid: "other", d: delta("other", "no") });
    deliver("pma_bus", { sid: "s1", d: delta("s1", "yes") });
    deliver("pma_bus", { sid: "s1", seq: 3 });
    await tick();
    expect(got).toEqual([["delta", "yes"], ["event", 3, new Date(3000).toISOString()]]);
    unsub();
    deliver("pma_bus", { sid: "s1", d: delta("s1", "after") });
    expect(got).toHaveLength(2);
  });

  it("interrupts and provider changes are routed on pma_ctl", async () => {
    const i = vi.fn(), p = vi.fn();
    const ui = await bus.onInterrupt("s1", i); const up = await bus.onProvidersChanged(p);
    deliver("pma_ctl", { k: "int", sid: "s2" });
    deliver("pma_ctl", { k: "int", sid: "s1" });
    deliver("pma_ctl", { k: "prov" });
    expect(i).toHaveBeenCalledTimes(1);
    expect(p).toHaveBeenCalledTimes(1);
    await bus.publishInterrupt("s9");
    expect(JSON.parse(notifies.at(-1)!.payload)).toEqual({ k: "int", sid: "s9" });
    ui(); up();
  });

  it("a malformed notification payload is ignored", async () => {
    const cb = vi.fn();
    const u = await bus.subscribe("s1", cb);
    expect(() => notifyHandler!({ channel: "pma_bus", payload: "{not json" })).not.toThrow();
    expect(cb).not.toHaveBeenCalled();
    u();
  });

  it("opens a single LISTEN connection for many subscriptions", async () => {
    const before = connects;
    const us = await Promise.all([bus.subscribe("a", () => {}), bus.subscribe("b", () => {}), bus.onInterrupt("c", () => {})]);
    expect(connects).toBe(before);
    us.forEach((u) => u());
  });

  // Regression: each event notification triggers an independent SELECT and cb fires on resolution, so seq 5
  // can be delivered before seq 4 when the queries resolve out of order.
  it("event deltas are delivered in seq order even when their reads resolve out of order", async () => {
    const got: number[] = [];
    const prev = eventQuery;
    eventQuery = async (sid, seq) => { await tick(seq === 4 ? 30 : 1); return prev(sid, seq); };
    const u = await bus.subscribe("ord", (d) => { if (d.type === "event") got.push(d.event.seq); });
    deliver("pma_bus", { sid: "ord", seq: 4 });
    deliver("pma_bus", { sid: "ord", seq: 5 });
    await tick(60);
    eventQuery = prev; u();
    expect(got).toEqual([4, 5]);
  });

  it("subscribers of one session share a single row read per event notification, each still in seq order", async () => {
    const reads: number[] = [];
    const prev = eventQuery;
    eventQuery = async (sid, seq) => { reads.push(seq); await tick(seq === 7 ? 30 : 1); return prev(sid, seq); };
    const got: [number, number][] = [];
    const offs = await Promise.all([0, 1, 2].map((i) => bus.subscribe("fan", (d) => { if (d.type === "event") got.push([i, d.event.seq]); })));
    deliver("pma_bus", { sid: "fan", seq: 7 });
    deliver("pma_bus", { sid: "fan", seq: 8 });
    await tick(60);
    eventQuery = prev; offs.forEach((u) => u());
    expect(reads.sort()).toEqual([7, 8]);
    for (const i of [0, 1, 2]) expect(got.filter(([s]) => s === i).map(([, seq]) => seq)).toEqual([7, 8]);
    deliver("pma_bus", { sid: "fan", seq: 7 }); // settled reads are not cached: a later notification reads again
    await tick(40);
    expect(reads).toHaveLength(2); // no subscribers left, so nothing read
  });
});
