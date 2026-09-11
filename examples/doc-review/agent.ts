/**
 * doc-review — a vendor-neutral analog of OpenAI's "Bulk invoice/contract review" showcase: a lead
 * agent fans work out to parallel specialist subagents, then aggregates. It exercises the multi-agent
 * path (OpenAI agent.multi_agent -> rethink team plugin: spawn_agent / wait_agents), which sev-bot and
 * code-agent didn't. No cloud creds. Requires COMPAT_TEAM_PACKAGE set on the API (see docker-compose).
 *
 * Run (stack up, COMPAT_TEAM_PACKAGE=/app/plugins/team on the api): npx tsx examples/doc-review/agent.ts
 * Env: DR_API (default http://localhost:8080/agents-api/v1), DR_MODEL (default qoder/ultimate).
 */
import { createClient } from "../../src/api/routes/compat/sdk/index.ts";

const API = process.env.DR_API ?? "http://localhost:8080/agents-api/v1";
const NATIVE = API.replace(/\/agents-api\/v1$/, "/v1");
const MODEL = process.env.DR_MODEL ?? "qoder/ultimate";
const TOKEN = process.env.DR_TOKEN;
const authHeaders: Record<string, string> = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};

async function ensureEnvironment(): Promise<string> {
  const res = await fetch(`${NATIVE}/environments`, { method: "POST", headers: { "content-type": "application/json", ...authHeaders }, body: JSON.stringify({ name: "doc-review", provider: "local", network: "none" }) });
  if (!res.ok) throw new Error(`create environment failed ${res.status}: ${await res.text()}`);
  return (await res.json()).id as string;
}

// three short "contracts" to review against a policy — stands in for the showcase's document batch
const CONTRACTS = [
  { id: "C-1", text: "Vendor grants a 30-day termination for convenience. Payment net-45. Liability capped at fees paid." },
  { id: "C-2", text: "Auto-renews for 3 years with no termination for convenience. Payment net-90. Unlimited liability." },
  { id: "C-3", text: "Termination for convenience 60 days. Payment net-30. Liability capped at 12 months fees." },
];
const POLICY = "Policy: termination-for-convenience must be <= 45 days; payment terms <= net-60; liability must be capped. Flag any clause that violates the policy.";

async function main() {
  const environment_id = await ensureEnvironment();
  const client = createClient({ baseURL: API, apiKey: TOKEN });
  const session = await client.beta.agents.sessions.create({
    agent: {
      model: MODEL,
      instructions:
        "You are the lead contract-review agent. You have team tools (spawn_agent, wait_agents, list_agents). " +
        "For EACH contract given, spawn ONE subagent with a focused prompt to review that contract against the policy and return a verdict (compliant / violations). " +
        "Spawn them so they run in parallel, then wait_agents for all of them, and finally produce one consolidated table: contract id -> verdict + which clause violates the policy.",
      multi_agent: { enabled: true, max_concurrent_subagents: 3 },
      tools: [],
    },
    environment: { type: "self_hosted", environment_id },
  });
  console.log(`[doc-review] session ${session.id} (multi-agent)\n`);

  const input = `${POLICY}\n\nContracts to review:\n` + CONTRACTS.map((c) => `${c.id}: ${c.text}`).join("\n");
  for await (const ev of session.stream({ input })) {
    if (ev.type === "response.output_text.delta" && ev.output_text_delta) process.stdout.write(ev.output_text_delta);
    else if (ev.type === "session.turn.item.added" && ev.function_call) console.log(`\n[team] ${ev.function_call.name}(${JSON.stringify(ev.function_call.arguments).slice(0, 120)})`);
    else if (ev.type === "agent.session.turn.completed") console.log(`\n[turn completed: ${ev.stop_reason}]`);
    else if (ev.type === "turn.failed") console.log(`\n[turn failed]`);
  }
  console.log("\n[doc-review] done.");
}
main().catch((e) => { console.error(e); process.exit(1); });
