import { apiDelete, apiGet, apiPost, apiRequest } from "../lib/client.ts";
import { die, parseArgs, printJson, str, table } from "../lib/args.ts";

const USAGE = `schedules subcommand:
  list
  get <id>
  create --cron "min hour dom month dow" [--timezone TZ] [--name N]
         --action create --agent A --env E --message TEXT [--vaults vault_a,vault_b]
         --action message --session S --message TEXT
  update <id> [--cron EXPR] [--timezone TZ] [--name N] [--enabled true|false]
         [--action create|message ...]
  enable <id>   /   disable <id>
  delete <id>`;

function actionFrom(flags: Record<string, string | true>): Record<string, unknown> | undefined {
  const kind = str(flags, "action");
  if (!kind) return undefined;
  const message = str(flags, "message");
  if (!message) die(USAGE);
  if (kind === "create") {
    const agent = str(flags, "agent");
    const env = str(flags, "env");
    if (!agent || !env) die(USAGE);
    const body: Record<string, unknown> = { type: "session.create", agent_id: agent, environment_id: env, message };
    const vaults = str(flags, "vaults");
    if (vaults) body.vault_ids = vaults.split(",").filter(Boolean);
    return body;
  }
  if (kind === "message") {
    const session = str(flags, "session");
    if (!session) die(USAGE);
    return { type: "session.message", session_id: session, message };
  }
  die(`--action must be create or message (got ${JSON.stringify(kind)})`);
}

export async function cmdSchedules(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const [sub = "list", a] = positional;
  switch (sub) {
    case "list": case "ls": {
      const { data } = (await apiGet("/schedules")) as { data: any[] };
      table([["ID", "NAME", "CRON", "TZ", "ENABLED", "NEXT", "LAST"], ...data.map((s) => [s.id, s.name ?? "-", s.cron, s.timezone, String(s.enabled), String(s.next_run_at).slice(0, 16), s.last_run_status ?? "-"])]);
      return;
    }
    case "get": if (!a) die(USAGE); return printJson(await apiGet(`/schedules/${a}`));
    case "create": {
      const action = actionFrom(flags);
      const cron = str(flags, "cron");
      if (!action || !cron) die(USAGE);
      return printJson(await apiPost("/schedules", {
        cron,
        action,
        timezone: str(flags, "timezone") ?? "UTC",
        name: str(flags, "name"),
        ...(str(flags, "enabled") ? { enabled: str(flags, "enabled") === "true" } : {}),
      }));
    }
    case "update": {
      if (!a) die(USAGE);
      const body: Record<string, unknown> = {};
      if (str(flags, "cron")) body.cron = str(flags, "cron");
      if (str(flags, "timezone")) body.timezone = str(flags, "timezone");
      if (str(flags, "name") !== undefined) body.name = str(flags, "name");
      if (str(flags, "enabled")) body.enabled = str(flags, "enabled") === "true";
      const action = actionFrom(flags);
      if (action) body.action = action;
      if (!Object.keys(body).length) die("schedules update: nothing to change");
      return printJson(await apiRequest("PATCH", `/schedules/${a}`, body));
    }
    case "enable": if (!a) die(USAGE); return printJson(await apiRequest("PATCH", `/schedules/${a}`, { enabled: true }));
    case "disable": if (!a) die(USAGE); return printJson(await apiRequest("PATCH", `/schedules/${a}`, { enabled: false }));
    case "delete": case "rm": if (!a) die(USAGE); return printJson(await apiDelete(`/schedules/${a}`));
    default: die(USAGE);
  }
}
