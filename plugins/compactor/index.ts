import type { PluginAPI } from "../../src/plugins/api.ts";

/**
 * Custom context compaction — the reference "loop-behavior" plugin.
 *
 * `before_compact` is an *override* hook: instead of only observing compaction (or steering the
 * built-in summarizer with `instructions`), this plugin takes over the summary itself. It reads the
 * session's own event log through `ctx.events.get`, asks the session model for a *structured*
 * summary (decisions / open threads / files), and returns it as `summary`. The harness skips its
 * built-in summarizer and uses this text, but still owns the cut point (which must keep tool_call /
 * tool_result pairs intact) — so a plugin owns the parts that carry meaning in an event-sourced
 * model without ever touching the loop internals.
 *
 * `summary` is single-owner: if another plugin already provided one this turn, ours is ignored with
 * a warning (see host.ts OVERRIDE_FIELDS), so two compaction strategies can never silently fight.
 */
const SYSTEM = [
  "You compress an AI agent's earlier conversation into a durable briefing the agent will read after",
  "its older turns are dropped. Be faithful and specific. Use exactly these sections, each a short",
  "bullet list (omit a section only if truly empty):",
  "## Decisions — choices already made and settled, with the reason in a clause.",
  "## Open threads — what is still in flight or unresolved, and the next concrete step.",
  "## Files & artifacts — paths created or edited and what each now contains.",
  "## Constraints — standing rules the agent must keep honoring.",
].join(" ");

/** Pull readable text out of the event log for the summarizer. */
function transcript(events: { type: string; payload: unknown }[]): string {
  const lines: string[] = [];
  for (const e of events) {
    const p = e.payload as { content?: { type: string; text?: string }[]; summary?: string };
    const text = p?.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
    if (e.type === "user.message" && text) lines.push(`USER: ${text}`);
    else if (e.type === "agent.message" && text) lines.push(`ASSISTANT: ${text}`);
    else if (e.type === "agent.tool_result" && text) lines.push(`TOOL_RESULT: ${text.slice(0, 2000)}`);
    else if (e.type === "agent.thread_context_compacted" && p?.summary) lines.push(`[earlier summary]\n${p.summary}`);
  }
  return lines.join("\n\n");
}

export default function (p: PluginAPI) {
  p.on("before_compact", async (_ev, ctx) => {
    try {
      const events = await ctx.events.get({ limit: 1000 });
      const body = transcript(events);
      if (!body) return undefined; // nothing to summarize our way — fall back to the built-in
      const summary = await ctx.model.complete(`Conversation to compress:\n\n${body}`, { system: SYSTEM, maxTokens: 2000 });
      return summary.trim() ? { summary: summary.trim() } : undefined;
    } catch (e) {
      ctx.log(`compactor: falling back to built-in summarizer (${e instanceof Error ? e.message : e})`);
      return undefined; // any failure → the harness's default compaction still runs
    }
  });
}
