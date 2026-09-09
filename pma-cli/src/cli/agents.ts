import { apiGet, apiPost, type Agent } from "../lib/client.ts";
import { die, parseArgs, printJson, str, table } from "../lib/args.ts";

const USAGE = `agents subcommand:
  list
  get <id>
  create <name> <provider/model> [--system <prompt>] [--tools bash,read,write,edit]
example:
  pma agents create coder qoder/ultimate --system "You are a careful engineer"`;

export async function cmdAgents(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const [sub = "list", a, b] = positional;
  switch (sub) {
    case "list": case "ls": {
      const { data } = (await apiGet("/agents")) as { data: Agent[] };
      table([["ID", "NAME", "MODEL", "TOOLS"], ...data.map((x) => [x.id, x.name, `${x.model.provider}/${x.model.id}`, x.tools.join(",")])]);
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
      if (str(flags, "tools")) body.tools = str(flags, "tools")!.split(",");
      return printJson(await apiPost("/agents", body));
    }
    default:
      die(USAGE);
  }
}
