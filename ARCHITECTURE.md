# Architecture & module contract

Read DESIGN.md for the why. This file is the *what*: module boundaries every implementer follows.
All types live in `src/shared/types.ts` — code against them, do not redefine them.

```
src/shared/     types.ts (contract), ids.ts (newId("sess")), env.ts (config from process.env)
src/infra/      db.ts (pg pool + typed repos), events.ts (append/list/fold), pubsub.ts (redis pub/sub for
                StreamDelta), queue.ts (Redis Streams job queue for RunJob), migrate.ts (applies sql/schema.sql)
src/sandbox/    provider.ts (registry: getProvider(name)), local.ts, docker.ts, e2b.ts (remote materialize/capture), workspace.ts (materialize/capture
                helpers shared by providers), lease-store.ts (sandboxes table)
src/harness/    models.ts (pi-ai Models with qoder + anthropic providers), tools.ts (bash/read/write/edit
                AgentTools over ctx.sandbox()), fold.ts (events -> pi AgentMessage[]), run-turn.ts (one
                session run: fold, runAgentLoop, persist events, steering/interrupt, capture+release)
src/api/        main.ts (hono server), routes/*.ts (agents, environments, sessions, events, stream)
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
- Tools never import a provider; they use `ToolContext.sandbox()`.
- Secrets never enter events.
- Keep core small: harness/ + sandbox/ interfaces should stay < 1500 LOC total.
