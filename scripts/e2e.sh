#!/usr/bin/env bash
# End-to-end smoke test: requires api + runner running (and postgres/redis).
set -euo pipefail
cd "$(dirname "$0")/.."
export PI_API="${PI_API:-http://localhost:8080}"
CLI="npx tsx src/cli/main.ts"

echo "waiting for $PI_API/healthz ..."
for i in $(seq 1 60); do
  curl -fsS "$PI_API/healthz" >/dev/null 2>&1 && break
  sleep 1
  [ "$i" = 60 ] && { echo "api not healthy"; exit 1; }
done

id() { grep -o '"id": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/'; }

AGENT=$($CLI agent create --name e2e --provider qoder --model ${E2E_MODEL:-kmodel} | id)
ENV=$($CLI env create --name e2e --provider local | id)
SESSION=$($CLI session create --agent "$AGENT" --env "$ENV" | id)
echo "agent=$AGENT env=$ENV session=$SESSION"

# GNU timeout is absent on stock macOS (brew install coreutils gives gtimeout); fall back to no timeout.
if command -v timeout >/dev/null; then TIMEOUT="timeout ${E2E_TIMEOUT:-300}"
elif command -v gtimeout >/dev/null; then TIMEOUT="gtimeout ${E2E_TIMEOUT:-300}"
else TIMEOUT=""; fi

$TIMEOUT $CLI send "$SESSION" "Create a file hello.txt containing 'hi' then cat it" --wait

EVENTS=$($CLI events "$SESSION")
FAIL=0
echo "$EVENTS" | tr -d ' \n' | grep -Eq '"type":"agent.tool_use"[^}]*"name":"(bash|write)"' \
  || { echo "FAIL: no agent.tool_use with name bash/write"; FAIL=1; }
echo "$EVENTS" | tr -d ' \n' | grep -q '"type":"session.status_idle"' \
  || { echo "FAIL: no session.status_idle"; FAIL=1; }
[ "$FAIL" = 0 ] && echo "E2E OK"
exit $FAIL
