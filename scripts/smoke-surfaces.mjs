/**
 * One pass over every way in: the native API, the `pma` CLI, the OpenAI Agents API surface and the
 * Claude Managed Agents surface — each doing a real turn on a running stack, driven by the vendors'
 * own SDKs where one exists.
 *
 *   node scripts/smoke-surfaces.mjs                 # against http://localhost:8080
 *   PMA_HOST=... PMA_ENV=env_x node scripts/smoke-surfaces.mjs
 *
 * It answers one question: can a user actually get a turn out of each surface today. Depth per surface
 * lives elsewhere (test/openai-sdk, test/anthropic-sdk, scripts/e2e-plugins-cli.mjs).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import OpenAI from "openai7";
import Anthropic from "@anthropic-ai/sdk";

const exec = promisify(execFile);
const HOST = process.env.PMA_HOST ?? "http://localhost:8080";
const ENV = process.env.PMA_ENV ?? "env_pXwPk1AQ6DaS";
const MODEL = "qoder/auto";
const ASK = "Reply with exactly: PONG";

const api = async (method, path, body) => {
  const r = await fetch(`${HOST}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${t.slice(0, 160)}`);
  return t ? JSON.parse(t) : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pma = async (args) => (await exec("pma", args, { env: { ...process.env, PMA_HOST: HOST }, timeout: 300000, maxBuffer: 32e6 })).stdout;

const results = [];
const record = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(22)} ${String(detail).replace(/\s+/g, " ").slice(0, 100)}`); };
const step = async (name, fn) => { try { await fn(); } catch (e) { record(name, false, `threw: ${e?.stderr || e?.message || e}`); } };

/**
 * Wait for the turn to finish. Watching the status alone is a race — a short turn can start and end
 * between two polls — so the log is the authority: the turn is done once a status_idle follows the
 * message that triggered it.
 */
async function waitIdle(id, ms = 240000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await sleep(1500);
    const s = await api("GET", `/v1/sessions/${id}`);
    if (s.status === "running") continue;
    const { data } = await api("GET", `/v1/sessions/${id}/events?limit=200`);
    const types = data.map((e) => e.payload.type);
    if (types.lastIndexOf("session.status_idle") > types.lastIndexOf("user.message")) return s;
  }
  throw new Error("timed out waiting for the turn");
}
const answers = (events) => events.filter((e) => e.payload.type === "agent.message").map((e) => (e.payload.content ?? []).map((b) => b.text ?? "").join("")).join(" ");

await step("native API", async () => {
  const agent = await api("POST", "/v1/agents", { name: "smoke-native", model: { provider: "qoder", id: "auto" }, tools: [] });
  const session = await api("POST", "/v1/sessions", { agent: agent.id, environment_id: ENV, initial_events: [{ type: "user.message", content: [{ type: "text", text: ASK }] }] });
  await waitIdle(session.id);
  const { data } = await api("GET", `/v1/sessions/${session.id}/events?limit=50`);
  record("native API", /PONG/.test(answers(data)), `session ${session.id}`);
});

await step("pma CLI", async () => {
  const agent = JSON.parse(await pma(["agents", "create", "smoke-cli", MODEL, "--tools", "bash,read", "--json"]));
  const session = JSON.parse(await pma(["sessions", "create", "--agent", agent.id, "--env", ENV, "--json"]));
  const out = await pma(["session", "send", session.id, ASK, "--wait"]);
  record("pma CLI", /PONG/.test(out), `session ${session.id}`);
});

await step("pma CLI: reads", async () => {
  const checks = await Promise.all([
    pma(["agents", "list"]), pma(["sessions", "list"]), pma(["envs", "list"]), pma(["models"]),
    pma(["plugins", "list"]), pma(["vaults", "list"]), pma(["memory-stores", "list"]), pma(["skills", "list"]),
    pma(["files", "list"]), pma(["providers", "list"]), pma(["sandboxes", "list"]),
  ]);
  record("pma CLI: reads", checks.every((c) => typeof c === "string"), `${checks.length} list commands answered`);
});

await step("OpenAI Agents API", async () => {
  const stripAuth = async (url, init = {}) => { const h = new Headers(init.headers || {}); h.delete("authorization"); return fetch(url, { ...init, headers: h }); };
  const client = new OpenAI({ apiKey: "unused", baseURL: `${HOST}/openai/v1`, timeout: 240000, maxRetries: 0, fetch: stripAuth });
  const agent = await client.beta.agents.create({ model: MODEL, name: "smoke-openai", instructions: "Be exact." });
  const session = await client.beta.agents.sessions.create({ agent_id: agent.id, environment: { type: "reference", environment_id: ENV } });
  let text = "";
  for await (const ev of client.beta.agents.sessions.stream(session.id, { input: ASK })) {
    if (ev.type === "agent.session.turn.output_text.delta") text += ev.delta ?? "";
  }
  const items = await client.beta.agents.sessions.items.list(session.id);
  record("OpenAI Agents API", /PONG/.test(text), `stream + ${items.data.length} items`);
});

await step("Claude Managed Agents", async () => {
  const client = new Anthropic({ apiKey: "sk-ant-unused", baseURL: `${HOST}/anthropic`, timeout: 240000, maxRetries: 0 });
  const agent = await client.beta.agents.create({ name: "smoke-cma", model: MODEL, system: "Be exact.", tools: [{ type: "agent_toolset_20260401", default_config: { enabled: false } }] });
  const session = await client.beta.sessions.create({ agent: agent.id, environment_id: ENV, initial_events: [{ type: "user.message", content: [{ type: "text", text: ASK }] }] });
  let text = "";
  const stream = await client.beta.sessions.events.stream(session.id);
  for await (const ev of stream) {
    if (ev.type === "agent.message") text += ev.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    if (ev.type === "session.status_idle" && text) break;
  }
  record("Claude Managed Agents", /PONG/.test(text), `session ${session.id}`);
});

await step("one engine, three dialects", async () => {
  // a session created through one surface must read correctly through the others
  const session = await api("POST", "/v1/sessions", { agent: (await api("GET", "/v1/agents")).data[0].id, environment_id: ENV });
  const asOpenAi = await api("GET", `/openai/v1/agents/sessions/${session.id}`);
  const asCma = await api("GET", `/anthropic/v1/sessions/${session.id}?beta=true`);
  record("one engine, three dialects", asOpenAi.object === "agent.session" && asCma.type === "session", `${asOpenAi.status} / ${asCma.status}`);
});

await step("cleanup", async () => {
  const sessions = (await api("GET", "/v1/sessions?limit=100")).data.filter((s) => /^smoke-/.test(s.agent.name ?? ""));
  for (const s of sessions) { if (s.status !== "terminated") await api("POST", `/v1/sessions/${s.id}/archive`, {}); await api("DELETE", `/v1/sessions/${s.id}`); }
  const agents = (await api("GET", "/v1/agents")).data.filter((a) => /^smoke-/.test(a.name ?? ""));
  for (const a of agents) await api("DELETE", `/v1/agents/${a.id}`);
  record("cleanup", true, `removed ${sessions.length} sessions, ${agents.length} agents`);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} pass · ${failed.length} fail`);
process.exit(failed.length ? 1 : 0);
