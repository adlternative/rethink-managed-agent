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

/** Uploaded-file access for folding (images inline to the model; documents referenced by path). */
export interface FoldFiles {
  get(id: string): Promise<{ name: string; mime: string; data: Uint8Array } | null>;
}
/** Documents referenced by the transcript that must exist in the workspace under .attachments/. */
export interface Attachment { file_id: string; path: string }

export function foldEvents(events: SessionEvent[], files?: FoldFiles): Promise<Folded & { attachments: Attachment[] }>;
export function foldEvents(events: SessionEvent[]): Folded;
export function foldEvents(events: SessionEvent[], files?: FoldFiles): Folded | Promise<Folded & { attachments: Attachment[] }> {
  if (files) return foldEventsAsync(events, files);
  return foldSync(events, undefined, []);
}

async function foldEventsAsync(events: SessionEvent[], files: FoldFiles): Promise<Folded & { attachments: Attachment[] }> {
  // Resolve every referenced file once, up front; then fold synchronously.
  const ids = new Set<string>();
  for (const ev of events) if (ev.payload.type === "user.message") for (const b of ev.payload.content) if (b.type !== "text") ids.add(b.file_id);
  const resolved = new Map<string, { name: string; mime: string; data: Uint8Array } | null>();
  for (const id of ids) resolved.set(id, await files.get(id));
  const attachments: Attachment[] = [];
  const folded = foldSync(events, resolved, attachments);
  return { ...folded, attachments };
}

function foldSync(events: SessionEvent[], resolved: Map<string, { name: string; mime: string; data: Uint8Array } | null> | undefined, attachments: Attachment[]): Folded {
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
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
      for (const b of p.content) {
        if (b.type === "text") { content.push({ type: "text", text: b.text }); continue; }
        const f = resolved?.get(b.file_id);
        if (!f) { content.push({ type: "text", text: `[attachment ${b.file_id} unavailable]` }); continue; }
        if (b.type === "image" && f.mime.startsWith("image/")) {
          content.push({ type: "image", data: Buffer.from(f.data).toString("base64"), mimeType: f.mime });
        } else {
          // documents live in the workspace; the model reads them with its tools
          const path = `.attachments/${b.file_id}-${f.name}`;
          attachments.push({ file_id: b.file_id, path });
          content.push({ type: "text", text: `[attached file: ${path} (${f.mime}, ${f.data.length} bytes)]` });
        }
      }
      m = { role: "user", content, timestamp: Date.parse(ev.created_at) || Date.now() };
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
