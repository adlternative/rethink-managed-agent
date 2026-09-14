import type { PluginAPI, InputEvent, ToolCallEvent, TurnEvent } from "../../../src/plugins/api.ts";

// Second plugin: records what it sees through ctx.store so short-circuits and chaining are observable.
const schema = { type: "object", properties: {} } as never;
export default function (p: PluginAPI) {
  p.on("context", () => ({ appendSystemPrompt: "B-append", foo: "B-foo" }) as never);
  p.on("before_agent_start", () => ({ appendSystemPrompt: "B-bas" }));
  p.on("before_compact", () => ({ summary: "B-summary", keepRecentTokens: 100, instructions: "B-ins" }));
  p.on("input", async (ev: InputEvent, ctx) => { await ctx.store.set("input-seen", ev.text); return { text: `${ev.text}!` }; });
  p.on("tool_call", async (ev: ToolCallEvent, ctx) => { await ctx.store.set("tc-seen", ev.input); return { reason: "B-reason" }; });
  p.on("turn_end", async (ev: TurnEvent, ctx) => { await ctx.store.set("turn-seen", ev.turn); return { reason: "B-turn" }; });
  p.registerTool({ name: "t_dup", description: "B", parameters: schema, execute: async () => "from B" });
}
