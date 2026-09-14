import { describe, it, expect, vi, beforeEach } from "vitest";

// Redis event bus against an in-memory ioredis stand-in (hermetic): PUBLISH on any connection is routed to
// every connection SUBSCRIBEd to the channel; SUBSCRIBE can be held open to test in-flight ordering.
const st = vi.hoisted(() => ({
  conns: [] as any[],
  commands: [] as string[],
  holdSubscribe: null as null | { release: () => void; fail?: Error },
}));

vi.mock("ioredis", () => {
  class Redis {
    channels = new Set<string>();
    listeners = new Map<string, ((...a: any[]) => void)[]>();
    constructor(..._a: unknown[]) { st.conns.push(this); }
    on(ev: string, h: (...a: any[]) => void) { (this.listeners.get(ev) ?? this.listeners.set(ev, []).get(ev)!).push(h); return this; }
    async subscribe(ch: string) {
      st.commands.push(`subscribe ${ch}`);
      if (st.holdSubscribe) { const hold = st.holdSubscribe; await new Promise<void>((r) => { hold.release = r; }); if (hold.fail) throw hold.fail; }
      this.channels.add(ch); return this.channels.size;
    }
    async unsubscribe(ch: string) { st.commands.push(`unsubscribe ${ch}`); this.channels.delete(ch); return this.channels.size; }
    async publish(ch: string, msg: string) { let n = 0; for (const c of st.conns) if (c.channels.has(ch)) { n++; for (const h of c.listeners.get("message") ?? []) h(ch, msg); } return n; }
    disconnect() { st.commands.push("disconnect"); this.channels.clear(); }
    async quit() { return "OK"; }
  }
  return { Redis, default: Redis };
});

process.env.MESSAGING_BACKEND = "redis";
const bus = await import("../src/infra/pubsub.ts");
const delta = (sid: string, text: string) => ({ type: "agent.message_delta" as const, session_id: sid, stream_id: "x", text });
const subscriberConns = () => st.conns.filter((c) => c !== bus.redis);

beforeEach(() => { st.commands.length = 0; st.holdSubscribe = null; });

describe("redis bus subscriptions share one connection", () => {
  it("many subscribers across sessions use a single subscriber connection and get only their channel", async () => {
    const got: string[] = [];
    const offs = [];
    for (let i = 0; i < 50; i++) offs.push(await bus.subscribe(`s${i}`, (d) => got.push(`${i}:${(d as { text: string }).text}`)));
    expect(subscriberConns()).toHaveLength(1);
    await bus.publish(delta("s3", "hello"));
    await bus.publish(delta("s49", "bye"));
    expect(got).toEqual(["3:hello", "49:bye"]);
    for (const off of offs) off();
    expect(st.commands.filter((c) => c.startsWith("unsubscribe"))).toHaveLength(50);
    expect(st.commands).not.toContain("disconnect");
  });

  it("a channel stays subscribed until its last handler leaves; the same callback may subscribe twice", async () => {
    const got: string[] = [];
    const cb = (d: any) => got.push(d.text);
    const a = await bus.subscribe("shared", cb);
    const b = await bus.subscribe("shared", cb);
    expect(st.commands.filter((c) => c === "subscribe sess:shared")).toHaveLength(1);
    await bus.publish(delta("shared", "1"));
    expect(got).toEqual(["1", "1"]);
    a(); a(); // idempotent
    expect(st.commands).not.toContain("unsubscribe sess:shared");
    await bus.publish(delta("shared", "2"));
    expect(got).toEqual(["1", "1", "2"]);
    b();
    expect(st.commands).toContain("unsubscribe sess:shared");
    await bus.publish(delta("shared", "3"));
    expect(got).toEqual(["1", "1", "2"]);
    // resubscribing after the channel was dropped subscribes again
    const c = await bus.subscribe("shared", cb);
    await bus.publish(delta("shared", "4"));
    expect(got.at(-1)).toBe("4");
    c();
  });

  it("a second subscriber waits for the channel's in-flight SUBSCRIBE before resolving", async () => {
    st.holdSubscribe = { release: () => {} };
    let firstDone = false, secondDone = false;
    const hold = st.holdSubscribe;
    const p1 = bus.subscribe("slow", () => {}).then((u) => { firstDone = true; return u; });
    await new Promise((r) => setTimeout(r, 5));
    const p2 = bus.subscribe("slow", () => {}).then((u) => { secondDone = true; return u; });
    await new Promise((r) => setTimeout(r, 5));
    expect([firstDone, secondDone]).toEqual([false, false]);
    expect(st.commands.filter((c) => c === "subscribe sess:slow")).toHaveLength(1);
    st.holdSubscribe = null; hold.release();
    const [u1, u2] = await Promise.all([p1, p2]);
    expect([firstDone, secondDone]).toEqual([true, true]);
    u1(); u2();
  });

  it("a failed SUBSCRIBE rejects every waiter and leaves no handler behind", async () => {
    st.holdSubscribe = { release: () => {}, fail: new Error("NOPERM") };
    const hold = st.holdSubscribe;
    const got: string[] = [];
    const p = bus.subscribe("bad", (d: any) => got.push(d.text));
    await new Promise((r) => setTimeout(r, 5));
    st.holdSubscribe = null; hold.release();
    await expect(p).rejects.toThrow("NOPERM");
    const ok = await bus.subscribe("bad", (d: any) => got.push(`ok:${d.text}`));
    await bus.publish(delta("bad", "x"));
    expect(got).toEqual(["ok:x"]);
    ok();
  });

  it("interrupts and provider changes ride the same connection", async () => {
    const i = vi.fn(), p = vi.fn();
    const offI = await bus.onInterrupt("s1", i);
    const offP = await bus.onProvidersChanged(p);
    await bus.publishInterrupt("s1");
    await bus.publishInterrupt("s2");
    await bus.publishProvidersChanged();
    expect(i).toHaveBeenCalledTimes(1);
    expect(p).toHaveBeenCalledTimes(1);
    expect(subscriberConns()).toHaveLength(1);
    offI(); offP();
  });
});
