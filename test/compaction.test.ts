import { describe, it, expect, vi } from "vitest";
import { findCut, contextTokens, needsCompaction, compactMessages } from "../src/harness/compaction.ts";

const u = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 });
const a = (text: string, usage?: any) => ({ role: "assistant" as const, content: [{ type: "text" as const, text }], timestamp: 1, stopReason: "stop" as const, ...(usage ? { usage } : {}) }) as any;
const big = "x".repeat(4000); // ~1000 tokens
const tr2 = () => ({ role: "toolResult" as const, toolCallId: "x", toolName: "bash", content: [{ type: "text" as const, text: big }], isError: false, timestamp: 1 });

describe("compaction cut point", () => {
  it("ignores usage recorded before the latest summary", async () => {
    const { summaryMessage } = await import("../src/harness/compaction.ts");
    const old = a("old", { input: 5000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 5010 });
    // `old` carries usage from the pre-compaction context: once a summary follows it, only estimates apply
    expect(contextTokens([old, summaryMessage("short summary"), u("next")])).toBeLessThan(200);
    // usage recorded after the summary is trusted again
    expect(contextTokens([summaryMessage("short summary"), old, u("next")])).toBeGreaterThan(5000);
  });
  it("keeps the recent turns and cuts on a user-message boundary", () => {
    const msgs = [u(big), a(big), u(big), a(big), u(big), a(big)];
    // keep ~2000 tokens: index 3 (an assistant step) is where the budget runs out, and it is a valid boundary
    expect(findCut(msgs, 2000)).toBe(3);
    // a tool-call step is a boundary too, but never between a call and its results
    const tr = (id: string) => ({ role: "toolResult" as const, toolCallId: id, toolName: "bash", content: [{ type: "text" as const, text: big }], isError: false, timestamp: 1 });
    const oneTurn = [u("go"), a(big), tr("1"), a(big), tr("2"), a(big), tr("3")];
    expect(findCut(oneTurn, 2500)).toBe(5);
  });
  it("refuses to cut when everything is recent or no boundary exists", () => {
    expect(findCut([u(big), a(big)], 100_000)).toBe(-1);
    expect(findCut([u(big), tr2(), tr2()], 10)).toBe(-1);
  });
  it("uses a plugin-supplied summary verbatim and skips the built-in summarizer (before_compact override)", async () => {
    const msgs = [u(big), a(big), u(big), a(big), u(big), a(big)];
    const streamFn = vi.fn(); // must NOT be called when a summary override is given
    const r = await compactMessages({
      messages: msgs, model: { contextWindow: 2000 } as any, streamFn: streamFn as any,
      settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 }, summaryOverride: "PLUGIN SUMMARY",
    });
    expect(streamFn).not.toHaveBeenCalled();
    expect(r?.summary).toBe("PLUGIN SUMMARY");
    expect(r?.firstKeptIndex).toBe(3); // the cut stays the harness's, keeping tool pairs intact
    expect(r?.messages[0]).toMatchObject({ role: "user" }); // the summary is prepended as a user message
  });

  it("uses the last reported usage plus an estimate of trailing messages", () => {
    const msgs = [u("hi"), a("there", { input: 500, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 520 }), u(big)];
    const t = contextTokens(msgs);
    expect(t).toBeGreaterThan(520);
    expect(t).toBeLessThan(520 + 2000);
    expect(needsCompaction(msgs, { contextWindow: 2000 } as any, { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 })).toBe(true);
    expect(needsCompaction(msgs, { contextWindow: 200_000 } as any, { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 })).toBe(false);
  });
});
