import type { PluginAPI } from "../../src/plugins/api.ts";
import { Type } from "typebox";

/**
 * Memory as a plugin (Managed Agents "capture what it learns as it works"): remember/recall over the
 * principal-scoped plugin store, so learnings persist across every session of the tenant. The most
 * recent notes are injected into the system prompt each turn, and the Dreaming job (examples/dreamer)
 * distills raw sessions into more of these notes. No core change — it is all ctx.store.
 */
interface Note { text: string; tags: string[]; at: number }
const KEY = "notes";
const CAP = 500;

export default function (p: PluginAPI) {
  p.registerTool({
    name: "remember",
    description: "Save a durable learning to memory (persists across sessions for this owner). Use for facts, preferences, and mistakes to avoid.",
    parameters: Type.Object({ text: Type.String(), tags: Type.Optional(Type.Array(Type.String())) }),
    async execute({ text, tags }, ctx) {
      const notes = (await ctx.store.get<Note[]>(KEY, "principal")) ?? [];
      notes.push({ text, tags: tags ?? [], at: Date.now() });
      await ctx.store.set(KEY, notes.slice(-CAP), "principal");
      return `remembered (${notes.length} notes)`;
    },
  });

  p.registerTool({
    name: "recall",
    description: "Search memory for relevant past learnings. Omit query to get the most recent notes.",
    parameters: Type.Object({ query: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
    async execute({ query, limit }, ctx) {
      const notes = (await ctx.store.get<Note[]>(KEY, "principal")) ?? [];
      const q = (query ?? "").toLowerCase();
      const hits = (q ? notes.filter((n) => n.text.toLowerCase().includes(q) || n.tags.some((t) => t.toLowerCase().includes(q))) : notes).slice(-(limit ?? 10)).reverse();
      return hits.length ? hits.map((n) => `- ${n.text}${n.tags.length ? ` [${n.tags.join(", ")}]` : ""}`).join("\n") : "(no matching memories)";
    },
  });

  // Surface the most recent memories to the model automatically, so it "remembers as it works".
  p.on("context", async (_ev, ctx) => {
    const notes = (await ctx.store.get<Note[]>(KEY, "principal")) ?? [];
    if (!notes.length) return;
    const recent = notes.slice(-10).reverse().map((n) => `- ${n.text}`).join("\n");
    return { appendSystemPrompt: `## Memory (recent learnings; use recall for more)\n${recent}` };
  });
}
