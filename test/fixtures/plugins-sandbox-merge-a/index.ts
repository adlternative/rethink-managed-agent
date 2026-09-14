import type { PluginAPI, InputEvent, ToolCallEvent, TurnEvent, ErrorEvent } from "../../../src/plugins/api.ts";

// First of two plugins used to pin hook merge semantics and tool/command result edge cases.
const schema = { type: "object", properties: {} } as never;
export default function (p: PluginAPI) {
  p.on("context", () => ({ appendSystemPrompt: "A-append", foo: "A-foo" }) as never);
  p.on("before_agent_start", () => ({ appendSystemPrompt: "A-bas" }));
  // does not claim summary/keepRecentTokens: undefined values are skipped
  p.on("before_compact", () => ({ summary: undefined, keepRecentTokens: undefined, instructions: "A-ins" }));
  p.on("input", (ev: InputEvent) => (ev.text.includes("cancel") ? { cancel: true } : { text: ev.text.toUpperCase() }));
  p.on("tool_call", (ev: ToolCallEvent) => {
    const input = ev.input as Record<string, unknown>;
    return input.block ? { block: true, reason: "A-block" } : { input: { ...input, a: 1 }, reason: "A-reason" };
  });
  p.on("turn_end", (ev: TurnEvent) => (ev.turn === 99 ? { stop: true, reason: "A-stop" } : undefined));
  p.on("error", (ev: ErrorEvent) => { throw new Error(`hook exploded: ${ev.message}`); });

  p.registerTool({ name: "t_undefined", description: "returns nothing", parameters: schema, execute: (async () => undefined) as never });
  p.registerTool({ name: "t_iserror", description: "error result", parameters: schema, execute: async () => ({ content: [{ type: "text", text: "bad " }, { type: "text", text: "thing" }], isError: true }) });
  p.registerTool({ name: "t_dup", description: "A", parameters: schema, execute: async () => "from A" });
  p.registerTool({ name: "t_console", description: "logs to stdout", parameters: schema, execute: async () => { console.log("hi"); return "ok"; } });
  p.registerTool({ name: "t_store", description: "reads the store", parameters: schema, execute: async (_i, ctx) => JSON.stringify(await ctx.store.get("k")) });
  p.registerTool({ name: "t_hang", description: "never resolves", parameters: schema, execute: () => new Promise<string>(() => {}) });
  p.registerTool({ name: "t_exit", description: "kills the host", parameters: schema, execute: () => { setTimeout(() => process.exit(1), 50); return new Promise<string>(() => {}); } });
  p.registerTool({ name: "t_crash_async", description: "uncaught async throw", parameters: schema, execute: async () => { setTimeout(() => { throw new Error("x"); }, 20); return "scheduled"; } });
  p.registerCommand({ name: "c_undef", description: "returns nothing", handler: async () => undefined });
  p.registerCommand({ name: "Bad Name", description: "invalid", handler: async () => "never" });
}
