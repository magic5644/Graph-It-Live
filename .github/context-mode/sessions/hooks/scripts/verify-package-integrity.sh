#!/bin/bash
# PostToolUse hook — verify package integrity after VSIX packaging
# Critical rule: ZERO .map files allowed in the VSIX package
# VS Code hooks: PostToolUse output uses hookSpecificOutput.additionalContext.
# See: https://code.visualstudio.com/docs/copilot/customization/hooks#_posttooluse-output

set -euo pipefail

INPUT=$(cat)

if ! command -v jq &>/dev/null; then
  exit 0
fi

if ! command -v rg &>/dev/null; then
  exit 0
fi

if ! command -v unzip &>/dev/null; then
  exit 0
fi

if ! echo "$INPUT" | jq -e . >/dev/null 2>&1; then
  exit 0
fi

# Fallback safety: never break hook processing on script errors.
trap 'exit 0' ERR

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // .toolName // ""')

# Only act after terminal commands
if [[ "$TOOL_NAME" != "runInTerminal" \
   && "$TOOL_NAME" != "run_in_terminal" \
   && "$TOOL_NAME" != "runTerminalCommand" \
   && "$TOOL_NAME" != "bash" ]]; then
  exit 0
fi

CMD=$(echo "$INPUT" | jq -r '
  .tool_input.command //
  .tool_input.cmd //
  (.toolArgs | (fromjson? // .) | .command? // .cmd?) //
  ""
')

# Detect if a packaging command was just run
if ! echo "$CMD" | rg -q 'npm\s+run\s+package|npx\s+vsce\s+package|vsce\s+package'; then
  exit 0
fi

# Wait for the .vsix to be generated
sleep 1

# Find latest VSIX at project root
VSIX=$(ls -1t *.vsix 2>/dev/null | head -1 || true)

if [[ -z "$VSIX" ]]; then
  exit 0
fi

VSIX_SIZE=$(du -sh "$VSIX" 2>/dev/null | cut -f1 || echo "?")

# Check for .map files inside the VSIX (they must NOT be present)
MAP_FILES=$(unzip -l "$VSIX" 2>/dev/null | rg '\.map$' || true)

# Check WASM files are present (they MUST be)
WASM_FILES=$(unzip -l "$VSIX" 2>/dev/null | rg '\.wasm$' | rg -o '[^ ]+\.wasm' || true)
WASM_COUNT=$(echo "$WASM_FILES" | rg -c '\.wasm' 2>/dev/null || echo "0")

if [[ -n "$MAP_FILES" ]]; then
  MAP_COUNT=$(echo "$MAP_FILES" | wc -l | tr -d ' ')
  MAP_LIST=$(echo "$MAP_FILES" | head -5 | rg -o '[^ ]+\.map')

  jq -nc \
    --arg vsix "$VSIX" \
    --arg size "$VSIX_SIZE" \
    --arg count "$MAP_COUNT" \
    --arg list "$MAP_LIST" \
    '{
      "decision": "block",
      "reason": "Package integrity failure: .map files found in VSIX",
      "hookSpecificOutput": {
        "hookEventName": "PostToolUse",
        "additionalContext": (
          "PACKAGE INTEGRITY FAILURE: \($count) .map file(s) found in \($vsix) (\($size))\n" +
          "Files:\n\($list)\n\n" +
          "FIX REQUIRED:\n" +
          "1. Add `**/*.map` at the top of .vscodeignore\n" +
          "2. Use precise node_modules inclusions (e.g., !node_modules/pkg/dist/ NOT !node_modules/pkg/**)\n" +
          "3. Re-run: npm run package && npx vsce ls | grep \\.map$ (must be empty)\n" +
          "DO NOT release this package."
        )
      }
    }'
  exit 0
fi

# WASM check
WASM_STATUS=""
if [[ "$WASM_COUNT" -lt 3 ]]; then
  WASM_STATUS="WARNING: Only $WASM_COUNT/3 expected WASM files found. Check dist/wasm/ directory."
fi

jq -nc \
  --arg vsix "$VSIX" \
  --arg size "$VSIX_SIZE" \
  --arg wasm "$WASM_COUNT" \
  --arg wasm_status "$WASM_STATUS" \
  '{
    "hookSpecificOutput": {
      "hookEventName": "PostToolUse",
      "additionalContext": (
        "Package integrity OK: \($vsix) (\($size)) - zero .map files found\n" +
        "WASM files: \($wasm)/3 included" +
        (if $wasm_status != "" then "\n\($wasm_status)" else "" end)
      )
    }
  }'

exit 0
