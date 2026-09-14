/** Command dispatcher for the pma CLI: resource commands, send/stream/events and the BYOC worker. */
import { readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { int, list, modelRef, need, parse, str, UsageError, type Flags } from "./args.ts";
import { ctx, makePrinter, summarize, table, waitOutcome, type Out } from "./format.ts";
import { Client, resolveConfig } from "./http.ts";
import { runWorker } from "./worker.ts";

export interface Io {
  /** raw stdout / stderr writers (no newline added) */
  stdout(s: string): void;
  stderr(s: string): void;
  env: NodeJS.ProcessEnv;
  readStdin(): Promise<string>;
}

interface Ctx { io: Io; api: Client; flags: Flags; json: boolean; out: Out; print(v: unknown): void; line(s: string): void }

const seg = encodeURIComponent;

export const HELP = `pma CLI (npm run cli -- <command>) — scriptable client for the rethink-managed-agent API

usage: <command> [subcommand] [args] [--flag value | --flag=value] [--json] [--help]

resources:
  agents         list | get <id> | create <name> <provider/model> [...] | update <id> [...] | delete <id>
  envs           list | get <id> | create <name> --provider local|docker|e2b|byoc [...] | delete <id>
  sessions       list | get <id> | create --agent A --env E [...] | delete <id> | archive <id> | prompt <id>
                 set-system <id> | attach <id> <key>=<env> | mount|unmount <id> <mem> | skill <id> add|remove <skill>
  vaults         list | get <id> | create [name] | delete <id> | credentials list|put|delete <vault> [name]
  memory-stores  list | get <id> | create <name> [--description D] | delete <id>
  files          list | get <id> | upload <path> | download <id> [--out F] | delete <id>
  skills         list | get <id> | create --file SKILL.md | version <id> --file SKILL.md | delete <id>
  providers      list | get <id> | create <id> --api A --base-url U [...] | update <id> [...] | delete <id>
  models         list
  sandboxes      list [--all] | get <id> | pause <id> | delete <id>
  me             the principal this key acts as

conversation:
  send <session> <text...> [--file a.png,b.pdf] [--wait [--timeout SEC]]
  stream <session> [--since SEQ]
  events <session> [--since SEQ] [--limit N]
  interrupt <session>

byoc:
  worker --env <id> --key <worker_key> [--workdir DIR] [--id NAME]

singular aliases work too (agent create, env create, session create, vault credential put, ...).
Run "<command> --help" for its flags. List and event commands print a table; --json prints the raw API JSON.
Exit codes: 0 ok, 1 API / network / run failure, 2 usage error.
env: PMA_API (base URL, default http://localhost:8080; PI_API and PMA_HOST also read), PMA_API_KEY (bearer key; PMA_TOKEN also read)`;

const USAGE: Record<string, string> = {
  agents: `agents list
agents get <id>
agents create <name> <provider/model>            (or: --name N --provider P --model M)
       [--system S | --system-file F] [--tools bash,read,write,edit] [--packages npm:x,git:y,/path] [--skills skill_a,skill_b]
agents update <id> [--name N] [--model provider/model] [--system S | --system-file F | --no-system] [--tools ...] [--packages ...] [--skills ...]
agents delete <id>          removed if unused; archived (hidden, unusable for new sessions) if sessions reference it`,
  envs: `envs list
envs get <id>
envs create <name> --provider local|docker|e2b|byoc  (or: --name N)
       [--image I] [--network none|bridge] [--plugin-host runner|sandbox] [--git URL [--ref R] | --local PATH]
envs delete <id>            removed if unused; archived if sessions are attached (they keep working)
(byoc: the response carries worker_key once; run "worker --env <id> --key <worker_key>" on the machine that executes tools)`,
  sessions: `sessions list [--status idle|running|terminated] [--limit N] [--all]
sessions get <id>
sessions create --agent A --env E [--workspace-id W] [--model provider/model] [--message TEXT]
       [--memory-stores mem_a[:path],mem_b] [--vaults vault_a,vault_b] [--environments main=env_a,<key>=env_b[:fork]] [--parent sess_p]
sessions delete <id>
sessions archive <id>
sessions prompt <id>                                  the system prompt as actually sent
sessions set-system <id> --system S | --system-file F | --no-system
sessions attach <id> <key>=<env_id>[:fork]
sessions mount <id> <mem_id>[:mount_path]   /   sessions unmount <id> <mem_id>
sessions skill <id> add|remove <skill_id>
sessions send|stream|events|interrupt <id> ...        same as the top-level commands`,
  vaults: `vaults list
vaults get <id>
vaults create [name] [--metadata k=v,k2=v2]
vaults delete <id>
vaults credentials list <vault>
vaults credentials put <vault> <name> (--value-env VAR | --value-stdin | --value V) [--metadata k=v]
vaults credentials delete <vault> <name>
(secret values are write-only: the API never returns them; prefer --value-env or --value-stdin over --value, which lands in shell history)`,
  "memory-stores": `memory-stores list
memory-stores get <id>
memory-stores create <name> [--description D]
memory-stores delete <id>`,
  files: `files list
files get <id>
files upload <path>
files download <id> [--out FILE]      (default: stdout)
files delete <id>`,
  skills: `skills list
skills get <id>
skills create --file SKILL.md [--title T]   (or: --name N --description D --body B)
skills version <id> --file SKILL.md
skills delete <id>`,
  providers: `providers list
providers get <id>
providers create <id> --api openai-completions|openai-responses|anthropic-messages --base-url URL
       [--auth-env ENV_VAR | --key API_KEY | --no-auth] [--name N] [--header k:v] [--models id[:ctx],...]
providers update <id> [--base-url URL] [--auth-env E | --key K | --no-auth] [--enabled true|false] [--models ...] [--name N]
providers delete <id>`,
  models: "models [list]",
  sandboxes: `sandboxes list [--all]     (--all includes destroyed)
sandboxes get <id>
sandboxes pause <id>
sandboxes delete <id>`,
  me: "me",
  send: `send <session> <text...> [--file a.png,b.pdf] [--wait] [--timeout SEC]
  --wait streams the reply and exits once the run that answers this message is over:
  0 when it ended normally, 1 on a run error, a terminated session, a timeout or a lost stream`,
  stream: "stream <session> [--since SEQ]    follow the event stream (reconnects; ends when the session is terminated)",
  events: "events <session> [--since SEQ] [--limit N]    all stored events (follows pages)",
  interrupt: "interrupt <session>",
  worker: `worker --env <environment_id> --key <worker_key> [--workdir DIR] [--id NAME]
  key also via PMA_WORKER_KEY; DIR defaults to ./pma-worker. Runs a BYOC sandbox worker on this machine:
  it long-polls the API (outbound only) and executes the environment's commands under DIR.`,
};

export const ALIASES: Record<string, string> = {
  agent: "agents", env: "envs", environment: "envs", environments: "envs", session: "sessions", vault: "vaults",
  "memory-store": "memory-stores", memory_stores: "memory-stores", memories: "memory-stores", file: "files", skill: "skills",
  provider: "providers", model: "models", sandbox: "sandboxes", whoami: "me",
};

function usage(group: string): never { throw new UsageError(`usage:\n${USAGE[group] ?? HELP}`); }

function kv(spec: string | undefined): Record<string, string> | undefined {
  if (spec === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const part of spec.split(",").filter(Boolean)) {
    const i = part.indexOf("=");
    if (i <= 0) throw new UsageError(`expected key=value, got ${JSON.stringify(part)}`);
    out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

async function systemFrom(flags: Flags): Promise<string | null | undefined> {
  if (flags["no-system"]) return null;
  if (str(flags, "system-file")) return readFile(str(flags, "system-file")!, "utf8");
  return str(flags, "system");
}

function listOut(c: Ctx, res: any, header: string[], row: (x: any) => unknown[]): void {
  if (c.json) return c.print(res);
  c.line(table([header, ...((res?.data ?? []) as any[]).map((x) => row(x).map((v) => (v === undefined || v === null || v === "" ? "-" : String(v))))]));
}

/** "main=env_a,browser=env_b:fork" -> [{key, environment_id, fork_from?}] */
export function parseEnvList(spec: string) {
  return spec.split(",").filter(Boolean).map((part) => {
    const [key, rest] = part.split("=");
    if (!key || !rest) throw new UsageError(`bad environment spec ${JSON.stringify(part)}; expected key=env_id[:fork]`);
    const [environment_id, flag] = rest.split(":");
    return { key, environment_id, ...(flag === "fork" ? { fork_from: "main" } : {}) };
  });
}

const agentBody = async (flags: Flags) => {
  const b: Record<string, unknown> = {};
  const system = await systemFrom(flags);
  if (system !== undefined) b.system = system;
  if (str(flags, "tools")) b.tools = list(str(flags, "tools"));
  if (str(flags, "packages")) b.packages = list(str(flags, "packages"));
  if (str(flags, "skills")) b.skills = list(str(flags, "skills"));
  return b;
};

async function agents(c: Ctx, [sub = "list", a, b]: string[]): Promise<void> {
  const { api, flags } = c;
  switch (sub) {
    case "list": case "ls":
      return listOut(c, await api.json("GET", "/v1/agents"), ["ID", "NAME", "MODEL", "TOOLS", "PACKAGES"], (x) => [x.id, x.name, `${x.model?.provider}/${x.model?.id}`, (x.tools ?? []).join(","), (x.packages ?? []).join(",")]);
    case "get": if (!a) usage("agents"); return c.print(await api.json("GET", `/v1/agents/${seg(a)}`));
    case "create": {
      const name = a ?? str(flags, "name");
      if (!name) usage("agents");
      const model = b ? modelRef(b) : str(flags, "provider") ? { provider: str(flags, "provider")!, id: need(flags, "model", USAGE.agents) } : str(flags, "model") ? modelRef(str(flags, "model")!) : usage("agents");
      return c.print(await api.json("POST", "/v1/agents", { name, model, ...(await agentBody(flags)) }));
    }
    case "update": {
      if (!a) usage("agents");
      const body: Record<string, unknown> = await agentBody(flags);
      if (str(flags, "name")) body.name = str(flags, "name");
      if (str(flags, "model")) body.model = modelRef(str(flags, "model")!);
      if (!Object.keys(body).length) throw new UsageError("agents update: nothing to change");
      return c.print(await api.json("PATCH", `/v1/agents/${seg(a)}`, body));
    }
    case "delete": case "rm": if (!a) usage("agents"); return deleted(c, await api.json("DELETE", `/v1/agents/${seg(a)}`));
    default: usage("agents");
  }
}

/** Print a delete result; note when the resource was archived rather than removed. */
function deleted(c: Ctx, r: { id: string; archived?: boolean }): void {
  if (c.json) return c.print(r);
  c.line(r.archived ? `archived ${r.id} (still referenced by sessions; hidden and unusable for new sessions)` : `deleted ${r.id}`);
}

async function envs(c: Ctx, [sub = "list", a]: string[]): Promise<void> {
  const { api, flags } = c;
  switch (sub) {
    case "list": case "ls":
      return listOut(c, await api.json("GET", "/v1/environments"), ["ID", "NAME", "PROVIDER", "IMAGE", "NETWORK", "PLUGIN_HOST", "WORKSPACE"], (e) => [e.id, e.name, e.provider, e.image, e.network, e.plugin_host, e.workspace?.kind === "git" ? e.workspace.remote : e.workspace?.kind]);
    case "get": if (!a) usage("envs"); return c.print(await api.json("GET", `/v1/environments/${seg(a)}`));
    case "create": {
      const name = a ?? str(flags, "name");
      const provider = str(flags, "provider");
      if (!name || !provider) usage("envs");
      const workspace = str(flags, "git") ? { kind: "git", remote: str(flags, "git"), ...(str(flags, "ref") ? { ref: str(flags, "ref") } : {}) }
        : str(flags, "local") ? { kind: "local", path: str(flags, "local") } : { kind: "empty" };
      const env = await api.json("POST", "/v1/environments", { name, provider, image: str(flags, "image"), network: str(flags, "network"), plugin_host: str(flags, "plugin-host"), workspace });
      c.print(env);
      if (env?.worker_key && !c.json) c.io.stderr(`worker_key is shown only once. Start a worker with:\n  npm run cli -- worker --env ${env.id} --key ${env.worker_key}\n`);
      return;
    }
    case "delete": case "rm": if (!a) usage("envs"); return deleted(c, await api.json("DELETE", `/v1/environments/${seg(a)}`));
    default: usage("envs");
  }
}

async function sessions(c: Ctx, args: string[]): Promise<void> {
  const { api, flags } = c;
  const [sub = "list", a, b, d] = args;
  switch (sub) {
    case "list": case "ls": {
      const limit = int(flags, "limit");
      const data: any[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await api.json("GET", `/v1/sessions?limit=${limit ?? 50}${cursor ? `&cursor=${seg(cursor)}` : ""}`);
        data.push(...page.data);
        if (!flags.all || !page.has_more || !page.next_cursor) { cursor = page.has_more ? page.next_cursor : undefined; break; }
        cursor = page.next_cursor;
      }
      const shown = str(flags, "status") ? data.filter((s) => s.status === str(flags, "status")) : data;
      if (c.json) return c.print({ data: shown, has_more: !!cursor, next_cursor: cursor ?? null });
      listOut(c, { data: shown }, ["ID", "STATUS", "AGENT", "MODEL", "CTX", "UPDATED"], (s) => [s.id, s.status, s.agent?.name, `${s.agent?.model?.provider}/${s.agent?.model?.id}`, ctx(s.context), s.updated_at]);
      if (cursor) c.line("(more: pass --all to follow every page)");
      return;
    }
    case "get": if (!a) usage("sessions"); return c.print(await api.json("GET", `/v1/sessions/${seg(a)}`));
    case "create": {
      const agentId = need(flags, "agent", USAGE.sessions);
      const agent = str(flags, "model") ? { type: "agent_with_overrides", id: agentId, model: modelRef(str(flags, "model")!) } : agentId;
      const body: Record<string, unknown> = { agent };
      if (str(flags, "environments")) body.environments = parseEnvList(str(flags, "environments")!);
      else body.environment_id = need(flags, "env", USAGE.sessions);
      if (str(flags, "workspace-id")) body.workspace_id = str(flags, "workspace-id");
      if (str(flags, "parent")) body.parent_id = str(flags, "parent");
      if (str(flags, "vaults")) body.vault_ids = list(str(flags, "vaults"));
      if (str(flags, "memory-stores")) body.memory_stores = list(str(flags, "memory-stores"))!.map((x) => { const [id, mp] = x.split(":"); return mp ? { memory_store_id: id, mount_path: mp } : id; });
      if (str(flags, "message")) body.initial_events = [{ type: "user.message", content: [{ type: "text", text: str(flags, "message") }] }];
      return c.print(await api.json("POST", "/v1/sessions", body));
    }
    case "delete": case "rm": if (!a) usage("sessions"); return c.print(await api.json("DELETE", `/v1/sessions/${seg(a)}`));
    case "archive": if (!a) usage("sessions"); return c.print(await api.json("POST", `/v1/sessions/${seg(a)}/archive`, {}));
    case "prompt": {
      if (!a) usage("sessions");
      const r = await api.json("GET", `/v1/sessions/${seg(a)}/system_prompt`);
      return c.json ? c.print(r) : c.line(`# source: ${r.source}\n${r.rendered}`);
    }
    case "set-system": {
      const system = await systemFrom(flags);
      if (!a || system === undefined) usage("sessions");
      return c.print(await api.json("PATCH", `/v1/sessions/${seg(a)}`, { system }));
    }
    case "attach": if (!a || !b) usage("sessions"); return c.print(await api.json("POST", `/v1/sessions/${seg(a)}/environments`, parseEnvList(b)[0]));
    case "mount": {
      const [mid, mp] = (b ?? "").split(":");
      if (!a || !mid) usage("sessions");
      return c.print(await api.json("POST", `/v1/sessions/${seg(a)}/memory_stores`, mp ? { memory_store_id: mid, mount_path: mp } : { memory_store_id: mid }));
    }
    case "unmount": if (!a || !b) usage("sessions"); return c.print(await api.json("DELETE", `/v1/sessions/${seg(a)}/memory_stores/${seg(b)}`));
    case "skill":
      if (!a || !d || (b !== "add" && b !== "remove")) usage("sessions");
      return c.print(b === "add" ? await api.json("POST", `/v1/sessions/${seg(a)}/skills`, { type: "custom", skill_id: d }) : await api.json("DELETE", `/v1/sessions/${seg(a)}/skills/${seg(d)}`));
    case "send": return send(c, args.slice(1));
    case "stream": return streamCmd(c, args.slice(1));
    case "events": return eventsCmd(c, args.slice(1));
    case "interrupt": return interrupt(c, args.slice(1));
    default: usage("sessions");
  }
}

async function secretValue(c: Ctx): Promise<string> {
  const { flags } = c;
  if (str(flags, "value-env")) {
    const v = c.io.env[str(flags, "value-env")!];
    if (v === undefined) throw new UsageError(`environment variable ${str(flags, "value-env")} is not set`);
    return v;
  }
  if (flags["value-stdin"]) return (await c.io.readStdin()).replace(/\r?\n$/, "");
  if (str(flags, "value") !== undefined) return str(flags, "value")!;
  usage("vaults");
}

async function vaults(c: Ctx, [sub = "list", a, b, d]: string[]): Promise<void> {
  const { api, flags } = c;
  switch (sub) {
    case "list": case "ls": return listOut(c, await api.json("GET", "/v1/vaults"), ["ID", "NAME", "CREATED"], (v) => [v.id, v.name, v.created_at]);
    case "get": if (!a) usage("vaults"); return c.print(await api.json("GET", `/v1/vaults/${seg(a)}`));
    case "create": return c.print(await api.json("POST", "/v1/vaults", { name: a ?? str(flags, "name"), metadata: kv(str(flags, "metadata")) }));
    case "delete": case "rm": if (!a) usage("vaults"); return c.print(await api.json("DELETE", `/v1/vaults/${seg(a)}`));
    case "credentials": case "credential": case "creds": {
      const [op, vault, name] = [a, b, d];
      if (!vault) usage("vaults");
      switch (op) {
        case "list": case "ls": return listOut(c, await api.json("GET", `/v1/vaults/${seg(vault)}/credentials`), ["ID", "NAME", "CREATED"], (x) => [x.id, x.name, x.created_at]);
        case "put": case "set": {
          if (!name) usage("vaults");
          return c.print(await api.json("POST", `/v1/vaults/${seg(vault)}/credentials`, { name, value: await secretValue(c), metadata: kv(str(flags, "metadata")) }));
        }
        case "delete": case "rm": if (!name) usage("vaults"); return c.print(await api.json("DELETE", `/v1/vaults/${seg(vault)}/credentials/${seg(name)}`));
        default: usage("vaults");
      }
    }
    default: usage("vaults");
  }
}

async function memoryStores(c: Ctx, [sub = "list", a]: string[]): Promise<void> {
  const { api, flags } = c;
  switch (sub) {
    case "list": case "ls": return listOut(c, await api.json("GET", "/v1/memory_stores"), ["ID", "NAME", "DESCRIPTION", "UPDATED"], (m) => [m.id, m.name, String(m.description ?? "").slice(0, 40), m.updated_at]);
    case "get": if (!a) usage("memory-stores"); return c.print(await api.json("GET", `/v1/memory_stores/${seg(a)}`));
    case "create": {
      const name = a ?? str(flags, "name");
      if (!name) usage("memory-stores");
      return c.print(await api.json("POST", "/v1/memory_stores", { name, description: str(flags, "description") }));
    }
    case "delete": case "rm": if (!a) usage("memory-stores"); return c.print(await api.json("DELETE", `/v1/memory_stores/${seg(a)}`));
    default: usage("memory-stores");
  }
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json", ".csv": "text/csv" };
export const mimeOf = (p: string) => MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream";

async function upload(api: Client, p: string): Promise<any> {
  const data = await readFile(p);
  return api.read(await api.fetch("POST", "/v1/files", { body: data, headers: { "content-type": mimeOf(p), "x-file-name": path.basename(p) } }));
}

async function files(c: Ctx, [sub = "list", a]: string[]): Promise<void> {
  const { api, flags } = c;
  switch (sub) {
    case "list": case "ls": return listOut(c, await api.json("GET", "/v1/files"), ["ID", "FILENAME", "MIME", "BYTES"], (f) => [f.id, f.filename, f.mime_type, f.size_bytes]);
    case "get": if (!a) usage("files"); return c.print(await api.json("GET", `/v1/files/${seg(a)}`));
    case "upload": if (!a) usage("files"); return c.print(await upload(api, a));
    case "download": {
      if (!a) usage("files");
      const res = await api.fetch("GET", `/v1/files/${seg(a)}/content`);
      if (!res.ok) await api.read(res); // throws with the API error
      const buf = Buffer.from(await res.arrayBuffer());
      if (str(flags, "out")) { await writeFile(str(flags, "out")!, buf); return c.io.stderr(`wrote ${buf.length} bytes to ${str(flags, "out")}\n`); }
      return c.io.stdout(buf.toString("utf8"));
    }
    case "delete": case "rm": if (!a) usage("files"); return c.print(await api.json("DELETE", `/v1/files/${seg(a)}`));
    default: usage("files");
  }
}

async function skills(c: Ctx, [sub = "list", a]: string[]): Promise<void> {
  const { api, flags } = c;
  const body = async () => {
    const b: Record<string, unknown> = {};
    if (str(flags, "file")) b.markdown = await readFile(str(flags, "file")!, "utf8");
    for (const [flag, key] of [["title", "display_title"], ["name", "name"], ["description", "description"], ["body", "body"]] as const) if (str(flags, flag)) b[key] = str(flags, flag);
    if (!Object.keys(b).length) usage("skills");
    return b;
  };
  switch (sub) {
    case "list": case "ls": return listOut(c, await api.json("GET", "/v1/skills"), ["ID", "NAME", "VERSION", "DESCRIPTION"], (s) => [s.id, s.name, s.latest_version, String(s.description ?? "").slice(0, 60)]);
    case "get": if (!a) usage("skills"); return c.print(await api.json("GET", `/v1/skills/${seg(a)}`));
    case "create": return c.print(await api.json("POST", "/v1/skills", await body()));
    case "version": if (!a) usage("skills"); return c.print(await api.json("POST", `/v1/skills/${seg(a)}/versions`, await body()));
    case "delete": case "rm": if (!a) usage("skills"); return c.print(await api.json("DELETE", `/v1/skills/${seg(a)}`));
    default: usage("skills");
  }
}

function providerBody(flags: Flags): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  if (str(flags, "name")) b.name = str(flags, "name");
  if (str(flags, "api")) b.api = str(flags, "api");
  if (str(flags, "base-url")) b.base_url = str(flags, "base-url");
  if (str(flags, "auth-env")) b.auth = { type: "env", name: str(flags, "auth-env") };
  if (flags["no-auth"]) b.auth = { type: "none" };
  if (str(flags, "key")) b.auth = { type: "key", key: str(flags, "key") };
  if (str(flags, "models")) b.models = list(str(flags, "models"))!.map((part) => { const [id, ctx] = part.split(":"); return { id, context_window: ctx ? Number(ctx) : 200_000 }; });
  if (str(flags, "enabled")) b.enabled = str(flags, "enabled") === "true";
  const h = str(flags, "header");
  if (h) { const i = h.indexOf(":"); if (i <= 0) throw new UsageError("--header must be name:value"); b.headers = { [h.slice(0, i).trim()]: h.slice(i + 1).trim() }; }
  return b;
}

async function providers(c: Ctx, [sub = "list", id]: string[]): Promise<void> {
  const { api, flags } = c;
  switch (sub) {
    case "list": case "ls":
      return listOut(c, await api.json("GET", "/v1/providers"), ["ID", "API", "BASE_URL", "AUTH", "MODELS", "ENABLED"], (p) => [p.id, p.api, p.base_url, p.auth?.type === "env" ? `env:${p.auth.name}` : p.auth?.type, (p.models ?? []).length, p.enabled]);
    case "get": if (!id) usage("providers"); return c.print(await api.json("GET", `/v1/providers/${seg(id)}`));
    case "create": if (!id) usage("providers"); return c.print(await api.json("POST", "/v1/providers", { id, ...providerBody(flags) }));
    case "update": if (!id) usage("providers"); return c.print(await api.json("PATCH", `/v1/providers/${seg(id)}`, providerBody(flags)));
    case "delete": case "rm": if (!id) usage("providers"); return c.print(await api.json("DELETE", `/v1/providers/${seg(id)}`));
    default: usage("providers");
  }
}

async function sandboxes(c: Ctx, [sub = "list", a]: string[]): Promise<void> {
  const { api, flags } = c;
  switch (sub) {
    case "list": case "ls": return listOut(c, await api.json("GET", `/v1/sandboxes${flags.all ? "?include_destroyed=true" : ""}`), ["ID", "PROVIDER", "STATUS", "WORKSPACE", "LAST_USED"], (s) => [s.id, s.provider, s.status, s.workspace_id, s.last_used_at]);
    case "get": if (!a) usage("sandboxes"); return c.print(await api.json("GET", `/v1/sandboxes/${seg(a)}`));
    case "pause": if (!a) usage("sandboxes"); return c.print(await api.json("POST", `/v1/sandboxes/${seg(a)}/pause`, {}));
    case "delete": case "rm": if (!a) usage("sandboxes"); return c.print(await api.json("DELETE", `/v1/sandboxes/${seg(a)}`));
    default: usage("sandboxes");
  }
}

async function send(c: Ctx, [session, ...words]: string[]): Promise<void> {
  const { api, flags } = c;
  const text = words.join(" ");
  const attachments = list(str(flags, "file")) ?? [];
  if (!session || (!text && !attachments.length)) usage("send");
  const timeout = int(flags, "timeout");
  if (timeout !== undefined && !flags.wait) throw new UsageError("--timeout only applies with --wait");
  const content: unknown[] = text ? [{ type: "text", text }] : [];
  for (const f of attachments) {
    const up = await upload(api, f);
    content.push({ type: mimeOf(f).startsWith("image/") ? "image" : "document", source: { type: "file", file_id: up.id } });
    c.io.stderr(`uploaded ${up.filename} -> ${up.id}\n`);
  }
  const { events } = await api.json("POST", `/v1/sessions/${seg(session)}/events`, { events: [{ type: "user.message", content }] });
  if (!flags.wait) return c.print(events);
  const seq: number = events[events.length - 1].seq;
  // Subscribing from the message's own seq replays everything after it, so nothing between POST and connect is missed.
  const outcome = await waitFor(c, session, seq, (type, data) => waitOutcome(type, data, seq), timeout);
  if (!outcome.ok) throw new Error(outcome.reason);
}

/** Follow the stream from `since`, printing, until `until` yields an outcome. */
async function waitFor<T>(c: Ctx, session: string, since: number, until: (type: string, data: any) => T | null, timeoutSec?: number): Promise<T> {
  const printEvent = makePrinter(c.out);
  let result: T | null = null;
  await c.api.follow(session, since, (type, data) => {
    if (c.json) c.line(JSON.stringify({ event: type, data }));
    else printEvent(type, data);
    result = until(type, data);
    return result !== null;
  }, { timeoutMs: timeoutSec ? timeoutSec * 1000 : undefined, onReconnect: (last, why) => c.io.stderr(`[stream] ${why}; reconnecting from seq ${last}\n`) });
  return result as T;
}

async function streamCmd(c: Ctx, [session]: string[]): Promise<void> {
  if (!session) usage("stream");
  await waitFor(c, session, int(c.flags, "since") ?? 0, (type) => (type === "session.status_terminated" ? true : null), int(c.flags, "timeout"));
}

async function eventsCmd(c: Ctx, [session]: string[]): Promise<void> {
  if (!session) usage("events");
  const max = int(c.flags, "limit") ?? Infinity;
  const data: { seq: number }[] = [];
  let since = int(c.flags, "since") ?? 0;
  for (;;) {
    const page = await c.api.json("GET", `/v1/sessions/${seg(session)}/events?limit=${Math.min(1000, max - data.length)}&since=${since}`);
    data.push(...page.data);
    if (!page.has_more || page.data.length === 0 || data.length >= max) break;
    since = data.at(-1)!.seq;
  }
  if (c.json) return c.print({ data, has_more: false });
  c.line(table([["SEQ", "TYPE", "SUMMARY"], ...data.map((e: any) => [String(e.seq), e.type, summarize(e)])]));
}

async function interrupt(c: Ctx, [session]: string[]): Promise<void> {
  if (!session) usage("interrupt");
  c.print(await c.api.json("POST", `/v1/sessions/${seg(session)}/events`, { events: [{ type: "user.interrupt" }] }));
}

async function worker(c: Ctx): Promise<void> {
  const { flags } = c;
  const envId = str(flags, "env");
  const key = str(flags, "key") ?? c.io.env.PMA_WORKER_KEY;
  if (!envId || !key) usage("worker");
  if (!/^[\x21-\x7e]+$/.test(key)) throw new UsageError("--key must be the worker_key printed by envs create (printable ASCII)");
  let stop = false;
  const onSignal = () => { if (stop) process.exit(130); stop = true; c.io.stderr("[worker] stopping after the current poll (Ctrl-C again to exit now)\n"); };
  process.on("SIGINT", onSignal);
  try {
    await runWorker({
      client: c.api, envId, key,
      workdir: str(flags, "workdir") ?? path.join(process.cwd(), "pma-worker"),
      workerId: (str(flags, "id") ?? `${hostname()}-${process.pid}`).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64),
      log: (s) => c.io.stderr(`${s}\n`),
      stopped: () => stop,
    });
  } finally {
    process.off("SIGINT", onSignal);
  }
}

const GROUPS: Record<string, (c: Ctx, args: string[]) => Promise<void>> = {
  agents, envs, sessions, vaults, "memory-stores": memoryStores, files, skills, providers, sandboxes,
  models: async (c, [sub = "list"]) => { if (sub !== "list" && sub !== "ls") usage("models"); return listOut(c, await c.api.json("GET", "/v1/models"), ["PROVIDER", "ID", "CONTEXT"], (m) => [m.provider, m.id, m.context_window]); },
  me: async (c) => c.print(await c.api.json("GET", "/v1/me")),
  send: (c, a) => send(c, a), stream: streamCmd, events: eventsCmd, interrupt, worker: (c) => worker(c),
};

/** Run one CLI invocation; resolves to the process exit code (0 ok, 1 failure, 2 usage). */
export async function run(argv: string[], io: Io): Promise<number> {
  const { positional, flags } = parse(argv);
  const [first, ...rest] = positional;
  const group = first === undefined ? undefined : (ALIASES[first] ?? first);
  const out: Out = { write: (s) => io.stdout(s), log: (s) => io.stdout(`${s}\n`) };
  if (!group || group === "help") {
    const topic = rest[0] ? (ALIASES[rest[0]] ?? rest[0]) : undefined;
    if (topic && USAGE[topic]) { io.stdout(`usage:\n${USAGE[topic]}\n`); return 0; }
    if (!group && !flags.help) { io.stderr(`${HELP}\n`); return 2; }
    io.stdout(`${HELP}\n`);
    return 0;
  }
  const handler = GROUPS[group];
  if (!handler) { io.stderr(`unknown command ${JSON.stringify(first)}\n\n${HELP}\n`); return 2; }
  if (flags.help) { io.stdout(`usage:\n${USAGE[group]}\n`); return 0; }
  const ctx: Ctx = { io, api: new Client(resolveConfig(io.env)), flags, json: !!flags.json, out, print: (v) => io.stdout(`${JSON.stringify(v, null, 2)}\n`), line: (s) => io.stdout(`${s}\n`) };
  try {
    await handler(ctx, rest);
    return 0;
  } catch (e) {
    io.stderr(`${e instanceof Error ? e.message : String(e)}\n`);
    return e instanceof UsageError ? 2 : 1;
  }
}
