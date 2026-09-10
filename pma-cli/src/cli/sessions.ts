import { apiDelete, apiGet, apiPost, fmtCtx, fmtTokens, type Session } from "../lib/client.ts";
import { loadConfig } from "../lib/config.ts";
import { die, fmtTime, parseArgs, printJson, str, table } from "../lib/args.ts";

const USAGE = `sessions subcommand:
  list [--status idle|running|terminated]
  get <id>
  create [--agent <id>] [--env <id>] [--workspace-id <id>] [--model provider/id] [--message <text>]
         [--environments main=<env_id>,<key>=<env_id>[:fork],...]   (attach several sandboxes; ":fork" forks main's workspace)
  attach <id> <key>=<env_id>[:fork]
  archive <id>
  delete <id>`;

export async function createSession(opts: { agent?: string; env?: string; workspaceId?: string; model?: string; message?: string; environments?: string }): Promise<Session> {
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
  if (opts.environments) body.environments = parseEnvList(opts.environments);
  if (opts.message) body.initial_events = [{ type: "user.message", content: [{ type: "text", text: opts.message }] }];
  return apiPost("/sessions", body);
}

/** "main=env_a,browser=env_b:fork" -> [{key, environment_id, fork_from?}] */
export function parseEnvList(spec: string) {
  return spec.split(",").map((part) => {
    const [key, rest] = part.split("=");
    if (!key || !rest) die(`bad environment spec ${part}; expected key=env_id[:fork]`);
    const [environment_id, flag] = rest.split(":");
    return { key, environment_id, ...(flag === "fork" ? { fork_from: "main" } : {}) };
  });
}

export async function cmdSessions(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const [sub = "list", a] = positional;
  switch (sub) {
    case "list": case "ls": {
      let { data } = (await apiGet("/sessions")) as { data: Session[] };
      if (str(flags, "status")) data = data.filter((s) => s.status === str(flags, "status"));
      table([["ID", "STATUS", "AGENT", "MODEL", "CTX", "TOKENS", "UPDATED"], ...data.map((s) => [s.id, s.status, s.agent.name, `${s.agent.model.provider}/${s.agent.model.id}`, fmtCtx(s.context), s.usage ? fmtTokens(s.usage.total_tokens) : "-", fmtTime(s.updated_at)])]);
      return;
    }
    case "get":
      if (!a) die("usage: pma sessions get <id>");
      return printJson(await apiGet(`/sessions/${a}`));
    case "create":
      return printJson(await createSession({ agent: str(flags, "agent"), env: str(flags, "env"), workspaceId: str(flags, "workspace-id"), model: str(flags, "model"), message: str(flags, "message"), environments: str(flags, "environments") }));
    case "attach": {
      const spec = positional[2];
      if (!a || !spec) die("usage: pma sessions attach <id> <key>=<env_id>[:fork]");
      return printJson(await apiPost(`/sessions/${a}/environments`, parseEnvList(spec)[0]));
    }
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
