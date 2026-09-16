# pma — rethink-managed-agent CLI

Terminal client for the API in this repo, modelled on `qca-cli` (Qoder Cloud Agent CLI): a thin set of
subcommands over `fetch`, plus an Ink TUI for interactive chat with streaming, tool folding and slash commands.

## Quick start

```bash
cd pma-cli && npm install && npm run build       # -> bundle/pma.js (single file, node >= 20)
make install                                    # from the repo root: rebuild + copy into ~/.local/bin
                                                # (a snapshot — rerun after pulling or editing)
make install-dev                                # or: a wrapper that runs this working copy live,
                                                # so edits need no rebuild and no reinstall
alias pma="node $PWD/bundle/pma.js"

pma login --host http://localhost:8080           # ~/.pma/config.json
pma agents create coder qoder/ultimate --system "You are a careful engineer"
pma envs create dev --provider docker --image node:22-alpine
pma config --agent <agent_id> --env <env_id>     # defaults used by the TUI and `sessions create`

pma                                              # interactive chat; first message starts a session
pma "list the files in the workspace"            # start a session with a message
pma -r                                           # resume the latest session
pma -r sess_xxx                                  # resume a specific one
```

## Subcommands

| Command | Notes |
|---|---|
| `login [--host U] [--token T]` / `logout` | host + optional bearer token |
| `config [--host U] [--agent ID] [--env ID] [--header k:v]` | set / show defaults |
| `models` | models the runner can resolve (`GET /v1/models`) |
| `agents list \| get <id> \| create <name> <provider/model> [--system S] [--tools t,t]` | |
| `envs list \| get <id> \| create <name> --provider local\|docker\|e2b [--image I] [--git URL --ref R]` | `--image` is a docker image or an e2b template |
| `sessions list [--status s] \| get \| create [--agent --env --workspace-id --model p/id --message T] \| archive \| delete` | `--workspace-id` shares another session's workspace (and sandbox) |
| `session events <id> [--json] \| send <id> <text> [--wait] \| stream <id> \| interrupt <id> \| export <id> [--json]` | `--wait` streams the turn to stdout |
| `sandboxes list [--all] \| get <id> \| pause <id> \| delete <id>` | via the runner's reaper |
| `files upload <path> \| list \| get <id> \| delete <id>` | attachments for `session send --file` |
| `skills list \| get \| create --file SKILL.md \| update \| delete` | skill resources for `agents create --skills` |
| `memories list \| get \| create <name> \| delete` | memory stores for `sessions create --memories` |
| `providers …` / `worker …` | model providers (BYOK with `--key`) / BYOC sandbox worker |

Env overrides: `PMA_HOST`, `PMA_TOKEN`, `PMA_HEADERS` (JSON object), `PMA_CONFIG` (config path).

## TUI

| Slash command | |
|---|---|
| `/new [message]` | new session with the default agent/env (and `/model` override if set) |
| `/sessions` | switch session (↑↓ + type to filter) |
| `/agent` `/env` | pick defaults, persisted to config |
| `/model` | model override for the next `/new` (`agent_with_overrides`) |
| `/status` `/sandboxes` | session info / live sandboxes |
| `/plugins [add\|remove <source>]` | plugins on this session plus what this deployment offers; attaching one is live from the next turn and leaves the saved agent alone |
| `/plugins search <q>` `/plugins add` (no source) | search, or pick from, the deployment's catalogue. Each subcommand is its own completion entry, so typing `/plug` shows them |
| `/export [--json]` | write the conversation to `<session>.txt|json` |
| `/cancel` | send `user.interrupt` |
| `/clear` `/help` `/quit` | |

Keys: `Esc` clears suggestions → clears input → interrupts the running turn · `Ctrl+O` expand/collapse tool output ·
`↑/↓` input history or suggestion navigation · `Tab` completes a slash command · `Ctrl+A/E/K/U/W` line editing ·
`Ctrl+C` twice exits.

How it follows a session: on open it lists persisted events and folds them into messages (tool results hang
under their `agent.tool_use`), then attaches to `GET /v1/sessions/:id/events/stream?since=<last seq>`.
`agent.message_delta` items stream into a cursor-terminated message; the persisted `agent.message` that
follows replaces it as the authoritative copy. `agent.thinking_delta` renders as a dim `∴ thinking` block
(last two lines, Ctrl+O expands); `agent.tool_use_start` / `agent.tool_use_delta` show `▪ name(…)` with the
argument fragments until the persisted `agent.tool_use` replaces it. The stream reconnects from the last seq on network errors.

## Layout

```
src/index.ts        arg parsing, subcommand routing, TUI launch (like qca's index.ts)
src/lib/config.ts   ~/.pma/config.json + env overrides
src/lib/client.ts   apiGet/Post/Delete, streamEvents (SSE parser + reconnect), resource types
src/cli/*.ts        one file per subcommand group
src/tui/App.tsx     chat TUI (message model, stream handling, slash commands)
src/tui/Input.tsx   line editor; src/tui/Selector.tsx  ↑↓ picker
```

Unlike qca this uses the published `ink` package rather than a vendored fork, so there is no mouse
selection / scrollback pagination; the terminal's own scrollback is used.

## UI plugins (client-side)

pma has its own plugin API, independent of the server's: a module in `~/.pma/plugins/<name>.ts` (or a path
under `ui_plugins` in `~/.pma/config.json`) that default-exports `(ui) => void`. It never sees server code;
the only shared contract is the JSON shape of session events.

```ts
import type { UiAPI } from "pma-cli/src/ui-api";   // types only
export default function (ui: UiAPI) {
  ui.registerCommand({ name: "bookmark", description, handler(args, ctx) { ... } });   // local /bookmark
  ui.registerShortcut({ key: "ctrl+b", description, handler(ctx) { ... } });
  ui.registerStatus("bell", (ctx) => "🔔");                                              // header segment
  ui.registerToolRenderer("write", (input, result, ctx) => ({ title, lines }));       // custom tool rows
  ui.registerEventRenderer("sandbox.acquired", (payload, event, ctx) => "…");         // one-line event render
  ui.on("session.status_idle", (event, ctx) => { ... });                               // observe events
}
```

`ctx` offers `session`, `send(text)`, `note(text)`, `api.get/post`, `expanded`, `select(title, items)` and
`openSession(id)`. Unknown `/commands` are forwarded to the server as ordinary messages, so server-side plugin
commands (`/goal …`) and local ones coexist; `/help` lists both plus shortcuts.

Examples in `plugins/`: `notify` (bell + macOS notification when a run ends), `tool-preview` (write/edit/bash
rows show what they touch), `bookmarks` (`/bookmark`, `/bookmarks`, ctrl+b). Install with
`cp plugins/*.ts ~/.pma/plugins/`.
