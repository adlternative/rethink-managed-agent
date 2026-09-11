# sev-bot — OpenAI Agents API showcase, vendor-neutral

A runnable analog of OpenAI's [Agents API SRE incident-response showcase](https://developers.openai.com/showcase/agents-api-sev-bot), built on rethink's OpenAI-compatible layer (`/agents-api/v1`). It exercises the same mechanics — a session per incident, streaming, client/function tools with caller-side handlers, and one **approval-gated** tool that surfaces a `required_action` a human answers — but needs **no GitHub, AWS, or OpenAI credentials**. The read-only tools read local fixtures, the model is any rethink provider, and the environment is a pluggable sandbox provider.

## What it shows

- `sessions.create({agent, environment})` with `agent.tools` = three function tools + a builtin.
- `session.stream({input, tool_handlers})` streaming the investigation as `output_text` deltas.
- Warm client tools (`get_incident_details`, `search_logs`) auto-resolved by local handlers, resuming the same turn.
- `propose_rollback` declared with **no handler** → a `required_action`; the example prints the proposal, waits for console approve/deny, then `session.tool_result(...)` resumes the agent.

## Run

Bring up the stack and a model provider, then:

```sh
make up                      # postgres + redis + api + runner (or run them however you like)
# ensure a model provider exists (the Qoder proxy is seeded by default; or add your own)
npx tsx examples/sev-bot/incident_bot.ts
```

Environment overrides: `SEV_API` (default `http://localhost:8080/agents-api/v1`), `SEV_MODEL` (default `qoder/ultimate`, i.e. provider `qoder` id `ultimate`), `SEV_PROVIDER` (sandbox provider for the environment, default `local`), `SEV_TOKEN` (bearer, only if `AUTH_REQUIRED=true`), `SEV_AUTO_APPROVE` (`approve`/`deny` — set it, or run non-interactively, to decide the rollback without a prompt; unset + a TTY asks).

The bot creates its own environment via the native API, so no pre-config is needed beyond a working model provider. Swap `SEV_MODEL` to point at any OpenAI/Anthropic-compatible provider row — that is the whole "no cloud lock-in" story.
