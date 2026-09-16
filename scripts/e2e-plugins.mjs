/**
 * E2E for every bundled plugin: attach it to a real session on a running stack, exercise it the way a
 * user would, and judge from the event log — not from "the host loaded it".
 *
 *   node scripts/e2e-plugins.mjs            # against http://localhost:8080
 *   PMA_HOST=... PMA_ENV=env_x node scripts/e2e-plugins.mjs
 *
 * It creates one agent + session per plugin (named e2e-<plugin>) and leaves them behind for
 * inspection. Nothing destructive: the safety-net check uses a harmless string that matches its rules
 * rather than a real dangerous command. `compactor` is not exercised here — it needs a context
 * overflow; see DESIGN §18 and the harness compaction tests.
 */
import http from "node:http";

const HOST = process.env.PMA_HOST || "http://localhost:8080";
const ENV = process.env.PMA_ENV || "env_pXwPk1AQ6DaS";
const MODEL = { provider: "qoder", id: "auto" };
const api = async (method, path, body) => {
  const r = await fetch(`${HOST}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newSession(plugin, extraPackages = []) {
  const agent = await api("POST", "/v1/agents", { name: `e2e-${plugin}`, model: MODEL, tools: ["bash", "read", "write", "edit"], packages: [`/app/plugins/${plugin}`, ...extraPackages] });
  const session = await api("POST", "/v1/sessions", { agent: agent.id, environment_id: ENV });
  return { agent, session };
}

/** Send one message and wait until the session is idle again (or a run errors). */
async function ask(sessionId, text, { timeoutMs = 180000 } = {}) {
  await api("POST", `/v1/sessions/${sessionId}/events`, { events: [{ type: "user.message", content: [{ type: "text", text }] }] });
  const deadline = Date.now() + timeoutMs;
  let sawRunning = false;
  while (Date.now() < deadline) {
    await sleep(1500);
    const s = await api("GET", `/v1/sessions/${sessionId}`);
    if (s.status === "running") { sawRunning = true; continue; }
    if (sawRunning && s.status !== "running") return;
    // a command-only turn may never start a run; give it a moment then look at the log
    if (!sawRunning && Date.now() > deadline - timeoutMs + 12000) return;
  }
}

const events = (sessionId) => api("GET", `/v1/sessions/${sessionId}/events?limit=400`).then((r) => r.data.map((e) => e.payload));
const textOf = (blocks) => (blocks ?? []).map((b) => b.text ?? "").join("");
const toolCalls = (evs) => evs.filter((p) => p.type === "agent.tool_use").map((p) => p.name);
const notes = (evs) => evs.filter((p) => p.type === "plugin.message").map((p) => `${p.plugin}: ${textOf(p.content)}`);
const results = (evs) => evs.filter((p) => p.type === "agent.tool_result").map((p) => ({ error: p.is_error, text: textOf(p.content) }));
const answers = (evs) => evs.filter((p) => p.type === "agent.message").map((p) => textOf(p.content)).join(" ");

const report = [];
const record = (name, ok, detail) => { report.push({ name, ok, detail }); console.log(`${ok === true ? "PASS" : ok === "skip" ? "SKIP" : "FAIL"}  ${name.padEnd(12)} ${detail}`); };

async function run(name, fn) {
  const started = Date.now();
  try { await fn(); } catch (e) { record(name, false, `threw: ${String(e?.message ?? e).slice(0, 160)}`); }
  process.stdout.write(`      (${Math.round((Date.now() - started) / 1000)}s)\n`);
}

// ---------- the checks ----------

await run("_template", async () => {
  const { session } = await newSession("_template");
  await ask(session.id, "Call the template_echo tool with text set to ping. Do nothing else.");
  const evs = await events(session.id);
  record("_template", toolCalls(evs).includes("template_echo"), `tools=${toolCalls(evs).join(",") || "none"}`);
});

await run("checkpoint", async () => {
  const { session } = await newSession("checkpoint");
  await ask(session.id, "Use the write tool to create note.txt containing the word hello. Then stop.");
  await ask(session.id, "/checkpoints");
  const evs = await events(session.id);
  const listing = notes(evs).find((n) => n.startsWith("/checkpoints"));
  record("checkpoint", !!listing && !/none yet/.test(listing), listing ? listing.slice(0, 90) : "no /checkpoints reply");
});

await run("compactor", async () => {
  const { session } = await newSession("compactor");
  await ask(session.id, "Say hi.");
  const evs = await events(session.id);
  const ran = evs.some((p) => p.type === "session.error");
  record("compactor", ran ? false : "skip", ran ? "session errored" : "loads; before_compact needs a context overflow to fire (not forced here)");
});

await run("fork", async () => {
  const { session } = await newSession("fork");
  await ask(session.id, "Use the fork tool to have a sub-agent create fork.txt containing the word banana.");
  const evs = await events(session.id);
  const r = results(evs);
  record("fork", toolCalls(evs).includes("fork"), `tools=${toolCalls(evs).join(",") || "none"}; errors=${r.filter((x) => x.error).length}`);
});

await run("goal", async () => {
  const { session } = await newSession("goal");
  await ask(session.id, "/goal ship the greeting script");
  await ask(session.id, "Use the goal_progress tool to report that you started.");
  const evs = await events(session.id);
  record("goal", notes(evs).some((n) => n.startsWith("/goal")) && toolCalls(evs).includes("goal_progress"), `${notes(evs).find((n) => n.startsWith("/goal"))?.slice(0, 60) ?? "no /goal reply"} | tools=${toolCalls(evs).join(",")}`);
});

await run("memory", async () => {
  const { session } = await newSession("memory");
  await ask(session.id, "Use the remember tool to save this fact: my favourite fruit is durian.");
  const first = await events(session.id);
  // a second session of the same owner must see it: memory is principal-scoped
  const { session: s2 } = await newSession("memory");
  await ask(s2.id, "Use the recall tool with query fruit and tell me what it returns.");
  const second = await events(s2.id);
  const recalled = /durian/i.test(answers(second)) || results(second).some((r) => /durian/i.test(r.text));
  record("memory", toolCalls(first).includes("remember") && recalled, `remember=${toolCalls(first).includes("remember")} recall-across-sessions=${recalled}`);
});

await run("outcome", async () => {
  const { session } = await newSession("outcome");
  await ask(session.id, "/outcome greet.sh exists and prints hello | rubric: sh greet.sh prints hello | max: 2");
  await ask(session.id, "Create greet.sh so it prints hello.", { timeoutMs: 240000 });
  const evs = await events(session.id);
  const verdicts = notes(evs).filter((n) => n.includes("outcome"));
  record("outcome", verdicts.some((v) => /satisfied|needs revision/.test(v)), verdicts.map((v) => v.slice(0, 70)).join(" | ") || "no verdict");
});

await run("safety-net", async () => {
  const { session } = await newSession("safety-net");
  // harmless string that matches the SQL-drop rule; nothing is deleted even if it were to run
  await ask(session.id, 'Run exactly this with the bash tool: echo "DROP TABLE users"');
  const evs = await events(session.id);
  const blocked = results(evs).some((r) => /safety-net/.test(r.text));
  record("safety-net", blocked, blocked ? "blocked with its reason" : `results=${results(evs).map((r) => r.text.slice(0, 40)).join(" / ") || "none"}`);
});

await run("setup", async () => {
  const { session } = await newSession("setup");
  await ask(session.id, "/setup echo ready > setup-ran.txt");
  await ask(session.id, "Run `cat setup-ran.txt` with the bash tool and report its content.");
  const evs = await events(session.id);
  const ran = results(evs).some((r) => /ready/.test(r.text)) || /ready/i.test(answers(evs));
  record("setup", ran, ran ? "setup command ran before the turn" : `results=${results(evs).map((r) => r.text.slice(0, 40)).join(" / ")}`);
});

await run("team", async () => {
  const { session } = await newSession("team");
  await ask(session.id, "/team");
  const evs = await events(session.id);
  const reply = notes(evs).find((n) => n.startsWith("/team"));
  record("team", !!reply, reply?.slice(0, 90) ?? "no /team reply");
});

await run("verify", async () => {
  const { session } = await newSession("verify");
  await ask(session.id, "/verify test -f never-created.txt");
  await ask(session.id, "Use the write tool to create touched.txt containing x. Then stop.", { timeoutMs: 240000 });
  const evs = await events(session.id);
  const note = notes(evs).find((n) => /verify/.test(n) && !n.startsWith("/verify"));
  record("verify", !!note, note?.slice(0, 90) ?? `notes=${notes(evs).map((n) => n.slice(0, 40)).join(" | ") || "none"}`);
});

await run("web-fetch", async () => {
  const { session } = await newSession("web-fetch");
  // the api container is reachable from the runner by service name; no public network needed
  await ask(session.id, "Use the web_fetch tool on http://api:8080/v1/models and tell me one model id you see.");
  const evs = await events(session.id);
  const ok = toolCalls(evs).includes("web_fetch") && results(evs).some((r) => !r.error && /qoder|model/i.test(r.text));
  record("web-fetch", ok, `tools=${toolCalls(evs).join(",") || "none"}; ${results(evs).map((r) => (r.error ? "ERR " : "") + r.text.slice(0, 50)).join(" / ").slice(0, 120)}`);
});

await run("web-search", async () => {
  record("web-search", "skip", "needs a Bing key (BING_API_KEY) and egress; not configured here");
});

await run("webhook", async () => {
  const hits = [];
  const server = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { hits.push(b); res.end("ok"); }); });
  await new Promise((r) => server.listen(47999, "0.0.0.0", r));
  try {
    const { session } = await newSession("webhook");
    await ask(session.id, "/webhook set http://host.docker.internal:47999/hook");
    await ask(session.id, "Say hi.");
    await sleep(3000);
    const kinds = hits.map((h) => { try { return JSON.parse(h).type; } catch { return "?"; } });
    record("webhook", hits.length > 0, hits.length ? `received ${hits.length}: ${kinds.join(",")}` : "no delivery");
  } finally { server.close(); }
});

await run("workflow", async () => {
  const { session } = await newSession("workflow");
  await ask(session.id, "Call the run_workflow tool with this script and nothing else: `return 6 * 7`");
  const evs = await events(session.id);
  const ok = toolCalls(evs).includes("run_workflow") && (results(evs).some((r) => /42/.test(r.text)) || /42/.test(answers(evs)));
  record("workflow", ok, `tools=${toolCalls(evs).join(",") || "none"}; ${results(evs).map((r) => r.text.slice(0, 50)).join(" / ").slice(0, 100)}`);
});

console.log("\n──────── summary ────────");
for (const r of report) console.log(`${r.ok === true ? "PASS" : r.ok === "skip" ? "SKIP" : "FAIL"}  ${r.name.padEnd(12)} ${r.detail.slice(0, 110)}`);
const failed = report.filter((r) => r.ok === false);
console.log(`\n${report.filter((r) => r.ok === true).length} pass · ${report.filter((r) => r.ok === "skip").length} skip · ${failed.length} fail`);
