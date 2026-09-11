import type { PluginAPI } from "../../src/plugins/api.ts";

/**
 * A both-layers plugin: a brain before_agent_start hook ensures the hands sandbox is prepared before
 * the model works. `/setup <cmd>` stores a bootstrap command at AGENT scope (applies to every session
 * of the agent); on the first turn of a fresh sandbox (no marker file) it runs the command and writes
 * .agent/setup.done so it runs at most once per sandbox.
 */
const CMD = "setup_cmd"; const MARKER = ".agent/setup.done";

export default function (p: PluginAPI) {
  p.registerCommand({
    name: "setup",
    description: "/setup <shell command> — run it once to prepare a fresh sandbox (e.g. install deps). Agent-wide. /setup off to clear, /setup to show.",
    async handler(args, ctx) {
      const a = args.trim();
      if (!a) return `setup: ${(await ctx.store.get<string>(CMD, "agent")) ?? "(not set)"}`;
      if (a === "off") { await ctx.store.set(CMD, null, "agent"); return "setup cleared."; }
      await ctx.store.set(CMD, a, "agent");
      return `setup set (agent-wide): ${a}`;
    },
  });

  p.on("before_agent_start", async (_ev, ctx) => {
    const cmd = await ctx.store.get<string>(CMD, "agent");
    if (!cmd) return;
    const done = await ctx.sandbox.exec(`[ -f ${MARKER} ] && echo yes || echo no`);
    if (done.stdout.trim() === "yes") return;
    const r = await ctx.sandbox.exec(cmd, { timeoutMs: 600_000 });
    await ctx.sandbox.exec(`mkdir -p .agent && printf '%s\\n' ${JSON.stringify(new Date().toISOString())} > ${MARKER}`);
    await ctx.session.note(r.code === 0 ? `setup ran ok: ${cmd}` : `setup failed (exit ${r.code}): ${(r.stdout + r.stderr).slice(-500)}`);
  });
}
