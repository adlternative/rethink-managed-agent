import { describe, it, expect, vi, beforeEach } from "vitest";
import { latestOfTypesIn } from "./fixtures/event-queries/index.ts";

// Runner child orchestration (src/runner/children.ts) over in-memory repos and event queries: wait/list must
// probe the newest events and the parent's children directly, never the whole log or the whole sessions table.
process.env.MESSAGING_BACKEND = "memory";

const st = vi.hoisted(() => ({ sessions: new Map<string, any>(), events: new Map<string, any[]>(), calls: [] as string[] }));

vi.mock("../src/infra/db.ts", async (orig) => ({
  ...(await orig<typeof import("../src/infra/db.ts")>()),
  repos: {
    sessions: {
      get: async (id: string) => st.sessions.get(id) ?? null,
      list: async () => { st.calls.push("sessions.list"); return [...st.sessions.values()]; },
      childrenOf: async (parent: string) => { st.calls.push(`childrenOf ${parent}`); return [...st.sessions.values()].filter((s) => s.parent_id === parent); },
    },
  },
}));
vi.mock("../src/infra/events.ts", async (orig) => ({
  ...(await orig<typeof import("../src/infra/events.ts")>()),
  listAllEvents: async () => { st.calls.push("listAllEvents"); throw new Error("whole-log read"); },
  latestOfTypes: async (sid: string, types: string[]) => { st.calls.push(`latestOfTypes ${types}`); return latestOfTypesIn(st.events.get(sid) ?? [], types); },
  latestMatching: async (sid: string, type: string, match: Record<string, unknown>) => {
    st.calls.push(`latestMatching ${type}`);
    return [...(st.events.get(sid) ?? [])].reverse().find((e) => e.type === type && Object.entries(match).every(([k, v]) => e.payload[k] === v)) ?? null;
  },
}));

const { children } = await import("../src/runner/children.ts");
const log = (sid: string, ...payloads: any[]) => st.events.set(sid, payloads.map((p, i) => ({ seq: i + 1, type: p.type, payload: p })));

beforeEach(() => { st.sessions.clear(); st.events.clear(); st.calls.length = 0; });

describe("runner children", () => {
  it("wait returns an idle child settled after its newest message without reading its log", async () => {
    st.sessions.set("c1", { id: "c1", status: "idle" });
    log("c1", { type: "user.message" }, { type: "session.status_running" }, { type: "agent.message" }, { type: "session.status_idle", stop_reason: "end_turn", consumed_seq: 1 });
    expect((await children.wait("c1", new AbortController().signal)).id).toBe("c1");
    expect(st.calls).toEqual(["latestOfTypes user.message,session.status_idle"]);
  });

  it("untilQuestion returns once the newest question has no later user message", async () => {
    st.sessions.set("c2", { id: "c2", status: "running" });
    log("c2", { type: "user.message" }, { type: "session.status_running" }, { type: "agent.thread_message_sent", kind: "update" }, { type: "agent.thread_message_sent", kind: "question" });
    expect((await children.wait("c2", new AbortController().signal, { untilQuestion: true })).id).toBe("c2");
    expect(st.calls).not.toContain("listAllEvents");
  });

  it("a question already answered by a later user message keeps waiting (until the timeout)", async () => {
    st.sessions.set("c3", { id: "c3", status: "running" });
    log("c3", { type: "agent.thread_message_sent", kind: "question" }, { type: "user.message" });
    await expect(children.wait("c3", new AbortController().signal, { untilQuestion: true, timeoutMs: 1 })).rejects.toThrow(/timed out/);
  }, 5000);

  it("list asks for the parent's children instead of filtering every session", async () => {
    st.sessions.set("p", { id: "p", parent_id: null });
    st.sessions.set("k1", { id: "k1", parent_id: "p" });
    st.sessions.set("x", { id: "x", parent_id: "other" });
    expect((await children.list("p")).map((s) => s.id)).toEqual(["k1"]);
    expect(st.calls).toEqual(["childrenOf p"]);
  });
});
