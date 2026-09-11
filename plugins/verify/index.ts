import type { PluginAPI } from "../../src/plugins/api.ts";

/**
 * A both-layers plugin: a brain tool_result hook notices when the agent changed files, then at
 * turn_end runs a verify command in the hands sandbox; if it fails, it steers the brain with the
 * output so the model fixes it. `/verify <cmd>` sets the command (per workspace); `/verify off` clears.
 */
const CMD = "verify_cmd"; const DIRTY = "verify_dirty";

export default function (p: PluginAPI) {
  p.registerCommand({
    name: "verify",
    description: "/verify <shell command> — run it in the sandbox after edits; fail -> the agent fixes it. /verify off to disable, /verify to show.",
    async handler(args, ctx) {
      const a = args.trim();
      if (!a) return `verify: ${(await ctx.store.get<string>(CMD, "workspace")) ?? "(not set)"}`;
      if (a === "off") { await ctx.store.set(CMD, null, "workspace"); return "verify disabled."; }
      await ctx.store.set(CMD, a, "workspace");
      return `verify set: ${a} (runs after the agent edits files)`;
    },
  });

  // Mark the workspace dirty when the agent successfully writes/edits.
  p.on("tool_result", async (ev, ctx) => {
    if (!ev.isError && (ev.toolName === "write" || ev.toolName === "edit" || ev.toolName === "bash")) await ctx.store.set(DIRTY, true, "workspace");
    return undefined;
  });

  // At turn end, if edited and a verify command is set, run it in the sandbox and steer on failure.
  p.on("turn_end", async (_ev, ctx) => {
    const cmd = await ctx.store.get<string>(CMD, "workspace");
    const dirty = await ctx.store.get<boolean>(DIRTY, "workspace");
    if (!cmd || !dirty) return;
    await ctx.store.set(DIRTY, false, "workspace");
    const r = await ctx.sandbox.exec(cmd, { timeoutMs: 300_000 });
    if (r.code === 0) { await ctx.session.note(`verify passed: ${cmd}`); return; }
    await ctx.session.note(`verify failed (exit ${r.code}): ${cmd}`);
    await ctx.session.send(`The verify command \`${cmd}\` failed (exit ${r.code}). Fix the code so it passes.\n\nOutput:\n${(r.stdout + "\n" + r.stderr).slice(-3000)}`);
  });
}
