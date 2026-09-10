import { loadConfig, saveConfig } from "./lib/config.ts";
import { parseArgs, str, die } from "./lib/args.ts";

const VERSION = process.env.CLI_VERSION ?? "dev";
const HELP = `pma — terminal client for pi-like-managed-agent (v${VERSION})

usage:
  pma                                   interactive chat (new session on first message)
  pma "do something"                    start a session with this message
  pma -r | --resume [<session_id>]      resume the latest / a specific session
  pma --agent <id> --env <id>           use (and remember) default agent / environment
  pma --model provider/id               model override for the new session
  pma --workspace-id <id>               reuse an existing workspace (shares its sandbox)

subcommands:
  login [--host URL] [--token T]        configure the API host (default http://localhost:8080)
  config [--host U] [--agent ID] [--env ID] [--header k:v]   set / show defaults
  logout
  models
  providers  list | get <id> | create <id> --api A --base-url U [--auth-env E] [--models id:ctx,...] | update <id> | delete <id>
  agents     list | get <id> | create <name> <provider/model> [--system S|--system-file F] [...] | update <id> [--system S ...]
  envs       list | get <id> | create <name> --provider local|docker|e2b [--image I] [--network bridge] [--plugin-host sandbox] [--git URL]
  sessions   list | get <id> | create [--environments ...] [--memory-stores mem[:path]] | attach | mount | unmount | skill add|remove | archive | delete
  session    events <id> | send <id> <text> [--wait] [--file path]... | stream <id> | interrupt <id> | export <id>
  sandboxes  list [--all] | get <id> | pause <id> | delete <id>
  files      upload <path> | list | get <id> | delete <id>
  skills     list | get <id> | create --file SKILL.md | version <id> --file SKILL.md | delete <id>
  memory-stores  list | get <id> | create <name> [--description D] | delete <id>
  worker     --env <id> --key <worker_key> [--workdir DIR]     run a BYOC sandbox worker on this machine

env: PMA_HOST, PMA_TOKEN, PMA_HEADERS (JSON), PMA_CONFIG (config path; default ~/.pma/config.json)`;

process.on("unhandledRejection", (e: any) => die(`Error: ${e?.message ?? e}`));

const argv = process.argv.slice(2);
const SUBCOMMANDS = new Set(["files", "skills", "memory-stores", "worker", "providers", "config", "login", "logout", "models", "agents", "envs", "environments", "sessions", "session", "sandboxes", "help"]);

if (argv[0] && SUBCOMMANDS.has(argv[0])) {
  const sub = argv.slice(1);
  try {
    switch (argv[0]) {
      case "config": (await import("./cli/config.ts")).cmdConfig(sub); break;
      case "login": (await import("./cli/login.ts")).cmdLogin(sub); break;
      case "logout": (await import("./cli/login.ts")).cmdLogout(); break;
      case "files": await (await import("./cli/files.ts")).cmdFiles(sub); break;
      case "skills": await (await import("./cli/skills.ts")).cmdSkills(sub); break;
      case "memory-stores": await (await import("./cli/memories.ts")).cmdMemoryStores(sub); break;
      case "worker": await (await import("./cli/worker.ts")).cmdWorker(sub); break;
      case "providers": await (await import("./cli/providers.ts")).cmdProviders(sub); break;
      case "models": await (await import("./cli/models.ts")).cmdModels(); break;
      case "agents": await (await import("./cli/agents.ts")).cmdAgents(sub); break;
      case "envs": case "environments": await (await import("./cli/envs.ts")).cmdEnvs(sub); break;
      case "sessions": await (await import("./cli/sessions.ts")).cmdSessions(sub); break;
      case "session": await (await import("./cli/session.ts")).cmdSession(sub); break;
      case "sandboxes": await (await import("./cli/sandboxes.ts")).cmdSandboxes(sub); break;
      default: console.log(HELP);
    }
  } catch (e: any) {
    die(`Error: ${e?.message ?? e}`);
  }
} else {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h) { console.log(HELP); process.exit(0); }
  if (flags.version || flags.v) { console.log(VERSION); process.exit(0); }
  // --agent/--env are remembered as defaults, like `qca --agent --env`
  const cfg = loadConfig();
  let changed = false;
  if (str(flags, "agent")) { cfg.default_agent_id = str(flags, "agent"); changed = true; }
  if (str(flags, "env")) { cfg.default_env_id = str(flags, "env"); changed = true; }
  if (changed) saveConfig(cfg);
  const resumeFlag = flags.resume ?? flags.r;
  const resume = resumeFlag === true ? (positional[0] ?? "latest") : typeof resumeFlag === "string" ? resumeFlag : undefined;
  const message = resume ? undefined : positional.join(" ") || undefined;
  const { startTUI } = await import("./tui/App.tsx");
  await startTUI({ resume, agent: cfg.default_agent_id, env: cfg.default_env_id, message, workspaceId: str(flags, "workspace-id"), model: str(flags, "model") });
  process.exit(0);
}
