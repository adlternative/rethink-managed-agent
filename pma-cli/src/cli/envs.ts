import { apiGet, apiPost, type Environment } from "../lib/client.ts";
import { die, parseArgs, printJson, str, table } from "../lib/args.ts";

const USAGE = `envs subcommand:
  list
  get <id>
  create <name> --provider local|docker|e2b [--image <docker image | e2b template>] [--git <remote> [--ref <ref>]] [--local <host path>]`;

export async function cmdEnvs(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const [sub = "list", a] = positional;
  switch (sub) {
    case "list": case "ls": {
      const { data } = (await apiGet("/environments")) as { data: Environment[] };
      table([["ID", "NAME", "PROVIDER", "IMAGE", "WORKSPACE"], ...data.map((e) => [e.id, e.name, e.provider, e.image ?? "-", JSON.stringify(e.workspace)])]);
      return;
    }
    case "get":
      if (!a) die("usage: pma envs get <id>");
      return printJson(await apiGet(`/environments/${a}`));
    case "create": {
      const provider = str(flags, "provider");
      if (!a || !provider) die(USAGE);
      const workspace = str(flags, "git") ? { kind: "git", remote: str(flags, "git"), ref: str(flags, "ref") }
        : str(flags, "local") ? { kind: "local", path: str(flags, "local") } : { kind: "empty" };
      return printJson(await apiPost("/environments", { name: a, provider, image: str(flags, "image"), workspace }));
    }
    default:
      die(USAGE);
  }
}
