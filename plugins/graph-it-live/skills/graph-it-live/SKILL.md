---
name: graph-it-live
description: |
  Analyze code dependencies, call graphs, and architecture using the graph-it CLI. Use this skill
  whenever the user wants to understand how their code is connected — even if they don't say
  "dependency graph" explicitly. Trigger for: "what calls this function", "who uses this class",
  "is it safe to delete X", "what breaks if I change Y", "show me the architecture", "trace the
  execution from main", "find circular imports", "give me an overview of this module", "what imports
  this file", "impact analysis", "refactoring safety", "review this PR", "review this diff",
  "is this change risky", breaking changes, unused exports, dead code detection, codemap, file logic,
  module resolution, graph-it, dependency graph, reverse dependencies.
argument-hint: 'What do you want to analyze in your codebase?'
context: fork
---

# Graph-It-Live

AI-first dependency intelligence CLI for codebase analysis.
Analyze dependencies, call graphs, symbols, impact, and architecture from any agent-compatible IDE or CLI.

## When to Use

- Analyze file dependencies and imports
- Trace function execution across files
- Find all callers of a symbol (function, class, method)
- Detect breaking changes before refactoring
- Find unused exports / dead code
- Generate a codemap (structural overview) of any file
- Analyze intra-file call hierarchy and logic flow
- Crawl the full dependency tree from an entry point
- Find all files that import a given file (reverse lookup)
- Detect circular dependencies / cycles
- Check impact of changing a function signature
- Get a workspace architecture overview
- Review a Git diff for breaking signatures, impact, cycles, and test candidates

## Quick Start — Installation

**Requires Node.js v22+.**

```bash
# Install globally
npm install -g @magic5644/graph-it-live

# Or run without installing
npx @magic5644/graph-it-live <command>
```

After global install, `graph-it` is available on PATH. Verify:

```bash
graph-it --version
```

Check updates:

```bash
graph-it update
```

## Supported Languages

TypeScript, JavaScript, Python, Rust, C#, Go, Java, Vue, Svelte, GraphQL.

## CLI Commands Reference

### First Full Codebase Pass (Agent Bootstrap)

Use this workflow at the start of broad tasks (feature work, audits, refactors, onboarding):

```bash
# 1) Build/refresh the index
graph-it scan

# 2) Generate the agent-optimized global map
graph-it architecture --format toon
```

This TOON result is the **primary context** for agents: `nodes`, `edges`, `failedFiles`, `nodeCount`, `edgeCount`.

Only after that, run targeted analysis:

```bash
graph-it tool generate_codemap --filePath=/abs/path/to/file.ts
graph-it tool query_call_graph --filePath=/abs/path/to/file.ts --symbolName=mySymbol --depth=3
graph-it tool analyze_file_logic --filePath=/abs/path/to/file.ts
```

For open-ended architecture questions, use natural language query:

```bash
graph-it query "how does authentication flow through this project"
```

If the global graph is too large:

```bash
graph-it architecture --maxFiles 300 --format toon
```

Visual option for humans (not for LLM context):

```bash
graph-it architecture --format mermaid
```

### Index the Workspace

**Run `scan` before analysis commands** to build the dependency index. Most analysis commands depend on it.
The `review-pr` command is the exception: it indexes automatically, so do not run a
separate `scan` first unless you need to refresh the index for another command.

```bash
graph-it scan
```

Re-run after significant file changes to refresh the index.

### Workspace Overview

```bash
graph-it summary                   # Full workspace overview
graph-it summary src/api.ts        # Per-file codemap
```

The per-file codemap returns: exports, internals, dependencies, dependents, call flow, cycles.

### Trace Execution Flow

Trace the complete call chain starting from a function:

```bash
graph-it trace src/index.ts#main
graph-it trace src/auth.ts#validateToken
```

Format: `<filePath>#<functionName>`. Use absolute or relative paths.

### Analyze File Logic

Show the intra-file call hierarchy — which functions call which, in what order:

```bash
graph-it explain src/server.ts
```

Returns entry points, call tree, and internal cycles.

### Dependency Graph

Crawl the full dependency tree from an entry file:

```bash
graph-it path src/index.ts
```

Shows all transitive imports and detects circular dependencies.

### Find Unused Exports

Detect dead code — exported symbols that no other file imports:

```bash
graph-it check src/api.ts
```

Workspace-wide dead code scan:

```bash
graph-it check
```

Generate a markdown wiki from call graph relationships:

```bash
graph-it wiki
```

### Review a Pull Request or Diff

Use the dedicated command for deterministic local diff analysis. It requires a Git base ref and
indexes automatically:

```bash
graph-it review-pr --base origin/main --format markdown
graph-it review-pr --base origin/main --head feature/my-change --depth 3 --max-files 200 --format toon
```

Read `risk`, `score`, `limitations`, and `isPartial` before making a merge recommendation:

- `low`, `medium`, `high`, `critical` classify the highest-risk changed symbol.
- `isPartial: true` means file, parser, or impact-depth limits prevented a complete result.
- No breaking signature does **not** prove that a behavioral change is safe; inspect tests and affected flows.

Use the **pr-review** skill for the full review workflow and GitHub Actions gate.

### Output Formats

All commands support `--format`:

| Format     | Best for                                     |
|------------|----------------------------------------------|
| `text`     | Quick human reading in the terminal (default) |
| `json`     | Programmatic processing, scripts             |
| `toon`     | AI consumption — same data as JSON but 30–60% fewer tokens |
| `markdown` | Embedding structured output in a document   |
| `mermaid`  | **Visual diagrams shown to a human** — renders as a flowchart in VS Code, GitHub, Obsidian, or any Markdown preview. Only supported by `trace` and `path`. |

**Choosing the right format:**
- Processing output inside an agent or script → `--format toon`
- Showing a call graph or dependency tree to a human in chat or a preview pane → `--format mermaid`
- All other programmatic use → `--format json`

```bash
graph-it summary src/api.ts --format toon          # AI reads it
graph-it trace src/index.ts#main --format mermaid  # human sees the diagram
graph-it path src/index.ts --format mermaid        # dependency tree as flowchart
```

## Advanced: MCP Tool Invocation

`graph-it tool` can invoke **21 analysis tools** directly from CLI.
Server-management tool `set_workspace` is MCP-server only and intentionally excluded from `graph-it tool`.

```bash
graph-it tool --list                    # List all available tools
graph-it tool <tool_name> [--params]    # Invoke a specific tool
```

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `analyze_dependencies` | Direct imports and exports of a file |
| `crawl_dependency_graph` | Full dependency tree from an entry file |
| `find_referencing_files` | All files that import a given file (reverse lookup) |
| `expand_node` | Expand a node to discover dependencies beyond known paths |
| `parse_imports` | Parse raw import statements without path resolution |
| `verify_dependency_usage` | Check whether a specific import is actually used |
| `resolve_module_path` | Resolve a module specifier to an absolute file path |
| `get_symbol_graph` | Symbol-level dependencies within a file |
| `find_unused_symbols` | Dead code detection — unused exported symbols |
| `get_symbol_dependents` | All symbols that depend on a specific symbol |
| `trace_function_execution` | Full recursive call chain from a function |
| `get_symbol_callers` | All callers of a symbol (O(1) instant lookup) |
| `analyze_breaking_changes` | Detect breaking changes when modifying function signatures |
| `get_impact_analysis` | Full impact: callers + breaking changes combined |
| `get_index_status` | Current state of the dependency index |
| `invalidate_files` | Flush cache for specific files after modifications |
| `rebuild_index` | Rebuild the entire dependency index from scratch |
| `analyze_file_logic` | Intra-file call hierarchy and code flow |
| `generate_codemap` | Comprehensive structural overview of any source file |
| `query_call_graph` | BFS callers/callees via the SQLite call graph index |
| `scan_dead_code` | Workspace-wide dead code scan across all files |

> `query_natural_language` and `generate_wiki` are available as dedicated CLI commands (`graph-it query`, `graph-it wiki`) and as MCP server tools, but **not** in `graph-it tool --list`.
> Run `graph-it tool --list` for the installed CLI's authoritative tool inventory; releases can add tools over time.

### Tool Invocation Examples

```bash
# Analyze a single file's dependencies
graph-it tool analyze_dependencies --filePath=/abs/path/to/file.ts

# Find all files importing a specific file
graph-it tool find_referencing_files --targetPath=/abs/path/to/file.ts

# Get all callers of a symbol
graph-it tool get_symbol_callers --filePath=/abs/path/to/file.ts --symbolName=myFunction

# Full impact analysis
graph-it tool get_impact_analysis --filePath=/abs/path/to/file.ts --symbolName=myFunction

# Detect breaking changes (use --args JSON for large content payloads)
graph-it tool --args '{"filePath":"/abs/path/to/file.ts","symbolName":"myFunction","oldContent":"...old source...","newContent":"...new source..."}' analyze_breaking_changes

# Generate codemap
graph-it tool generate_codemap --filePath=/abs/path/to/file.ts

# Query call graph (BFS) — requires filePath; depth param is 'depth', NOT 'maxDepth'
graph-it tool query_call_graph --filePath=/abs/path/server.ts --symbolName=handleRequest --depth=3

# Workspace-wide dead code scan (across all files, unlike find_unused_symbols which is per-file)
graph-it tool scan_dead_code

# Natural-language architecture question
graph-it query "what calls the MCP worker and how"

# Generate wiki docs from call graph
graph-it wiki --output docs/wiki
```

**Important:** Tool `--filePath` arguments require **absolute paths**.

## Critical Rules (NEVER)

- **NEVER** call analysis tool commands without running `graph-it scan` first — all tools depend on the index. `review-pr` is the sole exception because it indexes automatically.
- **NEVER** use relative paths with `--filePath` — all file args must be absolute paths
- **NEVER** confuse `find_unused_symbols` (per-file) with `scan_dead_code` (workspace-wide); use `scan_dead_code` when you need a project-wide dead code report
- **NEVER** use `--maxDepth` with `query_call_graph` — the correct parameter is `--depth`
- **NEVER** invoke `set_workspace` from the CLI — it is MCP server only; the CLI uses `WORKSPACE_ROOT` env var or `graph-it scan` from the project root
- **NEVER** use `--format json` for large dependency graphs sent to an LLM — use `--format toon` to save 30-60% tokens
- **NEVER** pass `--filePath` to `find_referencing_files`; the expected parameter is `--targetPath`
- **NEVER** call `analyze_breaking_changes` with `--newFilePath`; it expects `oldContent` / `newContent`

## MCP Server Mode

Launch as an MCP server for AI client integration (no VS Code required):

```bash
graph-it serve
```

MCP server currently exposes **24 tools**:
- 21 analysis tools from `graph-it tool --list`
- `set_workspace` (server management)
- `query_natural_language`
- `generate_wiki`

### MCP Client Configuration

**VS Code / Cursor** (`.vscode/mcp.json` or `.cursor/mcp.json`):

```json
{
  "servers": {
    "graph-it-live": {
      "type": "stdio",
      "command": "graph-it",
      "args": ["serve"],
      "env": { "WORKSPACE_ROOT": "${workspaceFolder}" }
    }
  }
}
```

**Claude Desktop** (`~/.config/claude/claude_desktop_config.json`):

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

**Claude Code CLI:**

```bash
claude mcp add graph-it -- graph-it serve
```

**Windsurf** (`~/.codeium/windsurf/mcp_config.json`):

```json
{
  "mcpServers": {
    "graph-it-live": {
      "command": "graph-it",
      "args": ["serve"],
      "env": { "WORKSPACE_ROOT": "${workspaceFolder}" }
    }
  }
}
```

## VS Code Extension (Alternative)

Graph-It-Live is also a VS Code extension with native LM Tools for Copilot Agent mode (no MCP setup needed).

Install from Marketplace: search "Graph-It-Live" in Extensions (`Ctrl+Shift+X`).

Enable MCP server in extension: set `graph-it-live.enableMcpServer` to `true` in VS Code settings.

## Common Workflows

**"What breaks if I change this function?"**

```bash
graph-it scan
graph-it tool get_impact_analysis --filePath=/abs/path/src/auth/index.ts --symbolName=myFunction
```

**"Give me an overview of this module"**

```bash
# Outgoing: what this file imports and calls
graph-it summary src/auth/index.ts --format toon

# Incoming: who depends on this file
graph-it tool find_referencing_files --targetPath=/abs/path/src/auth/index.ts
```

Always check both directions: knowing what a module calls (outgoing) and who calls it (incoming) gives the full picture of its role and blast radius.

**"Find dead code in my project"**

```bash
# Outgoing: symbols this file exports that nobody imports
graph-it check src/utils.ts
graph-it tool find_unused_symbols --filePath=/abs/path/src/utils.ts

# Incoming: confirm the file itself is not orphaned (nothing imports it)
graph-it tool find_referencing_files --targetPath=/abs/path/src/utils.ts
```

Both directions are needed: a file can export symbols that appear used internally while still being completely unreachable from the rest of the project.

**"Trace the execution from main()"**

```bash
graph-it trace src/index.ts#main --format mermaid
```

**"Are there circular dependencies?"**

```bash
graph-it path src/index.ts
```

Cycles are auto-detected and reported.

**"Who calls this function across the project?"**

```bash
graph-it tool get_symbol_callers --filePath=/abs/path/src/utils/formatDate.ts --symbolName=formatDate
```

**"Answer architecture questions in natural language"**

```bash
graph-it query "how does the dependency index get rebuilt"
```

**"Generate a wiki for onboarding"**

```bash
graph-it wiki --output wiki
```

**"Review a pull request before merge"**

```bash
graph-it review-pr --base origin/main --format markdown
```

Escalate every high/critical symbol with `get_impact_analysis` or `get_symbol_callers`. Treat any
reported limitation as a manual-review item.

## Update

```bash
graph-it update
```

## Related Skills

- **dead-code-hunter** — uses Graph-It-Live under the hood to produce a full project-wide dead code deletion plan with safety rankings. Use it when you want to delete, not just inspect.
- **onboarding-express** — runs a structured Graph-It-Live tour of any codebase for a new developer: entry points, business logic, most complex module, and critical path diagram.
- **pr-review** — reviews a Git diff locally or in GitHub Actions, then turns Graph-It-Live evidence into merge-ready findings.
- **skill-manager** — manage installed skills interactively (list/uninstall). Useful when curating or cleaning a local skill stack.
