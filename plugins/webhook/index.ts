import type { PluginAPI, PluginContext } from "../../src/plugins/api.ts";
import { createHmac } from "node:crypto";

/** Webhooks as a plugin: fires on session_start / session_end / error through ctx.fetch (allow-listed on the runner). */
interface Cfg { url: string; secret?: string }
const KEY = "webhook";

async function deliver(ctx: PluginContext, type: string, data: Record<string, unknown>) {
  const cfg = await ctx.store.get<Cfg>(KEY, "agent");
  if (!cfg?.url) return;
  const body = JSON.stringify({ type, session_id: ctx.sessionId, agent_id: ctx.agentId, at: new Date().toISOString(), data });
  const headers: Record<string, string> = { "content-type": "application/json", "x-pma-event": type };
  if (cfg.secret) headers["x-pma-signature"] = `sha256=${createHmac("sha256", cfg.secret).update(body).digest("hex")}`;
  try {
    const r = await ctx.fetch(cfg.url, { method: "POST", headers, body });
    if (r.status >= 300) ctx.log(`webhook ${type} -> ${r.status}`);
  } catch (e) {
    ctx.log(`webhook ${type} failed: ${(e as Error).message}`);
  }
}

export default function (p: PluginAPI) {
  p.registerCommand({
    name: "webhook",
    description: "/webhook set <url> [secret] | /webhook clear | /webhook",
    async handler(args, ctx) {
      const [op, url, secret] = args.trim().split(/\s+/);
      if (op === "set" && url) { await ctx.store.set(KEY, { url, secret }, "agent"); return `webhook -> ${url}${secret ? " (signed)" : ""}`; }
      if (op === "clear") { await ctx.store.set(KEY, null, "agent"); return "webhook cleared"; }
      const cfg = await ctx.store.get<Cfg>(KEY, "agent");
      return cfg?.url ? `webhook -> ${cfg.url}${cfg.secret ? " (signed)" : ""}` : "no webhook configured";
    },
  });
  p.on("session_start", (ev, ctx) => deliver(ctx, "session.started", { session_id: ev.sessionId }));
  p.on("session_end", (ev, ctx) => deliver(ctx, "session.ended", { stop_reason: ev.stopReason, turns: ev.turns }));
  p.on("error", (ev, ctx) => deliver(ctx, "session.error", { error_type: ev.errorType, message: ev.message }));
}
