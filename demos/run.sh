#!/usr/bin/env bash
# Run every architecture demo in order. Needs only tsx (npm i) and, for the docker demos,
# a running docker daemon — no Postgres/redis/minio, no API/runner. Each demo uses the real
# SandboxManager and real providers with an in-memory lease store.
set -uo pipefail
cd "$(dirname "$0")/.."
DEMOS=(01-nn-session-sandbox 02-sandbox-disposable 03-shared-container 04-provider-swap 05-pause-resume)
[ "${1:-}" ] && DEMOS=("$1")
fail=0
for d in "${DEMOS[@]}"; do
  npx tsx "demos/$d.ts" || fail=1
done
# best-effort cleanup of any demo containers
docker ps -aq --filter label=pi.sandbox=1 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true
[ "$fail" = 0 ] && echo "ALL DEMOS OK" || { echo "SOME DEMOS FAILED"; exit 1; }
