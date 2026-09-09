import { apiDelete, apiGet, apiPost, type Session } from "../lib/client.ts";
import { loadConfig } from "../lib/config.ts";
import { die, fmtTime, parseArgs, printJson, str, table } from "../lib/args.ts";

const USAGE = `sessions subcommand:
  list [--status idle|running|terminated]
  get <id>
  create [--agent <id>] [--env <id>] [--workspace-id <id>] [--model provider/id] [--message <text>]
  archive <id>
  delete <id>`;

export async function createSession(opts: { agent?: string; env?: string; workspaceId?: string; model?: string; message?: string }): Promise<Session> {
  const cfg = loadConfig();
  const agentId = opts.agent ?? cfg.default_agent_id;
  const envId = opts.env ?? cfg.default_env_id;
  if (!agentId || !envId) die("agent and environment are required: pass --agent/--env or set defaults with `pma --agent <id> --env <id>`");
  let agent: unknown = agentId;
  if (opts.model) {
    const [provider, ...rest] = opts.model.split("/");
    agent = { type: "agent_with_overrides", id: agentId, model: { provider, id: rest.join("/") } };
  }
  const body: Record<string, unknown> = { agent, environment_id: envId };
  if (opts.workspaceId) body.workspace_id = opts.workspaceId;
  if (opts.message) body.initial_events = [{ type: "user.message", content: [{ type: "text", text: opts.message }] }];
  return apiPost("/sessions", body);
}

export async function cmdSessions(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const [sub = "list", a] = positional;
  switch (sub) {
    case "list": case "ls": {
      let { data } = (await apiGet("/sessions")) as { data: Session[] };
      if (str(flags, "status")) data = data.filter((s) => s.status === str(flags, "status"));
      table([["ID", "STATUS", "AGENT", "MODEL", "UPDATED"], ...data.map((s) => [s.id, s.status, s.agent.name, `${s.agent.model.provider}/${s.agent.model.id}`, fmtTime(s.updated_at)])]);
      return;
    }
    case "get":
      if (!a) die("usage: pma sessions get <id>");
      return printJson(await apiGet(`/sessions/${a}`));
    case "create":
      return printJson(await createSession({ agent: str(flags, "agent"), env: str(flags, "env"), workspaceId: str(flags, "workspace-id"), model: str(flags, "model"), message: str(flags, "message") }));
    case "archive":
      if (!a) die("usage: pma sessions archive <id>");
      return printJson(await apiPost(`/sessions/${a}/archive`, {}));
    case "delete": case "rm":
      if (!a) die("usage: pma sessions delete <id>");
      await apiDelete(`/sessions/${a}`);
      return console.log(`✓ session ${a} deleted`);
    default:
      die(USAGE);
  }
}
