# Guide

The parts of rethink you reach for once it is running: how a turn actually executes, how sandboxes and
workspaces relate, the resource shapes, and the operational details. The README is the entry point;
DESIGN.md is the rationale; this is the middle.

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

## Slack channel (mention → session)

See [`CHANNELS.md`](./CHANNELS.md) for the full setup. Short version: store `SLACK_BOT_TOKEN` and
`SLACK_SIGNING_SECRET` in a vault, create an integration with `pma integrations create --kind slack …`,
and point Slack’s Event Subscriptions / Interactivity Request URLs at
`/v1/integrations/<id>/events` and `/v1/integrations/<id>/interactions`. Mentions start or resume a
session; the durable `channel_threads` row survives API restarts. Tool confirmations (`always_ask`)
get Allow/Deny buttons; client tools are answered with `/answer <call_id> …` in the thread. Secrets
never enter the event log.

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

## Sandbox providers

| provider | where code runs | workspace transport | notes |
|---|---|---|---|
| `local` | runner host, `bash -lc` | in place | dev only, no isolation |
| `docker` | sibling container via docker socket | bind mount | default `--network none`, caps dropped, resource limits |
| `e2b` | e2b cloud sandbox (https://e2b.dev) | materialized inside the sandbox over the SDK; captured back as git patch or tarball | needs `E2B_API_KEY`; `image` is the e2b template name |
| `byoc` | **your own machine / cloud**: a `pma worker` you run polls the API (outbound only) and executes there | git refs are cloned by the worker; non-git workspaces stay on the worker (`{kind:"byoc"}` refs) | `pma envs create x --provider byoc` returns a `worker_key` once; `pma worker --env <id> --key <key> --workdir DIR` |

All three implement the same mechanism-only `SandboxProvider` interface (`create` / `connect` / `destroy` / `capture`). Policy lives in one place, `SandboxManager` (`src/sandbox/manager.ts`): the lease table, affinity reuse, rejecting a second live lease on the same workspace, reaping, and list/get/destroy. Adding a provider means one file under `src/sandbox/` plus a registry entry; it never touches the lease table.

Sandboxes are inspectable over the API: `GET /v1/sandboxes`, `GET /v1/sandboxes/:id`, `DELETE /v1/sandboxes/:id` (202: a ready sandbox is marked and a runner's reaper destroys it on its next pass; 409 if it is leased by a running session).

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

## BYOK (bring your own model key)

Providers accept `auth: {type: "key", key: "sk-…"}`: the API seals the key with AES-256-GCM under
`PMA_SECRET_KEY` before storing, reads return only `{type:"encrypted"}`, and the runner unseals it when
building the model registry. `pma providers create my-openai --api openai-responses --base-url https://api.openai.com/v1 --key sk-… --models gpt-5:400000`.
Operator-owned keys keep using `{type:"env", name}`. Without `PMA_SECRET_KEY`, storing keys is refused.

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

## Layout

```
src/shared/    types.ts (the contract), env.ts, ids.ts
src/infra/     db.ts, events.ts, pubsub.ts, queue.ts, migrate.ts
src/sandbox/   provider.ts, local.ts, docker.ts, workspace.ts, exec.ts, lease-store.ts
src/harness/   models.ts, tools.ts, fold.ts, run-turn.ts
src/api/       main.ts, routes/{agents,environments,sessions,events}.ts
src/channels/  slack adapter (events → sessions, thread mapping, outbound bridge)
src/runner/    main.ts
src/cli/       main.ts
sql/schema.sql, scripts/e2e.sh, test/
```

## Architecture diagram

The diagram source is `docs/architecture.archify.json`. The rendered HTML is a build artifact and is not committed:

```bash
bash scripts/diagram.sh --open   # renders docs/architecture.html and opens it
```

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

