import type { PluginAPI } from "../../src/plugins/api.ts";
import { Type } from "typebox";

/** Like a subagent/fork extension: the sub-agent gets its own context and the builtin tools in the same workspace. */
export default function (p: PluginAPI) {
  p.registerTool({
    name: "fork",
    description: "Delegate a self-contained subtask to a fresh sub-agent that shares this workspace but not your conversation. Give it a complete, standalone brief. Returns its final report. Use for exploration or parallelizable chunks so your own context stays small.",
    parameters: Type.Object({
      task: Type.String({ description: "complete standalone brief" }),
      read_only: Type.Optional(Type.Boolean({ description: "restrict the sub-agent to read/bash (no write/edit)" })),
      max_turns: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
    }),
    async execute({ task, read_only, max_turns }, ctx) {
      ctx.log(`fork: ${task.slice(0, 80)}`);
      const report = await ctx.agent.run(task, {
        system: "You are a sub-agent working in a sandboxed workspace on one delegated task. Do the task with the tools, then answer with a concise report of what you found or changed. Do not ask questions.",
        maxTurns: max_turns ?? 10,
        tools: read_only ? ["bash", "read"] : undefined,
      });
      return report || "(sub-agent produced no report)";
    },
  });
}
