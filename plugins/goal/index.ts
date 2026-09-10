import type { PluginAPI } from "../../src/plugins/api.ts";
import { Type } from "typebox";

/** Like pi-goal: a durable goal per workspace, injected into every model request until done. */
interface Goal { text: string; steps: { text: string; done: boolean }[]; done: boolean; updated: string }
const KEY = "goal";

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
  // Every model request sees the live goal state; the model does not have to remember it.
  p.on("context", async (_ev, ctx) => {
    const g = await ctx.store.get<Goal>(KEY, "workspace");
    if (!g || g.done) return undefined;
    const steps = g.steps.map((s, i) => `${s.done ? "[x]" : "[ ]"} ${i}. ${s.text}`).join("\n");
    return { appendSystemPrompt: `## Current goal\n${g.text}\n${steps}\nUpdate progress with goal_progress as you complete steps; call goal_progress with goal_done=true when finished.` };
  });
}
