#!/bin/bash
# UserPromptSubmit hook — audit user prompts for token-inefficiency patterns
# VS Code hooks: UserPromptSubmit uses common output format only (no hookSpecificOutput).
# We log hints to stderr for debugging visibility.
# See: https://code.visualstudio.com/docs/copilot/customization/hooks#_userpromptsubmit

set -euo pipefail

INPUT=$(cat)

if ! command -v jq &>/dev/null; then
  exit 0
fi

if ! command -v rg &>/dev/null; then
  exit 0
fi

if ! echo "$INPUT" | jq -e . >/dev/null 2>&1; then
  exit 0
fi

# Fallback safety: never break hook processing on script errors.
trap 'exit 0' ERR

PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""')

if [[ -z "$PROMPT" ]]; then
  exit 0
fi

# Detect prompts that will likely cause full-file reads of JSON/YAML
if echo "$PROMPT" | rg -qi '(read|show|open|display|check|look at)\s+(the\s+)?(package\.json|tsconfig|\.eslintrc|docker-compose)'; then
  echo "Tip: For JSON/YAML config files, use jq/yq instead of reading the full file (-95% tokens)" >&2
fi

# Detect packaging prompts
if echo "$PROMPT" | rg -qi '(package|build|release|vsix|publish)'; then
  echo "Package rule: after packaging, ALWAYS verify npx vsce ls | grep .map\$ returns empty" >&2
fi

exit 0
