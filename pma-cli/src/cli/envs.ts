import { apiGet, apiPost, type Environment } from "../lib/client.ts";
import { die, parseArgs, printJson, str, table } from "../lib/args.ts";

const USAGE = `envs subcommand:
  list
  get <id>
  create <name> --provider local|docker|e2b|byoc [--image <docker image | e2b template>] [--network none|bridge] [--plugin-host runner|sandbox]
         (byoc: the response includes worker_key once; run: pma worker --env <id> --key <worker_key>  on your machine)
                [--git <remote> [--ref <ref>]] [--local <host path>]`;

export async function cmdEnvs(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const [sub = "list", a] = positional;
  switch (sub) {
    case "list": case "ls": {
      const { data } = (await apiGet("/environments")) as { data: Environment[] };
      table([["ID", "NAME", "PROVIDER", "IMAGE", "NET", "PLUGINS", "WORKSPACE"], ...data.map((e) => [e.id, e.name, e.provider, e.image ?? "-", e.network ?? "none", e.plugin_host ?? "runner", JSON.stringify(e.workspace)])]);
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
      return printJson(await apiPost("/environments", { name: a, provider, image: str(flags, "image"), network: str(flags, "network"), plugin_host: str(flags, "plugin-host"), workspace }));
    }
    default:
      die(USAGE);
  }
}
