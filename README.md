# rethink-managed-agent

A small, self-hostable coding-agent service in the spirit of Claude Managed Agents, built on three ideas:

- **Thin harness.** The agent loop is [pi](https://github.com/badlogic/pi-mono)'s `runAgentLoop` from `@earendil-works/pi-agent-core`; we add four tools (`bash`, `read`, `write`, `edit`) and an append-only event log. Session state is *only* the fold of that log — there is no messages table.
- **Pluggable sandbox.** Compute is a short-lived *lease*, never part of a session. A session holds a workspace reference (git base + diff, a directory, or nothing); a sandbox is acquired lazily on the first tool call and released when the turn ends. Providers today: `local` (a directory on the runner host) and `docker` (sibling container).
- **Managed-Agent-like API.** Agents, environments, sessions, and events as REST resources; live output over SSE; user messages sent mid-turn are steered into the running loop.

Read `DESIGN.md` for the rationale and `ARCHITECTURE.md` for the module contract. Everything is typed against `src/shared/types.ts`. For a Chinese version of this README, see [README.zh.md](README.zh.md).

## Prior art, and where we differ

We genuinely admire the architecture of OpenAI's Agents API and Anthropic's Managed Agents. They got the
decomposition right: a **brain–hands split** where the model does the thinking and a managed sandbox does
the doing, with a durable session on top. Independently, this project arrived at nearly the same object
model (agent / session / environment / events), which is the strongest evidence that split is correct. If
you want the fastest path to a hosted agent with zero ops, use them — they are excellent.

Two things about those designs we think are not good enough, and set out to fix:

- **They bind you to one cloud vendor.** The model is the vendor's, the sandbox runs on the vendor's infra,
  and your event log lives there too. You cannot bring your own model, run it in your own VPC, or take the
  agent air-gapped. rethink makes the model a provider row (BYOK, any OpenAI/Anthropic-compatible endpoint),
  the sandbox a pluggable provider (local/docker/e2b/BYOC), and the whole stack self-hostable.
- **The architecture is not elegant enough.** The sandbox is welded 1:1 to the session, so state is split
  between an opaque platform store and a live container: suspend/resume means freezing a box, a session
  can't span or swap sandboxes, and the loop's truth is hidden inside the vendor. rethink keeps the same
  brain–hands split but makes the **event log the only source of truth** and the **sandbox a disposable
  lease** — session, workspace, and sandbox become three independent lifecycles that compose freely (N:N,
  rebuildable, shareable). Everything above core — sub-agents, approval, plan mode — is a plugin, not
  platform.

It is the same good idea, decoupled and made portable. See `docs/POSITIONING.md` for the full comparison.

## Quickstart (docker compose)

1. Start the model proxy on the host. The default provider is a keyless OpenAI-compatible proxy for Qoder models listening on port 4141:
   ```sh
   cd ~/qoder-openai-provider && npm start   # serves http://127.0.0.1:4141/v1
   ```
   Providers live in the DB (`pma providers list`); the Qoder proxy is seeded on first start. To add Anthropic: set `ANTHROPIC_API_KEY` on the runner and `pma providers create anthropic --api anthropic-messages --base-url https://api.anthropic.com --auth-env ANTHROPIC_API_KEY --models claude-sonnet-4-6:200000`, then reference `{provider:"anthropic", id:"claude-sonnet-4-6"}` on an agent.
2. Configure and start the stack (postgres, redis, api, runner):
   ```sh
   cp .env.example .env
   docker compose up --build
   ```
   The runner container reaches the proxy at `host.docker.internal:4141`. If something on the host already listens on 5432/6379/8080, set `PG_HOST_PORT`, `REDIS_HOST_PORT` or `API_PORT` in `.env` (they only change the published host ports).
3. Run the end-to-end smoke test from the host. It creates an agent (`qoder/ultimate`), a local environment, and a session, asks the agent to create a file, and asserts a `bash`/`write` tool call and a `session.status_idle` event appear:
   ```sh
   scripts/e2e.sh
   ```

**Minimal deploy (Postgres only).** `make up-min` runs the whole stack on Postgres alone — no Redis, no MinIO (`MESSAGING_BACKEND=postgres`, blobs on a local dir). One datastore to operate; the easiest way to fork and self-host. `make up` is the full stack (Redis for the queue/bus, MinIO for blobs) when you want them.

Open **http://localhost:8080/** in a browser for a read-only dashboard: the session list, each session's event timeline (messages, tool calls + results, status), and a live tail over SSE.

Talking to it by hand with the bundled CLI (`npm run cli -- <command>`; see [CLI](#cli) for every command):

```sh
npm run cli -- agents create dev qoder/ultimate                  # legacy form still works: agent create --name dev --provider qoder --model ultimate
npm run cli -- envs create local --provider local                # or --provider docker --image node:22-alpine, or --provider e2b --image base
npm run cli -- sessions create --agent agent_xxx --env env_xxx
npm run cli -- send sess_xxx "list the files here and add a README" --wait
npm run cli -- events sess_xxx
```

## Identity & ownership

Every top-level resource belongs to a **principal** — the polymorphic owner (a user today; `kind` extends to `org`/`service`). A request's principal is resolved from `Authorization: Bearer <token>` against `api_keys`; reads and writes are scoped to it, so one principal never sees or edits another's agents, sessions, files, and so on. Sub-sessions and forked workspaces inherit the parent's owner. See DESIGN §15.

Auth is off by default for local use: with `AUTH_REQUIRED=false` an unauthenticated request acts as `PMA_DEFAULT_PRINCIPAL` (the seeded `prc_local`), so nothing needs a token. Set `AUTH_REQUIRED=true` to require a valid key. Mint identities and keys with:

```
POST /v1/principals   {kind?, handle?, display_name?}     -> a principal (prc_...)
POST /v1/api_keys     {principal_id?, name?}              -> {token}  (shown once)
GET  /v1/me                                               -> the calling principal
```

Then call the API with `Authorization: Bearer pma_...`. The BYOC worker endpoints authenticate with `x-worker-key` instead and bypass principal auth.

**Bring your own identity.** rethink owns the *isolation* boundary (every resource carries `owner_id`, enforced in the repos) but not what a "user"/"org" means. *How* a credential becomes a principal is a pluggable resolver: point `PRINCIPAL_RESOLVER` at a module that default-exports a `PrincipalResolver` (`src/api/principal-resolver.ts`) and the consuming business plugs in its own auth — a verified JWT/OIDC, a trusted gateway header, mTLS, a per-tenant key. The resolver returns `{actor, owner?}`; everything downstream sees only `owner`, and returning an `owner` different from `actor` is where org scoping slots in later. The built-in default is Bearer→`api_keys`; `src/api/resolvers/trusted-header.ts` is a ready example (trusts an upstream gateway's `x-principal-id`, with `x-org-id` selecting the owner). So run many tenants in one deployment with principal isolation, or give a tenant that needs physical separation its own stack.

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

## How a turn runs

```
POST /events ──▶ events table (seq) ──▶ Redis stream "runs" ──▶ runner
                                                                  │ session.status_running
                                                                  │ fold(events) -> pi messages
                                                                  │ runAgentLoop  (tool call ⇒ lazily provider.acquire)
                                                                  │   agent.message / agent.tool_use / agent.tool_result
                                                                  │   deltas -> Redis pub/sub -> SSE
                                                                  │ provider.capture -> workspace.captured
                                                                  │ lease.release   -> sandbox.released
                                                                  └ session.status_idle
```

- **Steering.** If the session is already `running`, the API appends the user event and pushes it to `steer:{session}`; the loop drains that list between turns via pi's `getSteeringMessages`. Interrupts are pub/sub on `interrupt:{session}` and abort the loop.
- **Resume.** A new run folds the whole log back into pi messages. Assistant tool calls left without results (interrupted run) get synthetic error results so the transcript stays valid.
- **Max turns.** `MAX_TURNS` (default 50) caps tool-using turns per run; hitting it yields `stop_reason: "max_turns"`.

## Sandbox / session decoupling

Three objects with independent lifecycles:

| Object | Lives | Persisted as |
|---|---|---|
| Session | days; suspended between turns | `events` rows (append-only) |
| Workspace | across sessions | `workspaces.ref` — a `WorkspaceRef`: `{kind:"git", remote, base, patch?}`, `{kind:"dir", path}`, `{kind:"local", path}`, or `{kind:"empty"}` |
| Sandbox | minutes to hours; disposable | `sandboxes` table (lease registry) only |

The session row never references a sandbox. When a tool first runs, the harness calls `provider.acquire({workspaceId, workspaceRef, image, affinity: workspaceId})`. The provider either reuses a `ready` sandbox with the same affinity (atomic `UPDATE ... FOR UPDATE SKIP LOCKED` marks it `busy`) or materializes the workspace ref into a fresh one (git clone + checkout + `git apply`, `cp -R` for `dir`, in-place for `local`). At the end of the run the provider *captures* the workspace (`git diff HEAD --binary` with untracked files included, or a copy of the sandbox dir into `WORKSPACE_ROOT/<id>` — the sandbox dir itself is ephemeral and reapable), the harness records `workspace.captured` (git remotes with embedded credentials are redacted there) and updates `workspaces.ref` — optimistically, only if the ref is still the one the run started from — and the lease is released (status `ready`). A provider rejects `acquire` while another session holds a `busy` lease on the same affinity (DESIGN §5), so two runs never write one workspace at once. The runner's reaper pauses sandboxes that have been `ready` longer than `SANDBOX_IDLE_TTL_MS` (docker `pause`, e2b snapshot; the filesystem, installed deps, and even running processes survive, the next acquire resumes them in place) and destroys paused ones after `SANDBOX_PAUSED_TTL_MS`; providers without pause (local) are destroyed at the first tier. DESIGN.md §12. A later turn — on any runner — rebuilds the workspace from the ref if the sandbox is gone.

See `demos/` for runnable proofs of each of these properties (`make demo`; no stack needed, docker optional) — N:N, disposable sandbox, shared container, provider swap, pause/resume — each with a side-by-side note on why session-bound products can't do it.

## Adding a sandbox provider

1. Implement `SandboxProvider` from `src/shared/types.ts`:
   - `acquire(req)` returns `{sandbox, release}`; `sandbox` exposes `workdir`, streaming `exec(cmd, {cwd, env, timeoutMs, signal})`, `readFile`, `writeFile`. Use `src/sandbox/workspace.ts` (`materialize`, `captureGit`) and `src/sandbox/exec.ts` (`streamProcess`, `resolveInside`) rather than re-implementing them, and record the lease with `src/sandbox/lease-store.ts` so affinity reuse and reaping work.
   - `capture(sandbox, prevRef)` returns the new `WorkspaceRef`.
   - `reap(idleTtlMs)` destroys idle leases and returns their ids.
2. Add the name to `SandboxProviderName` in `src/shared/types.ts` (and note it in `ARCHITECTURE.md`), then register an instance in `src/sandbox/provider.ts`.
3. Nothing in `src/harness` changes: tools only see `ToolContext.sandbox()`, and the runner picks the provider from `environment.provider`.

`src/sandbox/docker.ts` (about 100 lines) is the reference: `docker run -d ... sleep infinity`, `docker exec` for commands, files through the bind-mounted host directory.

### Docker provider from inside a container (`SANDBOX_HOST_ROOT`)

The docker provider talks to the host daemon through `/var/run/docker.sock`, so sandbox containers are *siblings* of the runner, not children. Bind mounts in `docker run -v host:/workspace` are resolved by the daemon on the host, which means the workspace directory must be given as a **host** path. When the runner is itself a container, the directory it materializes under `SANDBOX_LOCAL_ROOT` (`/data/sandboxes`) is not visible under that name on the host, so:

- `docker-compose.yml` bind-mounts a host directory (`./data/sandboxes` by default, overridable with `SANDBOX_HOST_ROOT`) at `/data/sandboxes` instead of using a named volume, and
- passes `SANDBOX_HOST_ROOT=$PWD/data/sandboxes` to the runner; `toHostPath()` in `docker.ts` rewrites `/data/sandboxes/<sbx>` to `<SANDBOX_HOST_ROOT>/<sbx>` for the `-v` flag only. Reads/writes from the runner keep using the container path.

Running the runner directly on the host, leave `SANDBOX_HOST_ROOT` unset: paths are used verbatim. A `ready` lease whose container or directory has disappeared (docker restart, wiped volume, a different runner host) is detected on `acquire` and retired; the workspace is rebuilt from its ref into a fresh sandbox.

## Local development without docker

Requires Node 22+, a Postgres, and a Redis (for example `brew services start postgresql@16 redis`, then `createdb pi`).

```sh
npm install
cp .env.example .env          # edit DATABASE_URL / REDIS_URL; the model provider is a DB row (below)
npm run migrate               # idempotent; api and runner also migrate on boot
npm run api                   # http://localhost:8080
npm run runner                # in another terminal; consumes the run queue and reaps sandboxes
scripts/e2e.sh
```

`SANDBOX_LOCAL_ROOT` (default `./data/sandboxes`) is where the `local` provider (and the `docker` provider's bind mounts) put workspaces. `WORKSPACE_ROOT` (default `./data/workspaces`) is where captured `dir` workspaces live; the reaper never touches it. Run more runners for more concurrency: they share one consumer group; a job pending longer than 120s is re-examined by any runner, and `claimRun` (`UPDATE sessions ... WHERE status='idle'`, or `running` with a heartbeat older than 90s) decides whether that run is alive (job stays pending) or dead (taken over). The `local` provider is dev-only: commands run on the runner host with an allow-listed env; use `docker` for untrusted code (containers get `--network none`, `--cap-drop ALL`, pids/memory/cpu limits — see the `SANDBOX_DOCKER_*` variables).

Other useful scripts: `npm run typecheck`, `npm test` (vitest: fold + local sandbox), `npm run cli -- <cmd>` (see [CLI](#cli)).

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

## Layout

```
src/shared/    types.ts (the contract), env.ts, ids.ts
src/infra/     db.ts, events.ts, pubsub.ts, queue.ts, migrate.ts
src/sandbox/   provider.ts, local.ts, docker.ts, workspace.ts, exec.ts, lease-store.ts
src/harness/   models.ts, tools.ts, fold.ts, run-turn.ts
src/api/       main.ts, routes/{agents,environments,sessions,events}.ts
src/runner/    main.ts
src/cli/       main.ts
sql/schema.sql, scripts/e2e.sh, test/
```

## System prompt

The prompt is the agent's `system` text plus the smallest possible framework sections, and it is
inspectable: `GET /v1/sessions/:id/system_prompt` (`pma sessions prompt <id>`, `/prompt` in the TUI)
returns exactly what the last run sent. The default, when `system` is empty, is one sentence:
"You are a coding agent working in a sandboxed workspace. Paths are relative to the workspace root."

Sections are appended only when they apply, one short block each: `Skills (…)` listing skills the model can
load with the `skill` tool, `Memory (…)` listing mounts, and text plugins add via `context` /
`before_agent_start` hooks. To own the layout, use placeholders in `system`: `{{skills}}`, `{{memory}}`,
`{{plugins}}` — then only the placeholders you wrote are rendered, where you put them.

Change it at any level: `PATCH /v1/agents/:id {system}` (`pma agents update <id> --system … | --system-file F`)
for future sessions; `PATCH /v1/sessions/:id {system}` (`pma sessions set-system <id> …`, `/prompt set …`)
for a running session, applied on its next turn and recorded as `session.updated`.

## Files, skills, memory stores (Managed Agents-shaped)

Binary content lives in an S3-compatible **blob store** (MinIO in compose; `BLOB_ENDPOINT` / `BLOB_BUCKET` /
`BLOB_ACCESS_KEY` / `BLOB_SECRET_KEY`); without one, bytes fall back to Postgres.

| resource | API | in a session |
|---|---|---|
| **File** | `POST /v1/files` (multipart `file` or raw + `x-file-name`) → `{id, type:"file", filename, mime_type, size_bytes, downloadable}`; `GET /v1/files[/:id[/content]]`, `DELETE` | `user.message` blocks `{type:"image"\|"document", source:{type:"file", file_id}}`: images go to the model inline, documents are written to `.attachments/<id>-<filename>` in the main sandbox. `pma session send <id> "…" --file a.pdf,b.png` |
| **Skill** | `POST /v1/skills` (multipart `files` incl. `SKILL.md` + `display_title`, or JSON `{markdown}`) → `{id, type:"skill", source:"custom", display_title, name, latest_version}`; `POST /v1/skills/:id/versions` | `agents.skills: [{type:"custom", skill_id, version?}]` (bare ids accepted); listed in the system prompt, loaded on demand with the builtin `skill` tool. `pma skills create --file SKILL.md`, `pma agents create x p/m --skills skill_a` |
| **Memory store** | `POST /v1/memory_stores {name, description}` → `{id, type:"memory_store", …}` | `sessions.memory_stores: [{memory_store_id, mount_path}]` (default `memories/<name>`, relative to the workspace root): mounted before a run (tar over exec/writeFile, works on every provider) and snapshotted back to the blob store after (`{kind:"blob"}` refs, portable across runners). Inherited by child sessions. `pma sessions create --memory-stores mem_a:memories/notes` |

**Mid-session changes** (take effect on the next turn, recorded as `session.updated {changes}`):
`POST/DELETE /v1/sessions/:id/memory_stores[/:storeId]` and `POST/DELETE /v1/sessions/:id/skills[/:skillId]`;
`pma sessions mount|unmount <id> <mem_id>[:path]`, `pma sessions skill <id> add|remove <skill_id>`.

## Big tool outputs (spill-to-store)

Tool results over 30k chars are truncated head+tail for the model, but the full text is kept in
`tool_outputs` (Postgres) under the tool call id. The truncation note tells the model to call the builtin
`tool_output {tool_use_id, grep | offset/limit}` to search or page through it, and
`GET /v1/sessions/:id/tool-outputs/:toolUseId` serves the raw text.

## Streams and ids

Every assistant message has a `stream_id`; its `agent.message_delta` / `agent.thinking_delta` /
`agent.tool_use_*` previews and the persisted `agent.message` share it, so a client that reconnects mid-stream
can attach late deltas and finalize the right message. The final reasoning text is persisted on
`agent.message.thinking`, so a resumed TUI shows past thinking blocks.

## Usage and context size

Every model request appends `span.model_request_end {model, usage:{input, output, cache_read, cache_write,
total_tokens}, context:{tokens, window, ratio}}`; the session row keeps cumulative `usage` and the latest
`context`, and each run ends with a `session.usage` snapshot. `GET /v1/sessions/:id` returns both; pma shows
`ctx 4.5k/200k (2%)` in the TUI header (yellow > 50%, red > 80%), in `/status`, and in `pma sessions list`.

## Context compaction

Before every model request the runner estimates the context (last reported usage plus an estimate of
what followed, pi's heuristics). Over `contextWindow - COMPACTION_RESERVE_TOKENS` it summarizes everything
older than the last ~`COMPACTION_KEEP_RECENT_TOKENS` (pi's summarizer, chaining the previous summary), cutting
only at turn or tool-step boundaries, and persists `agent.thread_context_compacted {summary, first_kept_seq}`.
Folding honours it: older message events are replaced by the summary, so any runner resuming the session sees
the compacted context. Defaults match pi (16384 / 20000); `COMPACTION_ENABLED=0` turns it off.

## Reliability notes

- **enqueue-after-commit**: the API commits `user.message` first and only then XADDs the run job. If it dies
  in between (or Redis loses the entry), the runner's reconciler (every 60s) finds idle sessions whose newest
  `user.message` is newer than their newest status event and older than 30s, and re-enqueues them. Messages
  arriving while a run is active are covered by `finishRun`'s unconsumed-seq check.

## BYOC (self-hosted sandboxes)

```bash
pma envs create my-laptop --provider byoc            # -> worker_key (shown once)
pma worker --env env_x --key "$WORKER_KEY" --workdir ~/pma-work   # on the machine that should run the tools
pma sessions create --agent <agent> --env env_x --message "uname -a"
```

The worker never accepts inbound connections: it long-polls `POST /v1/environments/:id/worker/poll`
(authenticated with the key) for create / exec / read / write / capture / destroy requests, runs them
under one directory per sandbox (file access confined to it, commands with an allow-listed env), and posts
results back; the runner relays over Redis. A sandbox whose worker stops heartbeating (60s) is retired, and a
run on an environment with no worker connected fails immediately with instructions instead of hanging.
Runner-side plugins work unchanged; `plugin_host: "sandbox"` is not available for byoc yet.

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

## BYOK (bring your own model key)

Providers accept `auth: {type: "key", key: "sk-…"}`: the API seals the key with AES-256-GCM under
`PMA_SECRET_KEY` before storing, reads return only `{type:"encrypted"}`, and the runner unseals it when
building the model registry. `pma providers create my-openai --api openai-responses --base-url https://api.openai.com/v1 --key sk-… --models gpt-5:400000`.
Operator-owned keys keep using `{type:"env", name}`. Without `PMA_SECRET_KEY`, storing keys is refused.

## Sessions ↔ sandboxes (N:N)

A session attaches one or more environments (`environments: [{key:"main", ...}, {key:"browser", ...}]`,
or `POST /v1/sessions/:id/environments` later); each has its own workspace and leases its own sandbox on
demand, and the builtin tools take an `env` parameter to pick one. Several sessions may share a workspace
(and therefore its sandbox, one live lease at a time). Sub-agents: `ctx.agent.run(task, {isolated: true})`
creates a child session (`parent_id`) on a *fork* of the workspace with its own sandbox; the parent gets
`session.thread_created` / `agent.thread_message_received` with the child's report and patch. See DESIGN.md §11.

```bash
pma sessions create --agent "$AGENT" --environments "main=$LOCAL_ENV,dk=$DOCKER_ENV"   # two sandboxes, one conversation
pma sessions attach sess_x browser=$E2B_ENV:fork                         # later, on a fork of main's workspace
```

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

## Sandbox providers

| provider | where code runs | workspace transport | notes |
|---|---|---|---|
| `local` | runner host, `bash -lc` | in place | dev only, no isolation |
| `docker` | sibling container via docker socket | bind mount | default `--network none`, caps dropped, resource limits |
| `e2b` | e2b cloud sandbox (https://e2b.dev) | materialized inside the sandbox over the SDK; captured back as git patch or tarball | needs `E2B_API_KEY`; `image` is the e2b template name |
| `byoc` | **your own machine / cloud**: a `pma worker` you run polls the API (outbound only) and executes there | git refs are cloned by the worker; non-git workspaces stay on the worker (`{kind:"byoc"}` refs) | `pma envs create x --provider byoc` returns a `worker_key` once; `pma worker --env <id> --key <key> --workdir DIR` |

All three implement the same mechanism-only `SandboxProvider` interface (`create` / `connect` / `destroy` / `capture`). Policy lives in one place, `SandboxManager` (`src/sandbox/manager.ts`): the lease table, affinity reuse, rejecting a second live lease on the same workspace, reaping, and list/get/destroy. Adding a provider means one file under `src/sandbox/` plus a registry entry; it never touches the lease table.

Sandboxes are inspectable over the API: `GET /v1/sandboxes`, `GET /v1/sandboxes/:id`, `DELETE /v1/sandboxes/:id` (202: a ready sandbox is marked and a runner's reaper destroys it on its next pass; 409 if it is leased by a running session).

## Architecture diagram

The diagram source is `docs/architecture.archify.json`. The rendered HTML is a build artifact and is not committed:

```bash
bash scripts/diagram.sh --open   # renders docs/architecture.html and opens it
```
