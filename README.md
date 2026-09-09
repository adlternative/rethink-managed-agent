# pi-like managed agent

A small, self-hostable coding-agent service in the spirit of Claude Managed Agents, built on three ideas:

- **Thin harness.** The agent loop is [pi](https://github.com/badlogic/pi-mono)'s `runAgentLoop` from `@earendil-works/pi-agent-core`; we add four tools (`bash`, `read`, `write`, `edit`) and an append-only event log. Session state is *only* the fold of that log — there is no messages table.
- **Pluggable sandbox.** Compute is a short-lived *lease*, never part of a session. A session holds a workspace reference (git base + diff, a directory, or nothing); a sandbox is acquired lazily on the first tool call and released when the turn ends. Providers today: `local` (a directory on the runner host) and `docker` (sibling container).
- **Managed-Agent-like API.** Agents, environments, sessions, and events as REST resources; live output over SSE; user messages sent mid-turn are steered into the running loop.

Read `DESIGN.md` for the rationale and `ARCHITECTURE.md` for the module contract. Everything is typed against `src/shared/types.ts`.

## Quickstart (docker compose)

1. Start the model proxy on the host. The default provider is a keyless OpenAI-compatible proxy for Qoder models listening on port 4141:
   ```sh
   cd ~/qoder-openai-provider && npm start   # serves http://127.0.0.1:4141/v1
   ```
   To use Anthropic directly instead, set `ANTHROPIC_API_KEY` and reference `{provider:"anthropic", id:"claude-sonnet-4-6"}` when creating an agent.
2. Configure and start the stack (postgres, redis, api, runner):
   ```sh
   cp .env.example .env
   docker compose up --build
   ```
   The runner container reaches the proxy at `host.docker.internal:4141`.
3. Run the end-to-end smoke test from the host. It creates an agent (`qoder/ultimate`), a local environment, and a session, asks the agent to create a file, and asserts a `bash`/`write` tool call and a `session.status_idle` event appear:
   ```sh
   scripts/e2e.sh
   ```

Talking to it by hand with the bundled CLI (`PI_API` defaults to `http://localhost:8080`):

```sh
npm run cli -- agent create --name dev --provider qoder --model ultimate
npm run cli -- env create --name local --provider local            # or --provider docker --image node:22-alpine
npm run cli -- session create --agent agent_xxx --env env_xxx
npm run cli -- send sess_xxx "list the files here and add a README" --wait
npm run cli -- events sess_xxx
```

## API

All bodies and responses are JSON. Errors are `{type:"error", error:{type, message}}` with 400/404/500.

| Method | Path | Body / query | Notes |
|---|---|---|---|
| GET | `/healthz` | | `{ok:true}` |
| POST | `/v1/agents` | `{name, model:{provider,id}, system?, tools?}` | `tools` defaults to all four builtins |
| GET | `/v1/agents`, `/v1/agents/:id` | | |
| POST | `/v1/environments` | `{name, provider:"local"\|"docker", image?, workspace?}` | `workspace` is the default `WorkspaceSpec`: `{kind:"empty"}` (default), `{kind:"git", remote, ref?}`, `{kind:"local", path}` |
| GET | `/v1/environments`, `/v1/environments/:id` | | |
| POST | `/v1/sessions` | `{agent: id \| {type:"agent_with_overrides", id, model?, system?, tools?}, environment_id, workspace? \| workspace_id?, initial_events?}` | Snapshots the agent config into the session. Omit `workspace*` to use the environment default; pass `workspace_id` to continue an existing workspace |
| GET | `/v1/sessions`, `/v1/sessions/:id` | | `status` is `idle` / `running` / `terminated` |
| DELETE | `/v1/sessions/:id` | | Cascades to events |
| POST | `/v1/sessions/:id/archive` | | Appends `session.status_terminated` |
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

The session row never references a sandbox. When a tool first runs, the harness calls `provider.acquire({workspaceId, workspaceRef, image, affinity: workspaceId})`. The provider either reuses a `ready` sandbox with the same affinity (atomic `UPDATE ... FOR UPDATE SKIP LOCKED` marks it `busy`) or materializes the workspace ref into a fresh one (git clone + checkout + `git apply`, `cp -R` for `dir`, in-place for `local`). At the end of the run the provider *captures* the workspace (`git diff HEAD --binary` with untracked files included, or the managed dir path), the harness records `workspace.captured` and updates `workspaces.ref`, and the lease is released (status `ready`). The runner's reaper destroys sandboxes that have been `ready` longer than `SANDBOX_IDLE_TTL_MS`. A later turn — on any runner — rebuilds the workspace from the ref if the sandbox is gone.

## Adding a sandbox provider

1. Implement `SandboxProvider` from `src/shared/types.ts`:
   - `acquire(req)` returns `{sandbox, release}`; `sandbox` exposes `workdir`, streaming `exec(cmd, {cwd, env, timeoutMs, signal})`, `readFile`, `writeFile`. Use `src/sandbox/workspace.ts` (`materialize`, `captureGit`) and `src/sandbox/exec.ts` (`streamProcess`, `resolveInside`) rather than re-implementing them, and record the lease with `src/sandbox/lease-store.ts` so affinity reuse and reaping work.
   - `capture(sandbox, prevRef)` returns the new `WorkspaceRef`.
   - `reap(idleTtlMs)` destroys idle leases and returns their ids.
2. Add the name to `SandboxProviderName` in `src/shared/types.ts` (and note it in `ARCHITECTURE.md`), then register an instance in `src/sandbox/provider.ts`.
3. Nothing in `src/harness` changes: tools only see `ToolContext.sandbox()`, and the runner picks the provider from `environment.provider`.

`src/sandbox/docker.ts` (about 90 lines) is the reference: `docker run -d ... sleep infinity`, `docker exec` for commands, files through the bind-mounted host directory.

## Local development without docker

Requires Node 22+, a Postgres, and a Redis (for example `brew services start postgresql@16 redis`, then `createdb pi`).

```sh
npm install
cp .env.example .env          # edit DATABASE_URL / REDIS_URL / QODER_BASE_URL as needed
npm run migrate               # idempotent; api and runner also migrate on boot
npm run api                   # http://localhost:8080
npm run runner                # in another terminal; consumes the run queue and reaps sandboxes
scripts/e2e.sh
```

`SANDBOX_LOCAL_ROOT` (default `./data/sandboxes`) is where the `local` provider (and the `docker` provider's bind mounts) put workspaces. Run more runners for more concurrency; they share one consumer group and reclaim jobs left pending by a dead runner after 60s.

Other useful scripts: `npm run typecheck`, `npm test` (vitest: fold + local sandbox), `npm run cli -- <cmd>`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `postgres://pi:pi@localhost:5432/pi` | Postgres (PolarDB-PG is wire compatible) |
| `REDIS_URL` | `redis://localhost:6379` | Queue, pub/sub, steering lists |
| `QODER_BASE_URL` | `http://127.0.0.1:4141/v1` | OpenAI-compatible proxy for the `qoder` provider |
| `ANTHROPIC_API_KEY` | | Enables the `anthropic` provider |
| `SANDBOX_DEFAULT_PROVIDER` | `local` | Fallback when an environment has no provider |
| `SANDBOX_LOCAL_ROOT` | `./data/sandboxes` | Host directory for sandbox workspaces |
| `SANDBOX_IDLE_TTL_MS` | `600000` | Reaper threshold for idle sandboxes |
| `API_PORT` | `8080` | |
| `MAX_TURNS` | `50` | Tool-using turns per run |

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
