# dreamer — scheduled cross-session learning ("Dreaming")

A vendor-neutral analog of Claude Managed Agents' **Dreaming**: a scheduled job that reads recent
sessions' event logs, distills recurring learnings, and writes them into the tenant's **memory** so
future sessions benefit. It works precisely because **events are the only source of truth** — the
job is an external client that reads the exportable event log; no core change, no session hook.

- **Reads**: `GET /v1/sessions` + `/events` (the durable log).
- **Writes**: distilled learnings into memory, by driving a memory-enabled agent that calls
  `remember()` (the `plugins/memory` tool). Future sessions auto-recall them.
- **Human review**: `DREAMER_REVIEW=1` makes it *propose* learnings (printed) instead of applying them.

## Run

```sh
npx tsx examples/dreamer/dreamer.ts            # distill + remember
DREAMER_REVIEW=1 npx tsx examples/dreamer/dreamer.ts   # propose only, for a human to approve
```

## Schedule (cron)

Prefer platform schedules when the stack is running (`/v1/schedules`, `pma schedules create …`): create a
session each night that runs this distill step, or message an existing dreamer session. External cron
still works for a one-off host job:

```
0 3 * * *  cd /path/to/rethink-managed-agent && npx tsx examples/dreamer/dreamer.ts >> /var/log/dreamer.log 2>&1
```

```bash
pma schedules create --cron "0 3 * * *" --name dreamer --action create --agent "$AGENT" --env "$ENV" --message "Run the dreamer distill for recent sessions"
```

Env: `DREAMER_API` (default `http://localhost:8080/v1`), `DREAMER_MODEL` (default `qoder/ultimate`),
`DREAMER_LOOKBACK` (recent sessions to scan, default 20), `DREAMER_MEMORY_PACKAGE` (default
`/app/plugins/memory`), `DREAMER_REVIEW=1`.
