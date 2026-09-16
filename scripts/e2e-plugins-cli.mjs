/**
 * The same plugin E2E, but every step goes through the `pma` CLI the way a user would: install the
 * plugin with `pma agents create --packages`, open a session with `pma sessions create`, talk to it
 * with `pma session send --wait`, and judge from `pma session events --json`. The API is never called
 * directly, so a CLI that builds the wrong request fails here even when the server is fine.
 *
 *   node scripts/e2e-plugins-cli.mjs               # uses the `pma` on PATH against PMA_HOST
 *   PMA_BIN="node pma-cli/bundle/pma.js" node scripts/e2e-plugins-cli.mjs
 *
 * It also covers the three ways a plugin gets attached: on the agent, on a session at create, and on
 * a session that is already running.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const BIN = (process.env.PMA_BIN ?? "pma").split(" ");
const HOST = process.env.PMA_HOST ?? "http://localhost:8080";
const ENV = process.env.PMA_ENV ?? "env_pXwPk1AQ6DaS";
const MODEL = "qoder/auto";

async function pma(args, { timeout = 300000 } = {}) {
  const { stdout } = await exec(BIN[0], [...BIN.slice(1), ...args], { env: { ...process.env, PMA_HOST: HOST }, timeout, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}
const pmaJson = async (args, opts) => JSON.parse(await pma([...args, "--json"], opts));

const textOf = (blocks) => (blocks ?? []).map((b) => b.text ?? "").join("");
async function log(session) {
  const data = await pmaJson(["session", "events", session]);
  const payloads = data.map((e) => e.payload);
  return {
    tools: payloads.filter((p) => p.type === "agent.tool_use").map((p) => p.name),
    notes: payloads.filter((p) => p.type === "plugin.message").map((p) => `${p.plugin}: ${textOf(p.content)}`),
    results: payloads.filter((p) => p.type === "agent.tool_result").map((p) => ({ error: p.is_error, text: textOf(p.content) })),
    answers: payloads.filter((p) => p.type === "agent.message").map((p) => textOf(p.content)).join(" "),
    errors: payloads.filter((p) => p.type === "session.error").map((p) => p.error?.message ?? "error"),
  };
}

const report = [];
const record = (name, ok, detail) => { report.push({ name, ok, detail }); console.log(`${ok === true ? "PASS" : ok === "skip" ? "SKIP" : "FAIL"}  ${name.padEnd(14)} ${String(detail).replace(/\s+/g, " ").slice(0, 120)}`); };

/** Install a plugin the way the docs say: a package source on a new agent. */
async function installOnAgent(plugin, extra = []) {
  const agent = await pmaJson(["agents", "create", `e2ecli-${plugin}`, MODEL, "--tools", "bash,read,write,edit", "--packages", [`/app/plugins/${plugin}`, ...extra].join(",")]);
  const session = await pmaJson(["sessions", "create", "--agent", agent.id, "--env", ENV]);
  return { agent, session };
}
/**
 * Send and wait for the turn. A slow session is not a failed check: the evidence is in the event log
 * either way, so a timeout returns instead of throwing (a plugin that keeps the agent working — goal,
 * outcome — can run for minutes).
 */
const say = async (session, text, timeoutSec = 300) => {
  try { await pma(["session", "send", session, text, "--wait"], { timeout: timeoutSec * 1000 }); }
  catch (e) { if (!/ETIMEDOUT|timed out|killed/i.test(String(e?.message ?? e))) throw e; }
};

async function check(name, fn) {
  const t = Date.now();
  try { await fn(); } catch (e) { record(name, false, `threw: ${e?.stderr || e?.message || e}`); }
  process.stdout.write(`      (${Math.round((Date.now() - t) / 1000)}s)\n`);
}

// ---------- the three install paths ----------

await check("install:agent", async () => {
  const { agent, session } = await installOnAgent("goal");
  const shown = await pma(["agents", "get", agent.id]);
  await say(session.id, "/goal ship it");
  const l = await log(session.id);
  record("install:agent", shown.includes("/app/plugins/goal") && l.notes.some((n) => n.startsWith("/goal")), `agents get shows it; /goal -> ${l.notes[0] ?? "no reply"}`);
});

await check("install:session", async () => {
  // the agent itself has no plugins; the session brings one
  const agent = await pmaJson(["agents", "create", "e2ecli-plain", MODEL, "--tools", "bash,read,write,edit"]);
  const session = await pmaJson(["sessions", "create", "--agent", agent.id, "--env", ENV, "--packages", "/app/plugins/memory"]);
  await say(session.id, "Use the remember tool to save: the CLI install path works.");
  const l = await log(session.id);
  const saved = (await pmaJson(["agents", "get", agent.id])).packages ?? [];
  record("install:session", l.tools.includes("remember") && saved.length === 0, `tools=${l.tools.join(",") || "none"}; saved agent packages=${JSON.stringify(saved)}`);
});

await check("install:running", async () => {
  const agent = await pmaJson(["agents", "create", "e2ecli-running", MODEL, "--tools", "bash,read,write,edit"]);
  const session = await pmaJson(["sessions", "create", "--agent", agent.id, "--env", ENV]);
  await say(session.id, "Say ok.");
  await pma(["sessions", "packages", "add", session.id, "safety-net"]); // a bare catalogue name
  const listed = await pma(["sessions", "packages", "list", session.id]);
  await say(session.id, 'Run exactly this with the bash tool: echo "DROP TABLE users"');
  const l = await log(session.id);
  record("install:running", listed.includes("safety-net") && l.results.some((r) => /safety-net/.test(r.text)), `list shows it; blocked=${l.results.some((r) => /safety-net/.test(r.text))}`);
});

// ---------- every plugin, installed through the CLI ----------

await check("_template", async () => {
  const { session } = await installOnAgent("_template");
  await say(session.id, "Call the template_echo tool with text set to ping. Do nothing else.");
  const l = await log(session.id);
  record("_template", l.tools.includes("template_echo"), `tools=${l.tools.join(",") || "none"}`);
});

await check("checkpoint", async () => {
  const { session } = await installOnAgent("checkpoint");
  await say(session.id, "Use the write tool to create note.txt containing hello. Then stop.");
  await say(session.id, "/checkpoints");
  const l = await log(session.id);
  const listing = l.notes.find((n) => n.startsWith("/checkpoints"));
  record("checkpoint", !!listing && !/none yet/.test(listing), listing ?? "no reply");
});

await check("fork", async () => {
  const { session } = await installOnAgent("fork");
  await say(session.id, "Use the fork tool to have a sub-agent create fork.txt containing banana.");
  const l = await log(session.id);
  record("fork", l.tools.includes("fork"), `tools=${l.tools.join(",") || "none"}`);
});

await check("memory", async () => {
  const { session } = await installOnAgent("memory");
  await say(session.id, "Use the remember tool to save: my favourite fruit is durian.");
  const { session: s2 } = await installOnAgent("memory");
  await say(s2.id, "Use the recall tool with query fruit and tell me what it returns.");
  const [a, b] = [await log(session.id), await log(s2.id)];
  record("memory", a.tools.includes("remember") && (/durian/i.test(b.answers) || b.results.some((r) => /durian/i.test(r.text))), `remember=${a.tools.includes("remember")} recall=${/durian/i.test(b.answers)}`);
});

await check("outcome", async () => {
  const { session } = await installOnAgent("outcome");
  await say(session.id, "/outcome greet.sh exists and prints hello | rubric: sh greet.sh prints hello | max: 2");
  await say(session.id, "Create greet.sh so it prints hello.", 240);
  const l = await log(session.id);
  const verdict = l.notes.filter((n) => /outcome/.test(n));
  record("outcome", verdict.some((v) => /satisfied|needs revision/.test(v)), verdict.join(" | ") || "no verdict");
});

await check("setup", async () => {
  const { session } = await installOnAgent("setup");
  await say(session.id, "/setup echo ready > setup-ran.txt");
  await say(session.id, "Run `cat setup-ran.txt` with the bash tool and report its content.");
  const l = await log(session.id);
  record("setup", l.results.some((r) => /ready/.test(r.text)) || /ready/i.test(l.answers), `results=${l.results.map((r) => r.text.slice(0, 30)).join(" / ")}`);
});

await check("team", async () => {
  const { session } = await installOnAgent("team");
  await say(session.id, "/team");
  const l = await log(session.id);
  record("team", l.notes.some((n) => n.startsWith("/team")), l.notes.find((n) => n.startsWith("/team")) ?? "no reply");
});

await check("verify", async () => {
  const { session } = await installOnAgent("verify");
  await say(session.id, "/verify test -f never-created.txt");
  await say(session.id, "Use the write tool to create touched.txt containing x. Then stop.", 240);
  const l = await log(session.id);
  const note = l.notes.find((n) => /verify/.test(n) && !n.startsWith("/verify"));
  record("verify", !!note, note ?? `notes=${l.notes.join(" | ") || "none"}`);
});

await check("web-fetch", async () => {
  const { session } = await installOnAgent("web-fetch");
  await say(session.id, "Use the web_fetch tool on http://api:8080/v1/models and tell me one model id you see.");
  const l = await log(session.id);
  record("web-fetch", l.tools.includes("web_fetch") && l.results.some((r) => !r.error && /qoder|model/i.test(r.text)), `tools=${l.tools.join(",") || "none"}`);
});

await check("webhook", async () => {
  const http = await import("node:http");
  const hits = [];
  const server = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { hits.push(b); res.end("ok"); }); });
  await new Promise((r) => server.listen(47998, "0.0.0.0", r));
  try {
    const { session } = await installOnAgent("webhook");
    await say(session.id, "/webhook set http://host.docker.internal:47998/hook");
    await say(session.id, "Say hi.");
    await new Promise((r) => setTimeout(r, 3000));
    record("webhook", hits.length > 0, hits.length ? `received ${hits.length}` : "no delivery");
  } finally { server.close(); }
});

await check("workflow", async () => {
  const { session } = await installOnAgent("workflow");
  await say(session.id, "Call the run_workflow tool with this script and nothing else: `return 6 * 7`");
  const l = await log(session.id);
  record("workflow", l.tools.includes("run_workflow") && (l.results.some((r) => /42/.test(r.text)) || /42/.test(l.answers)), `tools=${l.tools.join(",") || "none"}`);
});

record("web-search", "skip", "needs a Bing key (BING_API_KEY); not configured here");
record("compactor", "skip", "needs a context overflow; covered by the harness compaction tests and a small-context live run");

console.log("\n──────── summary (everything through the pma CLI) ────────");
for (const r of report) console.log(`${r.ok === true ? "PASS" : r.ok === "skip" ? "SKIP" : "FAIL"}  ${r.name.padEnd(14)} ${String(r.detail).replace(/\s+/g, " ").slice(0, 100)}`);
console.log(`\n${report.filter((r) => r.ok === true).length} pass · ${report.filter((r) => r.ok === "skip").length} skip · ${report.filter((r) => r.ok === false).length} fail`);
