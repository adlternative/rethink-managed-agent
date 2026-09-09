import { describe, expect, it } from "vitest";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { foldEvents, toContentBlocks } from "../src/harness/fold.ts";
import type { SessionEvent, SessionEventPayload } from "../src/shared/types.ts";

let seq = 0;
function ev(payload: SessionEventPayload): SessionEvent {
  seq++;
  return { id: `evt_${seq}`, session_id: "sess_1", seq, type: payload.type, payload, created_at: "2026-01-01T00:00:00.000Z" };
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "qoder",
    model: "auto",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 1,
  };
}

function toolResult(id: string, text: string): ToolResultMessage {
  return { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: 2 };
}

describe("foldEvents", () => {
  it("folds user, agent and tool events and ignores the rest", () => {
    const a = assistant([{ type: "text", text: "hi" }]);
    const events = [
      ev({ type: "session.status_running" }),
      ev({ type: "user.message", content: [{ type: "text", text: "hello" }] }),
      ev({ type: "sandbox.acquired", sandbox_id: "sbx_1", provider: "local" }),
      ev({ type: "agent.message", content: [{ type: "text", text: "hi" }], pi: a }),
      ev({ type: "session.status_idle", stop_reason: "end_turn" }),
    ];
    const { messages, lastSeq } = foldEvents(events);
    expect(lastSeq).toBe(events[events.length - 1].seq);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "hello" }] });
    expect(messages[1]).toBe(a);
  });

  it("appends synthetic error results for tool calls that never completed", () => {
    const a = assistant([
      { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
      { type: "toolCall", id: "call_2", name: "bash", arguments: { command: "pwd" } },
    ]);
    const events = [
      ev({ type: "user.message", content: [{ type: "text", text: "go" }] }),
      ev({ type: "agent.message", content: [], pi: a }),
      ev({ type: "agent.tool_use", tool_use_id: "call_1", name: "bash", input: {} }),
      ev({ type: "agent.tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "ok" }], is_error: false, pi: toolResult("call_1", "ok") }),
      ev({ type: "user.interrupt" }),
      ev({ type: "session.status_idle", stop_reason: "interrupted" }),
      ev({ type: "user.message", content: [{ type: "text", text: "continue" }] }),
    ];
    const { messages } = foldEvents(events);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "toolResult", "user"]);
    const synthetic = messages[3] as ToolResultMessage;
    expect(synthetic.toolCallId).toBe("call_2");
    expect(synthetic.isError).toBe(true);
    expect(synthetic.content[0]).toMatchObject({ type: "text" });
  });

  it("drops assistant messages with no content", () => {
    const events = [
      ev({ type: "user.message", content: [{ type: "text", text: "go" }] }),
      ev({ type: "agent.message", content: [], pi: { ...assistant([]), stopReason: "aborted" } }),
    ];
    expect(foldEvents(events).messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("returns lastSeq 0 for an empty log", () => {
    expect(foldEvents([])).toEqual({ messages: [], lastSeq: 0 });
  });
});

describe("toContentBlocks", () => {
  it("keeps only text blocks", () => {
    const a = assistant([
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "a" },
      { type: "toolCall", id: "c", name: "bash", arguments: {} },
      { type: "text", text: "b" },
    ]);
    expect(toContentBlocks(a)).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);
  });
});
