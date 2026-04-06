#!/usr/bin/env bash
# E2E smoke test: pack → install globally → run all tools → uninstall
# Usage: bash scripts/test-cli-e2e.sh [workspace_path]
set -euo pipefail

WORKSPACE=$(cd "${1:-$(pwd)}" && pwd)   # absolute path
ENTRY_FILE="$WORKSPACE/src/extension/extension.ts"
SAMPLE_FILE="$WORKSPACE/src/cli/index.ts"
SAMPLE_FILE_REL="src/cli/index.ts"      # relative (for CLI commands)
ENTRY_FILE_REL="src/extension/extension.ts"
SYMBOL="main"

# --workspace=VAL (equals sign) keeps the value as a single --flag token in raw
# argv, so rawCommandArgs detection in index.ts works correctly.
W="--workspace=$WORKSPACE"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
PASS=0; FAIL=0

pass() { echo -e "${GREEN}✔ $1${NC}"; PASS=$((PASS+1)); }
fail() { echo -e "${RED}✗ $1${NC}"; FAIL=$((FAIL+1)); }
section() { echo -e "\n${YELLOW}── $1 ──${NC}"; }

# ── 1. Build + pack ──────────────────────────────────────────────────────────
section "Build & pack"
npm run build:cli -- --production
TGZ=$(npm pack --silent)
echo "  Packed: $TGZ"

# ── 2. Install ───────────────────────────────────────────────────────────────
section "Install from tgz"
npm install -g "./$TGZ"
BINARY=$(which graph-it || echo "")
[[ -n "$BINARY" ]] && pass "graph-it found at $BINARY" || fail "graph-it not in PATH"

# ── 3. Basic commands ────────────────────────────────────────────────────────
section "Basic commands"
graph-it --version   && pass "--version"       || fail "--version"
graph-it --help | grep -q "Commands:"          && pass "--help"         || fail "--help"
graph-it tool --list | grep -q "analyze_dependencies" && pass "tool --list" || fail "tool --list"
graph-it tool --help | grep -q "Usage:"        && pass "tool --help"   || fail "tool --help"
graph-it scan --help | grep -q "scan"          && pass "scan --help"   || fail "scan --help"

# ── 4. Index tools ───────────────────────────────────────────────────────────
section "Index"
# tool args use --key=value (positional after tool name, parsed by parseToolArgs)
graph-it "$W" tool get_index_status        && pass "get_index_status"  || fail "get_index_status"
graph-it "$W" tool rebuild_index           && pass "rebuild_index"     || fail "rebuild_index"
graph-it "$W" tool invalidate_files "--filePaths=[\"$SAMPLE_FILE\"]"   && pass "invalidate_files" || fail "invalidate_files"

# ── 5. File-level tools ──────────────────────────────────────────────────────
section "File-level"
graph-it "$W" tool analyze_dependencies    "--filePath=$SAMPLE_FILE"                               && pass "analyze_dependencies"    || fail "analyze_dependencies"
graph-it "$W" tool crawl_dependency_graph  "--entryFile=$ENTRY_FILE"                               && pass "crawl_dependency_graph"  || fail "crawl_dependency_graph"
graph-it "$W" tool find_referencing_files  "--targetPath=$SAMPLE_FILE"                             && pass "find_referencing_files"  || fail "find_referencing_files"
graph-it "$W" tool expand_node             "--filePath=$SAMPLE_FILE" "--knownPaths=[]"             && pass "expand_node"             || fail "expand_node"
graph-it "$W" tool parse_imports           "--filePath=$SAMPLE_FILE"                               && pass "parse_imports"           || fail "parse_imports"
graph-it "$W" tool verify_dependency_usage "--sourceFile=$SAMPLE_FILE" "--targetFile=$ENTRY_FILE" && pass "verify_dependency_usage" || fail "verify_dependency_usage"
graph-it "$W" tool resolve_module_path     "--fromFile=$SAMPLE_FILE" "--moduleSpecifier=./commandHelp" && pass "resolve_module_path" || fail "resolve_module_path"
graph-it "$W" tool analyze_file_logic      "--filePath=$SAMPLE_FILE"                               && pass "analyze_file_logic"      || fail "analyze_file_logic"
graph-it "$W" tool generate_codemap        "--filePath=$SAMPLE_FILE"                               && pass "generate_codemap"        || fail "generate_codemap"

# ── 6. Symbol-level tools ────────────────────────────────────────────────────
section "Symbol-level"
graph-it "$W" tool get_symbol_graph        "--filePath=$SAMPLE_FILE"                               && pass "get_symbol_graph"        || fail "get_symbol_graph"
graph-it "$W" tool find_unused_symbols     "--filePath=$SAMPLE_FILE"                               && pass "find_unused_symbols"     || fail "find_unused_symbols"
graph-it "$W" tool get_symbol_dependents   "--filePath=$SAMPLE_FILE" "--symbolName=$SYMBOL"        && pass "get_symbol_dependents"   || fail "get_symbol_dependents"
graph-it "$W" tool trace_function_execution "--filePath=$SAMPLE_FILE" "--symbolName=$SYMBOL"       && pass "trace_function_execution" || fail "trace_function_execution"
graph-it "$W" tool get_symbol_callers      "--filePath=$SAMPLE_FILE" "--symbolName=$SYMBOL"        && pass "get_symbol_callers"      || fail "get_symbol_callers"

# ── 7. Impact & breaking changes ─────────────────────────────────────────────
section "Impact & breaking changes"
graph-it "$W" tool get_impact_analysis     "--filePath=$SAMPLE_FILE" "--symbolName=$SYMBOL"        && pass "get_impact_analysis"     || fail "get_impact_analysis"
# analyze_breaking_changes requires oldContent — pass current file content as baseline (no diff expected)
OLD=$(cat "$SAMPLE_FILE" | head -30 | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/' | tr -d '\n' | sed 's/\\n$//')
graph-it "$W" tool analyze_breaking_changes --args "{\"filePath\":\"$SAMPLE_FILE\",\"oldContent\":\"$OLD\"}" && pass "analyze_breaking_changes" || fail "analyze_breaking_changes"

# ── 8. Call graph ─────────────────────────────────────────────────────────────
section "Call graph"
graph-it "$W" tool query_call_graph        "--filePath=$SAMPLE_FILE" "--symbolName=$SYMBOL"        && pass "query_call_graph"        || fail "query_call_graph"

# ── 9. High-level CLI commands (no -w: auto-detected from CWD = workspace) ───
# Note: global flags with a space-separated value (-w VAL) end up in rawCommandArgs
# and get misinterpreted as the file pos-arg.  Omit -w; rely on CWD detection.
section "CLI commands"
graph-it scan                              && pass "scan"            || fail "scan"
graph-it summary                           && pass "summary"         || fail "summary"
graph-it summary "$SAMPLE_FILE_REL"        && pass "summary [file]"  || fail "summary [file]"
graph-it explain "$SAMPLE_FILE_REL"        && pass "explain"         || fail "explain"
graph-it path "$ENTRY_FILE_REL"            && pass "path"            || fail "path"
graph-it check "$SAMPLE_FILE_REL"          && pass "check"           || fail "check"
graph-it trace "$SAMPLE_FILE_REL#$SYMBOL"  && pass "trace"           || fail "trace"

# ── 10. Uninstall ─────────────────────────────────────────────────────────────
section "Cleanup"
npm uninstall -g graph-it-live && pass "uninstalled" || fail "uninstall"
rm -f "$TGZ" && pass "tgz removed"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}Passed: $PASS${NC}  ${RED}Failed: $FAIL${NC}"
[[ $FAIL -eq 0 ]] && echo -e "${GREEN}All tests passed ✔${NC}" && exit 0 || exit 1
