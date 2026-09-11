/**
 * dreamer — a vendor-neutral take on Claude Managed Agents "Dreaming": a scheduled, cross-session
 * job that reads recent sessions' event logs, distills recurring learnings (mistakes, workflows,
 * preferences), and writes them into the tenant's memory so future sessions benefit. It is NOT a
 * session hook — it is an external scheduled client, enabled by "events are the only truth": it reads
 * the exportable event log via the API and feeds distilled summaries to a memory-enabled agent that
 * calls remember() (the plugins/memory tool). Schedule it with cron (see README).
 *
 * Run once: npx tsx examples/dreamer/dreamer.ts
 * Env: DREAMER_API (default http://localhost:8080/v1), DREAMER_MODEL (default qoder/ultimate),
 *      DREAMER_LOOKBACK (recent sessions to scan, default 20), DREAMER_MEMORY_PACKAGE
 *      (default /app/plugins/memory), DREAMER_REVIEW=1 (propose only; a human approves).
 */
const API = process.env.DREAMER_API ?? "http://localhost:8080/v1";
const MODEL = process.env.DREAMER_MODEL ?? "qoder/ultimate";
const LOOKBACK = Number(process.env.DREAMER_LOOKBACK ?? 20);
const MEMORY_PKG = process.env.DREAMER_MEMORY_PACKAGE ?? "/app/plugins/memory";
const REVIEW = process.env.DREAMER_REVIEW === "1";
const TOKEN = process.env.DREAMER_TOKEN;
const H = { "content-type": "application/json", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) };
const api = async (m: string, p: string, body?: unknown) => { const r = await fetch(`${API}${p}`, { method: m, headers: H, body: body ? JSON.stringify(body) : undefined }); if (!r.ok) throw new Error(`${m} ${p} ${r.status}: ${await r.text()}`); return r.json(); };

/** One compact line per recent session: the ask, the outcome, and any tool errors — the raw material to learn from. */
async function summarizeRecent(): Promise<string[]> {
  const { data } = await api("GET", `/sessions?limit=${LOOKBACK}`);
  const out: string[] = [];
  for (const s of data) {
    if (s.agent?.name === "dreamer") continue; // don't learn from our own runs
    const { data: evs } = await api("GET", `/sessions/${s.id}/events?limit=1000`);
    const ask = evs.find((e: any) => e.payload.type === "user.message")?.payload.content?.map((b: any) => b.text).join("") ?? "";
    const finals = evs.filter((e: any) => e.payload.type === "agent.message");
    const last = finals.length ? finals[finals.length - 1].payload.content.map((b: any) => b.text).join("") : "";
    const errors = evs.filter((e: any) => e.payload.type === "agent.tool_result" && e.payload.is_error).length;
    const stop = [...evs].reverse().find((e: any) => e.payload.type === "session.status_idle")?.payload.stop_reason ?? s.status;
    if (ask) out.push(`- [${stop}${errors ? `, ${errors} tool errors` : ""}] ask: ${ask.slice(0, 200)} | result: ${last.slice(0, 200)}`);
  }
  return out;
}

async function main() {
  const summaries = await summarizeRecent();
  if (!summaries.length) { console.log("[dreamer] no recent sessions to learn from"); return; }
  console.log(`[dreamer] distilling ${summaries.length} recent sessions...`);

  // A memory-enabled agent: it has recall + remember (plugins/memory). Ephemeral per run.
  const agent = await api("POST", "/agents", { name: "dreamer", model: { provider: MODEL.split("/")[0], id: MODEL.split("/").slice(1).join("/") || MODEL }, packages: [MEMORY_PKG], tools: [] });
  const env = await api("POST", "/environments", { name: "dreamer", provider: "local", network: "none" });
  const session = await api("POST", "/sessions", { agent: agent.id, environment_id: env.id });

  const instruction = REVIEW
    ? "Do NOT call remember. Propose durable learnings as a numbered list for a human to review."
    : "First call recall to see existing memory and avoid duplicates. Then call remember once per NEW durable learning (a recurring mistake to avoid, a workflow that works, or a preference). Keep each concise and general.";
  const prompt = `You are the dreaming process. Below are summaries of recent agent sessions for this tenant. Identify recurring patterns and lasting learnings.\n\n${instruction}\n\nRecent sessions:\n${summaries.join("\n")}`;

  await api("POST", `/sessions/${session.id}/events`, { events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }] });
  // poll to completion
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await api("GET", `/sessions/${session.id}`);
    if (s.status === "idle" || s.status === "terminated") break;
  }
  const { data: evs } = await api("GET", `/sessions/${session.id}/events?limit=1000`);
  const said = evs.filter((e: any) => e.payload.type === "agent.message").map((e: any) => e.payload.content.map((b: any) => b.text).join("")).join("\n");
  const remembered = evs.filter((e: any) => e.payload.type === "agent.tool_use" && e.payload.name === "remember").length;
  console.log(`\n[dreamer] ${REVIEW ? "proposed learnings (review, not applied):" : `wrote ${remembered} memories`}\n${said}`);
  await api("DELETE", `/sessions/${session.id}`).catch(() => {});
}
main().catch((e) => { console.error(e); process.exit(1); });
