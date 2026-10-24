# slack-coding-agent

Minimal Slack ↔ rethink wiring: mention the bot in a channel, get a durable coding session in that
thread (parity intent with Omnara’s `examples/slack-coding-agent`).

## What it sets up

1. A local sandbox environment and a coding agent (`bash` / `read` / `write` / `edit`).
2. A vault with `SLACK_BOT_TOKEN` + `SLACK_SIGNING_SECRET` (from your env — never printed).
3. A Slack channel integration pointing at that agent/env/vault.
4. Prints the Events + Interactivity Request URLs to paste into your Slack app.

## Prerequisites

- Stack up: `make up` (or local api + runner + Postgres).
- `PMA_SECRET_KEY` set (compose / `.env`).
- Slack app bot token + signing secret in the environment:
  - `SLACK_BOT_TOKEN=xoxb-…`
  - `SLACK_SIGNING_SECRET=…`
- A public (or tunneled) URL to the API, e.g. `https://….ngrok-free.app` as `PMA_PUBLIC_URL`.

## Run

```sh
export PMA_API=http://localhost:8080
export PMA_PUBLIC_URL=https://your-tunnel.example   # what Slack will POST to
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_SIGNING_SECRET=...
# optional when AUTH_REQUIRED=true:
# export PMA_API_KEY=pma_...

npx tsx examples/slack-coding-agent/setup.ts
```

Then in Slack app settings:

- Event Subscriptions → Request URL = printed `…/events` (subscribe to `app_mention` and message events for channels you use).
- Interactivity → Request URL = printed `…/interactions`.
- Invite the bot to a channel and `@mention` it.

Thread replies continue the same rethink session. Allow/Deny buttons satisfy `always_ask` tool
confirmations; for client tools, reply `/answer <call_id> <result>` in the thread.
