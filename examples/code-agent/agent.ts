/**
 * code-agent — a vendor-neutral analog of OpenAI's "Data agent" / "GitHub issue investigation"
 * showcases: an agent that actually RUNS commands in a sandbox (the path sev-bot never used). It maps
 * OpenAI environment.type=self_hosted to a rethink sandbox provider (docker here) and uses the builtin
 * bash/write/read tools, which execute inside the sibling container. No cloud creds.
 *
 * Run (stack up): npx tsx examples/code-agent/agent.ts
 * Env: CODE_API (default http://localhost:8080/agents-api/v1), CODE_MODEL (default qoder/ultimate),
 *      CODE_PROVIDER (sandbox provider, default docker), CODE_IMAGE (default node:22-alpine).
 */
import { createClient } from "../../src/api/routes/compat/sdk/index.ts";

const API = process.env.CODE_API ?? "http://localhost:8080/agents-api/v1";
const NATIVE = API.replace(/\/agents-api\/v1$/, "/v1");
const MODEL = process.env.CODE_MODEL ?? "qoder/ultimate";
const PROVIDER = process.env.CODE_PROVIDER ?? "docker";
const IMAGE = process.env.CODE_IMAGE ?? "node:22-alpine";
const TOKEN = process.env.CODE_TOKEN;
const authHeaders: Record<string, string> = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};

async function ensureEnvironment(): Promise<string> {
  const body: Record<string, unknown> = { name: "code-agent", provider: PROVIDER, network: "none" };
  if (PROVIDER === "docker" || PROVIDER === "e2b") body.image = IMAGE;
  const res = await fetch(`${NATIVE}/environments`, { method: "POST", headers: { "content-type": "application/json", ...authHeaders }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`create environment failed ${res.status}: ${await res.text()}`);
  return (await res.json()).id as string;
}

async function main() {
  const environment_id = await ensureEnvironment();
  console.log(`[code-agent] environment ${environment_id} (${PROVIDER}${PROVIDER === "docker" ? "/" + IMAGE : ""}); model ${MODEL}`);
  const client = createClient({ baseURL: API, apiKey: TOKEN });

  const session = await client.beta.agents.sessions.create({
    agent: {
      model: MODEL,
      instructions: "You are a coding agent working in a fresh Linux sandbox. Use the bash tool to do the work, verify by running it, and report the concrete result. Keep it tight.",
      tools: [{ type: "bash" }, { type: "write" }, { type: "read" }], // builtin tools -> run inside the sandbox
    },
    environment: { type: "self_hosted", environment_id, workspace_directory: "/workspace" },
  });
  console.log(`[code-agent] session ${session.id}\n`);

  const task = "Create a file nums.txt with the numbers 1 to 10, one per line. Then compute their sum with a shell command and tell me the total. Finally list the files in the workspace.";
  for await (const ev of session.stream({ input: task })) {
    if (ev.type === "response.output_text.delta" && ev.output_text_delta) process.stdout.write(ev.output_text_delta);
    else if (ev.type === "session.turn.item.added" && ev.function_call) console.log(`\n[bash] ${JSON.stringify(ev.function_call.arguments).slice(0, 160)}`);
    else if (ev.type === "agent.session.turn.completed") console.log(`\n[turn completed: ${ev.stop_reason}]`);
    else if (ev.type === "turn.failed") console.log(`\n[turn failed]`);
  }
  console.log("\n[code-agent] done.");
}
main().catch((e) => { console.error(e); process.exit(1); });
