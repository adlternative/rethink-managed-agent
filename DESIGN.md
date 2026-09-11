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
  the fetch allowlist, failing soft), which lists and calls its tools; `web_search` maps to the existing
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
