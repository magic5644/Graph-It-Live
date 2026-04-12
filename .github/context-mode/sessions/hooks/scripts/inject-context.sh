#!/bin/bash
# SessionStart hook — inject project context into the agent conversation
# VS Code hooks: SessionStart output supports hookSpecificOutput.additionalContext
# See: https://code.visualstudio.com/docs/copilot/customization/hooks#_sessionstart-output

set -euo pipefail

emit_continue() {
  echo '{"continue": true}'
  exit 0
}

if ! command -v jq &>/dev/null; then
  emit_continue
fi

# Fallback safety: never break hook processing on script errors.
trap 'emit_continue' ERR

# Extract only the needed fields from package.json
NAME=$(jq -r '.name // "unknown"' package.json 2>/dev/null || echo "unknown")
VERSION=$(jq -r '.version // "0.0.0"' package.json 2>/dev/null || echo "0.0.0")
SCRIPTS=$(jq -r '.scripts | keys | join(", ")' package.json 2>/dev/null || echo "none")

# Git context
BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
NODE_VERSION=$(node --version 2>/dev/null || echo "unknown")
ENGINES=$(jq -r '.engines // {} | to_entries | map("\(.key): \(.value)") | join(", ")' package.json 2>/dev/null || echo "")

# Check if better-tools are available (agent tools only: jq, yq, rg, fd)
TOOLS_AVAILABLE=()
command -v jq  &>/dev/null && TOOLS_AVAILABLE+=("jq")
command -v yq  &>/dev/null && TOOLS_AVAILABLE+=("yq")
command -v rg  &>/dev/null && TOOLS_AVAILABLE+=("rg")
command -v fd  &>/dev/null && TOOLS_AVAILABLE+=("fd")
command -v http &>/dev/null && TOOLS_AVAILABLE+=("http")
TOOLS_STR="${TOOLS_AVAILABLE[*]:-none}"

# Count source files using fd
TS_COUNT=$(fd -e ts -e tsx . src/ 2>/dev/null | wc -l | tr -d ' ' || echo "?")
TEST_COUNT=$(fd -e test.ts . tests/ 2>/dev/null | wc -l | tr -d ' ' || echo "?")

jq -nc \
  --arg name "$NAME" \
  --arg version "$VERSION" \
  --arg branch "$BRANCH" \
  --arg node "$NODE_VERSION" \
  --arg scripts "$SCRIPTS" \
  --arg engines "$ENGINES" \
  --arg tools "$TOOLS_STR" \
  --arg ts_count "$TS_COUNT" \
  --arg test_count "$TEST_COUNT" \
  '{
    "hookSpecificOutput": {
      "hookEventName": "SessionStart",
      "additionalContext": (
        "=== Graph-It-Live Project Context ===\n" +
        "Project: \($name) v\($version) | Branch: \($branch) | Node: \($node)\n" +
        "Source files: \($ts_count) TypeScript | Tests: \($test_count)\n" +
        "Available scripts: \($scripts)\n" +
        (if $engines != "" then "Engine requirements: \($engines)\n" else "" end) +
        "\n=== Better-Tools Available: " + $tools + " ===\n" +
        "RULES:\n" +
        "- Use `jq` instead of Read for JSON files (-95% tokens)\n" +
        "- Use `yq` instead of Read for YAML/TOML files (-95% tokens)\n" +
        "- Use `rg` instead of grep (5-10x faster, respects .gitignore)\n" +
        "- Use `fd` instead of find (intuitive, respects .gitignore)\n" +
        "- NEVER use lazygit/fzf/bat/zoxide in automated scripts (TUI only)\n" +
        "\n=== Package Integrity Rules ===\n" +
        "After `npm run package`: verify with `npx vsce ls | grep \\.map\\$` - must be EMPTY"
      )
    }
  }'
