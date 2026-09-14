# rethink-managed-agent: a thin harness + a pluggable sandbox

## 0. In one line

**The harness does exactly one thing: run the agent loop and write everything to an append-only event log.**
The sandbox is a pluggable "compute lease", not part of the session; a session only holds a "workspace
reference" and rents a sandbox when it actually needs to execute.

## 1. Why the existing products feel "heavy"

Taking Claude Managed Agents / Qoder Cloud Agent as the reference, the weight comes not from feature
count but from a few couplings:

| Coupling | Consequence |
|---|---|
| session ≡ container lifecycle | suspending a session means snapshotting/freezing the whole container; resuming waits for it to boot; one session can only run in one container |
| the tool stack is baked into the platform | adding a tool means changing the platform; users can't bring their own shell or their own MCP |
| state scattered across the platform DB + container disk | "resume" has to restore both, with fuzzy semantics; you can't move a session to a different sandbox |
| the control plane owns orchestration | plan mode, sub-agents, approval flows all live in the platform layer, so every new capability thickens the platform |

pi (Mario Zechner's pi coding agent) takes the opposite approach: a tiny loop, tools that are plain
functions, a session that is a replayable JSONL tree, and every "advanced capability" as an extension
rather than core. This design ports that philosophy to a "managed/cloud" shape and adds the one layer
pi doesn't have: decoupling the sandbox.

## 2. Design principles

1. **A very thin harness**: core is only the loop, the event log, tool dispatch, and the provider
   abstraction. Target < 1500 lines.
2. **Everything is an event**: session state = the fold of the event log. There is no second source of truth.
3. **The sandbox is a lease, not a possession**: a session doesn't own a sandbox; it acquires one when
   needed and releases it when done.
4. **The workspace is what's persistent**: file state is expressed as a git commit + diff or a volume
   snapshot; the sandbox is just ephemeral compute that loads it.
5. **Tools are provider-agnostic**: a tool only gets the `ctx.sandbox` interface and doesn't know whether
   it's backed by the local host, docker, or firecracker.
6. **Extensions are modules**: tools, system-prompt fragments, event hooks, and sandbox providers are all
   plain importable modules — no plugin registry.

## 3. The three layers

```
┌──────────────────────────────────────────────────────────┐
│ Control Plane (optional, very thin)                       │
│ HTTP/WS: createSession / send / stream / list             │
└───────────────┬──────────────────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────────────┐
│ Harness Core                                              │
│  AgentLoop  ─ Model provider ─ ToolRegistry ─ EventLog     │
│      │                                                    │
│      │ ctx.sandbox (interface)                            │
└──────┼───────────────────────────────────────────────────┘
       │ SandboxLease (acquire / release)
┌──────▼───────────────────────────────────────────────────┐
│ Sandbox Layer (pluggable)                                 │
│  Provider: local | docker | firecracker | e2b | k8s | ssh  │
│  WorkspaceMaterializer: git | volume-snapshot | rsync      │
└──────────────────────────────────────────────────────────┘
```

Three independent lifecycles:

| Object | Lifecycle | Persisted as |
|---|---|---|
| Session | the lifetime of the conversation, can be suspended for days | event log (JSONL) |
| Workspace | code/file state, shareable across sessions | git ref + diff, or snapshot id |
| Sandbox | minutes to hours, disposable at any time | nothing (throwaway) |

## 4. Core interfaces

### 4.1 Sandbox (the minimal surface a provider must implement)

```ts
interface Sandbox {
  id: string;
  exec(cmd: string, opts?: { cwd?: string; env?: Record<string,string>; timeoutMs?: number; signal?: AbortSignal })
    : AsyncIterable<ExecChunk>;              // streamed stdout/stderr + exit
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  // optional capabilities, declared so tools can degrade gracefully
  capabilities: { ports?: boolean; snapshot?: boolean; gpu?: boolean };
  exposePort?(port: number): Promise<URL>;
  snapshot?(): Promise<SnapshotRef>;
}

interface SandboxProvider {
  name: string;
  acquire(req: SandboxRequest): Promise<SandboxLease>;
}

interface SandboxRequest {
  workspace: WorkspaceRef;      // what to load inside
  image?: string;
  resources?: { cpu?: number; memMb?: number };
  secrets?: Record<string,string>;   // injected at lease time, never logged
  affinity?: string;            // hint the provider to reuse an existing sandbox (many sessions, one workspace)
}

interface SandboxLease {
  sandbox: Sandbox;
  release(): Promise<void>;     // return it; the provider decides whether to destroy or pool
  ttlMs: number;                // auto-reclaim after this much idle time
}
```

`exec/readFile/writeFile` are enough to run 90% of tools. Everything else goes behind capabilities.

### 4.2 Workspace (the persistent layer, the bridge between session and sandbox)

```ts
type WorkspaceRef =
  | { kind: "git"; remote: string; base: string; patch?: BlobRef }   // commit + uncommitted diff
  | { kind: "snapshot"; provider: string; id: string }               // volume / overlay snapshot
  | { kind: "local"; path: string };                                 // local dev

interface WorkspaceMaterializer {
  materialize(ref: WorkspaceRef, sb: Sandbox): Promise<void>;  // put the workspace into the sandbox
  capture(sb: Sandbox, prev: WorkspaceRef): Promise<WorkspaceRef>; // extract new state from the sandbox
}
```

On suspend: `capture` → a new `WorkspaceRef` is written to the event log → `lease.release()`.
On resume: read the log to get the latest `WorkspaceRef` → `acquire` → `materialize`. The sandbox can be
brand new, or even a different provider.

### 4.3 Session and the event log

```ts
type Event =
  | { t: "user"; text: string }
  | { t: "assistant"; content: ContentBlock[] }
  | { t: "tool_call"; id: string; name: string; input: unknown }
  | { t: "tool_result"; id: string; output: unknown; truncated?: boolean }
  | { t: "workspace"; ref: WorkspaceRef }          // a workspace-state change point
  | { t: "sandbox"; action: "acquired" | "released"; provider: string; sandboxId: string }
  | { t: "meta"; ... };                             // model switch, system-prompt fragments, etc.

interface Session {
  id: string;
  log: EventLog;                    // append(ev) / replay() / fork(atEventId)
  workspace(): WorkspaceRef;        // the latest ref, from folding the log
}
```

The key: **a session has no sandbox field**. The sandbox only appears as events, for audit and debugging.
Like pi, the log is a tree: `fork(atEventId)` yields a branch session sharing the prefix. Two branches can
each rent their own sandbox, or share one via `affinity`.

### 4.4 The agent loop (the heart of the harness, sketched)

```ts
async function run(session: Session, model: Model, tools: ToolRegistry, provider: SandboxProvider) {
  let lease: SandboxLease | null = null;
  const sandbox = async () => (lease ??= await acquireAndLog(session, provider)).sandbox;

  while (true) {
    const msgs = session.log.replay();                 // folded into model context
    const resp = await model.stream(msgs, tools.schemas());
    session.log.append({ t: "assistant", content: resp.content });
    const calls = resp.toolCalls();
    if (calls.length === 0) break;

    for (const c of calls) {
      session.log.append({ t: "tool_call", ...c });
      const out = await tools.get(c.name).run(c.input, { sandbox, session, signal });
      session.log.append({ t: "tool_result", id: c.id, output: out });
    }
  }
  if (lease) { await captureAndLog(session, lease.sandbox); await lease.release(); }
}
```

Note `sandbox` is acquired lazily: a pure-conversation turn never rents a sandbox at all.

### 4.5 Tool

```ts
interface Tool<I> {
  name: string;
  schema: JSONSchema;
  run(input: I, ctx: ToolContext): Promise<ToolOutput>;
}
interface ToolContext {
  sandbox(): Promise<Sandbox>;   // lazy
  session: Session;
  signal: AbortSignal;
}
```

The builtin tools are only `bash`, `read`, `write`, `edit` — all working through `ctx.sandbox()`.
"Sub-agent", "plan mode", "approval" never enter core: a sub-agent is a tool that internally `fork`s the
session and calls `run` again.

## 5. Sandboxes and sessions are many-to-many

| Scenario | How |
|---|---|
| one session across many sandboxes | suspend/resume does it naturally; you can also explicitly `release` and `acquire` with a different image/provider |
| many sessions on one sandbox | a review-session and a fix-session on the same workspace use the same `affinity`; the provider returns the same instance, each session using its own cwd or a git worktree |
| a warm pool | the provider keeps prewarmed instances; `acquire` only `materialize`s, cutting cold start from minutes to seconds |
| swap provider | the event log is unchanged; only the `provider` argument changes — `local` for local dev, `firecracker` for the cloud |
| no sandbox | pure Q&A / read-only workspace (read straight from the git remote) rents nothing |

Protecting against concurrent writes to one sandbox is not in core: the materializer isolates via worktrees,
or the provider rejects a duplicate `affinity`.

## 6. Keeping the control plane thin

```
POST /sessions                { workspace, model }         → { id }
POST /sessions/:id/messages   { text }                     → 202
GET  /sessions/:id/events     (SSE / WS, supports since=)
POST /sessions/:id/fork       { atEventId }
POST /sessions/:id/suspend    → capture + release
```

No sandbox-related API. To see the sandbox, look at the `sandbox` events in the stream. The control plane is
itself stateless; session logs go to object storage or SQLite, and scaling out is just replicating loop
processes.

## 7. Extension points (all plain modules)

```ts
export default {
  tools: [myTool],
  systemPrompt: (ctx) => "...",           // fragment concatenation, not replacement
  onEvent: (ev, session) => {},           // audit / telemetry / approval interception
  providers: { myCloud: myProvider },
  materializers: { git: gitMaterializer },
} satisfies Extension;
```

How an approval flow is implemented: `onEvent` throws `NeedsApproval` on `tool_call`, the loop writes the
event as `pending` and suspends the session; after the user approves, an `approved` event is appended and it
continues. Core only needs to know "suspend/continue" — it doesn't know what approval is.

## 8. Comparison with a thick harness

| | Managed-Agent style | This design |
|---|---|---|
| session resume | restore the container | replay the log + re-materialize |
| swap runtime | not possible | change the provider argument |
| add a tool | change the platform | write a function |
| suspend cost | a running container or a snapshot | a git diff |
| many sessions, one workspace | usually unsupported | affinity + worktree |
| core size | platform-scale | ~1500 lines |

## 9. Tradeoffs and known costs

- **Cold start**: not binding a container means every resume has to materialize. Warm pools and snapshot
  providers mitigate it, but it's slower than "keep the container alive".
- **Non-git state**: installed deps, running services, databases are not in git. Handle via the `snapshot`
  capability or a `setup` script run by the materializer (a config file in the workspace, e.g. `.agent/setup.sh`).
- **Secrets**: injected only at `acquire`, never in the event log; tool_result must be redacted.
- **Concurrency on a shared sandbox**: core does no locking; it's delegated to the provider/materializer and
  must be documented clearly.
- **Large outputs**: tool_result must be truncated with the full text spilled to a blob, keeping only a
  reference in the log, or replay cost explodes.

## 10. MVP roadmap

1. `core/`: EventLog (JSONL), AgentLoop, ToolRegistry, the 4 builtin tools.
2. `sandbox/local`: run subprocesses directly; `materializer/git`.
3. CLI: end-to-end locally, with session suspend, fork, resume.
4. `sandbox/docker`: prove "same log, different provider".
5. A thin control plane (HTTP + SSE).
6. Warm pool + `sandbox/firecracker` or an e2b provider.
7. Extensions: sub-agent tool, approval hook.

Every step should keep core from growing. If a feature thickens core, first ask whether it can be an extension.

## 11. Sessions and sandboxes are N:N (finalized)

An early implementation had a session 1:1 with a workspace, the sandbox determined by the workspace affinity,
and one session with at most one sandbox at a time. This section fixes the relationship as N:N while still
holding the two principles: events are the only truth; the sandbox is only a lease.

### 11.1 Model

```
session ──1:N── session_environments(key, environment, workspace)
                       │  key = "main" is the primary environment (default tool target, subject of capture)
                       │  other keys are attached environments, e.g. "browser", "gpu"
                       ▼
workspace ──N:1 sandbox lease (affinity = workspace.id, at most one active lease at a time)
```

- **One session, many sandboxes**: a session attaches several environments, each renting its own sandbox.
  The builtin tools take an optional `env` argument, defaulting to `main`. The `sandbox.acquired` event
  carries `env`, and `workspace.captured` carries `workspace_id` and `env`; several coexisting needs no new
  event model.
- **Many sessions, one sandbox**: unchanged — sessions on the same workspace reuse via affinity, with the
  active lease mutually exclusive.
- **Sub-sessions**: `sessions.parent_id`. A sub-session owns a workspace forked from the parent (git: copy
  base + patch; dir: copy the directory), so it has its own sandbox and runs in parallel without stepping on
  the parent's files. When a sub-session ends, the parent receives `agent.thread_message_received` carrying
  the report plus a patch; the parent decides whether to apply it. Event names align with the Managed Agents
  multiagent shape.

### 11.2 Runtime

- run-turn holds a `Map<envKey, lease>`, leasing lazily; on finish it captures and releases each one.
- A plugin's `ctx.sandbox` also takes `env`; `ctx.agent.run(task, { isolated: true })` creates a sub-session
  and waits for it, rather than running a nested loop in the same sandbox.
- The runner has a concurrency degree (`RUNNER_CONCURRENCY`), or a parent waiting on a sub-session would
  deadlock on a single consumer.

### 11.3 Explicit non-goals

- No concurrent writes from multiple sessions in one sandbox: still guaranteed by affinity mutual exclusion.
- No cross-session "sandbox pool" lease sharing: sandbox reuse only happens within one workspace.
- No mounting one workspace onto two environments at once: an attached environment either brings its own
  workspace or forks the main one.

## 12. Sandbox idle / pause / resume

After a lease is released, the sandbox is not destroyed immediately but retired in two tiers, both thresholds
configurable:

```
busy ──release──► ready ──idle > SANDBOX_IDLE_TTL_MS──► paused ──idle > SANDBOX_PAUSED_TTL_MS──► destroyed
                    ▲                                     │
                    └──────────── next acquire auto-resumes ─┘
```

- **ready**: the container is still running; a session hitting the same workspace reconnects in seconds
  (`origin: reused`).
- **paused**: docker uses `pause` (the freezer cgroup freezes processes, keeping memory state and releasing
  CPU); the next `unpause` resumes in place with even background processes still alive. e2b uses the SDK's
  `pause` snapshot, likewise preserving memory state. Uniform semantics: the pause tier keeps state (files +
  processes), and only destroy actually reclaims. On the next acquire the manager `resume`s then `connect`s
  (`origin: resumed`). A provider without pause (local) is destroyed directly.
- **destroyed**: a later arrival rebuilds from the workspace ref (`origin: created`).

Ops entry points: `POST /v1/sandboxes/:id/pause` and `DELETE`, both executed by the runner's reaper on its
next pass; the API process never touches containers directly. The `sandbox.acquired` event carries an
`origin` field, so you can see whether each acquire was a create, a reuse, or a resume.

## 13. BYOC and BYOK

- **BYOC**: a `byoc` provider's sandbox runs on the user's own `pma worker`. The worker only makes outbound
  long-polls; the runner's exec / read / write / capture are relayed to the worker via Redis lists and the
  API, with results returning the same way. One worker key per environment, returned once at creation. A
  sandbox on the same workspace is judged alive by the worker heartbeat, and a non-git workspace stays on the
  worker's disk as `{kind:"byoc", worker, path}`. This is the self-hosted form of Managed Agents in this
  design; the harness and event model are entirely unchanged.
- **BYOK**: a provider's credential gains a `{type:"key"}` input; the API seals it with AES-256-GCM under
  `PMA_SECRET_KEY` before storing it, never returns the ciphertext on read, and the runner unseals it to
  register the provider. An operator's own key still uses the `{type:"env"}` reference.

## 14. Multi-agent

Referencing the pi ecosystem (tintinweb/pi-subagents, nicobailon/pi-subagents, pi-dynamic-workflows): they
are all "multi-instance" — a sub-agent is an independent session, isolation is by git worktree, orchestration
is a deterministic JS script, and child-to-parent communication is via intercom. The counterparts already
exist here, just renamed:

| pi ecosystem | This design |
|---|---|
| sub-agent as an independent session | a sub-session (`parent_id`), run concurrently on any runner |
| git worktree isolation | workspace fork, each with its own sandbox |
| `agent()` / `parallel()` / `pipeline()` scripts | `plugins/workflow`'s `run_workflow`, same script shape |
| intercom `contact_supervisor` | builtin `report_to_parent`; a question ends the sub-session's turn and the parent's reply arrives as the sub's next user message |
| agent types / frontmatter | `plugins/team`'s roles (editable in the store) |

Core only added the six `ctx.agents.*` capabilities and one builtin tool, with events aligned to Managed
Agents' `session.thread_created` and `agent.thread_message_sent/received`. Teams and workflows are themselves
entirely plugins.

## 15. Principals and ownership (multi-tenant, phase 1)

Rather than introducing `user_id`, use a polymorphic subject `principals(id, kind, ...)`: a user, an org, and
a service account are all a `kind` of it. Every top-level resource (agents / environments / workspaces /
providers / files / skills / memory_stores / sessions) gains an `owner_id → principals(id)` column. Today
`owner_id` always points at a `kind='user'` subject; tomorrow it points at a `kind='org'` one — no resource
table changes. Extending to orgs is adding rows and a table, not a whole-schema migration.

- **actor vs owner**: the actor is the authenticated caller (a principal); the owner scope is the resource's
  ownership boundary. In phase 1 owner == actor; with orgs, an `X-Org` header selects it after a membership
  check and it becomes the org subject.
- **auth**: `api_keys(token_sha256 → principal)`, `Authorization: Bearer <token>`. With `AUTH_REQUIRED=false`
  (default), a request with no token falls back to `PMA_DEFAULT_PRINCIPAL` (the schema-seeded `prc_local`), so
  the single-machine flow needs zero changes; `=true` enforces auth. The BYOC worker uses `x-worker-key` and
  bypasses principal auth.
- **ownership threaded through**: the API middleware puts `{actor, owner}` on the context; create routes
  stamp `owner_id`, and list/get/update/delete take the owner scope and add `WHERE owner_id=$n`, centralized
  in the repos in `src/infra/db.ts`. The runner/harness read as the system (no scope), because they process
  sessions of any owner; a sub-session and a forked workspace inherit the parent's `owner_id`.
- **authorization seam**: keep a functional check point — in phase 1 it's `resource.owner_id === actor.id`;
  with orgs it becomes "actor is a member of that org and the role allows it", with the call site unchanged.

**Extending to orgs (incremental)**: add `kind='org'` rows in `principals` + `memberships(member_id, org_id,
role)` + `X-Org` parsing, with resource tables and repo logic untouched.

**Phase 2 (done): owner-keyed isolation**
- **Containers never cross subjects**: `container_key` is prefixed with `owner_id`
  (`${owner}/${container_group}/${env}`), so when the manager reuses a container by key it never merges two
  subjects' mounts into one; shared containers only hold within one owner.
- **Sandbox ownership**: `sandboxes.owner_id` (ephemeral rows, nullable, no FK), written on acquire; the
  `/v1/sandboxes` ops view (list/get/delete/pause) filters by the caller's owner, invisible across subjects.
  The reaper still scans by provider as the system.
- **plugin_store subject isolation holds naturally**: `owner` (agent_id / workspace_id) is bound server-side
  from the session context; a plugin can only pass `key` + `scope`, and since each agent/workspace belongs to
  a unique subject, a plugin cannot reach another subject's data. Phase 2 additionally adds `scope="principal"`
  (owner = `session.owner_id`) for a tenant-wide plugin store.
- **Per-subject fetch allowlist**: `principals.fetch_allow` (a comma list or `*`); each run takes that
  subject's policy, falling back to the deployment-level `PLUGIN_FETCH_ALLOW`.

**Identity is a pluggable seam (isolation stays in the platform, identity goes to the business side)**. rethink
owns only the *isolation* boundary (every resource carries `owner_id`, enforced in the repos); it doesn't
define what "user"/"org" means. How a credential becomes a principal is decided by a `PrincipalResolver`
(`src/api/principal-resolver.ts`): the deployment points `PRINCIPAL_RESOLVER` at a module that default-exports
one, and the consuming business plugs its own identity in (a verified JWT/OIDC, a trusted gateway header,
mTLS, a per-tenant key). The resolver returns `{actor, owner?}`, and everything downstream sees only `owner`;
returning an `owner` different from `actor` is the org-scope slot. The built-in default is Bearer→`api_keys`;
`src/api/resolvers/trusted-header.ts` is a ready example (trusts an upstream gateway's `x-principal-id`, with
`x-org-id` selecting the owner). So there are two tiers to offer: principals for **soft isolation** of many
tenants in one deployment, and a separate stack for those who need **hard isolation**.

**Still deferred**:
- provider id is a global primary key, so a cross-owner name collides with 409 (providers are more like
  infrastructure; BYOK keys are sealed per row).
- API-key minting under `AUTH_REQUIRED=true` is still open to any authenticated actor; a real deployment
  should add an admin gate.
- Orgs (`kind='org'` + `memberships` + a role check) are phase 3, and should stay thin, hidden behind the
  resolver.

## 16. OpenAI Agents API compatibility layer

A thin adapter makes rethink speak the OpenAI Agents API session dialect, so showcase-grade code (like the
SRE "sev-bot") runs by pointing at rethink's base URL, and **binds to no cloud vendor**: the model resolves
to a rethink provider row (BYOK), the environment to a pluggable sandbox provider (local/docker/e2b/byoc).
The adapter is mounted at `/agents-api/v1` and is pure translation over the native engine; the one engine
addition is **client/function tools**.

- **Endpoints**: `POST /sessions` (create, `{agent, environment, input?, stream?}`), `GET /sessions/:id`
  (retrieve, with `info.required_actions`), `POST /sessions/:id` (continue), `POST /sessions/:id/tool_result`,
  `DELETE`, `GET /sessions/:id/events/stream`. Mounted under a prefix parallel to the native `/v1`, each with
  its own `auth()`.
- **Client/function tools (the core mechanism)**: `{type:'function',name,parameters}` is executed by the
  **caller**, not the sandbox. When the agent calls it, the turn stays alive and execute blocks on a
  **durable per-call result channel** (a Redis list, not lossy pub/sub); the caller POSTs `tool_result` and
  the same turn resumes, or on timeout (`CLIENT_TOOL_WAIT_MS`, default 5 min, < `RUN_TIMEOUT_MS`) it ends the
  call with a timeout error.
  - **The engine has no "pending"/"approval" concept (the pi philosophy)**: a client tool is just an ordinary
    `agent.tool_use` in the log whose result arrives late. `required_action` is derived entirely by the
    adapter from the log — an `agent.tool_use` whose name is one of the session's `client_tools` with no later
    `agent.tool_result` — surfaced via retrieve and the `agent.session.action_required` stream event. For real
    approval/permission, use the pi-style plugin `tool_call` hook (`block`/`reason`); that is the layer it
    belongs to, not core.
  - **Why not "a never-settling promise + abort"**: pi's loop bare-`await`s `tool.execute` with no signal
    race, so that would **deadlock** and leak the sandbox lease (the key trap found by adversarial review).
    So it mirrors the repo's proven `report_to_parent` pattern: execute always returns a real result, the
    loop unwinds normally, and the history stays valid for the LLM.
- **Tool types**: builtin names (`bash/read/write/edit`) pass through into the sandbox; `{type:'mcp'}` is
  connected for real by a server-side MCP-over-HTTP client (`src/harness/mcp.ts`, Streamable HTTP, gated by
  the fetch allowlist, failing soft), which lists and calls its tools. Its `authorization` / `headers` are
  sealed with `PMA_SECRET_KEY` before the session is stored (refused with 400 when no key is set), only the
  runner opens them (`src/infra/mcp-credentials.ts`), API output shows `"[redacted]"` markers — never the
  value or the ciphertext — and `migrate` reseals plaintext left by older versions; `web_search` maps to the existing
  `plugins/web-search` pi plugin (`COMPAT_WEBSEARCH_PACKAGE`, needs `plugin_host=sandbox`+`network=bridge`);
  `multi_agent` maps to the team plugin (`COMPAT_TEAM_PACKAGE`, with `max_concurrent_subagents` advisory);
  `programmatic_tool_calling` stays accepted-and-ignored.
- **Stream events**: native deltas/events are re-encoded to OpenAI names (`response.output_text.delta`,
  `session.turn.item.added` with `function_call`, `agent.session.action_required`,
  `agent.session.turn.completed`, `turn.failed/cancelled`).
- **SDK**: `src/api/routes/compat/sdk/` provides a zero-dependency `client.beta.agents.sessions.*` client
  that auto-runs handler-backed function tools and returns the result; a call with no handler is handed back
  to the caller as a `required_action` (sev-bot's approval gate).
- **MVP boundaries**: webhook delivery of `action_required` is not built (SSE + retrieve cover it);
  `programmatic_tool_calling` is not built (accepted-and-ignored); `input` is string-only; cold resume across
  idle is covered by the keep-alive long-poll (approval completes within the window).

### 16.1 Official OpenAI SDK surface (`/openai/v1`)

Alongside the hand-written showcase adapter above, `src/api/routes/compat/openai-agents.ts` serves the
**exact contract of the official `openai` SDK's Agents API** (`client.beta.agents.sessions.*`), so real
SDK code runs against `baseURL: "<host>/openai/v1"` unchanged. It matches the SDK's paths verbatim
(`POST/GET/DELETE /agents/sessions`, `GET /agents/sessions/{id}`, `POST /agents/sessions/{id}` update,
`GET /agents/sessions`, `POST/GET /agents/sessions/{id}/events`), the `AgentSession` object
(`object:"agent.session"`, `status: idle|in_progress|requires_action|failed`, top-level
`required_actions[]` with the SDK's `{arguments, call_id, name, turn_id, type:"function_call"}` shape),
and the `agent.session.input.{message,tool_result,cancel}` event union — all as a pure projection over
the native event log (reusing `translate.ts` and `requiredActions`). `test/openai-sdk.test.ts` drives the
**real `openai@7.15.0`** (aliased `openai7`) with a capturing `fetch`, asserting the SDK hits our paths,
our projection parses in the SDK, and the SDK's request bodies are what our mapper consumes — the
anti-drift check (like OMA's SDK audit). **Phase 1b** adds streaming: `GET /agents/sessions/{id}/events` with `Accept: text/event-stream`
(what `sessions.stream()` subscribes to) projects the native event log into the exact
`agent.session.turn.*` SSE sequence the SDK's `TurnState` drives on — `turn.created`
(`turn.subagent_id === null` sets the turn id), `turn.item.added` with an `item.type: "function_call"`
(a pending tool call the SDK's `toolHandlers` run, result submitted back through `POST .../events`),
and a `turn.completed` + `agent.session.idle` (or `agent.session.failed`) terminal. `src/api/routes/
compat/openai-stream.ts` holds the projection; the stream starts at the current tail (subscribe-before-
input) so a fresh turn is never preceded by a replayed prior turn. `test/openai-sdk.test.ts` drives the
real `sessions.stream(id, {input, toolHandlers})` over our projection and asserts the SDK runs the
handler with our item's arguments, submits the result, and terminates — no server needed.
**Phase 1c** adds the read projections `GET /agents/sessions/{id}/items` (event log → messages /
function calls / function-call outputs) and `GET .../turns[/{turnId}]` (one `Turn` per
`status_running`, closed by `status_idle`).

**Phase 2** adds `create({ stream: true })` (POST /agents/sessions returning the turn's SSE straight
from create, verified live), **subagents** (`client.beta.agents.sessions.subagents.*`) — our child
sessions (`parent_id`) projected into `agent.session.subagent` with their own `items`/`turns` (reusing
`toItems`/`toTurns` on the child's log) — and **artifacts** (`client.beta.agents.sessions.artifacts.*`):
a session's produced files read straight from its captured `dir`/`local` workspace (`src/infra/
artifacts.ts`, path-confined, no sandbox lease), listed / retrieved / streamed as content / deleted.
The API mounts the `workspaces` volume to read them. Verified live: a run wrote `report.txt`, then
`artifacts.list` + `artifacts.content` returned it.

**The whole Agents API surface is now covered** (sessions, events, items, turns, subagents, artifacts,
vaults) and every resource group has been exercised live with the real `openai@7.15.0`. The contract is
derived by reading the pinned SDK's TypeScript declarations (`npm pack openai@7.15.0`), not guessed.

**Verified live** against the running stack (rebuilt API): the real `openai@7.15.0` SDK created a
session, ran `sessions.stream()` with a `get_time` toolHandler, and the actual model called the
function tool — the SDK ran the handler, submitted the result through `POST .../events`, and the model
answered from it; `items.list`/`turns.list` returned the projected `message / function_call /
function_call_output / message` items and one `completed` turn. (`AUTH_REQUIRED=false` runs as the
default principal when no `Authorization` header is sent; the SDK always sends a bearer, so a real key
is needed under `AUTH_REQUIRED=true`.)

## 17. The three layers, and who owns each

The system is three layers, each an independent isolation domain that can be operator-run or
tenant-owned. This is the reference mental model; the plugin "placements" of §16 live *inside* it.

| Layer | Role | In the code | Anthropic split | Can be owned by |
|---|---|---|---|---|
| **1. Operator service** (control plane) | API, run queue, event log (truth), DB, provider registry, tenancy/auth, wake, sandbox provisioning policy | `src/api/*`, `src/infra/{queue,pubsub,db,events}.ts` | control-plane (`wake`/`getSession`/`emitEvent`/`provision`) | the operator |
| **2. Brain** (runner / harness) | runs the agent loop, folds events → context, dispatches tools, hosts **agent-behavior plugins** | `src/runner/*`, `src/harness/*`, the runner-mode plugin host | the harness | operator (shared) **or the tenant** |
| **3. Hands** (sandbox) | executes commands/tools; pluggable provider | `src/sandbox/*` (local/docker/e2b/byoc) | agent-behavior `execute` | operator or the tenant (BYOC) |

Boundaries between the layers are already interfaces, so each is separately deployable:

- **Service ↔ Brain**: the event log + run queue (`RunQueue`/`Bus`, redis/postgres/memory backends).
  The brain never shares memory with the service; it consumes jobs and appends events.
- **Brain ↔ Hands**: the `SandboxProvider` interface. The brain holds only `ctx.sandbox`; the hands
  can be a sibling container, a cloud sandbox, or the tenant's own worker (BYOC).

**Each layer, independently ownable:**

- **Hands**: done — `byoc` provider runs the sandbox on the tenant's own worker.
- **Brain**: the runner is already a stateless process that can be deployed separately and scaled by
  running more of them (they share one consumer group). The one missing piece for a *tenant-owned*
  brain is **per-tenant run routing**: a runner scoped to a set of owners so a tenant's own runner only
  handles that tenant's sessions (`RUNNER_OWNERS`, with the job tagged by `owner_id`). The Postgres
  queue makes this a `WHERE owner_id = ANY(...)` filter; Redis would use a per-owner stream. With that,
  a tenant runs their own brain runner (their own agent-behavior plugins, their own model keys) against
  the operator's service, executing on their own hands sandbox — "the brain belongs to the user".
- **Service**: the operator's control plane; multi-tenant via principals + owner-scoped data.

**Plugin placement is a property of the brain**, not a fourth layer: an agent-behavior plugin runs in
the brain (runner-mode host, operator-curated via `PLUGIN_ALLOW`) or is pushed down into the hands
(sandbox-mode host, isolated in the tenant's sandbox, `PLUGIN_ALLOW_SANDBOX`). A future
`plugin_host=service` is the brain's plugin host as its own per-tenant service — still layer 2.

## 18. How plugins customize the agent loop

The agent loop (`src/harness/run-turn.ts`) is a **fixed skeleton the brain owns**: assemble context →
request model → stream → dispatch tools → collect results → repeat, with compaction / retry / abort
woven in. A plugin never replaces the loop; it attaches at **typed decision points**. This is what
keeps the loop governable (`PLUGIN_ALLOW`), upgradable (the point is a versioned contract, not the
guts), and event-sourced (every change lands as an event, so replay still explains the state). A
plugin that genuinely wants a different loop owns its own runner (§17), it does not fork the core.

Two independent axes describe a plugin — do not conflate them:

- **Placement** — where the plugin's *code* runs: the shared runner host (`plugin_host=runner`,
  operator-vetted, persistent, `PLUGIN_ALLOW`) or inside the user's sandbox (`plugin_host=sandbox`,
  isolated blast radius, `PLUGIN_ALLOW_SANDBOX`). A deployment/trust choice. `makeContext` is
  identical in both, so the *same* plugin works either way.
- **Reach** — what the plugin *acts on*: the **hands** (drives the sandbox via `ctx.sandbox`, or runs
  in it) or the **brain** (only `ctx.store`/`events`/`model`/`agents`/`session`). "Hands plugin"
  means reach, not placement: `verify` runs on the runner yet is a hands plugin (it remote-drives the
  sandbox). Reach is decided by the capabilities used, not by where the code lives.

### 18.1 Two shapes of decision point

Every hook (`src/plugins/api.ts`) is one of two shapes, chosen per point:

- **Middleware (compose, many):** `input`, `context`, `tool_call`, `tool_result`, `turn_end`.
  Handlers run in registration order, each seeing the event as modified by earlier ones; results
  merge (text-ish fields accumulate, `block`/`cancel` short-circuit — `host.ts`). Many plugins stack.
- **Override / provider (answer-or-default, single-owner):** the loop asks "does anyone want to
  supply this?" — the *first* plugin to answer wins, a later one is ignored with a warning
  (`OVERRIDE_FIELDS` in `host.ts`), and if none answer the built-in default runs. This is how loop
  *strategy* becomes pluggable without a plugin owning the whole loop.

`before_compact` is the reference override point. Because history is an event log (compaction
persists only `{ summary, first_kept_seq }`), a plugin owns the parts that carry meaning — `summary`
(compute it with `ctx.model`/`ctx.events`, skipping the built-in summarizer) and `keepRecentTokens` —
while the **cut point stays the harness's** (it must keep `tool_call`/`tool_result` pairs intact).
`plugins/compactor` is the worked example; new override points (retry, model-request middleware)
follow the same convention. Adding a decision point is a deliberate, versioned contract extension —
never expose the loop's mutable internals, and do not add hooks speculatively.

### 18.2 What of pi's extension surface we carry, and what we do not

The pi-compat adapter (`src/plugins/pi-compat.ts`) maps a pi extension onto this system. The split is
principled, not incidental:

- **Carried well** — the agent-behavior core: `registerTool`; `on(tool_call | tool_result | input |
  before_agent_start | turn_start | turn_end | session_start | session_shutdown | context |
  session_before_compact)`; `exec` (→ `ctx.sandbox`); sub-agents (→ `ctx.agents`, richer than pi's).
  A pi compaction extension's `{ compaction: CompactionResult }` maps to our `summary` override.
- **Deliberately unsupported, and correct to be:**
  - *All TUI / interactive* — `ctx.ui.*`, `registerMessageRenderer`/`EntryRenderer`/
    `MarkdownTransformer`, `registerShortcut`, `registerFlag`, `setLabel`, `model_select` /
    `thinking_level_select`, `user_bash`, `ui_prompt_*`. The server is headless.
  - *`registerProvider` / OAuth / `login`* — a plugin shipping provider credentials is exactly the
    ambient authority the API forbids; providers are operator infrastructure (layer 1), DB-configured.
  - *`sessionManager`, `session_before_switch`/`_fork`/`_tree`, `project_trust`* — interactive
    session-file management; our sessions are event logs managed by the platform, and trust is
    `PLUGIN_ALLOW` governance, not an interactive prompt.
- **Reworked, not dropped:** mid-run **model and tool-set switching** is a pma-native capability —
  `ctx.session.setModel("provider/id")` / `ctx.session.setActiveTools(names)`, applied on the next
  turn via pi's `AgentLoopTurnUpdate` (model, context, tools), with compaction and the context-window
  budget following the new model. pi's own `setModel` / `setActiveTools` (context-free methods on the
  API object) are not mapped — like `sendMessage`, they assume a single ambient session the multi-session
  host does not have; the capability is reached through `ctx.session` instead.

## 19. Vaults (per-principal secret injection)

Vaults close the credential gap against Claude Managed Agents / the OpenAI Agents API. A **vault** is a
named, per-principal container of **encrypted secrets**; a session lists `vault_ids`, and at run time
the harness decrypts those secrets and injects them into every sandbox the session leases as
environment variables. Secrets are **write-only**: the API returns a credential's name and metadata,
never its value.

- **Storage** (`src/infra/db.ts`): `vaults` + `vault_credentials` tables; each secret is sealed with
  the existing BYOK cipher (`src/infra/secrets.ts`, AES-256-GCM, `PMA_SECRET_KEY`) — no new crypto.
  `vaultSecrets(owner_id, vault_ids)` decrypts an owner's vault secrets into an env map.
- **Injection** (`SandboxRequest.secrets`): the isolating providers already inject at container create
  (`docker`/`e2b`); `local` now injects into each command's env too (via `addMount`). `run-turn`
  computes the session's vault secrets once and passes them on every `acquire`.
- **API**: native `/v1/vaults` (+ `/:id/credentials`), and the official SDK surface
  `client.beta.agents.vaults.*` at `/openai/v1/vaults` (+ `/:id/credentials`); the SDK's typed `auth`
  union (`static_bearer` / `mcp_oauth`) is accepted by storing its token. `AgentSession.vault_ids` is
  populated and session create accepts `vault_ids`.
- **Verified live** (rebuilt stack, real `openai@7.15.0`): created a vault + credential (value never
  returned by create or list), created a session with `vault_ids` and a `bash` tool, and the model ran
  `echo $MY_SECRET` in the sandbox — the injected secret appeared in the tool output.

What this is NOT: a general vendor secret-manager or MCP-OAuth token-rotation service (the SDK models
the latter). It is the core, broadly useful thing — encrypted secrets injected into the agent's
environment — which is what Managed-Agents-style workloads actually need.

## 20. Environment lifecycle & BYOC reconnect

The OpenAI stream projects a sandbox lease into `agent.session.environment.ready` (from our persisted
`sandbox.acquired` event), so the SDK sees the environment come up during a turn — verified live (it
appears in `sessions.stream()` before the first tool result).

**BYOC reconnect** matches the SDK's `environment_connection` semantics end to end:

- **Pause** (`src/runner/main.ts` `pauseIfDisconnected`): before a run, if the session's environment is
  `byoc` and no worker is live (`anyWorkerAlive`), the runner appends `session.environment_disconnected`
  and skips the run — instead of hanging on `acquire` or terminating. The session then reads as
  `requires_action` with `{ type: "environment_connection", environment_id }` (derived in
  `environmentActions`), and the stream emits `agent.session.environment.failed` +
  `agent.session.requires_action`.
- **Resume** (`src/api/routes/worker.ts`): a worker's poll is a heartbeat; on a *fresh* (re)connect the
  route marks the worker alive first (so the runner's re-check wins the race), then `resumeEnvironment`
  re-enqueues the environment's idle sessions that are waiting on a reconnection. The re-run passes the
  pause check and proceeds; a later `session.status_running` clears the pending action.
- **Verified live**: a `byoc` session with no worker paused as `requires_action` /
  `environment_connection`; a worker poll (reconnect) resumed it and the run completed —
  `environment_disconnected → status_running → status_idle`, final status `idle`, `required_actions: []`.

The pending action clears on `session.status_running` (run resumed past the pause), not on
`sandbox.acquired`, because a toolless run completes without ever leasing a sandbox.
