# Examples — OpenAI Agents API showcases, vendor-neutral

Each maps an OpenAI Agents API showcase onto rethink's compat layer (`/agents-api/v1`) with **no cloud
credentials** — model is any rethink provider (BYOK), environment is a pluggable sandbox provider.
Bring the stack up (`make up`) with a model provider, then run one with `npx tsx`.

| Example | OpenAI showcase analog | Capabilities it proves |
|---|---|---|
| [`sev-bot/`](sev-bot/) | SRE incident response | client/function tools (caller-side handlers), **human approval** via `required_action` + `tool_result`, streaming, parallel tool calls |
| [`code-agent/`](code-agent/) | Data agent / GitHub-issue agent | **code execution in a real sandbox** — builtin `bash`/`write`/`read` run inside a docker sibling container (`self_hosted` env) |
| [`doc-review/`](doc-review/) | Bulk invoice/contract review | **multi-agent** — `multi_agent` maps to the team plugin; the lead agent spawns parallel subagents (real child sessions) and aggregates |
| [`docs-qa/`](docs-qa/) | Quickstart docs Q&A | **real MCP over HTTP** — a `{type:'mcp'}` tool connects (server-side) to the public OpenAI docs MCP server; the agent calls its tools and cites a doc |
| [`dreamer/`](dreamer/) | Managed Agents "Dreaming" | **scheduled cross-session learning** — reads recent sessions' event logs, distills learnings, and writes them into tenant memory (`plugins/memory`) for future sessions |
| [`slack-coding-agent/`](slack-coding-agent/) | (Omnara Slack coding agent parity) | **Slack thread channel** — mention → session, in-thread replies, Allow/Deny for `always_ask` (see `docs/CHANNELS.md`) |

All three were run end-to-end against the live stack with the local Qoder model. Watch any run at
**http://localhost:8080/** (the dashboard) or via `GET /v1/sessions/:id/events`.

`doc-review` needs the team plugin wired on the API: `COMPAT_TEAM_PACKAGE=/app/plugins/team` (already set
in `docker-compose.yml`). `web_search` maps to the existing `plugins/web-search` pi plugin (`COMPAT_WEBSEARCH_PACKAGE`), which needs `plugin_host=sandbox` + `network=bridge` on the environment to run. Still accepted-and-ignored unless wired: `programmatic_tool_calling`.
