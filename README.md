# rethink-managed-agent

A small, self-hostable coding-agent service in the spirit of Claude Managed Agents and the OpenAI Agents
API — the same brain–hands split, decoupled so you can run it yourself:

- **The event log is the only truth.** Session state is the fold of an append-only log. There is no
  messages table and nothing hidden in a container.
- **The sandbox is a lease.** A session holds a workspace *reference* (git base + diff, a directory, or
  nothing); compute is acquired on the first tool call and released at the end of the turn. Session,
  workspace and sandbox are three lifecycles that compose freely (`local`, `docker`, `e2b`, or a worker
  you run yourself).
- **The model is a row.** Any endpoint speaking `openai-completions`, `openai-responses` or
  `anthropic-messages` — your gateway, your vLLM box, your key.
- **Everything above the loop is a plugin.** Sub-agents, approval gates, outcomes, verification,
  memory: hooks and tools, not platform.

The loop itself is [pi](https://github.com/badlogic/pi-mono)'s `runAgentLoop`, plus four tools
(`bash`, `read`, `write`, `edit`).

| | |
|---|---|
| Why it is shaped this way | [DESIGN.md](DESIGN.md) · [docs/POSITIONING.md](docs/POSITIONING.md) |
| How a turn runs, sandboxes, resources, ops | [docs/GUIDE.md](docs/GUIDE.md) |
| Module contract | [ARCHITECTURE.md](ARCHITECTURE.md) · `src/shared/types.ts` |
| Plugins | [docs/PLUGINS.md](docs/PLUGINS.md) · [docs/WORKFLOWS.md](docs/WORKFLOWS.md) |
| Terminal client | [pma-cli/README.md](pma-cli/README.md) |

## Quickstart

```sh
cp .env.example .env
docker compose up --build -d          # postgres, redis, api, runner
make install                          # `pma` into ~/.local/bin  (make install-dev for a live wrapper)

pma envs create local --provider local
pma agents create coder qoder/auto --tools bash,read,write,edit
pma                                   # chat; first message starts a session
```

The same CLI is scriptable (`npm run cli -- <command>` also works; `PMA_API` defaults to
`http://localhost:8080`; when `AUTH_REQUIRED=true`, pass a bearer key as `PMA_API_KEY`):

```sh
pma agents create dev qoder/ultimate                             # the older agent create --name … --provider … --model … still works
pma envs create local --provider local
pma sessions create --agent agent_xxx --env env_xxx
pma send sess_xxx "list the current files and add a README" --wait
pma events sess_xxx
pma vaults create ci && pma vaults credentials put vlt_xxx GITHUB_TOKEN --value-env GITHUB_TOKEN
pma --help                                                       # every command; <command> --help for its flags
```

A model provider is seeded on first start so a fresh clone runs with no key: a local OpenAI-compatible
proxy at `QODER_BASE_URL`. Point it anywhere, or make your own row — see **Models** below.
`scripts/e2e.sh` runs the whole flow headless; `scripts/smoke-surfaces.mjs` does one turn through every
surface at once.

## The objects

| | |
|---|---|
| **Agent** | a reusable definition: model, system prompt, tools, plugins, MCP servers |
| **Environment** | where compute happens: a sandbox provider plus a default workspace spec |
| **Session** | one conversation. Snapshots its agent, so editing the agent never changes a running session |
| **Workspace** | the persistent file state, as a reference (git base + diff, a captured dir, a blob) |
| **Sandbox** | ephemeral compute, leased per turn, reapable, never referenced by a session |
| **Event** | the log. Everything else is a projection of it |

## API

All bodies and responses are JSON. Errors are `{type:"error", error:{type, message}}` with 400/401/404/500. Every `/v1/*` route (except the BYOC worker) runs behind principal auth and is scoped to the caller.

| Method | Path | Body / query | Notes |
|---|---|---|---|
| GET | `/healthz` | | `{ok:true}` |
| GET | `/v1/me` | | the authenticated principal |
| POST | `/v1/principals`, `/v1/api_keys` | | mint a principal / a bearer token (token shown once) |
| POST | `/v1/agents` | `{name, model:{provider,id}, system?, tools?}` | `tools` defaults to all four builtins |
| GET | `/v1/agents`, `/v1/agents/:id` | | |
| POST | `/v1/environments` | `{name, provider:"local"\|"docker"\|"e2b", image?, workspace?}` | `workspace` is the default `WorkspaceSpec`: `{kind:"empty"}` (default), `{kind:"git", remote, ref?}`, `{kind:"local", path}` |
| GET | `/v1/environments`, `/v1/environments/:id` | | |
| POST | `/v1/sessions` | `{agent: id \| {type:"agent_with_overrides", id, model?, system?, tools?, packages?}, environment_id, workspace? \| workspace_id?, initial_events?}` | Snapshots the agent config into the session. Omit `workspace*` to use the environment default; pass `workspace_id` to continue an existing workspace |
| GET | `/v1/sessions`, `/v1/sessions/:id` | | `status` is `idle` / `running` / `terminated` |
| DELETE | `/v1/sessions/:id` | | Cascades to events |
| POST | `/v1/sessions/:id/archive` | | Appends `session.status_terminated` |
| POST | `/v1/sessions/:id/environments` | `{key, environment_id, workspace?\|workspace_id?\|fork_from?}` | attach another sandbox to a session (tools take `env`) |
| GET/POST/PATCH/DELETE | `/v1/providers` | `{id, api, base_url, auth:{type:"env",name}\|{type:"none"}, models:[{id, context_window, ...}], headers?, enabled?}` | model providers are data; keys stay in runner env vars. Seeded with the Qoder proxy on first start; runners reload on change |
| GET | `/v1/models` | | flat model list across enabled providers |
| GET | `/v1/sandboxes` | | lease registry view; `POST /v1/sandboxes/:id/pause` (docker pause / e2b snapshot) and `DELETE /v1/sandboxes/:id` act via the reaper |
| POST | `/v1/sessions/:id/events` | `{events:[{type:"user.message", content:[{type:"text", text}]} \| {type:"user.interrupt"}]}` | Idle session: enqueues a run. Running session: message is steered into the live loop. Interrupt: aborts the loop |
| GET | `/v1/sessions/:id/events` | `?since=<seq>&limit=<n>` | `{data, has_more}`; `seq` is per-session and monotonic |
| GET | `/v1/sessions/:id/events/stream` | `?since=<seq>` | SSE. Replays from the DB, then live. `event:` is the event type; extra `agent.message_delta` frames carry streamed text and are not persisted. Closes on `session.status_terminated` |

Event types (`SessionEventPayload` in `src/shared/types.ts`): `user.message`, `user.interrupt`, `agent.message`, `agent.tool_use`, `agent.tool_result`, `session.status_running`, `session.status_idle` (with `stop_reason`: `end_turn` / `interrupted` / `error` / `max_turns`), `session.status_terminated`, `session.error`, `sandbox.acquired`, `sandbox.released`, `workspace.captured`.

## Vendor API compatibility

rethink speaks its own API plus both vendor dialects, over one engine. No vendor SDK runs on the server
and no request leaves the deployment — each surface is a translation at the edge. Full matrix and the
list of what deliberately cannot be compatible: [DESIGN.md §21](DESIGN.md).

| Surface | Point your SDK at | What it covers |
|---|---|---|
| **OpenAI Agents API** | `new OpenAI({ baseURL: "<host>/openai/v1" })` | `client.beta.agents.*`: agents, sessions (+stream), events, items, turns, subagents, artifacts, vaults + credentials |
| **Claude Managed Agents** | `new Anthropic({ baseURL: "<host>/anthropic" })` | `client.beta.{agents,sessions,vaults}.*`: agents (toolsets, MCP servers), sessions (+SSE), threads, vaults + credentials, environments, memory stores |
| **native** | `pma` CLI / your own code at `/v1` | everything, including what the dialects have no word for |
| legacy showcase | `/agents-api/v1` | kept for existing callers; frozen |

Both vendor surfaces are tested against the vendors' own SDKs (`openai@7.15.0`,
`@anthropic-ai/sdk@0.123.0`) driving the router, and verified live end to end.

Where a vendor feature is really a *behavior of the agent loop*, it is a plugin rather than engine
code: CMA's **outcomes** (define what "done" means, grade the run, send the agent back until the rubric
is met) are `plugins/outcome` driven by ordinary hooks, with the dialect wired on top
(`COMPAT_OUTCOME_PACKAGE`). See [DESIGN §21.3](DESIGN.md).

A model resolves through rethink's provider table, so a vendor model id needs a provider row of that
name or an entry in `COMPAT_MODEL_MAP`. MCP credentials live in a vault and are matched to a declared
server by URL (or named with `credential_id`), never stored on a reusable agent. An MCP tool whose
`permission_policy` is `always_ask` is held until the caller confirms it.

### The legacy showcase adapter (`/agents-api/v1`)

A thin adapter makes rethink speak the OpenAI Agents API session surface, so showcase-style code (e.g. the SRE "sev-bot") runs against a rethink base URL with no cloud vendor bound: the model resolves to a rethink provider row (BYOK), and the environment to a pluggable sandbox provider (local/docker/e2b/byoc). The adapter is pure translation over the native engine; the only engine addition is **client/function tools**.

| Method | Path | OpenAI analog |
|---|---|---|
| POST | `/agents-api/v1/sessions` | `sessions.create({agent, environment, input?, stream?})` |
| GET | `/agents-api/v1/sessions/:id` | `sessions.retrieve` — `info.required_actions`, `info.environment.environment_id` |
| POST | `/agents-api/v1/sessions/:id` | continue / `session.stream({input})` |
| POST | `/agents-api/v1/sessions/:id/tool_result` | `session.tool_result({call_id, success, output})` |
| DELETE | `/agents-api/v1/sessions/:id` | delete |
| GET | `/agents-api/v1/sessions/:id/events/stream` | SSE reattach |

**Client/function tools** are the core novelty: a tool declared `{type:"function", name, parameters}` is executed by the *caller*, not the sandbox. When the agent calls one, the turn stays alive and blocks on a durable per-call result channel; the caller POSTs `tool_result` (or a human approves) and the turn resumes in place. A call left unanswered surfaces as a `required_action` (retrieve + the `agent.session.action_required` stream event) until `CLIENT_TOOL_WAIT_MS` (default 5 min, < `RUN_TIMEOUT_MS`) elapses. Builtin tool names (`bash`/`read`/`write`/`edit`) pass through to the sandbox. `{type:'mcp'}` tools are connected for real by a server-side MCP-over-HTTP client (`src/harness/mcp.ts`, fetch-allowlist gated); `web_search` maps to the `plugins/web-search` plugin (`COMPAT_WEBSEARCH_PACKAGE`, needs a sandbox host + bridge network); `multi_agent` maps to the team plugin (`COMPAT_TEAM_PACKAGE`); `programmatic_tool_calling` is accepted-and-ignored.

SSE events are re-encoded to OpenAI names (`response.output_text.delta`, `session.turn.item.added` with `function_call`, `agent.session.action_required`, `agent.session.turn.completed`, `turn.failed`/`cancelled`). A dependency-free TS client that mirrors `client.beta.agents.sessions.*` lives at `src/api/routes/compat/sdk/`.

Config: `COMPAT_DEFAULT_PROVIDER`, `COMPAT_MODEL_MAP` (JSON: OpenAI model string → `provider/id`), `COMPAT_DEFAULT_ENVIRONMENT` (backs `environment.type` when no `environment_id` is given), `COMPAT_TEAM_PACKAGE` (for `multi_agent`). Runnable example: `examples/sev-bot/` (see its README) — a vendor-neutral incident-response bot with read-only function tools and one human-approved rollback, needing no GitHub/AWS/OpenAI credentials.

## Models come from provider rows, not from this repo

A **provider** is a row: `{id, api, base_url, auth, models[]}`. `api` is one of the three shapes pi-ai
speaks — `openai-completions`, `openai-responses`, `anthropic-messages` — so anything that speaks one
of them works: OpenAI, Anthropic, a vLLM or Ollama endpoint, a company gateway, an OpenAI-compatible
proxy. Agents name a model as `{provider, id}`; the runner rebuilds its registry when a row changes.

```bash
pma providers create my-openai  --api openai-responses     --base-url https://api.openai.com/v1 --key sk-…            --models gpt-5:400000
pma providers create my-claude  --api anthropic-messages   --base-url https://api.anthropic.com  --auth-env ANTHROPIC_API_KEY --models claude-sonnet-4-6:200000
pma providers create my-vllm    --api openai-completions   --base-url http://gpu-box:8000/v1     --no-auth            --models qwen3:128000
pma agents create coder my-vllm/qwen3
```

`QODER_*` in `.env.example` is nothing more than the **dev seed**: on first start, if the providers
table is empty, one row is inserted pointing at a local OpenAI-compatible proxy so a fresh clone can
run without any key. `pma providers delete qoder` and it is gone; nothing in the engine refers to it.

## Plugins

Two independent plugin surfaces: **agent plugins** (server side, below) and **UI plugins** for the pma terminal
client (commands, shortcuts, status segments, renderers; see [pma-cli/README.md](pma-cli/README.md#ui-plugins-client-side)).
They share nothing but the event JSON.

Agents are extended with **pma plugins**: tools, hooks (`tool_call` / `tool_result` / `context` / turn
and session events), skills and prompt templates, packaged like pi packages (`npm:`, `git:`, or a path).
Plugins run either in a per-agent host process on the runner (Node permission model + network lockdown;
only `ctx` — sandbox, store, model, sub-agent, allow-listed fetch — reaches the world) or, per environment
(`plugin_host: "sandbox"`), inside the leased sandbox where they may use fs and the network directly and the
sandbox is the boundary. Pure-tool / pure-hook pi packages load through a compat
adapter. Samples in `plugins/`: goal, fork, safety-net, web-fetch. See [docs/PLUGINS.md](docs/PLUGINS.md).

```bash
pma agents create coder qoder/kmodel --packages /app/plugins/goal,/app/plugins/fork,/app/plugins/safety-net
```

## CLI

There are two clients with the same resource commands:

- **`npm run cli -- <command>`** (`src/cli/`, no build step): the scriptable client used by `scripts/e2e.sh`. Every
  `pma <command>` line in this README and in `docs/` also runs as `npm run cli -- <command>` (except `login`/`config`
  and the TUI).
- **`pma`** (`pma-cli/`): the same subcommands plus an Ink TUI with streaming, tool folding and slash commands,
  modelled on qca-cli. See [pma-cli/README.md](pma-cli/README.md).

```bash
make install          # builds pma-cli and puts `pma` in ~/.local/bin
pma login --host http://localhost:8080
pma --help
```

Bundled CLI commands (`npm run cli -- --help`, and `<command> --help` for the flags of one):

| Command | Subcommands |
|---|---|
| `agents` | `list`, `get <id>`, `create <name> <provider/model> [--system S \| --system-file F] [--tools a,b] [--packages p1,p2] [--skills s1,s2]`, `update <id> [...]`, `delete <id>` (removed if unused, archived if sessions reference it) |
| `envs` | `list`, `get <id>`, `create <name> --provider local\|docker\|e2b\|byoc [--image I] [--network none\|bridge] [--plugin-host runner\|sandbox] [--git URL [--ref R]]`, `delete <id>` (removed if unused, archived if sessions are attached; byoc prints the `worker_key` once) |
| `sessions` | `list [--status S] [--all]`, `get`, `create --agent A --env E [--model p/m] [--message T] [--packages npm:x,/path] [--memory-stores mem[:path],..] [--vaults vault_a,vault_b] [--environments main=env,k=env[:fork]] [--parent sess]`, `delete`, `archive`, `prompt`, `set-system`, `attach`, `mount`, `unmount`, `skill add\|remove`, `packages list\|add\|remove` |
| `send` | `send <session> <text...> [--file a.png,b.pdf] [--wait [--timeout SEC]]` |
| `stream` / `events` / `interrupt` | `stream <session> [--since SEQ]`, `events <session> [--since SEQ] [--limit N]` (follows every page), `interrupt <session>` |
| `vaults` | `list`, `get`, `create [name]`, `delete`, `credentials list <vault>`, `credentials put <vault> <name> --value-env VAR \| --value-stdin \| --value V [--mcp-url URL]`, `credentials delete <vault> <name>` |
| `plugins` | `list [query]` — what this deployment ships, the source to attach, and where each may run |
| `memory-stores`, `files`, `skills`, `providers`, `sandboxes`, `models`, `me` | `list` / `get` / `create` / `delete` where the API has them; `files upload <path>` and `download <id> [--out F]`, `skills version`, `providers update`, `sandboxes pause` |
| `worker` | `worker --env <id> --key <worker_key> [--workdir DIR]`: the BYOC worker loop (see [BYOC](#byoc-self-hosted-sandboxes)) |

Singular aliases (`agent create`, `env create`, `session create`, `vault credential put`) keep older scripts working.
Configuration: `PMA_API` (base URL, default `http://localhost:8080`; the legacy `PI_API` is still read) and
`PMA_API_KEY` (sent as `Authorization: Bearer`, needed with `AUTH_REQUIRED=true`; `PMA_TOKEN` is also read).
List and `events` commands print tables, `--json` prints the raw API JSON; `create`/`get` print JSON.
`send --wait` subscribes from the message's own seq (nothing between the POST and the subscription is missed),
reconnects from the last seen seq when the stream drops, and exits once the run that consumed the message is
idle. Exit codes: `0` ok, `1` API / network error, a run that ended in error, a terminated session or a
`--timeout`, `2` usage error. Secret values given to `vaults credentials put` are only sent to the API, never printed.

Other targets: `make up` / `make down` / `make logs` (compose), `make e2e`, `make test`, `make diagram`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `postgres://pi:pi@localhost:5432/pi` | Postgres (PolarDB-PG is wire compatible) |
| `AUTH_REQUIRED` | `false` | Require a valid `Authorization: Bearer` key on `/v1/*`; when false, unauthenticated requests act as `PMA_DEFAULT_PRINCIPAL` |
| `PMA_DEFAULT_PRINCIPAL` | `prc_local` | Principal that unauthenticated (dev) requests act as; seeded by the schema |
| `PRINCIPAL_RESOLVER` | | Module that default-exports a `PrincipalResolver` (credential → principal); empty uses the built-in Bearer/`api_keys` resolver |
| `TRUSTED_PRINCIPAL_HEADER` | `x-principal-id` | Header the `trusted-header` example resolver reads (only safe behind a trusted gateway) |
| `REDIS_URL` | `redis://localhost:6379` | Queue, pub/sub, steering lists |
| `QODER_BASE_URL` / `QODER_API_KEY` | `http://127.0.0.1:4141/v1` / `qoder` | Only the **dev seed** provider (see "Models come from provider rows"); delete the row and these do nothing |
| `ANTHROPIC_API_KEY` | | Seeds an `anthropic` provider row too, when set |
| `SANDBOX_DEFAULT_PROVIDER` | `local` | Fallback when an environment has no provider |
| `SANDBOX_LOCAL_ROOT` | `./data/sandboxes` | Directory (as seen by the runner) for ephemeral sandbox dirs |
| `WORKSPACE_ROOT` | `./data/workspaces` | Persistent captured `dir` workspaces (never reaped) |
| `LOCAL_WORKSPACE_ALLOW_ROOT` | | Enables `{kind:"local", path}` workspace specs, confined to this directory; empty rejects them |
| `SANDBOX_DOCKER_NETWORK` / `_MEMORY` / `_CPUS` / `_PIDS` | `none` / `2g` / `2` / `512` | Docker sandbox limits |
| `SANDBOX_HOST_ROOT` | | Same directory as seen by the docker host; required for the `docker` provider when the runner is a container (compose sets it) |
| `SANDBOX_IDLE_TTL_MS` | `600000` | Reaper threshold for idle sandboxes |
| `API_PORT` | `8080` | Also the host port published by compose |
| `PG_HOST_PORT` / `REDIS_HOST_PORT` | `5432` / `6379` | Host ports published by compose only |
| `MAX_TURNS` | `50` | Tool-using turns per run |
| `BASH_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` | `600000` / `900000` | Default and cap for one `bash` tool call |
| `RUN_TIMEOUT_MS` | `1800000` | Wall-clock cap for one run; exceeding it aborts with `session.error{type:"run_timeout"}` |

Everything else lives in `.env.example` with a comment; `docs/BACKENDS.md` covers running without Redis.
