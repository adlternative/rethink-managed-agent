import type { PluginAPI } from "../../src/plugins/api.ts";
import { Type } from "typebox";

/**
 * Like pi-goal, on the pma hook system: a durable goal per workspace that stays in front of the
 * model (`context`), can be managed by the user with `/goal ...` commands, is announced when a run
 * starts (`before_agent_start`), and reports progress to the user (`ctx.session.note`) when a run ends.
 */
interface Goal { text: string; steps: { text: string; done: boolean }[]; done: boolean; updated: string }
const KEY = "goal";
const render = (g: Goal) => `${g.text}\n${g.steps.map((s, i) => `${s.done ? "[x]" : "[ ]"} ${i}. ${s.text}`).join("\n")}`;

export default function (p: PluginAPI) {
  p.registerTool({
    name: "set_goal",
    description: "Set (or replace) the persistent goal for this workspace with an ordered list of steps. Call this first for multi-step tasks.",
    parameters: Type.Object({ goal: Type.String(), steps: Type.Array(Type.String(), { minItems: 1 }) }),
    async execute({ goal, steps }, ctx) {
      const g: Goal = { text: goal, steps: steps.map((s) => ({ text: s, done: false })), done: false, updated: new Date().toISOString() };
      await ctx.store.set(KEY, g, "workspace");
      return `goal set with ${steps.length} steps`;
    },
  });
  p.registerTool({
    name: "goal_progress",
    description: "Mark goal steps as done by index (0-based), or mark the whole goal done. Returns the remaining steps.",
    parameters: Type.Object({ done_steps: Type.Optional(Type.Array(Type.Integer())), goal_done: Type.Optional(Type.Boolean()) }),
    async execute({ done_steps, goal_done }, ctx) {
      const g = await ctx.store.get<Goal>(KEY, "workspace");
      if (!g) return { content: [{ type: "text", text: "no goal set; call set_goal first" }], isError: true };
      for (const i of done_steps ?? []) if (g.steps[i]) g.steps[i]!.done = true;
      if (goal_done) g.done = true;
      g.updated = new Date().toISOString();
      await ctx.store.set(KEY, g, "workspace");
      const left = g.steps.filter((s) => !s.done);
      return g.done ? "goal marked done" : `remaining: ${left.map((s) => s.text).join("; ") || "(none — mark goal_done)"}`;
    },
  });

  // /goal              show the goal
  // /goal clear        forget it
  // /goal <text>       set a goal from the user's words and have the model plan the steps
  p.registerCommand({
    name: "goal",
    description: "Show, set or clear the persistent goal: /goal | /goal clear | /goal <text>",
    async handler(args, ctx) {
      const a = args.trim();
      const g = await ctx.store.get<Goal>(KEY, "workspace");
      if (!a) return g ? `Current goal${g.done ? " (done)" : ""}:\n${render(g)}` : "No goal set. Use /goal <text> to set one.";
      if (a === "clear") { await ctx.store.set(KEY, null, "workspace"); return "Goal cleared."; }
      return { reply: `Goal noted: ${a}`, send: `The user set this goal: "${a}". Break it into concrete steps with set_goal, then start on step 0.` };
    },
  });

  // Every model request sees the live goal state; the model does not have to remember it.
  p.on("context", async (_ev, ctx) => {
    const g = await ctx.store.get<Goal>(KEY, "workspace");
    if (!g || g.done) return undefined;
    return { appendSystemPrompt: `## Current goal\n${render(g)}\nUpdate progress with goal_progress as you complete steps; call goal_progress with goal_done=true when finished.` };
  });
  // Announce at run start so the user sees what the agent is working against.
  p.on("before_agent_start", async (_ev, ctx) => {
    const g = await ctx.store.get<Goal>(KEY, "workspace");
    if (g && !g.done) await ctx.session.note(`working toward: ${g.text} (${g.steps.filter((s) => s.done).length}/${g.steps.length} steps done)`);
    return undefined;
  });
  // Progress report when the run ends.
  p.on("session_end", async (ev, ctx) => {
    const g = await ctx.store.get<Goal>(KEY, "workspace");
    if (!g) return;
    const done = g.steps.filter((s) => s.done).length;
    if (g.done) await ctx.session.note("goal complete ✓");
    else if (ev.stopReason === "end_turn") await ctx.session.note(`goal progress: ${done}/${g.steps.length} steps; remaining: ${g.steps.filter((s) => !s.done).map((s) => s.text).join("; ")}`);
  });
}
