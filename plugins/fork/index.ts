import type { PluginAPI } from "../../src/plugins/api.ts";
import { Type } from "typebox";

/** Like a subagent/fork extension: the sub-agent gets its own context and the builtin tools in the same workspace. */
export default function (p: PluginAPI) {
  p.registerTool({
    name: "fork",
    description: "Delegate a self-contained subtask to a fresh sub-agent. Default: shares this workspace and sandbox (good for exploration). isolated=true: a separate child session on a fork of the workspace with its own sandbox, safe to run in parallel with other work; returns its report and, for git workspaces, a patch you may apply. Give a complete, standalone brief.",
    parameters: Type.Object({
      task: Type.String({ description: "complete standalone brief" }),
      isolated: Type.Optional(Type.Boolean({ description: "run as a separate child session on a forked workspace with its own sandbox" })),
      read_only: Type.Optional(Type.Boolean({ description: "(inline only) restrict the sub-agent to read/bash" })),
      max_turns: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
    }),
    async execute({ task, isolated, read_only, max_turns }, ctx) {
      ctx.log(`fork${isolated ? " (isolated)" : ""}: ${task.slice(0, 80)}`);
      const system = "You are a sub-agent working in a sandboxed workspace on one delegated task. Do the task with the tools, then answer with a concise report of what you found or changed. Do not ask questions.";
      const r = await ctx.agent.run(task, { system, maxTurns: max_turns ?? 10, tools: read_only && !isolated ? ["bash", "read"] : undefined, isolated: !!isolated });
      if (typeof r === "string") return r || "(sub-agent produced no report)";
      return `child session ${r.sessionId}\n\n${r.report}${r.patch ? `\n\n--- patch (apply with: git apply) ---\n${r.patch}` : ""}`;
    },
  });
}
