#!/bin/bash
# PostToolUse hook — run ESLint after TypeScript/JavaScript file edits
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

if ! echo "$INPUT" | jq -e . >/dev/null 2>&1; then
  exit 0
fi

# Fallback safety: never break hook processing on script errors.
trap 'exit 0' ERR

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // .toolName // ""')

# Only act on file-editing tools
case "$TOOL_NAME" in
  edit|create|editFiles|createFile|create_file|replaceStringInFile|replace_string_in_file|multiReplaceStringInFile|multi_replace_string_in_file)
    ;;
  *)
    exit 0
    ;;
esac

# Extract the file path — handle both single file and array formats
FILE_PATH=$(echo "$INPUT" | jq -r '
  .tool_input.filePath //
  .tool_input.file_path //
  .tool_input.path //
  .tool_input.file //
  (.tool_input.files // [] | first) //
  (.tool_input.replacements // [] | first | .filePath // .path // .file) //
  (.toolArgs | (fromjson? // .) | .filePath? // .file_path? // .path? // .file? // (.files? | first)? // (.replacements? | first | .filePath? // .path? // .file?)) //
  ""
')

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

# Use rg to check if it's a TypeScript/JavaScript source file
if ! echo "$FILE_PATH" | rg -q '\.(ts|tsx|js|jsx|mts|mjs)$'; then
  exit 0
fi

# Only lint files within src/ (not generated dist/ or out-webview/)
if [[ "$FILE_PATH" != src/* && "$FILE_PATH" != */src/* && "$FILE_PATH" != *\\src\\* ]]; then
  exit 0
fi

# Run ESLint on the modified file and parse results with jq
if ! command -v npx &>/dev/null; then
  exit 0
fi

LINT_JSON=$(npx eslint "$FILE_PATH" --format json 2>/dev/null || echo "[]")

if ! echo "$LINT_JSON" | jq -e . >/dev/null 2>&1; then
  exit 0
fi

# Use jq to extract error count and messages
ERROR_COUNT=$(echo "$LINT_JSON" | jq '[.[].errorCount] | add // 0')
WARN_COUNT=$(echo "$LINT_JSON"  | jq '[.[].warningCount] | add // 0')

if [[ "$ERROR_COUNT" -gt 0 || "$WARN_COUNT" -gt 0 ]]; then
  # Extract first 5 issues
  ISSUES=$(echo "$LINT_JSON" | jq -r '
    .[].messages[]
    | select(.severity >= 1)
    | "  [\(if .severity == 2 then "ERROR" else "WARN" end)] \(.line):\(.column) \(.message) (\(.ruleId // "unknown"))"
  ' | head -5)

  jq -nc \
    --argjson errors "$ERROR_COUNT" \
    --argjson warns "$WARN_COUNT" \
    --arg file "$FILE_PATH" \
    --arg issues "$ISSUES" \
    '{
      "hookSpecificOutput": {
        "hookEventName": "PostToolUse",
        "additionalContext": (
          "ESLint: \($errors) error(s), \($warns) warning(s) in \($file):\n\($issues)" +
          (if $errors > 5 then "\n  ... and more. Run: npx eslint \($file)" else "" end)
        )
      }
    }'
  exit 0
fi

exit 0
