# CLI Layer

**Last Updated:** 2026-10-09
**Layer:** Standalone Terminal Interface (VS Code Agnostic)
**Files:** 34 in `src/cli/` (20 command modules under `src/cli/commands/`, 4 REPL modules under `src/cli/repl/`)

## Overview

`graph-it` is the standalone CLI for Graph-It-Live, published to npm separately from the VS Code extension. It shares the same `Analyzer` and `MCP` layers (no `vscode` imports anywhere in `src/cli/`).

**Entry binary:** `dist/graph-it.js` (npm `bin` field points directly at the built file; shebang & chmod +x applied by esbuild)

**Install:**
```bash
npm install -g @magic5644/graph-it-live
graph-it --help
```

**VS Code opt-in:** `graph-it install` adds the binary to the system PATH.

## Directory: `src/cli/`

### Entry Point

```
index.ts
├─→ Parses CLI arguments via node:util parseArgs
├─→ Resolves workspace root (findWorkspaceRoot)
├─→ Creates CliRuntime instance
├─→ Dispatches to command module run()
└─→ Handles errors → stderr + structured exit code
```

**Global options:**
- `--workspace, -w` — Workspace root (default: auto-detected upward from cwd)
- `--format, -f` — Output format: `text|json|toon|markdown|mermaid` (default: `text`)
- `--help, -h` — Show help
- `--version, -v` — Show version
- `--reindex` — Discard the cached index and rebuild it
- `--no-cache` — Neither read nor write the index cache (also `GRAPH_IT_NO_CACHE=1`)

### CliRuntime

```
runtime.ts
├─→ CliRuntime class — Spider lifecycle management
│   ├─→ init(workspaceRoot)  Sets up Spider, cache, workers
│   ├─→ ensureIndexed()      Triggers full index on first run / stale state
│   ├─→ dispose()            Shuts down workers cleanly
│   └─→ spider              Exposes constructed Spider instance
├─→ findWorkspaceRoot(startDir) — Walks up to find package.json / tsconfig.json
└─→ CliState — Persisted to .graph-it/state.json
```

State file (`.graph-it/state.json`):
```json
{
  "workspaceRoot": "/absolute/path",
  "lastScanTimestamp": "2026-09-15T10:00:00.000Z",
  "filesIndexed": 213
}
```

### Output Formatter

```
formatter.ts
├─→ formatOutput(data, format, command) → string
├─→ validateFormatForCommand(format, command) — Throws CliError for invalid combos
├─→ Formats:
│   ├─→ text     Human-readable with labels and bullets
│   ├─→ json     JSON.stringify (2-space indent)
│   ├─→ toon     TOON via shared/toon.ts + token savings stats
│   ├─→ markdown Markdown tables / headings
│   └─→ mermaid  Flowchart TD (trace / path commands only)
└─→ CLI_OUTPUT_FORMATS — const array of all valid formats
```

**Format × Command availability (core commands; see full command list below for all 20):**

| Format   | scan | summary | trace | explain | path | check | tool |
|----------|:----:|:-------:|:-----:|:-------:|:----:|:-----:|:----:|
| text     |  ✓   |    ✓    |   ✓   |    ✓    |  ✓   |   ✓   |  ✓  |
| json     |  ✓   |    ✓    |   ✓   |    ✓    |  ✓   |   ✓   |  ✓  |
| toon     |  ✓   |    ✓    |   ✓   |    ✓    |  ✓   |   ✓   |  ✓  |
| markdown |  ✓   |    ✓    |   ✓   |    ✓    |  ✓   |   ✓   |  ✓  |
| mermaid  |  —   |    —    |   ✓   |    —    |  ✓   |   —   |  —  |

### Error Handling

```
errors.ts
├─→ ExitCode enum
│   ├─→ SUCCESS           0
│   ├─→ GENERAL_ERROR     1
│   ├─→ AMBIGUOUS_SYMBOL  2
│   ├─→ WORKSPACE_NOT_FOUND 3
│   ├─→ UNSUPPORTED_FORMAT  4
│   └─→ SECURITY_VIOLATION  5
├─→ CliError extends Error
│   └─→ readonly exitCode: ExitCode
└─→ classifyError(unknown) → { message, exitCode }
```

### Symbol Address Parser

```
symbols.ts
├─→ SymbolRef { filePath: string; symbolName?: string }
├─→ parseSymbolRef(ref, workspaceRoot) → SymbolRef
│   ├─→ Syntax: "file.ts#FunctionName" or "file.ts#ClassName.method"
│   ├─→ Relative paths resolved against workspaceRoot
│   └─→ Throws CliError.SECURITY_VIOLATION on path traversal
└─→ resolveSymbolRef(ref, spider) → SymbolRef with validated file
```

### Opt-in Installer

```
install.ts
├─→ installCli() — Copies binary to PATH (e.g., /usr/local/bin/graph-it)
└─→ getInstallTarget() — Platform-aware install directory
```

### Supporting Modules

```
commandHelp.ts     getCommandHelp(command) — per-command `--help` text
options.ts         readIntegerOption(args, flag, range) — integer flags, usage error when invalid
versionCheck.ts    maybeNotifyCliUpdate() — new-version notice (TTY only, GRAPH_IT_DISABLE_UPDATE_CHECK=1 skips it)
errorCollector.ts  Silent logger backend: buffers parse/index errors instead of writing stderr
repl/              Ink REPL: ink/ReplInkApp.ts, sessionState.ts, terminal.ts, tokenize.ts
```

## Commands (`src/cli/commands/`)

### scan

```
commands/scan.ts
├─→ Calls runtime.ensureIndexed()
├─→ Retrieves status via executeGetIndexStatus()
└─→ Returns formatted index statistics
```

### summary

```
commands/summary.ts
├─→ Optional <file> arg: generates per-file codemap (TOON format)
├─→ Without file: workspace-level overview (file count, language breakdown)
└─→ Uses MCP executeGenerateCodemap() / executeGetIndexStatus()
```

### trace

```
commands/trace.ts
├─→ Args: <file>#<symbol>
├─→ Parses with parseSymbolRef()
├─→ Calls executeTraceFunctionExecution()
└─→ Supports mermaid output for call graphs
```

### explain

```
commands/explain.ts
├─→ Args: <file>
├─→ Calls executeAnalyzeFileLogic()
└─→ Returns intra-file call hierarchy (AST-based)
```

### path

```
commands/path.ts
├─→ Args: <file>
├─→ Calls executeCrawlDependencyGraph()
└─→ Supports mermaid flowchart output
```

### check

```
commands/check.ts
├─→ Args: [file-or-directory]
├─→ No args: calls executeScanDeadCode() for the workspace
├─→ Directory arg: calls executeScanDeadCode({ scopePath })
├─→ File arg: calls executeFindUnusedSymbols()
└─→ Reports unused exported symbols or workspace-wide dead code
```

### repl

```
commands/repl.ts
├─→ Launched when `graph-it` is invoked with no command in a TTY
├─→ Provides guided prompts for existing commands
└─→ Falls back to direct-command help when stdin is not a TTY
```

### serve

```
commands/serve.ts
├─→ Spawns MCP stdio server (dist/mcpServer.mjs)
├─→ Pipes stdin/stdout for MCP client integration
└─→ Used as: mcpServers.graph-it-live.command: "graph-it serve"
```

**MCP client configuration example (Claude Desktop):**
```json
{
  "mcpServers": {
    "graph-it-live": {
      "command": "graph-it",
      "args": ["serve"],
      "env": { "WORKSPACE_ROOT": "/path/to/project" }
    }
  }
}
```

### tool

```
commands/tool.ts
├─→ Args: <tool-name> [key=value ...]
├─→ Invokes any MCP tool by name
└─→ Example: graph-it tool get_index_status
```

### update

```
commands/update.ts
├─→ Runs npm install -g @magic5644/graph-it-live@latest
└─→ Reports current vs latest version
```

### architecture

```
commands/architecture.ts
├─→ Builds a complete workspace dependency architecture graph by aggregating per-file analysis
└─→ Backs `graph-it architecture --format toon` (broad workspace snapshot used by AIDD agents)
```

### check-dependencies

```
commands/checkDependencies.ts
├─→ Args: <file>
└─→ Checks both outgoing and incoming dependencies for a target file
```

### cycles

```
commands/cycles.ts
├─→ Args: <file>
└─→ Lists confirmed dependency cycles that include the target file
```

### path-in

```
commands/pathIn.ts
├─→ Args: <file>
└─→ Finds incoming dependencies (referencing files) for a target file
```

### context

```
commands/context.ts
├─→ Deterministic, token-bounded graph context retrieval
├─→ Flags: --mode, --scope, --depth, --max-nodes, --token-budget, --from, --to, --seeds, --relations, --cursor, --directed
└─→ Wraps MCP executeGraphContext()
```

### query

```
commands/query.ts
├─→ Args: <question>
└─→ Queries the codebase with natural language using the call graph index
```

### review-pr

```
commands/reviewPr.ts
├─→ Flags: --base <git-ref> (required), --head, --depth, --max-files
├─→ Runs ReviewGateAnalyzer against a local Git diff (workspace-validated paths)
├─→ Used by .github/actions/graph-it-review-gate composite Action
└─→ Reports risk score, per-symbol evidence, and capability limitations
```

### stats

```
commands/stats.ts
└─→ Reports session TOON encoding size vs JSON equivalent (token savings)
```

### wiki

```
commands/wiki.ts
└─→ Generates a navigable Markdown wiki from the call graph (backs generate_wiki MCP tool)
```

### export-html

```
commands/ExportHtmlCommand.ts
└─→ Standalone HTML graph export (uses analyzer/export/HtmlExporter + NodeMetadataBuilder)
```

## Critical Architecture Rules

1. **NO `vscode` imports** anywhere in `src/cli/` — same rule as `analyzer/` and `mcp/`
2. **stdout is data-only** — all logs redirected to stderr via `StderrLogger`
3. **Path security** — `parseSymbolRef` rejects paths containing `..` above workspace root
4. **Workspace detection** — walks up from cwd looking for `package.json` or `tsconfig.json`
5. **Exit codes** — always use `ExitCode` enum; never `process.exit(1)` directly

## Relationship to Other Layers

```
CLI Layer
  ├─→ Uses: src/analyzer/ (Spider, SpiderBuilder, AstWorkerHost, ...)
  ├─→ Uses: src/mcp/tools/ (executeGetIndexStatus, executeTraceFunctionExecution, ...)
  ├─→ Uses: src/shared/ (types, toon, logger, path)
  └─→ Independent of: src/extension/, src/webview/
```
