#!/bin/bash
# PreToolUse hook — block dangerous shell commands before execution
# VS Code hooks: PreToolUse output uses hookSpecificOutput with permissionDecision.
# See: https://code.visualstudio.com/docs/copilot/customization/hooks#_pretooluse-output

set -euo pipefail

INPUT=$(cat)

if ! command -v jq &>/dev/null; then
  exit 0
fi

if ! command -v rg &>/dev/null; then
  exit 0
fi

if ! command -v fd &>/dev/null; then
  exit 0
fi

if ! echo "$INPUT" | jq -e . >/dev/null 2>&1; then
  exit 0
fi

# Fallback safety: never break hook processing on script errors.
trap 'exit 0' ERR

# Extract tool name for both VS Code and Claude Code hook payloads.
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // .toolName // ""')

# Only intercept terminal/shell execution tools
if [[ "$TOOL_NAME" != "runInTerminal" \
   && "$TOOL_NAME" != "run_in_terminal" \
   && "$TOOL_NAME" != "runTerminalCommand" \
   && "$TOOL_NAME" != "bash" \
   && "$TOOL_NAME" != "executeCommand" ]]; then
  exit 0
fi

CMD=$(echo "$INPUT" | jq -r '
  .tool_input.command //
  .tool_input.cmd //
  (.toolArgs | (fromjson? // .) | .command? // .cmd?) //
  ""
')

if [[ -z "$CMD" ]]; then
  exit 0
fi

# --- BLOCK: Destructive filesystem operations ---
if echo "$CMD" | rg -q 'rm\s+-[a-zA-Z]*r[a-zA-Z]*f\s+/'; then
  jq -nc '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": "rm -rf on absolute paths is not allowed. Use a relative path or delete files individually.",
      "additionalContext": "If you need to clean build artifacts, use: rm -rf ./dist or npm run clean"
    }
  }'
  exit 0
fi

# --- BLOCK: Dropping root-level directories ---
if echo "$CMD" | rg -q 'rm\s+-[a-zA-Z]*r[a-zA-Z]*f\s+\.(git|github|src|tests|node_modules)\b'; then
  jq -nc '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": "Deleting .git, .github, src, tests, or node_modules is not allowed."
    }
  }'
  exit 0
fi

# --- BLOCK: SQL destructive DDL ---
if echo "$CMD" | rg -iq 'DROP\s+(TABLE|DATABASE|SCHEMA)\s'; then
  jq -nc '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": "DROP TABLE/DATABASE/SCHEMA commands require explicit human approval."
    }
  }'
  exit 0
fi

# --- ASK: git push --force ---
if echo "$CMD" | rg -q 'git\s+push\s+.*--force|git\s+push\s+.*-f\b'; then
  jq -nc '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "ask",
      "permissionDecisionReason": "Force-pushing can rewrite remote history. Are you sure?"
    }
  }'
  exit 0
fi

# --- ASK: packaging after recent .vscodeignore change ---
if echo "$CMD" | rg -q 'npm\s+run\s+package|npx\s+vsce\s+package'; then
  if fd -t f '\.vscodeignore' . --changed-within 10min 2>/dev/null | rg -q '.'; then
    jq -nc '{
      "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "ask",
        "permissionDecisionReason": ".vscodeignore was recently modified. After packaging, verify: npx vsce ls | grep .map$ (must return empty)"
      }
    }'
    exit 0
  fi
fi

# All checks passed — no output means allow
exit 0
