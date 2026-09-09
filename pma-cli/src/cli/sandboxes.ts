import { apiDelete, apiGet, type SandboxRow } from "../lib/client.ts";
import { die, fmtTime, parseArgs, printJson, table } from "../lib/args.ts";

const USAGE = `sandboxes subcommand:
  list [--all]      (--all includes destroyed)
  get <id>
  delete <id>       (ready sandboxes only; a runner's reaper destroys it on its next pass)`;

export async function cmdSandboxes(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const [sub = "list", a] = positional;
  switch (sub) {
    case "list": case "ls": {
      const { data } = (await apiGet(`/sandboxes${flags.all ? "?include_destroyed=true" : ""}`)) as { data: SandboxRow[] };
      table([["ID", "PROVIDER", "STATUS", "WORKSPACE", "LAST USED"], ...data.map((s) => [s.id, s.provider, s.status, s.workspace_id ?? "-", fmtTime(s.last_used_at)])]);
      return;
    }
    case "get":
      if (!a) die("usage: pma sandboxes get <id>");
      return printJson(await apiGet(`/sandboxes/${a}`));
    case "delete": case "rm":
      if (!a) die("usage: pma sandboxes delete <id>");
      return printJson(await apiDelete(`/sandboxes/${a}`));
    default:
      die(USAGE);
  }
}
