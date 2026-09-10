import type { PluginAPI, PluginContext } from "../../src/plugins/api.ts";
import { Type } from "typebox";

/**
 * Agent teams on top of ctx.agents. Roles live in the agent-scoped store (editable with /team) and
 * default to four Claude-Code-style types. The model orchestrates with spawn_agent / wait_agents /
 * message_agent / list_agents; children report back through their builtin report_to_parent tool.
 */
interface Role { system: string; model?: string; tools?: string[]; maxTurns?: number }
const DEFAULT_ROLES: Record<string, Role> = {
  explorer: { system: "You are a read-only scout. Find the relevant files/facts and report concisely with paths and line numbers. Never modify files.", tools: ["bash", "read"], maxTurns: 12 },
  planner: { system: "You produce a concrete step-by-step implementation plan for the given task in this workspace, citing the files to change. Do not implement.", tools: ["bash", "read"], maxTurns: 10 },
  worker: { system: "You implement the delegated change in this workspace, verify it (run tests/build when possible), and report exactly what you changed.", maxTurns: 25 },
  reviewer: { system: "You review the workspace for the stated concern and report findings as a list with severity, file:line and a fix suggestion. Do not modify files.", tools: ["bash", "read"], maxTurns: 12 },
};
const roles = async (ctx: PluginContext) => ({ ...DEFAULT_ROLES, ...((await ctx.store.get<Record<string, Role>>("team.roles", "agent")) ?? {}) });

export default function (p: PluginAPI) {
  p.registerCommand({
    name: "team",
    description: "/team — list roles · /team set <role> <system prompt> · /team del <role>",
    async handler(args, ctx) {
      const [op, name, ...rest] = args.trim().split(/\s+/);
      const custom = (await ctx.store.get<Record<string, Role>>("team.roles", "agent")) ?? {};
      if (op === "set" && name && rest.length) { custom[name] = { ...(custom[name] ?? {}), system: rest.join(" ") }; await ctx.store.set("team.roles", custom, "agent"); return `role ${name} saved`; }
      if (op === "del" && name) { delete custom[name]; await ctx.store.set("team.roles", custom, "agent"); return `role ${name} removed`; }
      const all = await roles(ctx);
      return Object.entries(all).map(([k, r]) => `- ${k}${r.tools ? ` [${r.tools.join(",")}]` : ""}: ${r.system.slice(0, 90)}`).join("\n");
    },
  });

  p.registerTool({
    name: "spawn_agent",
    description: "Start a child agent in the background on an isolated copy of the workspace (or sharing it). Returns immediately with its id; use wait_agents to join. Roles: explorer, planner, worker, reviewer, or a custom /team role.",
    parameters: Type.Object({
      role: Type.String(),
      task: Type.String({ description: "complete, standalone brief" }),
      name: Type.Optional(Type.String({ description: "label, e.g. 'security-review'" })),
      share_workspace: Type.Optional(Type.Boolean({ description: "work on the same workspace instead of a fork (only one agent can hold the sandbox at a time)" })),
    }),
    async execute({ role, task, name, share_workspace }, ctx) {
      const r = (await roles(ctx))[role];
      if (!r) return { content: [{ type: "text", text: `unknown role ${role}; known: ${Object.keys(await roles(ctx)).join(", ")}` }], isError: true };
      const h = await ctx.agents.spawn(task, { system: r.system, model: r.model, tools: r.tools, maxTurns: r.maxTurns, role, name, shareWorkspace: share_workspace });
      return `spawned ${role} ${h.sessionId}${name ? ` (${name})` : ""}`;
    },
  });

  p.registerTool({
    name: "wait_agents",
    description: "Wait for child agents to finish (or to ask a question) and return their reports. Omit ids to wait for all running children.",
    parameters: Type.Object({ ids: Type.Optional(Type.Array(Type.String())), timeout_s: Type.Optional(Type.Integer({ minimum: 10, maximum: 3600 })) }),
    async execute({ ids, timeout_s }, ctx) {
      const targets = ids?.length ? ids : (await ctx.agents.list()).filter((c) => !c.finished).map((c) => c.sessionId);
      if (!targets.length) return "no running child agents";
      const results = await Promise.all(targets.map((id) => ctx.agents.wait(id, { timeoutMs: (timeout_s ?? 900) * 1000, untilQuestion: true }).catch((e) => ({ sessionId: id, status: "running" as const, finished: false, updates: [], lastReport: `wait failed: ${e.message}` }))));
      return results.map((s) => {
        if (s.pendingQuestion) return `## ${s.sessionId} — QUESTION (answer with message_agent, question_id=${s.pendingQuestion.id})\n${s.pendingQuestion.text}`;
        return `## ${s.sessionId} — ${s.finished ? `finished (${s.stopReason ?? "end_turn"})` : s.status}${s.updates.length ? `\nupdates:\n${s.updates.map((u) => `- ${u}`).join("\n")}` : ""}\n${s.lastReport ?? "(no report)"}`;
      }).join("\n\n");
    },
  });

  p.registerTool({
    name: "message_agent",
    description: "Send instructions to a child agent (steers it if running, starts its next turn if idle). To answer a child's question pass its question_id.",
    parameters: Type.Object({ id: Type.String(), text: Type.String(), question_id: Type.Optional(Type.String()) }),
    async execute({ id, text, question_id }, ctx) {
      if (question_id) await ctx.agents.reply(id, question_id, text); else await ctx.agents.steer(id, text);
      return "sent";
    },
  });

  p.registerTool({
    name: "list_agents",
    description: "List this session's child agents with status and last report.",
    parameters: Type.Object({}),
    async execute(_i, ctx) {
      const all = await ctx.agents.list();
      return all.length ? all.map((s) => `- ${s.sessionId} ${s.finished ? "finished" : s.status}${s.pendingQuestion ? " (question pending)" : ""}${s.lastReport ? `: ${s.lastReport.slice(0, 120)}` : ""}`).join("\n") : "no child agents";
    },
  });

  p.registerTool({
    name: "agent_patch",
    description: "Get the git patch a finished child produced on its forked workspace (apply with `git apply` via bash).",
    parameters: Type.Object({ id: Type.String() }),
    async execute({ id }, ctx) { return (await ctx.agents.patch(id)) ?? "(no patch: the child's workspace is not git-backed or has no changes)"; },
  });
}
