# Architecture & module contract

Read DESIGN.md for the why. This file is the *what*: module boundaries every implementer follows.
All types live in `src/shared/types.ts` — code against them, do not redefine them.

```
src/shared/     types.ts (contract), ids.ts (newId("sess")), env.ts (config from process.env)
src/infra/      db.ts (pg pool + typed repos), events.ts (append/list/fold), pubsub.ts (redis pub/sub for
                StreamDelta), queue.ts (Redis Streams job queue for RunJob), migrate.ts (applies sql/schema.sql)
src/sandbox/    manager.ts (SandboxManager: policy — leases, affinity reuse, conflict rejection, reap, list/get/destroy),
                provider.ts (registry + process-wide manager), local.ts / docker.ts / e2b.ts (mechanism: create/connect/
                destroy/capture only), workspace.ts (materialize/capture helpers), lease-store.ts (sandboxes table)
src/plugins/    api.ts (plugin API + capabilities), host.ts (permission-restricted host process), client.ts
                (runner side: spawn, tools, hooks, capability serving), protocol.ts, installer.ts, pi-compat.ts
src/harness/    pi-session.ts (EXPERIMENTAL: pi-coding-agent AgentSession, see docs/PI_EXTENSIONS.md),
                tools.ts (bash/read/write/edit AgentTools over ctx.sandbox()), fold.ts (events -> pi
                AgentMessage[]), run-turn.ts (one session run: fold, pi-agent-core loop + plugin hooks, persist events,
                steering/interrupt, capture+release), models.ts (pi-ai registry built from the providers table; runner reloads on providers:changed)
src/api/        main.ts (hono server), routes/*.ts (providers, agents, environments, sessions, events, stream, sandboxes, models)
src/runner/     main.ts (consume queue -> run-turn; reaper loop)
src/cli/        main.ts (thin client: create agent/env/session, send, stream)
```

## Runtime flow
1. `POST /v1/sessions/:id/events` appends user events and reads `sessions.status` under the same row lock
   (`withSession`); for `user.message`: idle -> enqueue `RunJob`; running -> `RPUSH steer:{session}` (with seq)
   so the live loop picks it up via pi `getSteeringMessages`. `user.interrupt`: `PUBLISH interrupt:{session}`.
2. Runner: subscribes to interrupts, then `claimRun` (one tx: status idle->running + `session.status_running`;
   a `running` session whose heartbeat is stale is taken over, a live one makes the job stay pending), folds
   the whole log into pi context, lazily acquires sandbox on first tool call, runs pi `runAgentLoop`, appends
   events as they happen, publishes StreamDelta. Steer entries with seq <= folded lastSeq are dropped (dupes).
3. On loop end: capture workspace -> `workspace.captured` (+ optimistic `workspaces.ref` update), release
   lease -> `sandbox.released`, `finishRun` (one tx: `session.status_idle` + status idle + detect user
   messages with seq > consumed -> runner enqueues a follow-up run).
4. `GET /v1/sessions/:id/events/stream` (SSE): replay from `since` seq from DB, then subscribe to pubsub.

## Invariants
- events table is append-only; session state = fold(events). No "messages" column anywhere.
- session row never references a sandbox. Sandboxes appear only as events + the sandboxes table (lease registry).
- session ↔ environment is 1:N (`session_environments`, key "main" is primary); each environment leases its own sandbox; child sessions (`parent_id`) run on forked workspaces. DESIGN.md §11.
- Tools never import a provider; they use `ToolContext.sandbox()`. The harness only sees `SandboxService` (acquire/capture) from `SandboxManager.bind(name)`.
- Providers never touch the sandboxes table; only SandboxManager writes leases.
- Secrets never enter events.
- Keep core small: harness/ + sandbox/ interfaces should stay < 1500 LOC total.
