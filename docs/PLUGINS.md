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
  p.on("tool_call",   (ev, ctx) => ({ block: true, reason }) | undefined);   // before a tool runs; can block
  p.on("tool_result", (ev, ctx) => ({ content?, isError? }) | undefined);    // after; can rewrite the result
  p.on("context",     (ev, ctx) => ({ appendSystemPrompt }) | undefined);   // before every model request
  p.on("turn_start" | "turn_end" | "session_start" | "session_end", (ev, ctx) => void);
}
```

`ctx` capabilities:

| capability | what it does | where it runs |
|---|---|---|
| `ctx.sandbox.exec / readFile / writeFile` | the session's sandbox, workspace-confined, lazily leased like the builtin tools | sandbox |
| `ctx.store.get / set(key, value, "agent" \| "workspace")` | JSON KV in Postgres (`plugin_store`) | runner |
| `ctx.model.complete(prompt, {system, maxTokens})` | one-shot completion with the session's model | runner |
| `ctx.agent.run(task, {system, maxTurns, tools})` | a sub-agent loop with the builtin tools in the same sandbox; returns its final text | runner + sandbox |
| `ctx.fetch(url, init)` | HTTP through the runner, host allowlist `PLUGIN_FETCH_ALLOW` (default `*`) | runner |
| `ctx.log(...)` | runner log | runner |

Skills and prompt templates are listed in the system prompt and loaded on demand with a builtin
`skill` tool, so the model never needs a filesystem path.

## Isolation

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

All four, plus the pi fixture below, were exercised in a live session; see the commit message for the transcript summary.

## pi compatibility (best effort)

A package with a `pi` manifest is loaded through `src/plugins/pi-compat.ts`, which maps
`registerTool` and `on(tool_call | tool_result | context | turn_* | session_start | session_shutdown)`
onto the pma API and records everything else (`registerCommand`, shortcuts, renderers, providers,
`ctx.ui.*`, `ctx.cwd`) as an ignored no-op / rejecting stub. Pure-tool and pure-hook pi packages
work; anything that needs the TUI or the local filesystem does not, by design.

The earlier experiment that hosted pi-coding-agent's own `AgentSession` (full pi extension API,
extensions running unsandboxed in the runner) is kept behind `EXPERIMENTAL_PI_PACKAGES=1`; see
`docs/PI_EXTENSIONS.md`. It is not the supported path.
