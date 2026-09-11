import type { PluginAPI } from "../../src/plugins/api.ts";
import { Type } from "typebox";

/**
 * A both-layers plugin: brain turn-hooks + commands + a tool, driving git in the hands sandbox.
 * It keeps a *shadow* git history under .agent/ckpt.git (a separate GIT_DIR, so it never touches the
 * user's own .git or HEAD / the harness's git-diff capture). Each turn end snapshots the workspace;
 * `/checkpoints` lists them; the `revert` tool restores one.
 */
const G = "git --git-dir=.agent/ckpt.git --work-tree=. -c user.email=ckpt@pma -c user.name=checkpoint";
async function ensure(ctx: import("../../src/plugins/api.ts").PluginContext) {
  await ctx.sandbox.exec(`mkdir -p .agent && [ -d .agent/ckpt.git ] || ${G} init -q`);
}

export default function (p: PluginAPI) {
  p.on("turn_end", async (_ev, ctx) => {
    await ensure(ctx);
    // commit only if something changed; never fail the turn
    await ctx.sandbox.exec(`${G} add -A && (${G} diff --cached --quiet || ${G} commit -q -m "checkpoint $(date -u +%FT%TZ)") || true`);
  });

  p.registerCommand({
    name: "checkpoints",
    description: "List workspace checkpoints (most recent first).",
    async handler(_args, ctx) { await ensure(ctx); const r = await ctx.sandbox.exec(`${G} log --oneline -20 2>/dev/null || echo "(none yet)"`); return r.stdout.trim() || "(none yet)"; },
  });

  p.registerTool({
    name: "revert",
    description: "Restore the whole workspace to a checkpoint commit (from /checkpoints). Destructive: discards later changes.",
    parameters: Type.Object({ commit: Type.String({ description: "the short hash from /checkpoints" }) }),
    async execute({ commit }, ctx) {
      await ensure(ctx);
      const r = await ctx.sandbox.exec(`${G} reset --hard ${JSON.stringify(commit).replace(/"/g, "")} 2>&1`);
      return r.code === 0 ? `reverted to ${commit}` : `revert failed: ${r.stdout || r.stderr}`;
    },
  });
}
