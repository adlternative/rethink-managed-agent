/**
 * Context compaction over the event log. Reuses pi's summarizer and token heuristics; the cut
 * point is ours because our history is a flat event log, not pi's session tree.
 *
 * Result is persisted as `agent.thread_context_compacted { summary, first_kept_seq }`: fold()
 * drops message events older than first_kept_seq and prepends the summary as a user message,
 * so every later run (on any runner) sees the compacted context without recomputing it.
 */
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Model, UserMessage } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateTokens, generateSummary, shouldCompact } from "@earendil-works/pi-coding-agent";
import { env } from "../shared/env.ts";

export interface CompactionSettings { enabled: boolean; reserveTokens: number; keepRecentTokens: number }
export const settingsFromEnv = (): CompactionSettings => ({
  enabled: env.COMPACTION_ENABLED,
  reserveTokens: env.COMPACTION_RESERVE_TOKENS,
  keepRecentTokens: env.COMPACTION_KEEP_RECENT_TOKENS,
});

const SUMMARY_PREFIX = "[Context summary of the earlier conversation]";
const isSummary = (m: AgentMessage) => m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "text" && m.content[0].text.startsWith(SUMMARY_PREFIX);

/**
 * Tokens the next request will carry: the last reported usage plus an estimate of what came after
 * it. Usage recorded *before* the latest summary describes the pre-compaction context and is
 * ignored, otherwise a freshly compacted history would look as large as before and compact again.
 */
export function contextTokens(messages: AgentMessage[]): number {
  let summaryIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (isSummary(messages[i]!)) { summaryIdx = i; break; }
  let lastUsageIdx = -1;
  let base = 0;
  for (let i = messages.length - 1; i > summaryIdx; i--) {
    const m = messages[i]!;
    if (m.role === "assistant" && (m as { usage?: Parameters<typeof calculateContextTokens>[0] }).usage) {
      base = calculateContextTokens((m as { usage: Parameters<typeof calculateContextTokens>[0] }).usage);
      lastUsageIdx = i;
      break;
    }
  }
  let trailing = 0;
  for (let i = lastUsageIdx + 1; i < messages.length; i++) trailing += estimateTokens(messages[i]!);
  return base + trailing;
}

export function needsCompaction(messages: AgentMessage[], model: Model<any>, settings: CompactionSettings): boolean {
  return shouldCompact(contextTokens(messages), model.contextWindow, settings);
}

/**
 * Newest-first, keep ~keepRecentTokens, then move the cut to a user-message boundary so tool
 * calls stay paired with their results. Returns the index of the first kept message, or -1 if
 * there is nothing worth cutting (everything is recent, or no boundary exists).
 */
export function findCut(messages: AgentMessage[], keepRecentTokens: number): number {
  let acc = 0;
  let cut = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateTokens(messages[i]!);
    if (acc > keepRecentTokens) { cut = i; break; }
  }
  // Walk forward to a boundary: a user message (new turn) or an assistant message (a new step whose
  // tool results follow it). Never cut between an assistant tool call and its results.
  while (cut < messages.length && messages[cut]!.role === "toolResult") cut++;
  if (cut <= 0 || cut >= messages.length) return -1;
  return cut;
}

export const summaryMessage = (summary: string, timestamp = Date.now()): UserMessage => ({
  role: "user",
  content: [{ type: "text", text: `${SUMMARY_PREFIX}\n\n${summary}` }],
  timestamp,
});

export interface CompactionOutcome {
  messages: AgentMessage[];
  summary: string;
  firstKeptIndex: number;
  tokensBefore: number;
  tokensAfter: number;
}

/** Summarize everything before the cut with pi's summarizer (chaining a previous summary if any). */
export async function compactMessages(opts: {
  messages: AgentMessage[];
  model: Model<any>;
  streamFn: StreamFn;
  settings: CompactionSettings;
  previousSummary?: string;
  signal?: AbortSignal;
}): Promise<CompactionOutcome | null> {
  const cut = findCut(opts.messages, opts.settings.keepRecentTokens);
  if (cut < 0) return null;
  const tokensBefore = contextTokens(opts.messages);
  // Older part to fold into the summary. A leading summary message from an earlier compaction is
  // passed as previousSummary instead of being re-summarized as conversation.
  let older = opts.messages.slice(0, cut);
  let previous = opts.previousSummary;
  const first = older[0];
  if (first && isSummary(first)) {
    previous ??= (first as UserMessage & { content: { text: string }[] }).content[0]!.text.slice(SUMMARY_PREFIX.length + 2);
    older = older.slice(1);
  }
  const summary = await generateSummary(older, opts.model, opts.settings.reserveTokens, undefined, undefined, opts.signal, undefined, previous, "off", opts.streamFn);
  const messages: AgentMessage[] = [summaryMessage(summary), ...opts.messages.slice(cut)];
  return { messages, summary, firstKeptIndex: cut, tokensBefore, tokensAfter: contextTokens(messages) };
}
