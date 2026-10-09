#!/bin/bash
# Deterministic AIDD gate check, run by /bugfix and /aidd-feature before QA/review agents.
# Exit 0 = PASS, exit 1 = BLOCK (return to the developer without invoking an agent).

set -u
cd "$(dirname "$0")/.." || exit 1

# Real import/export/require/dynamic import of vscode; comment lines quoting the rule are ignored.
VSCODE_IMPORT="^\s*(import|export)\b.*['\"]vscode['\"]|(require|import)\(\s*['\"]vscode['\"]"

if violations=$(grep -rnE "$VSCODE_IMPORT" src/analyzer src/mcp); then
  echo "BLOCK: vscode import in a Node.js-only layer (src/analyzer, src/mcp):"
  echo "$violations"
  exit 1
fi

echo "PASS: layer isolation intact (no vscode import in src/analyzer, src/mcp)"
