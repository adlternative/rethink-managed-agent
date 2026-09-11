/**
 * docs-qa — mirrors OpenAI's Agents API quickstart ("Use the OpenAI documentation MCP ... to answer
 * technical questions") but through rethink's compat layer with a REAL MCP client. The agent gets a
 * {type:"mcp"} tool pointing at the public OpenAI docs MCP server; rethink connects to it server-side
 * (runner), lists its tools, and lets the model call them. Vendor-neutral: model is any provider.
 *
 * Run (stack up): npx tsx examples/docs-qa/agent.ts "your question"
 * Env: DQ_API (default http://localhost:8080/agents-api/v1), DQ_MODEL (default qoder/ultimate),
 *      DQ_MCP_URL (default https://developers.openai.com/mcp).
 */
import { createClient } from "../../src/api/routes/compat/sdk/index.ts";

const API = process.env.DQ_API ?? "http://localhost:8080/agents-api/v1";
const NATIVE = API.replace(/\/agents-api\/v1$/, "/v1");
const MODEL = process.env.DQ_MODEL ?? "qoder/ultimate";
const MCP_URL = process.env.DQ_MCP_URL ?? "https://developers.openai.com/mcp";
const TOKEN = process.env.DQ_TOKEN;
const authHeaders: Record<string, string> = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};
const question = process.argv.slice(2).join(" ") || "How do I connect an MCP server to an agent? Cite a doc page.";

async function ensureEnvironment(): Promise<string> {
  const res = await fetch(`${NATIVE}/environments`, { method: "POST", headers: { "content-type": "application/json", ...authHeaders }, body: JSON.stringify({ name: "docs-qa", provider: "local", network: "none" }) });
  if (!res.ok) throw new Error(`create environment failed ${res.status}: ${await res.text()}`);
  return (await res.json()).id as string;
}

async function main() {
  const environment_id = await ensureEnvironment();
  const client = createClient({ baseURL: API, apiKey: TOKEN });
  const session = await client.beta.agents.sessions.create({
    agent: {
      model: MODEL,
      instructions: "Answer the user's technical question using the OpenAI docs MCP tools (search then fetch the relevant page). Be concise and cite the doc URL you used.",
      tools: [
        { type: "mcp", server_label: "openai_docs", transport: { type: "http", server_url: MCP_URL }, allowed_tools: ["search_openai_docs", "fetch_openai_doc", "list_openai_docs"] },
      ],
    },
    environment: { type: "self_hosted", environment_id },
  });
  console.log(`[docs-qa] session ${session.id}; mcp ${MCP_URL}\nQ: ${question}\n`);
  for await (const ev of session.stream({ input: question })) {
    if (ev.type === "response.output_text.delta" && ev.output_text_delta) process.stdout.write(ev.output_text_delta);
    else if (ev.type === "session.turn.item.added" && ev.function_call) console.log(`\n[mcp] ${ev.function_call.name}(${JSON.stringify(ev.function_call.arguments).slice(0,120)})`);
    else if (ev.type === "agent.session.turn.completed") console.log(`\n[turn completed: ${ev.stop_reason}]`);
    else if (ev.type === "turn.failed") console.log(`\n[turn failed]`);
  }
  console.log("\n[docs-qa] done.");
}
main().catch((e) => { console.error(e); process.exit(1); });
