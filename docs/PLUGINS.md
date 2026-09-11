# pma plugins

Third-party code extends an agent through a small capability-based API. The design rule is
**no ambient authority**: a plugin never gets Node's `fs`, `child_process` or `net`. Everything it can
do goes through `ctx`, and everything in `ctx` is mediated by the runner and scoped to the session's
sandbox and agent. There is nothing to audit for "does this plugin read or write files": it cannot,
except through `ctx.sandbox`, which is confined to the workspace by construction.

## Package

```
my-plugin/
  package.json      { "pma": { "plugins": ["./index.ts"], "skills": ["./skills"], "prompts": ["./prompts"] } }
  index.ts          export default function (p: PluginAPI) { ... }
  skills/<name>/SKILL.md   (pi layout, frontmatter name/description)
  prompts/<name>.md
```

Sources on an agent: `packages: ["npm:<pkg>", "git:<url>[@ref]", "/absolute/path"]` (`pma agents create x qoder/kmodel --packages ...`).
They are installed once per agent into `PI_AGENT_ROOT/<agent_id>` and cached by the source list.

## API (`src/plugins/api.ts`)

```ts
export default function (p: PluginAPI) {
  p.registerTool({ name, description, parameters /* typebox */, async execute(input, ctx) { return "text" | { content, isError } } });
  p.registerCommand({ name: "goal", description, async handler(args, ctx) { return { reply?, send? } | "reply" } });   // "/goal ..." in a user message
  p.on("<hook>", (event, ctx) => result | undefined);
}
```

### Hooks (modelled on pi's extension events)

| hook | when | may return |
|---|---|---|
| `input` | a user message is about to enter the session (trigger, steer, or sub-agent brief) | `{text}` rewrite · `{cancel:true}` swallow |
| `before_agent_start` | once per run, before the first model request | `{systemPrompt \| appendSystemPrompt, injectMessage}` |
| `context` | before every model request; carries `contextTokens` / `contextWindow` | `{appendSystemPrompt}` (this request only) |
| `model_request_start` / `model_request_end` | around each provider call; end carries usage | — |
| `message_end` | the assistant produced a message: text, thinking, tool calls | — |
| `tool_call` | before a tool runs | `{block, reason}` · `{input}` rewrite |
| `tool_result` | after a tool ran | `{content, isError}` rewrite — `content` is `ToolResultContent[]` (text + inline-image blocks); composes as middleware |
| `turn_start` / `turn_end` | per model turn; end carries `toolCalls` | `turn_end`: `{stop, reason}` |
| `before_compact` / `after_compact` | around context compaction | `before`: `{cancel}` · `{instructions}` steer the summarizer · **override:** `{summary}` replace it, `{keepRecentTokens}` change the keep budget |
| `sandbox_acquired` / `sandbox_released` / `workspace_captured` | sandbox lifecycle | — |
| `session_start` / `session_end` | per run; end carries `stopReason`, `turns` | — |
| `error` | a run failed | — |

**Two shapes of hook.** Most are **middleware**: handlers run in registration order, each sees the
event as modified by earlier ones (`input.text`, `tool_call.input`), text results (`appendSystemPrompt`,
`instructions`, `reason`) accumulate, and decisions (`block`, `cancel`, `stop`) are final once made —
so plugins stack. A few carry **override** fields (`before_compact`'s `summary` / `keepRecentTokens`):
these are single-owner — the *first* plugin to set one wins, a later one is ignored with a warning
(`OVERRIDE_FIELDS` in `host.ts`), so two plugins never silently fight over the loop's strategy, and if
none answer the built-in default runs. This is how loop *behavior* (compaction, and future retry /
model-request points) is pluggable without a plugin owning the whole loop. See DESIGN.md §18.

### Commands

`registerCommand({name, handler})` makes `/name args` in a user message run the handler instead of the
model. The handler's `reply` is persisted as `plugin.message` (shown to the user, never sent to the model);
`send` forwards a rewritten prompt to the model. Without `send` the turn ends after the reply.

`ctx` capabilities:

| capability | what it does | where it runs |
|---|---|---|
| `ctx.session.note(text)` | persist a note for the user (`plugin.message`; not model context) | runner |
| `ctx.session.send(text)` | queue a user-role message: steers the running turn or starts the next run | runner |
| `ctx.session.interrupt()` | abort the current run | runner |
| `ctx.sandbox.exec / readFile / writeFile` | the session's sandbox, workspace-confined, lazily leased like the builtin tools | sandbox |
| `ctx.store.get / set(key, value, "agent" \| "workspace")` | JSON KV in Postgres (`plugin_store`) | runner |
| `ctx.model.complete(prompt, {system, maxTokens})` | one-shot completion with the session's model | runner |
| `ctx.agent.run(task, {system, maxTurns, tools})` | a sub-agent loop with the builtin tools in the same sandbox; returns its final text | runner + sandbox |
| `ctx.agent.run(task, {isolated: true, env?})` | a real child session on a fork of the workspace with its own sandbox (runs on any runner slot); returns `{report, patch?, sessionId}` and records thread events on the parent | runner + child sandbox |
| `ctx.agents.spawn(task, {role, name, system, model, tools, env, shareWorkspace, maxTurns})` | start a child session and return a handle immediately (parallelism) | runner |
| `ctx.agents.wait(h, {timeoutMs, untilQuestion})` · `status(h)` · `list()` | join / inspect children: `{finished, stopReason, lastReport, updates[], pendingQuestion?}` | runner |
| `ctx.agents.steer(h, text)` · `reply(h, questionId, text)` · `stop(h)` · `patch(h)` | talk to a child, answer its question, stop it, fetch its git patch | runner |
| `ctx.sandbox.*(…, {env})`, `ctx.sandbox.envs()` | target one of the session's attached environments | sandbox |
| `ctx.fetch(url, init)` | HTTP through the runner, host allowlist `PLUGIN_FETCH_ALLOW` (default `*`) | runner |
| `ctx.log(...)` | runner log | runner |

Skills and prompt templates are listed in the system prompt and loaded on demand with a builtin
`skill` tool, so the model never needs a filesystem path.

## Where plugins run: two placements

An environment chooses `plugin_host`:

| | `runner` (default) | `sandbox` |
|---|---|---|
| process | one host per agent on the runner, long-lived | one host per run, started inside the leased sandbox (`/tmp/pma-host`, outside the workspace) |
| plugin's own `fs` / `child_process` / `net` | denied (permission model + lockdown) | allowed — confined by the sandbox itself (docker `--cap-drop ALL`, resource limits, `network`) |
| `ctx.*` capabilities | RPC to runner | RPC to runner (store, model, sub-agent, fetch, log are still runner-served) |
| sandbox lease | lazy, only when a tool needs it | eager: the sandbox is leased at turn start so the host has somewhere to run |
| needs | nothing | `node` ≥ 22.18 in the sandbox image; a provider with `spawn` (local, docker; e2b pending) |
| use for | policy hooks, memory/goal, remote APIs, orchestration | plugins that read/write the workspace or talk to the network directly: search, LSP, indexers, git tooling, ported pi extensions |

`plugin_host: "sandbox"` is refused for the `local` provider (no isolation there). Network egress
from a docker sandbox is `network: "bridge"` on the environment; the default is `none`.

```bash
pma envs create web --provider docker --image node:22-alpine --network bridge --plugin-host sandbox
pma agents create researcher qoder/kmodel --packages /app/plugins/web-search,/app/plugins/goal,/app/plugins/safety-net
```

`plugins/web-search` is the sandbox-native sample: `web_search` (Bing) and `fetch_to_file` use the
global `fetch` and `node:fs` directly and were verified in a docker sandbox (Bing results parsed,
`example.com` downloaded into `/workspace/example.html`, `goal` store and `safety-net` hook working
over RPC from inside the sandbox). In `runner` mode the same plugin fails visibly at the first
`fetch`, which is the intended signal that it needs the sandbox placement.

## Isolation (runner placement)

Plugins load in a **plugin host** process per agent (`src/plugins/host.ts`), started by the runner
with Node's permission model (`--permission --allow-fs-read=` only `src/plugins`, `node_modules/typebox` and the package dirs — never the repo root, so `.env` and the rest of `src/` are invisible): no fs writes, no
child processes, no workers, no access to the runner's env or DB. Node 22's permission model does not
cover sockets, so the host additionally locks the network down before the first plugin import
(`src/plugins/lockdown.ts`): the synchronous module hooks refuse to resolve `net`, `tls`, `http`,
`https`, `http2`, `dgram`, `dns` (and `child_process`, `worker_threads`, `vm`, ...) for both ESM and
CJS, and the global `fetch` / `WebSocket` / `EventSource` are replaced with throwing stubs and
frozen. A plugin that statically imports one of those modules fails to load and is reported in the
runner log; the only network path left is `ctx.fetch`, served by the runner under `PLUGIN_FETCH_ALLOW`. The host and the runner talk over
stdio JSON-RPC (`src/plugins/protocol.ts`); tool calls go runner → host, capability calls go host →
runner. `test/plugin-host.test.ts` loads a hostile plugin (`test/fixtures/pma-escape`) and asserts
that its write attempt fails with `ERR_ACCESS_DENIED` and that `child_process`, `http`, `net` and the global `fetch` are all unavailable.

Hooks and tools are wired into the pi-agent-core loop in `src/harness/run-turn.ts`:
`tool_call` → `beforeToolCall`, `tool_result` → `afterToolCall`, `context` → per-turn system prompt.

## Sample plugins (`plugins/`)

| package | provides |
|---|---|
| `goal` | `set_goal` / `goal_progress` tools, workspace-scoped store, `context` hook that keeps the goal in every request |
| `fork` | `fork` tool: delegate a standalone brief to a sub-agent (`ctx.agent.run`), optionally read-only |
| `safety-net` | `tool_call` hook blocking `rm -rf /`, force push, hard reset, `DROP TABLE`, disk wipes |
| `web-fetch` | `web_fetch` tool over `ctx.fetch` plus a `web-research` skill |
| `team` | agent teams: roles (`explorer`, `planner`, `worker`, `reviewer`, custom via `/team set`), tools `spawn_agent` / `wait_agents` / `message_agent` / `list_agents` / `agent_patch`; children run in parallel on forked workspaces and talk back with `report_to_parent` |
| `workflow` | `run_workflow` tool: a deterministic JS script with `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `args` (the pi-subagents / Claude Code `Workflow` shape) over child sessions; `Date.now` / `Math.random` throw. **See [docs/WORKFLOWS.md](./WORKFLOWS.md).** |
| `outcome` | Managed-Agents-style outcomes: `/outcome <goal> \| rubric: … \| max: N`; at `session_end` a read-only sub-agent gathers evidence, the model judges it, and `needs_revision` feedback is sent back as a new turn until satisfied or the cap |
| `webhook` | `/webhook set <url> [secret]`; POSTs `session.started` / `session.ended` / `session.error` through `ctx.fetch` with an HMAC-SHA256 `x-pma-signature` |
| `compactor` | the reference **override-hook** plugin: a `before_compact` handler that reads `ctx.events`, writes a structured summary with `ctx.model`, and returns it as `summary` (skipping the built-in summarizer); the cut point stays the harness's |
| `_template` | annotated starter — copy the directory, rename it, edit `index.ts`. Shows a tool, a command, a middleware hook, an override hook, and the full `ctx` cheat-sheet |

These were exercised in live sessions and by `test/plugin-host.test.ts`; see the commit messages for transcript summaries.

## pi compatibility (best effort)

A package with a `pi` manifest is loaded through `src/plugins/pi-compat.ts`, which maps
`registerTool` and `on(tool_call | tool_result | context | turn_* | session_start | session_shutdown |
session_before_compact)` onto the pma API and records everything else (`registerCommand`, shortcuts,
renderers, providers, `ctx.ui.*`, `ctx.cwd`) as an ignored no-op / rejecting stub. A pi compaction
extension's `{ compaction: CompactionResult }` maps to our `before_compact` `summary` override. Pure-tool
and pure-hook pi packages work; anything that needs the TUI, a local provider credential, or the local
filesystem does not — by design (see DESIGN.md §18.2 for the full support matrix and the rationale).

The earlier experiment that hosted pi-coding-agent's own `AgentSession` (full pi extension API,
extensions running unsandboxed in the runner) is kept behind `EXPERIMENTAL_PI_PACKAGES=1`; see
`docs/PI_EXTENSIONS.md`. It is not the supported path.

## What is a plugin vs core

Outcomes and webhooks are plugins (above): they only need hooks, `ctx.model`, `ctx.agent.run`, `ctx.fetch`
and `ctx.session.send`. Scheduled runs are not: plugins only live inside a run, so a cron trigger needs a
process that exists between runs. Today that is any external scheduler calling
`pma sessions create --agent … --env … --message …` (or the HTTP API); a `/v1/schedules` table plus a
runner tick is the ~100-line core addition if platform-managed schedules are ever wanted.

## Multi-agent model

Children are ordinary sessions (`parent_id` set) on a **fork** of the parent's workspace, run by any runner
slot, so they are parallel by construction and never write the same files. A child gets the builtin
`report_to_parent {kind: update | report | question}` tool: updates and reports are recorded as
`agent.thread_message_sent` (child) / visible through `ctx.agents.status` (parent); a `question` ends the
child's turn and the parent's `reply` arrives as the child's next user message (Managed-Agents thread
semantics, pi-subagents "intercom"). Nesting is allowed (a child can spawn children); depth is bounded only
by `MAX_TURNS` and runner concurrency, so keep fleets small or use `run_workflow` with `max_agents`.
