import { apiDelete, apiGet, apiPost, apiRequest, fmtCtx, fmtTokens, type Session } from "../lib/client.ts";
import { loadConfig } from "../lib/config.ts";
import { die, fmtTime, parseArgs, printJson, str, table } from "../lib/args.ts";

const USAGE = `sessions subcommand:
  list [--status idle|running|terminated]
  get <id>
  create [--agent <id>] [--env <id>] [--workspace-id <id>] [--model provider/id] [--message <text>] [--memory-stores mem_a[:mount],mem_b]
         [--packages npm:x,/abs/path]   plugins for this session only (added to the agent's own)
         [--environments main=<env_id>,<key>=<env_id>[:fork],...]   (attach several sandboxes; ":fork" forks main's workspace)
  attach <id> <key>=<env_id>[:fork]
  mount <id> <mem_id>[:mount_path]      /  unmount <id> <mem_id>        (memory stores; next turn)
  skill <id> add <skill_id>             /  skill <id> remove <skill_id>
  packages list <id>                    /  packages add|remove <id> <name|source>   plugins; live from the next turn
  set-system <id> (--system <text> | --system-file F | --no-system)      change this session's system prompt (next turn)
  prompt <id>                           show the system prompt as actually sent
  archive <id>
  delete <id>`;

export async function createSession(opts: { agent?: string; env?: string; workspaceId?: string; model?: string; message?: string; environments?: string; memoryStores?: string; packages?: string[] }): Promise<Session> {
  const cfg = loadConfig();
  const agentId = opts.agent ?? cfg.default_agent_id;
  const envId = opts.env ?? cfg.default_env_id;
  if (!agentId || !envId) die("agent and environment are required: pass --agent/--env or set defaults with `pma --agent <id> --env <id>`");
  // model and plugins ride on the same per-session override: the saved agent is never changed
  const overrides: Record<string, unknown> = {};
  if (opts.model) { const [provider, ...rest] = opts.model.split("/"); overrides.model = { provider, id: rest.join("/") }; }
  if (opts.packages?.length) {
    // an override replaces the field, so adding a plugin to one session would otherwise drop the
    // agent's own — union them, because "add" should only ever add
    const agentRow = (await apiGet(`/agents/${agentId}`)) as { packages?: string[] };
    overrides.packages = [...new Set([...(agentRow.packages ?? []), ...opts.packages])];
  }
  const agent: unknown = Object.keys(overrides).length ? { type: "agent_with_overrides", id: agentId, ...overrides } : agentId;
  const body: Record<string, unknown> = { agent, environment_id: envId };
  if (opts.workspaceId) body.workspace_id = opts.workspaceId;
  if (opts.environments) body.environments = parseEnvList(opts.environments);
  if (opts.memoryStores) body.memory_stores = opts.memoryStores.split(",").map((x) => { const [id, mp] = x.split(":"); return mp ? { memory_store_id: id, mount_path: mp } : id; });
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
      if (flags.json) return printJson(data);
      table([["ID", "STATUS", "AGENT", "MODEL", "CTX", "TOKENS", "UPDATED"], ...data.map((s) => [s.id, s.status, s.agent.name, `${s.agent.model.provider}/${s.agent.model.id}`, fmtCtx(s.context), s.usage ? fmtTokens(s.usage.total_tokens) : "-", fmtTime(s.updated_at)])]);
      return;
    }
    case "get":
      if (!a) die("usage: pma sessions get <id>");
      return printJson(await apiGet(`/sessions/${a}`));
    case "create":
      return printJson(await createSession({
        agent: str(flags, "agent"), env: str(flags, "env"), workspaceId: str(flags, "workspace-id"), model: str(flags, "model"),
        message: str(flags, "message"), environments: str(flags, "environments"), memoryStores: str(flags, "memory-stores"),
        packages: str(flags, "packages")?.split(",").map((x) => x.trim()).filter(Boolean),
      }));
    case "attach": {
      const spec = positional[2];
      if (!a || !spec) die("usage: pma sessions attach <id> <key>=<env_id>[:fork]");
      return printJson(await apiPost(`/sessions/${a}/environments`, parseEnvList(spec)[0]));
    }
    case "mount": {
      const [mid, mp] = (positional[2] ?? "").split(":");
      if (!a || !mid) die("usage: pma sessions mount <session> <mem_id>[:mount_path]");
      return printJson(await apiPost(`/sessions/${a}/memory_stores`, mp ? { memory_store_id: mid, mount_path: mp } : { memory_store_id: mid }));
    }
    case "unmount":
      if (!a || !positional[2]) die("usage: pma sessions unmount <session> <mem_id>");
      return printJson(await apiDelete(`/sessions/${a}/memory_stores/${positional[2]}`));
    case "skill": {
      const [, , op, sid] = positional;
      if (!a || !sid || (op !== "add" && op !== "remove")) die("usage: pma sessions skill <session> add|remove <skill_id>");
      return printJson(op === "add" ? await apiPost(`/sessions/${a}/skills`, { type: "custom", skill_id: sid }) : await apiDelete(`/sessions/${a}/skills/${sid}`));
    }
    // Plugins for one session: `packages list <id>` / `packages add|remove <id> <name|source>`. A bare
    // catalogue name is accepted, since that is what `pma plugins` prints.
    case "packages": case "plugins": {
      const [, op, sid, src] = positional;
      if (op === "list" || op === "ls") {
        if (!sid) die("usage: pma sessions packages list <session>");
        const s = (await apiGet(`/sessions/${sid}`)) as Session;
        const list = s.agent.packages ?? [];
        if (flags.json) return printJson(list);
        return list.length ? table([["SOURCE"], ...list.map((p) => [p])]) : console.log("(none)");
      }
      if ((op !== "add" && op !== "remove" && op !== "rm") || !sid || !src) die("usage: pma sessions packages list <session> | packages add|remove <session> <name|source>");
      const known = ((await apiGet("/plugins")) as { data: { name: string; source: string }[] }).data.find((p) => p.name === src);
      const source = known?.source ?? src;
      return printJson(op === "add"
        ? await apiPost(`/sessions/${sid}/packages`, { source })
        : await apiDelete(`/sessions/${sid}/packages/${encodeURIComponent(source)}`));
    }
    case "set-system": {
      if (!a) die(USAGE);
      const system = flags["no-system"] ? null : str(flags, "system") ?? (str(flags, "system-file") ? await (await import("node:fs/promises")).readFile(str(flags, "system-file")!, "utf8") : undefined);
      if (system === undefined) die("usage: pma sessions set-system <id> --system <text> | --system-file F | --no-system");
      return printJson(await apiRequest("PATCH", `/sessions/${a}`, { system }));
    }
    case "prompt": {
      if (!a) die(USAGE);
      const r = (await apiGet(`/sessions/${a}/system_prompt`)) as { rendered: string; source: string };
      console.log(`# source: ${r.source}\n${r.rendered}`);
      return;
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
