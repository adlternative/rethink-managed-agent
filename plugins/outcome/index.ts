import type { PluginAPI, PluginContext } from "../../src/plugins/api.ts";

/**
 * Managed-Agents-style outcomes as a plugin: define what "done" means, and the run is graded against
 * it instead of ending on the model's own say-so. At session_end the outcome is judged with the
 * session's model over evidence gathered from the workspace; "needs revision" sends the feedback back
 * as a user message (a new run), "satisfied" or the iteration cap stops the loop.
 *
 * Two ways in, one mechanism: `/outcome <goal> | rubric: ...` from a client, or a `user.define_outcome`
 * event on the Claude Managed Agents surface, which writes the same store record. Every evaluation is
 * also recorded as a structured note (`plugin.message` with `data`), so a surface can project it into
 * its own vocabulary — that is how the CMA layer emits span.outcome_evaluation_* and fills
 * `session.outcome_evaluations` without this plugin knowing that dialect exists.
 *
 * Two scopes: `/outcome default ...` stores an agent-level rubric that applies to every session of
 * the agent; `/outcome ...` sets it for just this session/workspace. A session-level outcome wins.
 */
export interface OutcomeEvaluation {
  outcome_id: string;
  iteration: number;
  /** needs_revision is the only non-terminal result */
  result: "needs_revision" | "satisfied" | "max_iterations_reached";
  explanation: string;
  completed_at: string;
}
export interface Outcome {
  outcome_id: string;
  goal: string;
  rubric: string;
  iteration: number;
  max: number;
  status: "open" | "satisfied" | "max_iterations_reached";
  evaluations: OutcomeEvaluation[];
}

export const OUTCOME_KEY = "outcome";
type Scope = "workspace" | "agent";

const newOutcome = (goal: string, rubric: string, max: number, id?: string): Outcome => ({
  outcome_id: id ?? `outc_${Math.random().toString(36).slice(2, 12)}`,
  goal, rubric, iteration: 0, max, status: "open", evaluations: [],
});

async function load(ctx: PluginContext): Promise<{ o: Outcome; scope: Scope } | null> {
  const ws = await ctx.store.get<Outcome>(OUTCOME_KEY, "workspace");
  if (ws) return { o: { evaluations: [], ...ws }, scope: "workspace" };
  const ag = await ctx.store.get<Outcome>(OUTCOME_KEY, "agent");
  return ag ? { o: { evaluations: [], ...ag }, scope: "agent" } : null;
}

/** Record one evaluation: on the outcome itself, and as a structured note surfaces can project. */
async function record(ctx: PluginContext, o: Outcome, scope: Scope, result: OutcomeEvaluation["result"], explanation: string, text: string) {
  const evaluation: OutcomeEvaluation = { outcome_id: o.outcome_id, iteration: o.iteration, result, explanation, completed_at: new Date().toISOString() };
  o.evaluations = [...(o.evaluations ?? []), evaluation];
  await ctx.store.set(OUTCOME_KEY, o, scope);
  await ctx.session.note(text, { kind: "outcome_evaluation", ...evaluation, description: o.goal, max_iterations: o.max });
}

export default function (p: PluginAPI) {
  p.registerCommand({
    name: "outcome",
    description: "/outcome <goal> [| rubric: <criteria>] [| max: N]  — define what 'done' means; /outcome clear",
    async handler(args, ctx) {
      let a = args.trim();
      let scope: Scope = "workspace";
      if (a.startsWith("default")) { scope = "agent"; a = a.slice("default".length).trim(); }
      if (!a) { const cur = await load(ctx); return cur ? `Outcome (${cur.scope}, ${cur.o.status}, iteration ${cur.o.iteration}/${cur.o.max}):\n${cur.o.goal}\nRubric: ${cur.o.rubric}` : "No outcome defined."; }
      if (a === "clear") { await ctx.store.set(OUTCOME_KEY, null, scope); return `Outcome cleared (${scope}).`; }
      const parts = a.split("|").map((s) => s.trim());
      const goal = parts[0]!;
      const rubric = parts.find((s) => s.toLowerCase().startsWith("rubric:"))?.slice(7).trim() || "The goal is fully achieved and verified (e.g. by running the code or checking the files).";
      const max = Number(parts.find((s) => s.toLowerCase().startsWith("max:"))?.slice(4).trim() ?? 3) || 3;
      await ctx.store.set(OUTCOME_KEY, newOutcome(goal, rubric, max), scope);
      return { reply: `Outcome defined at ${scope} scope (max ${max} iterations).`, send: `Work toward this outcome: ${goal}\nIt will be judged by this rubric: ${rubric}` };
    },
  });

  p.on("context", async (_ev, ctx) => {
    const cur = await load(ctx);
    return cur && cur.o.status === "open" ? { appendSystemPrompt: `## Outcome\n${cur.o.goal}\nJudged by: ${cur.o.rubric}\nMake sure the rubric is verifiably met before you finish.` } : undefined;
  });

  p.on("session_end", async (ev, ctx) => {
    const cur = await load(ctx);
    if (!cur || cur.o.status !== "open" || ev.stopReason !== "end_turn") return;
    const o = cur.o; const scope = cur.scope;
    // Gather evidence with a read-only sub-agent so the judge sees the real state, not the claim.
    const evidence = await ctx.agent.run(`Inspect the workspace and report concisely whether this outcome is met: "${o.goal}". Rubric: ${o.rubric}. Run commands/read files as needed; report facts only.`, { maxTurns: 6, tools: ["bash", "read"] });
    const verdict = await ctx.model.complete(`Outcome: ${o.goal}\nRubric: ${o.rubric}\n\nEvidence from inspecting the workspace:\n${typeof evidence === "string" ? evidence : evidence.report}\n\nAnswer with one line: SATISFIED or NEEDS_REVISION: <what is missing>`, { maxTokens: 200 });
    o.iteration += 1;
    const missing = verdict.replace(/^\s*NEEDS_REVISION:?\s*/i, "").trim();

    if (/^\s*SATISFIED/i.test(verdict)) {
      o.status = "satisfied";
      await record(ctx, o, scope, "satisfied", missing, `outcome satisfied ✓ (iteration ${o.iteration})`);
      return;
    }
    if (o.iteration >= o.max) {
      o.status = "max_iterations_reached";
      await record(ctx, o, scope, "max_iterations_reached", missing, `outcome not met after ${o.max} iterations: ${missing.slice(0, 200)}`);
      return;
    }
    await record(ctx, o, scope, "needs_revision", missing, `outcome needs revision (iteration ${o.iteration}/${o.max}): ${missing.slice(0, 200)}`);
    await ctx.session.send(`Outcome check (iteration ${o.iteration}/${o.max}) says the outcome is not yet met: ${missing}\nFix this and finish.`);
  });
}
