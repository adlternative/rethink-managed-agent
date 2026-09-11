# Pluggable backends

Every infrastructure dependency is (or is becoming) an interface with a factory that selects a
backend by env — the same pattern as `SandboxProvider`. The default backend ships; alternatives slot
in without touching call sites. Mechanism in the backend, selection in one `select()`, a stable
module API for callers.

## Blob store — implemented

`src/infra/blobs.ts` exposes `BlobStore { put/get/delete/ensure, configured }` and picks a backend
from `BLOB_BACKEND` (or auto):

| Backend | Select with | Use |
|---|---|---|
| `s3` | `BLOB_ENDPOINT` (+ keys/region/bucket) | MinIO in compose, any S3 in prod |
| `fs` | `BLOB_DIR` | local dir; zero external dep; single-node / air-gapped |
| none | neither set | falls back to Postgres `files.data` |

Callers (`files`, memory mounts) use the stable `putBlob/getBlob/deleteBlob/ensureBucket` wrappers
and never see the backend.

## Queue & pub/sub — implemented

`src/infra/queue.ts` (`RunQueue`) and `src/infra/pubsub.ts` (`Bus`) are behind interfaces, selected
by `MESSAGING_BACKEND`:

| Backend | Select | Notes |
|---|---|---|
| `redis` (default) | `MESSAGING_BACKEND=redis` | Streams consumer group (at-least-once, `XAUTOCLAIM` reclaims a dead runner's work) + pub/sub + Redis lists. The only backend that works across the split api/runner processes. |
| `postgres` | `MESSAGING_BACKEND=postgres` | **cross-process, no Redis** — queue via `FOR UPDATE SKIP LOCKED` + `LISTEN/NOTIFY`, bus via `LISTEN/NOTIFY` (large events sent as a `{sid,seq}` signal, read back from the events table), steer/tool-results as small tables. Run the whole stack on Postgres alone (`make up-min`). |
| `memory` | `MESSAGING_BACKEND=memory` | in-process `EventEmitter` + Maps; single-process dev/test, no Redis, no cross-process reclaim. |

`RunQueue { enqueue; consume(handler,{concurrency,signal}); depth }` and `Bus { publish/subscribe;
interrupt; steer push/pop; tool-result push/take; providers-changed }` keep the same module exports,
so callers are unchanged. Room remains for SQS/NATS/JetStream (queue) and a Postgres LISTEN/NOTIFY
backend (a cross-process no-Redis option). **BYOC still needs Redis** (its worker relay uses Redis
lists across processes).

## Database — wire-swappable now; repo layer is the seam

`DATABASE_URL` already accepts any Postgres-wire database (PolarDB-PG is used in compose comments),
so the DB is swappable across Postgres-compatible engines today. A genuinely different engine
(MySQL/SQLite) would reimplement the repositories in `src/infra/db.ts` — those `repos` / `files` /
`pluginStore` objects are the interface seam. The SQL uses Postgres features (`jsonb`, `FOR UPDATE
SKIP LOCKED`, `RETURNING`), so a second engine is a real port, not a config flip; it is intentionally
out of scope until a concrete need appears.

## Observability

- **Metrics**: `src/infra/metrics.ts` is a tiny Prometheus registry (counter/gauge/histogram, text
  exposition, scrape-time refresh). The API serves `GET /metrics` (http_requests_total,
  http_request_duration_seconds); the runner serves `/metrics` on `RUNNER_METRICS_PORT` (default
  9090): runner_runs_total{outcome}, runner_run_duration_seconds, runner_active_runs,
  runner_queue_depth (unacked pending). Swap for prom-client later; call sites (inc/observe/set) are
  stable.
- **Logs**: `src/infra/log.ts` — structured JSON logs (`LOG_FORMAT=json|pretty`, `LOG_LEVEL`), with a
  bound context (`log.child({ session, rid })`). The API logs one access line per request with the
  request id; the runner logs run.start/done/error with session + outcome + ms.
- **Request id**: every API response carries `x-request-id` (honored from the header if present).

## API maturity

- **Pagination**: `GET /v1/sessions` takes `?limit` (default 50, max 200) + `cursor`, returning
  `{ data, has_more, next_cursor }` (newest first). Other list endpoints follow the same shape as
  they grow.
- **Body limit**: JSON bodies over `API_MAX_BODY_BYTES` (default 4 MB) get 413; the multipart
  `/v1/files` route keeps its own 32 MB cap.
- **Errors**: uniform `{type:"error", error:{type, message}}`; statuses 400/401/404/413/500.

## Plugin placement, governance & the getEvents capability

Server-side plugins are **agent-behavior** ("the brain wears a hat"), and — like the sandbox that
holds the "hands" — the plugin host is a *runtime with a placement*, not something only the operator
can own. What matters is **where the plugin code executes**, not who authored it:

| Placement | Where it runs | Isolation | Governance | Whose plugins |
|---|---|---|---|---|
| `runner` (default) | the operator's shared runner process | Node `--permission` + network lockdown | `PLUGIN_ALLOW` (curated; docker-compose sets `/app/plugins/`) | operator / trusted |
| `sandbox` (`plugin_host=sandbox`) | inside the user's own session sandbox | the sandbox is the boundary | `PLUGIN_ALLOW_SANDBOX` (default `*`) | **the user can bring their own brain plugins** |

Enforcement is placement-aware: a package is accepted at agent-create if it is runnable in *at least
one* placement (`disallowedEverywhere`), and checked again at host start for the actual placement
(`disallowedFor(pkgs, "runner"|"sandbox")`). So a user-authored orchestration plugin that the shared
runner would reject runs fine when the session uses an isolated sandbox host — the code executes in
the user's own environment, capability-mediated and network-governed.

**Roadmap — the plugin host as its own service.** Today the host is a child process of the runner
(runner mode) or of the sandbox (sandbox mode). The natural next step is a third placement: a
dedicated **per-tenant plugin-host service** (a "brain sandbox") — the same `PluginHost` protocol over
a network transport instead of stdio, so a tenant's agent-behavior plugins run in their own isolated
service (even their own cloud, BYOC-style), fully decoupled from the operator's runner. The seam is
already there (PluginHost + the RPC protocol); only the transport and a `plugin_host=service` option
are new.

**Control-plane vs agent-behavior** (matching Anthropic's split): `wake` / `getSession` / `emitEvent`
/ `provision` are control-plane mechanisms — they live in the runner/API/queue/SandboxProvider, not
as plugins. Their agent-behavior counterpart, reading the event log, is exposed to plugins as
`ctx.events.get({sessionId?, since?, limit?})` (owner-scoped), with `recall_history` (in
`plugins/memory`) as the model-facing tool on top.
