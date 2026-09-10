import type { PluginAPI } from "../../src/plugins/api.ts";

/**
 * Managed-Agents-style outcomes as a plugin: /outcome <goal> | rubric: <criteria>
 * At session_end the outcome is judged with the session's model; "needs_revision" sends the
 * feedback back as a user message (a new run), "satisfied" or the iteration cap stops the loop.
 */
interface Outcome { goal: string; rubric: string; iteration: number; max: number; status: "open" | "satisfied" | "max_iterations_reached" }
const KEY = "outcome";

export default function (p: PluginAPI) {
  p.registerCommand({
    name: "outcome",
    description: "/outcome <goal> [| rubric: <criteria>] [| max: N]  — define what 'done' means; /outcome clear",
    async handler(args, ctx) {
      const a = args.trim();
      if (!a) { const o = await ctx.store.get<Outcome>(KEY, "workspace"); return o ? `Outcome (${o.status}, iteration ${o.iteration}/${o.max}):\n${o.goal}\nRubric: ${o.rubric}` : "No outcome defined."; }
      if (a === "clear") { await ctx.store.set(KEY, null, "workspace"); return "Outcome cleared."; }
      const parts = a.split("|").map((s) => s.trim());
      const goal = parts[0]!;
      const rubric = parts.find((s) => s.toLowerCase().startsWith("rubric:"))?.slice(7).trim() || "The goal is fully achieved and verified (e.g. by running the code or checking the files).";
      const max = Number(parts.find((s) => s.toLowerCase().startsWith("max:"))?.slice(4).trim() ?? 3) || 3;
      await ctx.store.set(KEY, { goal, rubric, iteration: 0, max, status: "open" } satisfies Outcome, "workspace");
      return { reply: `Outcome defined (max ${max} iterations). I will judge each run against the rubric.`, send: `Work toward this outcome: ${goal}\nIt will be judged by this rubric: ${rubric}` };
    },
  });

  p.on("context", async (_ev, ctx) => {
    const o = await ctx.store.get<Outcome>(KEY, "workspace");
    return o && o.status === "open" ? { appendSystemPrompt: `## Outcome\n${o.goal}\nJudged by: ${o.rubric}\nMake sure the rubric is verifiably met before you finish.` } : undefined;
  });

  p.on("session_end", async (ev, ctx) => {
    const o = await ctx.store.get<Outcome>(KEY, "workspace");
    if (!o || o.status !== "open" || ev.stopReason !== "end_turn") return;
    // Gather evidence with a read-only sub-agent so the judge sees the real state, not the claim.
    const evidence = await ctx.agent.run(`Inspect the workspace and report concisely whether this outcome is met: "${o.goal}". Rubric: ${o.rubric}. Run commands/read files as needed; report facts only.`, { maxTurns: 6, tools: ["bash", "read"] });
    const verdict = await ctx.model.complete(`Outcome: ${o.goal}\nRubric: ${o.rubric}\n\nEvidence from inspecting the workspace:\n${typeof evidence === "string" ? evidence : evidence.report}\n\nAnswer with one line: SATISFIED or NEEDS_REVISION: <what is missing>`, { maxTokens: 200 });
    o.iteration += 1;
    if (/^\s*SATISFIED/i.test(verdict)) {
      o.status = "satisfied";
      await ctx.store.set(KEY, o, "workspace");
      await ctx.session.note(`outcome satisfied ✓ (iteration ${o.iteration})`);
      return;
    }
    if (o.iteration >= o.max) {
      o.status = "max_iterations_reached";
      await ctx.store.set(KEY, o, "workspace");
      await ctx.session.note(`outcome not met after ${o.max} iterations: ${verdict.slice(0, 200)}`);
      return;
    }
    await ctx.store.set(KEY, o, "workspace");
    await ctx.session.note(`outcome needs revision (iteration ${o.iteration}/${o.max}): ${verdict.replace(/^\s*NEEDS_REVISION:?\s*/i, "").slice(0, 200)}`);
    await ctx.session.send(`Outcome check (iteration ${o.iteration}/${o.max}) says the outcome is not yet met: ${verdict.replace(/^\s*NEEDS_REVISION:?\s*/i, "")}\nFix this and finish.`);
  });
}
