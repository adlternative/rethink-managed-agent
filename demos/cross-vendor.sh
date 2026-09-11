#!/usr/bin/env bash
# Prove vendor-neutrality: register several OpenAI-compatible model providers, then run the SAME
# example (examples/docs-qa) against each by changing only the model string. Same compat API, same
# code, different vendor — on your own stack.
#
# Drop in whatever keys you have (any subset); the script registers only those and runs each:
#   KIMI_API_KEY=... KIMI_BASE_URL=https://api.moonshot.ai/v1 KIMI_MODEL=kimi-k2
#   GLM_API_KEY=...  GLM_BASE_URL=https://api.z.ai/api/paas/v4 GLM_MODEL=glm-5
#   OPENAI_API_KEY=... (base https://api.openai.com/v1, model gpt-4o etc.)
# The seeded local `qoder` provider is always included as a baseline.
# BYOK (auth type=key) needs PMA_SECRET_KEY set on api+runner; else register with auth-env instead.
set -uo pipefail
cd "$(dirname "$0")/.."
API="${PI_API:-http://localhost:8080}"
CLI="npx tsx src/cli/main.ts"

reg() { # id base_url key model
  local id="$1" base="$2" key="$3" model="$4"
  [ -z "$key" ] && { echo "skip $id (no key)"; return; }
  echo "registering provider $id ($base, model $model)"
  $CLI providers create "$id" --api openai-completions --base-url "$base" --auth-key "$key" --models "$model:200000" >/dev/null 2>&1 \
    || curl -fsS -X POST "$API/v1/providers" -H 'content-type: application/json' \
         -d "{\"id\":\"$id\",\"api\":\"openai-completions\",\"base_url\":\"$base\",\"auth\":{\"type\":\"key\",\"key\":\"$key\"},\"models\":[{\"id\":\"$model\",\"context_window\":200000,\"max_tokens\":8192}]}" >/dev/null
  echo "$id/$model"
}

MODELS=("qoder/ultimate")
reg kimi   "${KIMI_BASE_URL:-https://api.moonshot.ai/v1}"     "${KIMI_API_KEY:-}"   "${KIMI_MODEL:-kimi-k2}"   >/dev/null && [ -n "${KIMI_API_KEY:-}" ] && MODELS+=("kimi/${KIMI_MODEL:-kimi-k2}")
reg glm    "${GLM_BASE_URL:-https://api.z.ai/api/paas/v4}"    "${GLM_API_KEY:-}"    "${GLM_MODEL:-glm-5}"      >/dev/null && [ -n "${GLM_API_KEY:-}" ] && MODELS+=("glm/${GLM_MODEL:-glm-5}")
reg openai "${OPENAI_BASE_URL:-https://api.openai.com/v1}"    "${OPENAI_API_KEY:-}" "${OPENAI_MODEL:-gpt-4o}"  >/dev/null && [ -n "${OPENAI_API_KEY:-}" ] && MODELS+=("openai/${OPENAI_MODEL:-gpt-4o}")

echo "=== running examples/docs-qa against ${#MODELS[@]} vendor(s): ${MODELS[*]} ==="
for m in "${MODELS[@]}"; do
  echo; echo "──────── $m ────────"
  DQ_MODEL="$m" npx tsx examples/docs-qa/agent.ts "How do I connect an MCP server to an agent?" < /dev/null
done
echo; echo "Same code, same compat API, ${#MODELS[@]} vendors — swapped by one string."
