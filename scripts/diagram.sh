#!/usr/bin/env bash
# Render docs/architecture.archify.json -> docs/architecture.html (needs the archify skill).
set -euo pipefail
cd "$(dirname "$0")/.."
ARCHIFY="${ARCHIFY:-$HOME/.claude/skills/archify/bin/archify.mjs}"
node "$ARCHIFY" deliver architecture docs/architecture.archify.json docs/architecture.html --quality showcase
[ "${1:-}" = "--open" ] && open docs/architecture.html || true
