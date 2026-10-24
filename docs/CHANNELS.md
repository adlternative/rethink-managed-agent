# Channel integrations (Slack)

First-class path from a chat mention to a durable rethink session: the bot is mentioned in Slack,
rethink creates (or resumes) a session, agent replies land in the same thread, and tool confirmations
can be answered with in-thread buttons.

Discord / GitHub reuse the same `channel_integrations` + `channel_threads` tables once their adapters land.

## Concepts

| Resource | Role |
|---|---|
| **Integration** (`/v1/integrations`) | Owner-scoped binding: Slack workspace ↔ agent + environment + vault |
| **Vault credentials** | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` — sealed with `PMA_SECRET_KEY`; never in config JSON or the event log |
| **Thread mapping** (`channel_threads`) | `(team, channel, thread_ts) → session_id`; survives API/runner restarts |
| **Event dedup** (`channel_event_ids`) | Slack `event_id` claimed once so retries do not double-create |

## Setup

1. Create a Slack app with **Event Subscriptions** (`app_mention`, `message.channels` / `message.groups` as needed) and **Interactivity**.
2. Ensure `PMA_SECRET_KEY` is set on the API (vault sealing).
3. Store secrets and create the integration:

```bash
pma vaults create slack-bot
# Put sealed credentials named SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET into that vault
# (pma vaults credentials put <vault> <name> --value-env <VAR> or --value-stdin).
pma integrations create --kind slack --name coding --agent "$AGENT" --env "$ENV" --vault "$VAULT"
```

4. Point Slack at your API (public URL or tunnel):

- **Request URL (Events):** `https://<host>/v1/integrations/<id>/events`
- **Request URL (Interactivity):** `https://<host>/v1/integrations/<id>/interactions`

Those two routes authenticate with the Slack signing secret (not a bearer API key). CRUD under `/v1/integrations` still uses normal principal auth.

## Runtime behaviour

- **`app_mention`** (or a thread reply under a mapped root) → create or resume a session → append `user.message` → enqueue a run → bridge posts `agent.message` text back to the thread.
- **`agent.tool_confirmation_required`** (MCP / `always_ask`) → Slack message with **Allow** / **Deny** buttons → `user.tool_confirmation`.
- **Client / function tools** (`required_action`) → prompt to reply `/answer <tool_use_id> <json or text>` → `tool_result` (control plane only; not stored as a user message).
- Secrets are read from the vault inside the API process for signing verification and `chat.postMessage`; they are never written into events or session metadata beyond the vault id / integration id labels.

## Example

See [`examples/slack-coding-agent/`](../examples/slack-coding-agent/) for a scripted setup that creates agent, environment, vault, and integration rows (you still need a real Slack app + public Request URL to exercise end-to-end).
