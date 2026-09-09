import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ContentBlock, SessionEvent } from "../shared/types.ts";

/**
 * Fold the append-only event log into a pi transcript.
 * Assistant messages whose tool calls never got a result (interrupted run) are repaired
 * with synthetic error tool results so the sequence stays LLM-valid and the run can resume.
 */
export function foldEvents(events: SessionEvent[]): { messages: AgentMessage[]; lastSeq: number } {
  const messages: AgentMessage[] = [];
  let lastSeq = 0;
  for (const ev of events) {
    lastSeq = Math.max(lastSeq, ev.seq);
    const p = ev.payload;
    if (p.type === "user.message") {
      messages.push({ role: "user", content: p.content.map((b) => ({ type: "text", text: b.text })), timestamp: Date.parse(ev.created_at) || Date.now() });
    } else if (p.type === "agent.message" || p.type === "agent.tool_result") {
      messages.push(p.pi);
    }
  }
  return { messages: repairDanglingToolCalls(messages.filter(hasContent)), lastSeq };
}

/** Providers reject assistant messages with no content (e.g. aborted before the first token). */
function hasContent(m: AgentMessage): boolean {
  return m.role !== "assistant" || m.content.length > 0;
}

function repairDanglingToolCalls(messages: AgentMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    out.push(m);
    if (m.role !== "assistant") continue;
    const answered = new Set<string>();
    while (i + 1 < messages.length && messages[i + 1].role === "toolResult") {
      const r = messages[++i] as ToolResultMessage;
      answered.add(r.toolCallId);
      out.push(r);
    }
    for (const c of m.content) {
      if (c.type !== "toolCall" || answered.has(c.id)) continue;
      out.push({
        role: "toolResult",
        toolCallId: c.id,
        toolName: c.name,
        content: [{ type: "text", text: "Tool call was interrupted before completing; no result available." }],
        isError: true,
        timestamp: m.timestamp,
      } satisfies ToolResultMessage);
    }
  }
  return out;
}

export function toContentBlocks(msg: AssistantMessage): ContentBlock[] {
  return msg.content.flatMap((c) => (c.type === "text" ? [{ type: "text" as const, text: c.text }] : []));
}
