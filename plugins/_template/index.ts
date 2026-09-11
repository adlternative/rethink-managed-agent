import type { PluginAPI } from "../../src/plugins/api.ts";
import { Type } from "typebox";

/**
 * Starter plugin — copy this directory, rename it (and the package.json name), delete what you don't
 * need. A plugin is one default-exported function that receives `p` and registers tools, commands
 * and hooks. It has NO ambient authority: no fs, no child_process, no net. Every side effect goes
 * through `ctx`, which the runner mediates. The same code runs unchanged whether the plugin is
 * hosted on the runner (`plugin_host=runner`) or inside the user's sandbox (`plugin_host=sandbox`).
 *
 * ── ctx cheat-sheet (the only way out) ────────────────────────────────────────────────────────
 *   ctx.sessionId / agentId / workspaceId         who this call is for
 *   ctx.session.note(text)                         leave a note for the user (not seen by the model)
 *   ctx.session.send(text)                         inject a user-role message (steer the run / next run)
 *   ctx.session.interrupt()                        abort the current run
 *   ctx.sandbox.exec(cmd, {cwd,timeoutMs,env})     run in the sandbox  ── using this makes it a "hands" plugin
 *   ctx.sandbox.readFile(path) / writeFile(p, s)   read/write the workspace
 *   ctx.store.get/set(key, value, scope)           JSON KV; scope = "agent" | "workspace" | "principal"
 *   ctx.events.get({since,limit,sessionId?})       read the durable event log (owner-scoped)
 *   ctx.model.complete(prompt, {system,maxTokens}) one-shot model call (no tools)
 *   ctx.agent.run(task, {isolated?,tools,...})     run a sub-agent; isolated=true forks the workspace
 *   ctx.agents.spawn/wait/steer/reply/stop/list    multi-agent handles (see plugins/team, plugins/workflow)
 *   ctx.fetch(url, init)                           HTTP egress, governed by PLUGIN_FETCH_ALLOW
 *   ctx.log(...args)                               runner log
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 */
export default function (p: PluginAPI) {
  // 1) A TOOL the model can call. `parameters` is a typebox schema (validated before execute runs).
  p.registerTool({
    name: "template_echo",
    description: "Echo a message back. Replace with your own tool.",
    parameters: Type.Object({ message: Type.String({ description: "text to echo" }) }),
    async execute({ message }, ctx) {
      await ctx.log(`template_echo: ${message}`);
      return `echo: ${message}`; // return a string, or { content: [{type:"text",text}], isError? }
    },
  });

  // 2) A COMMAND: `/template ...` typed by the user runs this instead of the model.
  p.registerCommand({
    name: "template",
    description: "/template <text> — a demo command",
    async handler(args, _ctx) {
      return `you typed: ${args.trim() || "(nothing)"}`; // { reply?, send? } — `send` forwards a prompt to the model
    },
  });

  // 3a) A MIDDLEWARE hook: observe/tweak a decision point. Many plugins can stack; results compose.
  p.on("tool_call", async (ev, _ctx) => {
    // return { block: true, reason } to veto, or { input } to rewrite the args; undefined = pass.
    if (ev.toolName === "bash" && /rm\s+-rf\s+\//.test(String((ev.input as { command?: string })?.command ?? ""))) {
      return { block: true, reason: "template: refusing a destructive command" };
    }
    return undefined;
  });

  // 3b) An OVERRIDE hook: supply a strategy the loop uses instead of its default. Single-owner — the
  // first plugin to answer wins. Here: take over context compaction (delete if you don't need it).
  p.on("before_compact", async (_ev, ctx) => {
    const events = await ctx.events.get({ limit: 500 }).catch(() => []);
    if (!events.length) return undefined; // undefined = let the harness run its built-in summarizer
    // ... compute your own summary with ctx.model.complete(...) ...
    return undefined; // return { summary } to replace it, or { instructions } to only steer the default
  });
}
