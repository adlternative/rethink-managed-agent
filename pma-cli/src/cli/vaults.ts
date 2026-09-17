import { readFileSync } from "node:fs";
import { apiDelete, apiGet, apiPost } from "../lib/client.ts";
import { die, parseArgs, printJson, str, table } from "../lib/args.ts";

/**
 * Vaults hold the credentials a session lends to its agent: environment variables injected into the
 * sandbox, and MCP tokens the runner sends to a declared server. Secret values are write-only — the API
 * returns a credential's name and kind, never its value — so they are only ever passed in, never read
 * back here either.
 */
const USAGE = `vaults subcommand:
  list                                   /  get <id>  /  create [name] [--metadata k=v,k2=v2]  /  delete <id>
  credentials list <vault>
  credentials put <vault> <name> (--value V | --value-env VAR | --value-stdin) [--mcp-url URL]
         --mcp-url stores an MCP bearer token for that server instead of a sandbox environment variable
  credentials delete <vault> <name>
(prefer --value-env or --value-stdin: --value lands in your shell history)`;

const kv = (s?: string) => (s ? Object.fromEntries(s.split(",").map((p) => { const i = p.indexOf("="); return [p.slice(0, i), p.slice(i + 1)]; })) : undefined);

async function secretValue(flags: Record<string, string | true>): Promise<string> {
  const inline = str(flags, "value");
  if (inline) return inline;
  const fromEnv = str(flags, "value-env");
  if (fromEnv) {
    const v = process.env[fromEnv];
    if (!v) die(`environment variable ${fromEnv} is empty`);
    return v!;
  }
  if (flags["value-stdin"]) return readFileSync(0, "utf8").replace(/\n$/, "");
  die("a secret is required: --value V | --value-env VAR | --value-stdin");
  return "";
}

export async function cmdVaults(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const [sub = "list", a, b, c] = positional;
  switch (sub) {
    case "list": case "ls": {
      const { data } = (await apiGet("/vaults")) as { data: { id: string; name: string | null; created_at: string }[] };
      if (flags.json) return printJson(data);
      return data.length ? table([["ID", "NAME", "CREATED"], ...data.map((v) => [v.id, v.name ?? "-", v.created_at])]) : console.log("(none)");
    }
    case "get":
      if (!a) die("usage: pma vaults get <id>");
      return printJson(await apiGet(`/vaults/${a}`));
    case "create":
      return printJson(await apiPost("/vaults", { name: a ?? str(flags, "name"), metadata: kv(str(flags, "metadata")) }));
    case "delete": case "rm":
      if (!a) die("usage: pma vaults delete <id>");
      return printJson(await apiDelete(`/vaults/${a}`));
    case "credentials": case "credential": case "creds": {
      const [op, vault, name] = [a, b, c];
      if (!vault) die(USAGE);
      switch (op) {
        case "list": case "ls": {
          const { data } = (await apiGet(`/vaults/${vault}/credentials`)) as { data: { id: string; name: string; kind?: string; mcp_server_url?: string | null; created_at: string }[] };
          if (flags.json) return printJson(data);
          return data.length ? table([["ID", "NAME", "KIND", "MCP SERVER", "CREATED"], ...data.map((x) => [x.id, x.name, x.kind ?? "-", x.mcp_server_url ?? "-", x.created_at])]) : console.log("(none)");
        }
        case "put": case "set": {
          if (!name) die(USAGE);
          const value = await secretValue(flags);
          const mcpUrl = str(flags, "mcp-url");
          const body = mcpUrl
            ? { name, auth: { type: "static_bearer", mcp_server_url: mcpUrl, token: value }, metadata: kv(str(flags, "metadata")) }
            : { name, value, metadata: kv(str(flags, "metadata")) };
          return printJson(await apiPost(`/vaults/${vault}/credentials`, body));
        }
        case "delete": case "rm":
          if (!name) die(USAGE);
          return printJson(await apiDelete(`/vaults/${vault}/credentials/${encodeURIComponent(name)}`));
        default: die(USAGE);
      }
      return;
    }
    default: die(USAGE);
  }
}
