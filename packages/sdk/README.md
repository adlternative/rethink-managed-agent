# pma-sdk

Thin, dependency-free TypeScript client for the **native `/v1`** API of
[rethink-managed-agent](https://github.com/adlternative/rethink-managed-agent).

> This is **not** the in-tree OpenAI Agents compatibility helper under
> `src/api/routes/compat/sdk/`. Use this package for `/v1` sessions, SSE events,
> agents, environments, and vaults.

## Install

```sh
npm install pma-sdk
```

(From this monorepo before publish: `npm install ./packages/sdk`.)

## Quickstart

```ts
import { createClient } from "pma-sdk";

const pma = createClient({
  baseURL: process.env.PMA_API ?? "http://localhost:8080",
  apiKey: process.env.PMA_API_KEY, // optional when AUTH_REQUIRED=false
});

const agent = await pma.agents.create({
  name: "coder",
  model: { provider: "qoder", id: "auto" },
  tools: ["bash", "read", "write", "edit"],
});
const env = await pma.environments.create({ name: "local", provider: "local" });
const session = await pma.sessions.create({
  agent: agent.id,
  environment_id: env.id,
});

await pma.sessions.send(session.id, "list the current directory");

for await (const frame of pma.sessions.stream(session.id, { since: 0 })) {
  if (frame.type === "agent.message_delta") process.stdout.write(frame.data.text ?? "");
  if (frame.type === "session.status_idle") break;
}
```

## Auth

- Local compose (`AUTH_REQUIRED=false`): omit `apiKey`.
- Production: `pma login` (device flow) or mint `POST /v1/api_keys`, then pass the token.

## Spec

Machine-readable contract: [`openapi/v1.yaml`](../../openapi/v1.yaml) (also served at `GET /openapi/v1.yaml`).
Compat mounts (`/openai/v1`, `/anthropic`, `/agents-api/v1`) are documented separately in the server README.
