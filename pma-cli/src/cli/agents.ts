import { apiGet, apiPost, apiRequest, type Agent } from "../lib/client.ts";
import { die, parseArgs, printJson, str, table } from "../lib/args.ts";

const USAGE = `agents subcommand:
  list
  get <id>
  create <name> <provider/model> [--system <prompt> | --system-file F] [--tools bash,read,write,edit] [--packages npm:x,git:y,/path] [--skills skill_a,skill_b]
  update <id> [--system <prompt> | --system-file F | --no-system] [--name N] [--model p/m] [--tools ...] [--packages ...] [--skills ...]
  (system prompt placeholders: {{skills}} {{memory}} {{plugins}} — use any of them to lay the prompt out yourself)
example:
  pma agents create coder qoder/ultimate --system "You are a careful engineer"`;

export async function cmdAgents(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const [sub = "list", a, b] = positional;
  switch (sub) {
    case "list": case "ls": {
      const { data } = (await apiGet("/agents")) as { data: Agent[] };
      if (flags.json) return printJson(data);
      table([["ID", "NAME", "MODEL", "TOOLS", "PACKAGES"], ...data.map((x) => [x.id, x.name, `${x.model.provider}/${x.model.id}`, x.tools.join(","), (x.packages ?? []).join(",")])]);
      return;
    }
    case "get":
      if (!a) die("usage: pma agents get <id>");
      return printJson(await apiGet(`/agents/${a}`));
    case "create": {
      if (!a || !b || !b.includes("/")) die(USAGE);
      const [provider, ...rest] = b.split("/");
      const body: Record<string, unknown> = { name: a, model: { provider, id: rest.join("/") } };
      if (str(flags, "system")) body.system = str(flags, "system");
      if (str(flags, "system-file")) body.system = await (await import("node:fs/promises")).readFile(str(flags, "system-file")!, "utf8");
      if (str(flags, "tools")) body.tools = str(flags, "tools")!.split(",");
      if (str(flags, "packages")) body.packages = str(flags, "packages")!.split(",");
      if (str(flags, "skills")) body.skills = str(flags, "skills")!.split(",");
      return printJson(await apiPost("/agents", body));
    }
    case "update": {
      if (!a) die(USAGE);
      const body: Record<string, unknown> = {};
      if (str(flags, "name")) body.name = str(flags, "name");
      if (str(flags, "model")) { const [provider, ...rest] = str(flags, "model")!.split("/"); body.model = { provider, id: rest.join("/") }; }
      if (str(flags, "system")) body.system = str(flags, "system");
      if (str(flags, "system-file")) body.system = await (await import("node:fs/promises")).readFile(str(flags, "system-file")!, "utf8");
      if (flags["no-system"]) body.system = null;
      if (str(flags, "tools")) body.tools = str(flags, "tools")!.split(",");
      if (str(flags, "packages")) body.packages = str(flags, "packages")!.split(",");
      if (str(flags, "skills")) body.skills = str(flags, "skills")!.split(",");
      return printJson(await apiRequest("PATCH", `/agents/${a}`, body));
    }
    default:
      die(USAGE);
  }
}
