import { apiDelete, apiGet, apiPost, type SandboxRow } from "../lib/client.ts";
import { die, fmtTime, parseArgs, printJson, table } from "../lib/args.ts";

const USAGE = `sandboxes subcommand:
  list [--all]      (--all includes destroyed)
  get <id>
  pause <id>        (ready only; docker stop / e2b snapshot on the reaper's next pass; resumes on next use)
  delete <id>       (ready or paused; a runner's reaper destroys it on its next pass)`;

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
    case "pause":
      if (!a) die("usage: pma sandboxes pause <id>");
      return printJson(await apiPost(`/sandboxes/${a}/pause`, {}));
    case "delete": case "rm":
      if (!a) die("usage: pma sandboxes delete <id>");
      return printJson(await apiDelete(`/sandboxes/${a}`));
    default:
      die(USAGE);
  }
}
