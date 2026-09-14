import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { compactMessages, contextTokens, findCut, needsCompaction, settingsFromEnv, summaryMessage } from "../src/harness/compaction.ts";
import { env } from "../src/shared/env.ts";
import { assistantMsg, fakeModels, model, text } from "./fixtures/harness-fakes/deps.ts";

const big = "x".repeat(4000); // ~1000 tokens
const u = (t: string): AgentMessage => ({ role: "user", content: [{ type: "text", text: t }], timestamp: 1 });
const withUsage = (t: string, n: number, extra: object = {}) => { const m = text(t, extra); m.usage = { ...m.usage, input: n, totalTokens: n }; return m; };
const settings = { enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 };
const summarizer = (reply = "NEW SUMMARY") => {
  const { models, requests } = fakeModels([text(reply)]);
  return { streamFn: models.streamSimple.bind(models) as never, requests, prompt: () => (requests[0]!.context.messages[0] as { content: { text: string }[] }).content[0]!.text };
};

describe("contextTokens with missing or invalid usage", () => {
  it("zero usage (provider omitted it) does not hide the size of the history", () => {
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < 50; i++) msgs.push(u(big), text(big)); // text() carries all-zero usage, as pi-ai emits
    msgs.push(u("next"));
    const estimate = msgs.reduce((n, m) => n + Math.ceil(((m as { content: { text: string }[] }).content[0]!.text.length) / 4), 0);
    expect(contextTokens(msgs)).toBeGreaterThanOrEqual(estimate * 0.9);
    expect(needsCompaction(msgs, model(20_000), settings)).toBe(true);
  });

  it("an aborted/errored assistant with zero usage after a valid one does not reset the base", () => {
    const msgs: AgentMessage[] = [u("q"), withUsage("a", 150_000), u("q2"), assistantMsg([{ type: "text", text: "partial" }], { stopReason: "aborted" })];
    expect(contextTokens(msgs)).toBeGreaterThanOrEqual(150_000);
    const errored: AgentMessage[] = [u("q"), withUsage("a", 150_000), u("q2"), assistantMsg([{ type: "text", text: "x" }], { stopReason: "error" })];
    expect(contextTokens(errored)).toBeGreaterThanOrEqual(150_000);
  });

  it("assistant messages without a usage field fall back to estimates of everything", () => {
    const a = text(big); delete (a as { usage?: unknown }).usage;
    expect(contextTokens([u(big), a, u(big)])).toBe(3000);
  });

  it("compaction disabled never triggers", () => {
    expect(needsCompaction([withUsage("a", 1_000_000)], model(1000), { ...settings, enabled: false })).toBe(false);
  });

  it("settingsFromEnv reads the env at call time", () => {
    const saved = { ...env };
    try {
      env.COMPACTION_RESERVE_TOKENS = 7; env.COMPACTION_KEEP_RECENT_TOKENS = 8; env.COMPACTION_ENABLED = false;
      expect(settingsFromEnv()).toEqual({ enabled: false, reserveTokens: 7, keepRecentTokens: 8 });
    } finally { Object.assign(env, saved); }
  });
});

describe("compactMessages chaining", () => {
  const history = () => [summaryMessage("OLD SUMMARY"), u(big), text(big), u(big), text(big), u(big), text(big)];

  it("chains a leading summary message as previousSummary and does not re-summarize it", async () => {
    const s = summarizer();
    const r = await compactMessages({ messages: history(), model: model(20_000), streamFn: s.streamFn, settings });
    expect(r!.summary).toBe("NEW SUMMARY");
    const prompt = s.prompt();
    expect(prompt).toContain("<previous-summary>\nOLD SUMMARY\n</previous-summary>");
    // the old summary text appears only as previous summary, not inside the serialized conversation
    const convo = prompt.slice(0, prompt.indexOf("</conversation>"));
    expect(convo).not.toContain("OLD SUMMARY");
    expect(convo).not.toContain("[Context summary");
    expect((r!.messages[0] as { content: { text: string }[] }).content[0]!.text).toBe("[Context summary of the earlier conversation]\n\nNEW SUMMARY");
  });

  it("an explicit previousSummary wins over the leading summary message; instructions reach the summarizer", async () => {
    const s = summarizer();
    await compactMessages({ messages: history(), model: model(20_000), streamFn: s.streamFn, settings, previousSummary: "EXPLICIT", instructions: "focus on file paths" });
    const prompt = s.prompt();
    expect(prompt).toContain("<previous-summary>\nEXPLICIT\n</previous-summary>");
    expect(prompt).not.toContain("OLD SUMMARY");
    expect(prompt).toContain("Additional focus: focus on file paths");
  });

  it("returns null without calling the summarizer when there is no cut", async () => {
    const streamFn = vi.fn();
    expect(await compactMessages({ messages: [u("a"), text("b")], model: model(), streamFn: streamFn as never, settings })).toBeNull();
    expect(streamFn).not.toHaveBeenCalled();
  });

  it("propagates summarizer failures", async () => {
    const { models } = fakeModels([assistantMsg([], { stopReason: "error", errorMessage: "overloaded" })]);
    await expect(compactMessages({ messages: history(), model: model(20_000), streamFn: models.streamSimple.bind(models) as never, settings })).rejects.toThrow(/overloaded/);
  });

  it("tokensAfter does not count stale pre-compaction usage kept in the tail", async () => {
    const msgs: AgentMessage[] = [u(big), text(big), u(big), text(big), u("q"), withUsage("latest", 50_000)];
    const r = await compactMessages({ messages: msgs, model: model(60_000), streamFn: vi.fn() as never, settings: { ...settings, keepRecentTokens: 10 }, summaryOverride: "S" });
    expect(r!.tokensAfter).toBeLessThan(r!.tokensBefore);
  });

  it("findCut never keeps a leading tool result", () => {
    const tr = { role: "toolResult", toolCallId: "1", toolName: "bash", content: [{ type: "text", text: big }], isError: false, timestamp: 1 } as AgentMessage;
    const msgs = [u(big), text(big), tr, tr, u("tail")];
    const cut = findCut(msgs, 1500);
    expect(msgs[cut]!.role).not.toBe("toolResult");
  });
});
