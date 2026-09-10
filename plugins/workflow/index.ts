import type { PluginAPI, PluginContext } from "../../src/plugins/api.ts";
import { Type } from "typebox";

/**
 * Workflow scripts (the pi-subagents / Claude Code `Workflow` shape) as a plugin. The script is
 * plain JS run with `new Function` inside the plugin host: agent() spawns a child session on a
 * forked workspace and joins it; parallel() and pipeline() compose; phase()/log() narrate.
 * Determinism: Date.now / Math.random are shadowed to throw, like the originals.
 */
const SCRIPT = Type.Object({
  script: Type.String({ description: "JS: `export const meta = {name, description, phases?}` then a body using agent(prompt, {label, phase, role, system, model, tools, schema?}), parallel(thunks), pipeline(items, ...stages), phase(title), log(msg), args" }),
  args: Type.Optional(Type.Unknown()),
  max_agents: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

function splitMeta(script: string): { meta: string; body: string } {
  const m = /export\s+const\s+meta\s*=\s*/.exec(script);
  if (!m) return { meta: "", body: script };
  let i = m.index + m[0].length;
  if (script[i] !== "{") return { meta: "", body: script };
  let depth = 0; let inStr: string | null = null;
  for (let j = i; j < script.length; j++) {
    const ch = script[j]!;
    if (inStr) { if (ch === "\\") j++; else if (ch === inStr) inStr = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { let end = j + 1; if (script[end] === ";") end++; return { meta: script.slice(i, j + 1), body: script.slice(0, m.index) + script.slice(end) }; } }
  }
  return { meta: "", body: script };
}

export default function (p: PluginAPI) {
  p.registerTool({
    name: "run_workflow",
    description: "Run a deterministic multi-agent workflow script. Use for fan-out (parallel reviews, per-file migrations), verify loops, or pipelines that would overflow a single context. Returns the script's return value plus a log.",
    parameters: SCRIPT,
    async execute({ script, args, max_agents }, ctx) {
      const log: string[] = [];
      let spawned = 0; let phase = "";
      const cap = max_agents ?? 16;
      const agent = async (prompt: string, opts: Record<string, any> = {}) => {
        if (spawned >= cap) throw new Error(`workflow agent cap (${cap}) reached`);
        spawned++;
        const label = opts.label ?? `${opts.phase ?? phase ?? "agent"}:${spawned}`;
        log.push(`▸ ${label} start`);
        const h = await ctx.agents.spawn(prompt + (opts.schema ? `\n\nReturn ONLY a JSON object matching this JSON Schema: ${JSON.stringify(opts.schema)}` : ""), { system: opts.system, model: opts.model, tools: opts.tools, role: opts.role, name: label, maxTurns: opts.maxTurns ?? 20 });
        const s = await ctx.agents.wait(h, { timeoutMs: (opts.timeoutS ?? 900) * 1000 });
        log.push(`✓ ${label} ${s.stopReason ?? s.status}`);
        const text = s.lastReport ?? "";
        if (!opts.schema) return text;
        const m = /\{[\s\S]*\}/.exec(text);
        if (!m) return null;
        try { return JSON.parse(m[0]); } catch { return null; }
      };
      const parallel = (thunks: (() => Promise<unknown>)[]) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch((e) => { log.push(`✗ ${e.message}`); return null; })));
      const pipeline = async (items: unknown[], ...stages: ((prev: unknown, item: unknown, i: number) => Promise<unknown>)[]) =>
        Promise.all(items.map(async (item, i) => { let cur: unknown = item; for (const st of stages) { try { cur = await st(cur, item, i); } catch (e: any) { log.push(`✗ item ${i}: ${e.message}`); return null; } } return cur; }));
      // Strip `export const meta = {...}` with a balanced-brace scan (the literal may nest arrays/objects).
      const { meta, body } = splitMeta(script);
      let result: unknown;
      try {
        const fn = new Function("agent", "parallel", "pipeline", "phase", "log", "args", "Date", "Math", `return (async () => { ${body} })();`);
        const noDate = new Proxy(Date, { get(t, k) { if (k === "now") return () => { throw new Error("Date.now() is not allowed in workflows"); }; return Reflect.get(t, k); } });
        const noRandom = new Proxy(Math, { get(t, k) { if (k === "random") return () => { throw new Error("Math.random() is not allowed in workflows"); }; return Reflect.get(t, k); } });
        result = await fn(agent, parallel, pipeline, (t: string) => { phase = t; log.push(`── ${t} ──`); }, (m: string) => log.push(String(m)), args, noDate, noRandom);
      } catch (e: any) {
        return { content: [{ type: "text", text: `workflow failed: ${e.message}\n\nlog:\n${log.join("\n")}` }], isError: true };
      }
      await ctx.session.note(`workflow ${meta.slice(0, 60)} done: ${spawned} agents`);
      return `result:\n${typeof result === "string" ? result : JSON.stringify(result, null, 2)}\n\nlog:\n${log.join("\n")}`;
    },
  });
}
