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

Do not install the CLI automatically. Update only under the confirmation policy below. If it is
unavailable, offer the documented install options and wait for an explicit request.

## CLI and Capability Discovery

At the first activation of any Graph-It skill in a session, check `graph-it --version` when the CLI
and terminal are available. Prefer the CLI when its executable and a terminal are available; use
MCP only as fallback when the CLI is unavailable or unsuitable and the connected host advertises an
equivalent tool and schema. Use only the CLI's existing newer-version notice, if provided; do not
poll npm or add a separate update check. Share the version, inventory, and update decision across
Graph-It skills in the same session so discovery and any prompt happen at most once. Discover tools
with `graph-it tool --list`; consult `graph-it --help` or command help only when needed. Reuse that
inventory until the CLI/version, MCP server, or workspace context changes, or a requested tool is
unknown. Treat examples below as illustrative, not as a fixed capability list.

If the CLI reports a newer version, ask for explicit positive confirmation before running
`graph-it update` in interactive use. Silence, timeout, refusal, non-TTY execution, and generic
Agent mode are not consent. When automatic mode is explicitly enabled and pre-authorized, default
the update decision to yes and run `graph-it update` without another prompt. On success, refresh
`graph-it --version` and `graph-it tool --list`;
invalidate cached capabilities. If an MCP server is already running, advise that its host must
authorize a restart before it can use the updated CLI. On failure, keep using the existing CLI only
if it remains usable; otherwise explain the failure and stop CLI analysis. Give a brief warning and
do not escalate or retry in a loop.

`graph-it tool <name>` invokes an analysis tool directly through the CLI; it does not route every
CLI command through MCP. `graph-it serve` starts the MCP server. For MCP fallback, use only tools,
namespaces, and parameters advertised by the connected host's current tool schemas. CLI `--format`
and MCP `response_format` are different interfaces; use the latter only if the MCP schema supports
it.

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
# Illustrative tool names; verify the installed inventory and parameters first
graph-it tool generate_codemap --filePath=/abs/path/to/file.ts
graph-it tool query_call_graph --filePath=/abs/path/to/file.ts --symbolName=mySymbol --depth=3
graph-it explain /abs/path/to/file.ts
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

**Workspace root.** Imports resolving outside the workspace root are skipped. Without `--workspace`,
the CLI uses the nearest directory holding `package.json` or `tsconfig.json`; `graph-it -w <dir>` is
used exactly as given, and `.graph-it/` (index + cache) is created there. For impact, dependents and
cross-package questions in a monorepo, pass the monorepo root with `graph-it -w <monorepoRoot> ...`
instead of `cd` into a package. If `scan` warns that imports resolve outside the workspace root,
answers cover that root only (`get_index_status` reports `outOfRootImports` and `monorepoRoot`):
rerun with the `--workspace` it names or state the limitation.

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

Workspace-wide dead code scan, if the installed inventory advertises an equivalent tool:

```bash
graph-it tool scan_dead_code
```

Generate a markdown wiki from call graph relationships:

```bash
graph-it wiki
```

### Review a Pull Request or Diff

Use the dedicated command for deterministic local diff analysis. It requires a Git base ref and
indexes automatically. Without `--head`, it compares the base with the current working tree,
including staged and unstaged contents. Pass `--head <ref>` to compare two committed local or
remote refs:

```bash
graph-it review-pr --base origin/main --format markdown
graph-it review-pr --base origin/main --head feature/my-change --depth 3 --max-files 200 --format toon
```

Read `risk`, `score`, `limitations`, and `isPartial` before making a merge recommendation:

- `low`, `medium`, `high`, `critical` classify the highest-risk changed symbol.
- `isPartial: true` means file, parser, or impact-depth limits prevented a complete result.
- No breaking signature does **not** prove that a behavioral change is safe; inspect tests and affected flows.

If the connected MCP host advertises a structurally equivalent review tool, use its exact name and
input schema. Do not assume CLI options map to MCP parameters. The VS Code Branch Watch confidence
label is UI context and is not part of the CLI contract.

Use the **pr-review** skill for the full review workflow and GitHub Actions gate.

### Output Formats

For CLI commands that advertise `--format` in `graph-it --help` or command help:

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

## Tool Invocation Examples

These examples illustrate CLI usage, not a guaranteed tool set. Check the installed inventory and
relevant help before choosing a tool or parameter. If `query_call_graph` is available, use it for
call-site queries; use `graph-it explain` for intra-file logic. For MCP, use only the host-advertised
tool name/namespace and schema. If `graph_context` is advertised, it can be a starting point for
open-ended questions; do not assume it is exposed.

```bash
# Analyze a single file's dependencies
graph-it tool analyze_dependencies --filePath=/abs/path/to/file.ts

# Find all files importing a specific file
graph-it tool find_referencing_files --targetPath=/abs/path/to/file.ts

# Illustrative: query call sites only if this tool and parameters are advertised
graph-it tool query_call_graph --filePath=/abs/path/to/file.ts --symbolName=myFunction --direction=callers --depth=1

# Full impact analysis
graph-it tool get_impact_analysis --filePath=/abs/path/to/file.ts --symbolName=myFunction

# Detect breaking changes (use --args JSON for large content payloads)
graph-it tool analyze_breaking_changes --args '{"filePath":"/abs/path/to/file.ts","symbolName":"myFunction","oldContent":"...old source...","newContent":"...new source..."}'

# Generate codemap
graph-it tool generate_codemap --filePath=/abs/path/to/file.ts

# Illustrative: verify the installed tool's supported parameters first
graph-it tool query_call_graph --filePath=/abs/path/server.ts --symbolName=handleRequest --depth=3

# Workspace-wide dead code scan (across all files, unlike find_unused_symbols which is per-file)
graph-it tool scan_dead_code

# Natural-language architecture question
graph-it query "what calls the MCP worker and how"

# Generate wiki docs from call graph
graph-it wiki --output docs/wiki
```

For CLI tool parameters, follow the installed tool's help/schema; use absolute paths when that
parameter requires one. CLI `--format` controls CLI output only.

## Critical Rules (NEVER)

- **NEVER** run analysis before `graph-it scan`, except `review-pr`, which indexes automatically.
- **NEVER** assume a tool name or parameter exists because it appears in an example; verify the current CLI inventory/help or MCP schema.
- **NEVER** pass CLI flags or output settings to MCP unless its advertised input schema supports them.

## MCP Server Mode

Launch as an MCP server for AI client integration (no VS Code required):

```bash
graph-it serve
```

MCP availability is determined by the connected host's current advertised tools and input schemas;
it may differ from the installed CLI inventory. Do not assume tool names, namespaces, parameters,
or output options from this document. `response_format` is not the CLI `--format` flag and should
be used only when the host schema advertises it.

### Calling MCP tools

- If the host advertises `graph_context`, consider it for open-ended questions; use only its
  advertised schema and response shape. Otherwise choose among tools the host actually exposes.
- MCP output options and response metadata vary by tool/schema. Do not assume `response_format` or
  metadata fields unless the current host schema or response provides them.

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
# If advertised by the installed CLI, query_call_graph can report call sites
graph-it tool query_call_graph --filePath=/abs/path/src/utils/formatDate.ts --symbolName=formatDate --direction=callers --depth=1
```

For MCP, first check whether the host advertises an equivalent call-graph tool and use its exact
schema. Call sites are not a substitute for all symbol references.

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

Escalate every high/critical symbol with an advertised impact-analysis capability. Treat any
reported limitation as a manual-review item.

## Update

Run `graph-it update` only under the confirmation policy above; after success, refresh the version
and inventory and coordinate any MCP server restart with its host.

## Related Skills

- **dead-code-hunter** — uses Graph-It-Live under the hood to produce a full project-wide dead code deletion plan with safety rankings. Use it when you want to delete, not just inspect.
- **onboarding-express** — runs a structured Graph-It-Live tour of any codebase for a new developer: entry points, business logic, most complex module, and critical path diagram.
- **pr-review** — reviews a Git diff locally or in GitHub Actions, then turns Graph-It-Live evidence into merge-ready findings.
- **skill-manager** — manage installed skills interactively (list/uninstall). Useful when curating or cleaning a local skill stack.
