import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { foldEvents as foldAny, type Attachment, type FoldFiles, type Folded } from "../src/harness/fold.ts";
import type { SessionEvent, SessionEventPayload } from "../src/shared/types.ts";
import { call, text } from "./fixtures/harness-fakes/deps.ts";

// fold.ts lists the optional-files overload first, so a one-argument call is typed as a Promise; pin the sync signature
const foldEvents = foldAny as unknown as { (events: SessionEvent[]): Folded; (events: SessionEvent[], files: FoldFiles): Promise<Folded & { attachments: Attachment[] }> };
const log = (...items: [number, SessionEventPayload, string?][]): SessionEvent[] =>
  items.map(([seq, payload, at]) => ({ id: `evt_${seq}`, session_id: "s", seq, type: payload.type, payload, created_at: at ?? "2026-01-01T00:00:00.000Z" }));
const user = (t: string): SessionEventPayload => ({ type: "user.message", content: [{ type: "text", text: t }] });
const agent = (pi: AgentMessage): SessionEventPayload => ({ type: "agent.message", content: [], pi });
const result = (id: string, t: string): SessionEventPayload => {
  const pi: ToolResultMessage = { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: t }], isError: false, timestamp: 2 };
  return { type: "agent.tool_result", tool_use_id: id, content: [{ type: "text", text: t }], is_error: false, pi };
};

/** Every toolResult directly follows its assistant (or a sibling result) and answers exactly one pending call. */
function assertLlmValid(messages: AgentMessage[]) {
  let pending = new Set<string>();
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role === "toolResult") {
      expect(pending.has(m.toolCallId), `orphan toolResult ${m.toolCallId}`).toBe(true);
      expect(answered.has(m.toolCallId), `duplicate toolResult ${m.toolCallId}`).toBe(false);
      pending.delete(m.toolCallId);
      answered.add(m.toolCallId);
      continue;
    }
    expect([...pending], "tool calls left unanswered before the next message").toEqual([]);
    pending = new Set(m.role === "assistant" ? m.content.flatMap((c) => (c.type === "toolCall" ? [c.id] : [])) : []);
  }
}

describe("foldEvents: steering during a tool call", () => {
  it("a steer persisted between a tool call and its result yields an LLM-valid transcript (regression: synthetic + orphan result)", () => {
    const events = log(
      [8, user("run the tests")],
      [9, agent(call("c1", "bash", { command: "npm test" }))],
      [10, user("also check lint")], // steered while bash ran
      [11, result("c1", "3 passed")],
      [12, agent(text("done"))],
    );
    const { messages } = foldEvents(events);
    assertLlmValid(messages);
    const results = messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(false);
  });

  it("the plain interrupted case is still repaired with one synthetic result that shares its assistant's seq", () => {
    const a = call("c1", "bash", { command: "sleep 99" });
    const { messages, seqOf } = foldEvents(log([1, user("go")], [2, agent(a)], [3, user("stop that")]));
    assertLlmValid(messages);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "user"]);
    expect(seqOf.get(messages[2]!)).toBe(2);
  });
});

describe("foldEvents with files", () => {
  const png = { name: "cat.png", mime: "image/png", data: new Uint8Array([137, 80, 78, 71]) };
  const pdf = { name: "spec.pdf", mime: "application/pdf", data: new Uint8Array([1, 2, 3, 4, 5]) };

  it("inlines images, references documents by attachment path and marks missing files", async () => {
    const files: Record<string, typeof png | null> = { file_png: png, file_pdf: pdf, file_gone: null };
    const get = vi.fn(async (id: string) => files[id] ?? null);
    const events = log(
      [1, { type: "user.message", content: [
        { type: "text", text: "see" },
        { type: "image", source: { type: "file", file_id: "file_png" } },
        { type: "image", source: { type: "file", file_id: "file_pdf" } },
        { type: "document", source: { type: "file", file_id: "file_gone" } },
      ] }],
      [2, { type: "user.message", content: [{ type: "image", source: { type: "file", file_id: "file_png" } }] }],
    );
    const { messages, attachments } = await foldEvents(events, { get });
    expect((messages[0] as any).content).toEqual([
      { type: "text", text: "see" },
      { type: "image", data: Buffer.from(png.data).toString("base64"), mimeType: "image/png" },
      { type: "text", text: "[attached file: .attachments/file_pdf-spec.pdf (application/pdf, 5 bytes)]" },
      { type: "text", text: "[attachment file_gone unavailable]" },
    ]);
    expect(attachments).toEqual([{ file_id: "file_pdf", path: ".attachments/file_pdf-spec.pdf" }]);
    // each referenced file is fetched once even when referenced twice
    expect(get.mock.calls.map((c) => c[0]).sort()).toEqual(["file_gone", "file_pdf", "file_png"]);
  });

  it("the sync overload marks every file block unavailable", () => {
    const { messages } = foldEvents(log([1, { type: "user.message", content: [{ type: "image", source: { type: "file", file_id: "f1" } }] }]));
    expect((messages[0] as any).content).toEqual([{ type: "text", text: "[attachment f1 unavailable]" }]);
  });
});

describe("foldEvents compaction edge cases", () => {
  const compacted = (summary: string, first: number): SessionEventPayload => ({ type: "agent.thread_context_compacted", summary, first_kept_seq: first, tokens_before: 10, tokens_after: 5 });

  it("only the latest compaction applies, its summary timestamp comes from created_at, and lastSeq covers everything", () => {
    const events = log(
      [1, user("q1")], [2, agent(text("a1"))],
      [3, compacted("FIRST", 2)],
      [4, user("q2")], [5, agent(text("a2"))],
      [6, compacted("SECOND", 4), "2026-03-04T05:06:07.000Z"],
      [7, user("q3")],
      [8, { type: "session.status_idle", stop_reason: "end_turn" }],
    );
    const { messages, summary, lastSeq, seqOf } = foldEvents(events);
    expect(summary).toBe("SECOND");
    expect(lastSeq).toBe(8);
    const texts = messages.map((m: any) => m.content[0].text);
    expect(texts[0]).toBe("[Context summary of the earlier conversation]\n\nSECOND");
    expect(texts.slice(1)).toEqual(["q2", "a2", "q3"]);
    expect(messages[0]!.timestamp).toBe(Date.parse("2026-03-04T05:06:07.000Z"));
    expect(seqOf.get(messages[0]!)).toBe(6);
  });

  it("a compaction whose first kept seq is a steer between a call and its result keeps no orphan tool result", () => {
    const events = log(
      [1, user("q")], [2, agent(call("c1", "bash", { command: "x" }))], [3, user("steer")], [4, result("c1", "ok")], [5, agent(text("done"))],
      [6, compacted("S", 3)],
      [7, user("next")],
    );
    assertLlmValid(foldEvents(events).messages);
  });
});
