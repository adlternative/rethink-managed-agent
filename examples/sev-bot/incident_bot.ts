/**
 * sev-bot — a vendor-neutral analog of OpenAI's Agents API "SRE incident response" showcase, running
 * against rethink-managed-agent. It exercises the SAME mechanics as the OpenAI sample — a session per
 * incident, streaming, client/function tools with caller-side handlers, and one approval-gated tool
 * that surfaces a required_action a human answers — but needs NO GitHub/AWS/OpenAI credentials: the
 * read-only tools read local fixtures, the model is any rethink provider, and the environment is a
 * pluggable sandbox provider (local/docker). No cloud vendor is bound.
 *
 * Run (with the rethink stack up: api + runner + redis + postgres, and a `qoder`/other provider):
 *   npx tsx examples/sev-bot/incident_bot.ts
 * Env: SEV_API (default http://localhost:8080/agents-api/v1), SEV_MODEL (default qoder/ultimate),
 *      SEV_TOKEN (optional bearer if AUTH_REQUIRED=true), SEV_PROVIDER (env provider, default local).
 */
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "../../src/api/routes/compat/sdk/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.SEV_API ?? "http://localhost:8080/agents-api/v1";
const NATIVE = API.replace(/\/agents-api\/v1$/, "/v1");
const MODEL = process.env.SEV_MODEL ?? "qoder/ultimate";
const TOKEN = process.env.SEV_TOKEN;
const PROVIDER = process.env.SEV_PROVIDER ?? "local";
const authHeaders: Record<string, string> = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};

/** Create a rethink environment (native API) to back OpenAI environment.type=self_hosted. */
async function ensureEnvironment(): Promise<string> {
  const res = await fetch(`${NATIVE}/environments`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ name: "sev-bot", provider: PROVIDER, network: "none" }),
  });
  if (!res.ok) throw new Error(`create environment failed ${res.status}: ${await res.text()}`);
  return (await res.json()).id as string;
}

// --- caller-side tool handlers (read-only; local fixtures stand in for GitHub-MCP / log search) ---
const handlers = {
  async get_incident_details() {
    return JSON.parse(await readFile(path.join(here, "fixtures/incident.json"), "utf8"));
  },
  async search_logs(args: { query?: string; service?: string }) {
    const log = await readFile(path.join(here, "fixtures/app.log"), "utf8");
    const q = (args?.query ?? "").toLowerCase();
    const matches = log.split("\n").filter((l) => (q ? l.toLowerCase().includes(q) : /error|warn/i.test(l)));
    return { matches: matches.slice(0, 20) };
  },
  // propose_rollback is intentionally NOT handled here -> it becomes a required_action a human approves.
};

const tools = [
  { type: "function", name: "get_incident_details", description: "Fetch the alert/incident record.", parameters: { type: "object", properties: {} } },
  { type: "function", name: "search_logs", description: "Search service logs.", parameters: { type: "object", properties: { query: { type: "string" }, service: { type: "string" } } } },
  { type: "function", name: "propose_rollback", description: "Propose rolling a service back to a previous version. Requires human approval.", parameters: { type: "object", properties: { service: { type: "string" }, to_version: { type: "string" } }, required: ["service", "to_version"] } },
];

async function main() {
  const environment_id = await ensureEnvironment();
  console.log(`[sev-bot] environment ${environment_id}; model ${MODEL}; api ${API}`);
  const client = createClient({ baseURL: API, apiKey: TOKEN });

  const session = await client.beta.agents.sessions.create({
    agent: {
      model: MODEL,
      instructions:
        "You are sev-bot, an on-call incident responder. Investigate the incident using get_incident_details and search_logs, " +
        "state the most likely root cause in one or two sentences, then call propose_rollback with the service and the safe previous version. " +
        "Do not claim to have executed anything; propose_rollback only proposes.",
      multi_agent: { enabled: false },
      tools,
    },
    environment: { type: "self_hosted", environment_id, workspace_directory: "/workspace" },
  });
  console.log(`[sev-bot] session ${session.id}`);

  // Approval gate. Interactive TTY -> ask; non-interactive (piped/CI) or SEV_AUTO_APPROVE set -> decide
  // from SEV_AUTO_APPROVE (default "approve") without readline, so the demo is runnable unattended.
  const auto = !process.stdin.isTTY || process.env.SEV_AUTO_APPROVE !== undefined;
  const autoApprove = (process.env.SEV_AUTO_APPROVE ?? "approve").toLowerCase() !== "deny";
  const rl = auto ? null : createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string): Promise<boolean> => {
    if (auto) { console.log(`${q}${autoApprove ? "y (auto)" : "n (auto)"}`); return autoApprove; }
    const a = (await rl!.question(q)).trim().toLowerCase();
    return a === "y" || a === "yes";
  };

  // The read-only tools auto-resolve via `handlers`; propose_rollback has no handler, so it surfaces
  // as action_required while its turn stays open — we approve/deny INLINE and submit tool_result,
  // which unblocks that call and lets the same turn continue.
  for await (const ev of session.stream({ input: "Investigate the checkout-api 5xx spike and remediate.", tool_handlers: handlers })) {
    if (ev.type === "response.output_text.delta" && ev.output_text_delta) process.stdout.write(ev.output_text_delta);
    else if (ev.type === "session.turn.item.added" && ev.function_call) console.log(`\n[tool] ${ev.function_call.name}(${JSON.stringify(ev.function_call.arguments)})`);
    else if (ev.type === "agent.session.action_required" && ev.required_action?.name === "propose_rollback") {
      const ra = ev.required_action;
      const approved = await ask(`\n[approval] sev-bot proposes rollback ${JSON.stringify(ra.arguments)} — approve? (y/N) `);
      await session.tool_result({ call_id: ra.call_id, turn_id: ra.turn_id, success: true, output: { decision: approved ? "approved" : "denied", executed: false } });
      console.log(`[approval] ${approved ? "approved" : "denied"} — submitted; sev-bot continues.`);
    } else if (ev.type === "agent.session.turn.completed") console.log(`\n[turn completed: ${ev.stop_reason}]`);
  }

  rl?.close();
  console.log("\n[sev-bot] done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
