import type { PluginAPI } from "../../src/plugins/api.ts";

/** Like cc-safety-net: a policy hook; nothing here touches files — it only sees the proposed command. */
const RULES: { re: RegExp; why: string }[] = [
  { re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(\/|~|\$HOME)(\s|$)/, why: "recursive delete of / or home" },
  { re: /\bgit\s+push\b[^|;&]*(--force|-f)\b/, why: "force push" },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/, why: "destructive git reset/clean" },
  { re: /\bDROP\s+(DATABASE|TABLE)\b/i, why: "SQL drop" },
  { re: /\bmkfs\b|\bdd\s+if=.*of=\/dev\//, why: "disk wipe" },
  { re: /:\(\)\s*\{\s*:\|:&\s*\};:/, why: "fork bomb" },
];

export default function (p: PluginAPI) {
  p.on("tool_call", (ev, ctx) => {
    if (ev.toolName !== "bash") return undefined;
    const cmd = String((ev.input as { command?: string }).command ?? "");
    const hit = RULES.find((r) => r.re.test(cmd));
    if (!hit) return undefined;
    ctx.log(`safety-net blocked: ${cmd}`);
    return { block: true, reason: `safety-net: refusing to run this command (${hit.why}). Ask the user to run it themselves if it is really intended.` };
  });
}
