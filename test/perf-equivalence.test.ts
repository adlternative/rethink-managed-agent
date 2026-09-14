import { describe, it, expect } from "vitest";
import { foldEvents as foldAny, settledAfterLastMessage, type Attachment, type FoldFiles, type Folded } from "../src/harness/fold.ts";
import { toAgentSession, toItems, toTurns, ITEM_EVENT_TYPES, TURN_EVENT_TYPES } from "../src/api/routes/compat/openai-agents.ts";
import { toOpenAiSession, environmentActions, clientToolNames, STATE_EVENT_TYPES } from "../src/api/routes/compat/required-actions.ts";
import { runSession } from "../src/harness/run-turn.ts";
import type { SessionEvent, SessionEventPayload, SessionResource } from "../src/shared/types.ts";
import { stateFilter, latestOfTypesIn, foldSinceOf, windowOf } from "./fixtures/event-queries/index.ts";
import { randomLog } from "./fixtures/event-queries/random-log.ts";
import { fakeDeps, fakeHost, sessionFixture, text, userMsg } from "./fixtures/harness-fakes/deps.ts";

/**
 * The hot paths now read a bounded slice of the log (from the compaction cut, by event type, the newest
 * few) instead of the whole thing. These properties pin that each projection over the slice equals the
 * same projection over the whole log, on randomized logs.
 */
const foldEvents = foldAny as unknown as { (events: SessionEvent[]): Folded; (events: SessionEvent[], files: FoldFiles): Promise<Folded & { attachments: Attachment[] }> };

const session = (over: Partial<SessionResource> = {}): SessionResource => ({ ...sessionFixture({ id: "s", environment_id: "env", status: "idle" } as never, { client_tools: [{ type: "function", name: "client_fn", parameters: {} }] } as never), ...over } as SessionResource);
const SEEDS = Array.from({ length: 60 }, (_, i) => i * 7919 + 13);

describe("fold from the compaction cut", () => {
  it("folding events after foldSince equals folding the whole log (messages, lastSeq, summary, seqs, attachments)", async () => {
    const files: FoldFiles = { get: async (id) => (id === "file_3" ? null : { name: `${id}.bin`, mime: id === "file_0" ? "image/png" : "application/pdf", data: new Uint8Array([1, 2, 3]) }) };
    let compacted = 0;
    for (const seed of SEEDS) {
      const all = randomLog(seed);
      const since = foldSinceOf(all);
      if (since > 0) compacted++;
      const tail = all.filter((e) => e.seq > since);
      const a = await foldEvents(all, files), b = await foldEvents(tail, files);
      expect(b.messages, `seed ${seed}`).toEqual(a.messages);
      expect([b.lastSeq, b.summary], `seed ${seed}`).toEqual([a.lastSeq, a.summary]);
      expect(b.attachments, `seed ${seed}`).toEqual(a.attachments);
      expect(b.messages.map((m) => b.seqOf.get(m)), `seed ${seed}`).toEqual(a.messages.map((m) => a.seqOf.get(m)));
    }
    expect(compacted).toBeGreaterThan(10); // the property actually exercised cuts
  });

  it("a compaction whose first_kept_seq is missing or after itself never drops events the fold needs", () => {
    const all = randomLog(99, 120);
    const weird = [...all, { id: "x", session_id: "s", seq: 121, type: "agent.thread_context_compacted", payload: { type: "agent.thread_context_compacted", summary: "s", first_kept_seq: 500, tokens_before: 1, tokens_after: 1 }, created_at: all[0]!.created_at } as SessionEvent];
    expect(foldEvents(weird.filter((e) => e.seq > foldSinceOf(weird))).messages).toEqual(foldEvents(weird).messages);
    const missing = [...all, { ...weird.at(-1)!, payload: { type: "agent.thread_context_compacted", summary: "s" } as never }];
    expect(foldSinceOf(missing)).toBe(0);
  });

  it("runSession reads the log from foldSince and sends the same context as a whole-log read", async () => {
    const turns: SessionEventPayload[] = [];
    for (let i = 0; i < 6; i++) turns.push(userMsg(`q${i}`), { type: "agent.message", content: [{ type: "text", text: `a${i}` }], pi: text(`a${i}`) as never });
    const compaction: SessionEventPayload = { type: "agent.thread_context_compacted", summary: "earlier", first_kept_seq: 9, tokens_before: 10, tokens_after: 5 };
    const events = [...turns, compaction, userMsg("now")];
    const whole = fakeDeps({ events, replies: [text("ok")] });
    await runSession("sess_1", whole.deps);
    const cut = fakeDeps({ events, replies: [text("ok")] });
    const reads: unknown[] = [];
    cut.deps.foldSince = async (sid) => foldSinceOf(cut.logOf(sid));
    cut.deps.listEvents = async (sid, opts) => { reads.push(opts); return windowOf(cut.logOf(sid), opts); };
    await runSession("sess_1", cut.deps);
    expect(reads[0]).toEqual({ since: 8 });
    expect(cut.requests[0]!.context.messages).toEqual(whole.requests[0]!.context.messages);
    expect(cut.finishCalls).toEqual(whole.finishCalls);
  });
});

describe("compat projections over the type-filtered slice", () => {
  it("toAgentSession / toOpenAiSession / environmentActions match the whole log", () => {
    for (const seed of SEEDS) {
      const all = randomLog(seed);
      for (const s of [session(), session({ status: "running" }), session({ agent: { ...session().agent, client_tools: [] } })]) {
        const slice = stateFilter(all, STATE_EVENT_TYPES, clientToolNames(s));
        expect(toAgentSession(s, slice, "env"), `seed ${seed}`).toEqual(toAgentSession(s, all, "env"));
        expect(toOpenAiSession(s, slice, "env"), `seed ${seed}`).toEqual(toOpenAiSession(s, all, "env"));
        expect(environmentActions(slice)).toEqual(environmentActions(all));
      }
    }
  });

  it("toItems and toTurns match the whole log", () => {
    for (const seed of SEEDS) {
      const all = randomLog(seed);
      const s = session();
      expect(toItems(s, stateFilter(all, ITEM_EVENT_TYPES)), `seed ${seed}`).toEqual(toItems(s, all));
      expect(toTurns(s, stateFilter(all, TURN_EVENT_TYPES)), `seed ${seed}`).toEqual(toTurns(s, all));
    }
  });
});

describe("child wait probes over the newest events", () => {
  it("settledAfterLastMessage and the pending-question check match the whole log", () => {
    for (const seed of SEEDS) for (const cutAt of [20, 150, 399]) {
      const all = randomLog(seed).slice(0, cutAt);
      expect(settledAfterLastMessage(latestOfTypesIn(all, ["user.message", "session.status_idle"])), `seed ${seed}@${cutAt}`).toBe(settledAfterLastMessage(all));
      // runner children.wait untilQuestion: the newest question with no user.message after it
      const q = [...all].reverse().find((e) => e.type === "agent.thread_message_sent" && (e.payload as { kind?: string }).kind === "question");
      const whole = !!q && !all.some((e) => e.seq > q.seq && e.type === "user.message");
      const probe = !!q && !latestOfTypesIn(all, ["user.message"]).some((e) => e.seq > q.seq);
      expect(probe, `seed ${seed}@${cutAt}`).toBe(whole);
    }
  });
});

describe("plugin eventsGet pushdown", () => {
  it("returns the same slice whether the store honors {since, limit} or returns the whole log", async () => {
    const probeWith = async (honor: boolean, opts: { since?: number; limit?: number }) => {
      let got: unknown;
      const h = fakeHost({ hooks: { session_start: async (_e, caps) => { got = await caps.eventsGet(opts); } } });
      const events = Array.from({ length: 30 }, (_, i) => userMsg(`m${i}`));
      const f = fakeDeps({ events, replies: [text("ok")], host: h.host });
      if (honor) f.deps.listEvents = async (sid, o) => windowOf(f.logOf(sid), o);
      await runSession("sess_1", f.deps);
      return got as { seq: number }[];
    };
    for (const opts of [{}, { limit: 5 }, { since: 10 }, { since: 10, limit: 3 }, { since: 28, limit: 10 }, { limit: 0 }]) {
      const a = await probeWith(false, opts), b = await probeWith(true, opts);
      expect(b, JSON.stringify(opts)).toEqual(a);
    }
    const newest = await probeWith(true, { limit: 2 });
    expect(newest).toHaveLength(2);
    expect(newest[1]!.seq - newest[0]!.seq).toBe(1); // the two newest, in seq order
  });
});
