#!/usr/bin/env bash
set -euo pipefail

if command -v graph-it >/dev/null 2>&1; then
  exec graph-it update
fi

exec npx -y @magic5644/graph-it-live@latest update
