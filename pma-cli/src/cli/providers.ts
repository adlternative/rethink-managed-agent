import { apiDelete, apiGet, apiPost, apiRequest } from "../lib/client.ts";
import { die, parseArgs, printJson, str, table } from "../lib/args.ts";

const USAGE = `providers subcommand:
  list
  get <id>
  create <id> --api openai-completions|openai-responses|anthropic-messages --base-url URL
         [--auth-env ENV_VAR | --key API_KEY (BYOK, sealed at rest) | --no-auth] [--name N] [--header k:v] [--models id[:ctx],...]
  update <id> [--base-url URL] [--auth-env E] [--enabled true|false] [--models ...] [--name N]
  delete <id>
example:
  pma providers create my-gw --api openai-completions --base-url https://gw.example.com/v1 --auth-env GW_KEY --models gpt-4.1:1000000,o4-mini:200000`;

function parseModels(spec: string) {
  return spec.split(",").filter(Boolean).map((part) => {
    const [id, ctx] = part.split(":");
    return { id, context_window: ctx ? Number(ctx) : 200_000 };
  });
}

function bodyFrom(flags: Record<string, string | true>): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  if (str(flags, "name")) b.name = str(flags, "name");
  if (str(flags, "api")) b.api = str(flags, "api");
  if (str(flags, "base-url")) b.base_url = str(flags, "base-url");
  if (str(flags, "auth-env")) b.auth = { type: "env", name: str(flags, "auth-env") };
  if (flags["no-auth"]) b.auth = { type: "none" };
  if (str(flags, "key")) b.auth = { type: "key", key: str(flags, "key") };
  if (str(flags, "models")) b.models = parseModels(str(flags, "models")!);
  if (str(flags, "enabled")) b.enabled = str(flags, "enabled") === "true";
  const h = str(flags, "header");
  if (h) { const i = h.indexOf(":"); if (i > 0) b.headers = { [h.slice(0, i).trim()]: h.slice(i + 1).trim() }; }
  return b;
}

export async function cmdProviders(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const [sub = "list", id] = positional;
  switch (sub) {
    case "list": case "ls": {
      const { data } = (await apiGet("/providers")) as { data: any[] };
      table([["ID", "API", "BASE URL", "AUTH", "MODELS", "ENABLED"], ...data.map((p) => [p.id, p.api, p.base_url, p.auth.type === "env" ? `env:${p.auth.name}` : p.auth.type === "encrypted" ? "byok (sealed)" : "none", String(p.models.length), String(p.enabled)])]);
      return;
    }
    case "get":
      if (!id) die("usage: pma providers get <id>");
      return printJson(await apiGet(`/providers/${id}`));
    case "create":
      if (!id) die(USAGE);
      return printJson(await apiPost("/providers", { id, ...bodyFrom(flags) }));
    case "update":
      if (!id) die(USAGE);
      return printJson(await apiRequest("PATCH", `/providers/${id}`, bodyFrom(flags)));
    case "delete": case "rm":
      if (!id) die("usage: pma providers delete <id>");
      return printJson(await apiDelete(`/providers/${id}`));
    default:
      die(USAGE);
  }
}
