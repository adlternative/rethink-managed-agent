/**
 * Creates agent + env + vault + Slack integration for a coding bot.
 * Requires SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, and PMA_PUBLIC_URL (Slack-reachable API base).
 */
const API = (process.env.PMA_API ?? process.env.PMA_HOST ?? "http://localhost:8080").replace(/\/$/, "");
const PUBLIC = (process.env.PMA_PUBLIC_URL ?? API).replace(/\/$/, "");
const TOKEN = process.env.PMA_API_KEY ?? process.env.PMA_TOKEN ?? "";
const BOT = process.env.SLACK_BOT_TOKEN ?? "";
const SIGNING = process.env.SLACK_SIGNING_SECRET ?? "";
const MODEL = process.env.SLACK_MODEL ?? "qoder/ultimate";

if (!BOT || !SIGNING) {
  console.error("Set SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET in the environment (values are never logged).");
  process.exit(2);
}

const headers: Record<string, string> = { "content-type": "application/json" };
if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return data as T;
}

const [provider, modelId] = MODEL.includes("/") ? MODEL.split("/", 2) as [string, string] : ["qoder", MODEL];

const env = await api<{ id: string }>("POST", "/v1/environments", {
  name: "slack-coding",
  provider: process.env.SLACK_PROVIDER ?? "local",
  workspace: { kind: "empty" },
});

const agent = await api<{ id: string }>("POST", "/v1/agents", {
  name: "slack-coding-agent",
  model: { provider, id: modelId },
  system: "You are a coding agent in Slack. Keep replies concise; use tools when you need the workspace.",
  tools: ["bash", "read", "write", "edit"],
});

const vault = await api<{ id: string }>("POST", "/v1/vaults", { name: "slack-coding" });
await api("POST", `/v1/vaults/${vault.id}/credentials`, { name: "SLACK_BOT_TOKEN", value: BOT });
await api("POST", `/v1/vaults/${vault.id}/credentials`, { name: "SLACK_SIGNING_SECRET", value: SIGNING });

const integration = await api<{ id: string }>("POST", "/v1/integrations", {
  kind: "slack",
  name: "slack-coding-agent",
  agent_id: agent.id,
  environment_id: env.id,
  vault_id: vault.id,
  config: {},
});

console.log(JSON.stringify({
  agent_id: agent.id,
  environment_id: env.id,
  vault_id: vault.id,
  integration_id: integration.id,
  events_url: `${PUBLIC}/v1/integrations/${integration.id}/events`,
  interactions_url: `${PUBLIC}/v1/integrations/${integration.id}/interactions`,
}, null, 2));
console.log("Paste the URLs into your Slack app (Event Subscriptions + Interactivity). Secrets were written to the vault only.");
