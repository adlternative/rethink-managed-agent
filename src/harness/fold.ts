import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ContentBlock, SessionEvent } from "../shared/types.ts";
import { summaryMessage } from "./compaction.ts";

/**
 * Fold the append-only event log into a pi transcript.
 * Assistant messages whose tool calls never got a result (interrupted run) are repaired
 * with synthetic error tool results so the sequence stays LLM-valid and the run can resume.
 */
export interface Folded {
  messages: AgentMessage[];
  lastSeq: number;
  /** seq of the event each message came from (synthetic repairs share their assistant's seq) */
  seqOf: WeakMap<AgentMessage, number>;
  /** latest compaction summary, for chaining the next one */
  summary?: string;
}

export function foldEvents(events: SessionEvent[]): Folded {
  // Latest compaction wins: everything older than its cut is represented by the summary.
  let compaction: { summary: string; firstKeptSeq: number; at: SessionEvent } | null = null;
  for (const ev of events) {
    if (ev.payload.type === "agent.thread_context_compacted") compaction = { summary: ev.payload.summary, firstKeptSeq: ev.payload.first_kept_seq, at: ev };
  }
  const seqOf = new WeakMap<AgentMessage, number>();
  const messages: AgentMessage[] = [];
  let lastSeq = 0;
  if (compaction) {
    const m = summaryMessage(compaction.summary, Date.parse(compaction.at.created_at) || Date.now());
    seqOf.set(m, compaction.at.seq);
    messages.push(m);
  }
  for (const ev of events) {
    lastSeq = Math.max(lastSeq, ev.seq);
    if (compaction && ev.seq < compaction.firstKeptSeq) continue;
    const p = ev.payload;
    let m: AgentMessage | null = null;
    if (p.type === "user.message") {
      m = { role: "user", content: p.content.map((b) => ({ type: "text", text: b.text })), timestamp: Date.parse(ev.created_at) || Date.now() };
    } else if (p.type === "agent.message" || p.type === "agent.tool_result") {
      m = p.pi;
    }
    if (m) { seqOf.set(m, ev.seq); messages.push(m); }
  }
  const repaired = repairDanglingToolCalls(messages.filter(hasContent), seqOf);
  return { messages: repaired, lastSeq, seqOf, summary: compaction?.summary };
}

/** Providers reject assistant messages with no content (e.g. aborted before the first token). */
function hasContent(m: AgentMessage): boolean {
  return m.role !== "assistant" || m.content.length > 0;
}

function repairDanglingToolCalls(messages: AgentMessage[], seqOf: WeakMap<AgentMessage, number>): AgentMessage[] {
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
      const synthetic: ToolResultMessage = {
        role: "toolResult",
        toolCallId: c.id,
        toolName: c.name,
        content: [{ type: "text", text: "Tool call was interrupted before completing; no result available." }],
        isError: true,
        timestamp: m.timestamp,
      };
      const seq = seqOf.get(m);
      if (seq !== undefined) seqOf.set(synthetic, seq);
      out.push(synthetic);
    }
  }
  return out;
}

export function toContentBlocks(msg: AssistantMessage): ContentBlock[] {
  return msg.content.flatMap((c) => (c.type === "text" ? [{ type: "text" as const, text: c.text }] : []));
}
