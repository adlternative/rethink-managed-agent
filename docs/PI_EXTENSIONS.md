# pi packages (extensions / skills / prompts) in the runner

The runner hosts pi's own harness (`@earendil-works/pi-coding-agent` `AgentSession`) headlessly, so
packages from the pi ecosystem load unchanged. This is "route A": extensions execute inside the
runner process; only file/shell tools are ours and go through the sandbox lease.

## Using it

```bash
pma agents create coder qoder/kmodel --packages npm:@someone/pi-ext-foo,git:https://github.com/x/y,/abs/path/on/runner
```

`packages` is any pi package source (`npm:`, `git:`, or a path readable by the runner). On the first
run for that agent the runner installs them into `PI_AGENT_ROOT/<agent_id>` (a per-agent pi
`agentDir`; never the user's `~/.pi`) and caches by the source list. Installed extensions run for every
session of that agent; a session created with `agent_with_overrides` may override `packages`.

## What works

| pi feature | status | notes |
|---|---|---|
| `pi.registerTool(...)` | works | tools are active alongside bash/read/write/edit; executed in the runner |
| hooks: `tool_call`, `tool_result`, `context`, `before_agent_start`, `turn_*`, `message_*`, compaction hooks | work | `tool_call` can block a call before it reaches the sandbox (see `test/fixtures/pi-ext-demo`) |
| skills (`SKILL.md`) | work | listed in the system prompt; the `read` tool serves their runner-side path read-only |
| prompt templates | work | same read overlay |
| `pi.registerProvider` | works | model providers are pi's `ModelRuntime` |
| AGENTS.md / CLAUDE.md context files | partial | read from the extension `cwd` (see below), not from the live sandbox |
| UI: renderers, overlays, footer, shortcuts, `ctx.ui.*` | no | `hasUI === false`; `ctx.ui.select/confirm` reject — extensions must handle headless |
| slash commands (`registerCommand`) | no | there is no interactive input loop; `/name` in a user message is not dispatched |
| extensions that touch files / run shell via `cwd` | no | they run on the runner, not in the sandbox |

## The `cwd` extensions see

The sandbox is leased lazily and may never be acquired in a turn, so `cwd` cannot be the live sandbox
dir. It is the persisted workspace copy when that lives on this host (`dir` workspace refs, i.e. the
last capture), otherwise a per-workspace scratch dir under `PI_AGENT_ROOT/cwd/`. Treat it as a
snapshot, not the working tree.

## How it is wired (`src/harness/pi-session.ts`)

1. `ensurePackages` → `DefaultPackageManager.installAndPersist` into the agentDir.
2. `ModelRuntime` per agentDir with the qoder proxy registered (`registerProvider`).
3. `DefaultResourceLoader({cwd, agentDir, systemPrompt})` loads extensions/skills/prompts.
4. `SessionManager.inMemory()` seeded with the folded event history; the trailing user message is
   sent with `session.prompt()`.
5. `createAgentSession({ noTools: "builtin", customTools: <sandbox tools> })`, then
   `setActiveToolsByName([...ours, ...extensionTools])`.
6. `session.subscribe` maps pi events to our `agent.*` events; interrupts call `session.abort()`,
   steered user messages call `session.steer()`.

Compaction: pi compacts in memory during a run; the compacted summary is not yet persisted as an
event, so the next run refolds the full history. Follow-up: persist `agent.thread_context_compacted`
and honour it in `fold.ts`.

## Alternatives considered

- **pi inside the sandbox** (`pi --mode rpc` per sandbox): 100% package compatibility incl. file
  extensions, but model credentials and the loop move into the sandbox. Kept as a possible runtime
  mode, not implemented.
- **Own plugin format**: if pi compatibility ever costs more than it returns, tools + hooks + skills
  is a small surface to define ourselves; the seam is `createPiSession`.
