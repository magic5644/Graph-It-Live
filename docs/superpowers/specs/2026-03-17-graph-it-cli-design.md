# Graph-It-Live CLI Design

Date: 2026-03-17
Status: Approved for implementation planning

## Summary

Graph-It-Live will gain a standalone CLI that exposes the project's analysis engine without requiring the VS Code UI. The CLI must serve two audiences well:

- humans using the terminal for quick inspection, explanation, and CI checks
- AI agents that need a stable, scriptable, token-efficient interface

The CLI will ship first inside the current repository, but its structure must prepare an eventual npm package split with minimal rework.

## Goals

- Provide a first-class CLI entry point for code intelligence and graph analysis.
- Reuse the existing VS Code-agnostic analysis stack under [`src/analyzer`](/Users/gildaslebournault/github/Graph-It-Live/src/analyzer) and [`src/mcp`](/Users/gildaslebournault/github/Graph-It-Live/src/mcp).
- Expose all existing MCP tools through a stable CLI namespace.
- Add human-oriented commands that compose MCP and analyzer capabilities into simpler workflows.
- Support output formats for humans and agents: `text`, `json`, `toon`, `markdown`, and `mermaid`.
- Persist project-local runtime state under `.graph-it/`.
- Auto-create and reuse indexes when commands require them.
- Produce a standalone CLI bundle that end users can install outside VS Code if they choose.
- Provide a simple opt-in installation path for the CLI from inside the VS Code extension.
- Keep the design ready for a later `core + cli` npm packaging split.

## Non-Goals

- No monorepo or `packages/core` extraction in this phase.
- No new network protocol for `serve`; V1 is stdio MCP only.
- No persistent rule engine for `check`; V1 uses CLI flags only.
- No mandatory explicit `graph-it index` bootstrap step.
- No separate second analysis pipeline for the CLI.
- No implicit shell CLI installation as a side effect of VSIX installation.

## Key Decisions

### Architecture Strategy

Use a two-phase strategy:

1. add the CLI inside the current repository
2. shape the new runtime so it can move later into a dedicated npm package

The CLI must reuse the existing MCP runtime and tools instead of rebuilding analyzer orchestration from scratch.

### Primary Runtime Model

Create a shared CLI and MCP runtime that:

- resolves the target workspace
- initializes analysis services
- manages `.graph-it/`
- decides whether cached state is reusable
- invokes MCP-style tools through one internal interface

This runtime is the main seam for a later extraction to `@graph-it/core`.

### Product Surface

The CLI uses a double-layer model:

- human-oriented commands such as `scan`, `summary`, `trace`, `explain`, `path`, `check`, and `serve`
- an exhaustive tool namespace: `graph-it tool <mcp-tool>`

This keeps the terminal UX readable for humans while preserving exact, stable tool access for agents.

### Symbol Addressing

The CLI accepts both:

- simple symbol names when they are unique
- canonical references in the form `path/to/file.ts#Qualified.Symbol`
- an optional disambiguation suffix in the form `path/to/file.ts#Qualified.Symbol:line`

Resolution rules:

- `Qualified.Symbol` may include container names such as class or namespace segments
- if a simple symbol name resolves to more than one candidate, the command must fail deterministically and suggest canonical candidates
- if `path/to/file.ts#Qualified.Symbol` still resolves to more than one candidate inside the file, the command must fail and suggest `:line` disambiguators
- V1 does not require arbitrary AST selector syntax beyond `#Qualified.Symbol[:line]`

### Workspace State

Persistent CLI state lives inside the analyzed project under `.graph-it/`. The CLI must not depend on a machine-global cache for normal operation.

## Existing Constraints to Preserve

- `src/analyzer/**` and `src/mcp/**` must remain VS Code-agnostic.
- Typed extension and webview protocol under [`src/shared/types.ts`](/Users/gildaslebournault/github/Graph-It-Live/src/shared/types.ts) must remain intact.
- Cross-platform path handling must use existing normalized path utilities.
- Packaging-sensitive changes still need VSIX validation and zero `.map` files in the package.

## Target Architecture

### Layers

#### 1. Existing analysis core

Reuse existing services from:

- [`src/analyzer`](/Users/gildaslebournault/github/Graph-It-Live/src/analyzer)
- [`src/mcp/tools`](/Users/gildaslebournault/github/Graph-It-Live/src/mcp/tools)
- [`src/mcp/McpWorkerHost.ts`](/Users/gildaslebournault/github/Graph-It-Live/src/mcp/McpWorkerHost.ts)
- [`src/mcp/worker/invokeTool.ts`](/Users/gildaslebournault/github/Graph-It-Live/src/mcp/worker/invokeTool.ts)

#### 2. Shared runtime

Add a new shared runtime layer that hides worker startup, workspace resolution, caching, and tool invocation from the CLI command layer.

Recommended responsibilities:

- workspace and tsconfig discovery
- `.graph-it/` state management
- cache and index reuse checks
- normalized tool invocation
- formatter selection support

#### 3. CLI command layer

Add a new CLI entry point and command handlers under `src/cli/**`.

Recommended structure:

- `src/cli/index.ts`
- `src/cli/runtime/**`
- `src/cli/commands/**`
- `src/cli/tool-command/**`
- `src/cli/format/**`
- `src/cli/resolve/**`

#### 4. Output renderers

Keep output rendering separate from analysis execution. Reuse TOON support from [`src/shared/toon.ts`](/Users/gildaslebournault/github/Graph-It-Live/src/shared/toon.ts). Add CLI renderers for `text`, `markdown`, and `mermaid`.

## Runtime and Index Model

### Workspace Resolution

The CLI determines the workspace in this order:

1. `--project <path>` when provided
2. the current working directory otherwise

If `--project` points to a `tsconfig.json`, the CLI resolves the effective project root from that file before initializing the runtime.

### `.graph-it/` Layout

V1 state must live in the project under `.graph-it/`.

Recommended layout:

- `.graph-it/cache/` for regenerable cache artifacts
- `.graph-it/state.json` for versioned metadata about the current runtime state

Do not use a single monolithic `cache.json` for all state. Different artifacts have different invalidation and rebuild costs.

### Auto-Indexing

The CLI must not require a manual index step before use.

Behavior:

- if a command requires an index and none exists, the CLI creates it automatically
- if an index exists and is still valid, the CLI reuses it
- if cached state is stale, the CLI rebuilds what is needed before serving the command

An explicit reindex command may exist later as an optimization, but it is not a prerequisite for normal use.

### Invalidation Rules

V1 invalidation should be simple and reliable.

The runtime should treat cached state as stale when any of the following change:

- CLI or runtime version
- workspace root
- `tsconfigPath`
- relevant analysis options such as `excludeNodeModules` or depth-related settings
- a lightweight project fingerprint based on source file metadata such as `mtime` and size

The design does not require perfect incremental invalidation in V1. It requires deterministic reuse and deterministic rebuilds.

### `serve`

`graph-it serve` launches the existing MCP server in standalone stdio mode. It must use the same workspace resolution and `.graph-it/` state model as all CLI commands so that humans, CI, and agents observe the same project state.

For normal CLI commands, workspace selection is fixed for the duration of a single process invocation.

For `serve`, `--project` sets the initial workspace only. After startup, an MCP client may still call `graphitlive_set_workspace`. When that happens, the runtime must tear down the current in-memory workspace state, bind itself to the new workspace, and use that workspace's own `.graph-it/` directory. Cache ownership therefore remains project-local even when one long-lived server process switches workspaces.

## CLI Surface

### Global Options

V1 global options:

- `--project <path>`
- `--format <text|json|toon|markdown|mermaid>`
- `--output <file>`
- `--verbose`
- `--no-color`

Additional command-specific options may exist where needed, such as `--scope <path>` for `check`.

### Human Commands

#### `graph-it scan [path]`

Analyze a directory or entry point and return a dependency graph view.

Notes:

- primary human-facing graph exploration command
- if `[path]` is omitted, the command analyzes the resolved workspace root
- if `[path]` is relative, resolve it against the resolved workspace root
- may compose existing graph crawl tooling
- supports `text`, `json`, `toon`, `markdown`, and `mermaid`

#### `graph-it summary [path]`

Return high-value project metrics such as node counts, edge counts, coupling indicators, and orphan candidates.

Notes:

- human-oriented summary, not a raw MCP passthrough
- if `[path]` is omitted, the command summarizes the resolved workspace root
- if `[path]` is relative, resolve it against the resolved workspace root
- supports `text`, `json`, `markdown`, and `toon`
- `mermaid` is optional and not required for V1

#### `graph-it trace <symbol>`

Trace blast radius for a symbol.

Notes:

- accepts unique simple names or canonical references
- primary V1 behavior is impact analysis: which symbols and files are affected by changing the target symbol
- symbol caller, execution trace, and call graph data may enrich the result, but they do not change the command's core meaning
- supports `text`, `json`, `toon`, `markdown`, and `mermaid`

#### `graph-it explain <file>`

Explain the structure of a file in a concise, machine-friendly, and human-friendly way.

Notes:

- should summarize exports, classes, methods, functions, relationships, and call flow when available
- may compose codemap, symbol graph, and file logic analysis
- supports `text`, `json`, `toon`, and `markdown`
- `mermaid` is optional, not required in V1

#### `graph-it path <from> <to>`

Find the shortest directed path between two resolved symbols in the cross-file call graph.

Notes:

- accepts canonical symbol references and unique simple names
- V1 is symbol-only; file nodes and mixed file-symbol paths are out of scope
- V1 uses the call graph domain, not the file dependency graph
- if multiple shortest paths exist, the command should choose one deterministically using a stable ordering rule defined during implementation planning
- supports `text`, `json`, `toon`, `markdown`, and `mermaid`

#### `graph-it check`

Run a small fixed set of file-graph checks using CLI flags only in V1.

Notes:

- no persistent `.graph-it/config.json` requirement in V1
- intended for CI and terminal use
- V1 check scope is the file dependency graph
- the command accepts `--scope <path>` to restrict analysis to a subdirectory or file-derived project slice
- if no explicit path or `--scope` flag is supplied, the command checks the resolved workspace root
- any relative path input is resolved against the resolved workspace root
- minimum V1 rules:
  - `--threshold-coupling <0..1>` compares a normalized project coupling score computed as directed edge density within the analyzed scope
  - `--max-cycles <n>` limits the number of detected circular dependency groups
  - `--max-orphans <n>` limits files with no inbound and no outbound edges inside the analyzed scope
- the command evaluates only the rules explicitly requested on the command line
- exit code semantics:
  - `0` when analysis succeeds and all requested checks pass
  - `1` when analysis succeeds and at least one requested check fails
  - `2` when the command cannot evaluate the checks because of usage or runtime errors
- supports `text`, `json`, and `markdown`

#### `graph-it serve`

Launch the MCP server in standalone stdio mode for agent clients outside VS Code.

Notes:

- no HTTP or WebSocket mode in V1
- must share runtime and workspace state with the rest of the CLI

### MCP Tool Namespace

The CLI must expose all current MCP tools via:

`graph-it tool <mcp-tool> [options]`

Parity requirement: all existing MCP tools must be callable from the CLI.

Canonical CLI tool names must match the externally registered MCP names from the standalone server. In V1, the parity surface is the `graphitlive_*` namespace already exposed by the MCP server.

For terminal ergonomics, the CLI may also support unprefixed aliases such as `query_call_graph`, but those aliases are convenience aliases only. The canonical parity contract is the external MCP namespace.

V1 tool list:

- `graphitlive_set_workspace`
- `graphitlive_analyze_dependencies`
- `graphitlive_crawl_dependency_graph`
- `graphitlive_find_referencing_files`
- `graphitlive_expand_node`
- `graphitlive_parse_imports`
- `graphitlive_verify_dependency_usage`
- `graphitlive_resolve_module_path`
- `graphitlive_get_index_status`
- `graphitlive_invalidate_files`
- `graphitlive_rebuild_index`
- `graphitlive_get_symbol_graph`
- `graphitlive_find_unused_symbols`
- `graphitlive_get_symbol_dependents`
- `graphitlive_trace_function_execution`
- `graphitlive_get_symbol_callers`
- `graphitlive_analyze_breaking_changes`
- `graphitlive_get_impact_analysis`
- `graphitlive_analyze_file_logic`
- `graphitlive_generate_codemap`
- `graphitlive_query_call_graph`

`graphitlive_set_workspace` remains available for MCP parity even though the CLI runtime also auto-configures the workspace implicitly.

### Tool Input Contract

V1 `graph-it tool` input must use the external MCP tool parameter contract rather than a CLI-specific translated contract.

Canonical input methods:

- `--json '<params-json>'`
- `--input <file.json>`
- `--input -` to read the params object from stdin

If a tool requires no parameters, the CLI supplies `{}` implicitly.

V1 does not require bespoke flag parsing for every MCP tool. Human-friendly flags belong in the human command layer, not in the parity namespace.

The JSON payload shape passed to `graph-it tool graphitlive_*` must match the corresponding external MCP tool schema exactly. The CLI may inject or override the `format` field, but it must not rename, remap, or reinterpret other parameter fields.

### Tool Format Precedence

`graph-it tool` uses the global CLI `--format` flag as the canonical output selection mechanism.

Precedence rules:

1. if CLI `--format` is provided, it wins
2. otherwise, if the JSON payload includes a `format` field, that value is honored
3. otherwise, if the selected MCP tool supports a `format` parameter, the CLI injects `format: "toon"`
4. otherwise, the CLI renders the result as `json`

This makes the agent-facing parity surface deterministic while preserving compatibility with the existing MCP payload shapes.

If both `--project` and `graphitlive_set_workspace` are used, `--project` defines the initial workspace for CLI process startup, and `graphitlive_set_workspace` may replace it later using the same workspace-switch behavior defined for `serve`.

## Format Model

### Supported Formats

V1 supports:

- `text`
- `json`
- `toon`
- `markdown`
- `mermaid`

### Defaults

- human commands default to `text`
- `graph-it tool ...` defaults to `toon` when the result is naturally representable in TOON
- otherwise `graph-it tool ...` defaults to `json`

### `markdown`

`markdown` is a first-class CLI output format, not a wrapper around raw JSON.

When supported, markdown output should:

- summarize the result in a readable structure
- use short sections and compact tables when useful
- include a fenced Mermaid block when a diagram adds value

For graph-oriented commands such as `scan`, `trace`, and `path`, `--format markdown` should produce narrative markdown plus a `mermaid` block when appropriate.

### `mermaid`

`mermaid` produces raw Mermaid diagram text with no surrounding prose.

V1 only needs one canonical graph style for most cases:

- `flowchart TD`

Additional Mermaid diagram types can be added later, but they are not required for planning or for V1.

### Unsupported Combinations

Not every command must support every format. If a command-format combination is unnatural or misleading, the CLI must fail with a structured `FORMAT_NOT_SUPPORTED` error.

Examples:

- `parse_imports --format mermaid` should fail cleanly
- `serve --format markdown` should fail cleanly

## Error Model

Use stable machine-readable error codes across CLI surfaces.

Minimum V1 error set:

- `WORKSPACE_NOT_FOUND`
- `INDEX_STALE`
- `SYMBOL_AMBIGUOUS`
- `SYMBOL_NOT_FOUND`
- `FORMAT_NOT_SUPPORTED`
- `ANALYSIS_FAILED`
- `UNSUPPORTED_LANGUAGE`

Rendering rules:

- `text`: short explanation plus next action when useful
- `json`: stable structured error object
- `toon`: compact structured error output only when it remains clear; otherwise use `json`
- `markdown`: short readable failure summary

`INDEX_STALE` is primarily an internal rebuild reason in V1. In normal CLI flows, stale index state should usually trigger automatic rebuild rather than a surfaced user error. It should only be user-visible when automatic recovery fails or when diagnostic output explicitly requests it.

## Command Composition Rules

Human commands may compose one or more underlying MCP tools or analyzer services.

Recommended compositions:

- `scan` primarily builds on dependency graph crawl behavior
- `summary` aggregates graph and index metrics into one human-oriented result
- `trace` is primarily an impact-analysis command and may add caller or call-graph context as enrichment
- `explain` may combine codemap, symbol graph, and intra-file logic analysis
- `path` may use graph traversal and symbol resolution services

The plan should preserve a clean boundary between:

- raw tool execution
- human command composition
- output rendering

## Testing Requirements

The CLI adds user-facing behavior and therefore needs direct coverage.

### Unit Tests

Add focused tests for:

- option parsing
- workspace resolution
- symbol resolution
- cache and invalidation decisions
- format selection
- `markdown` and `mermaid` renderers
- unsupported format handling

### Integration Tests

Add CLI integration tests on fixtures for:

- `scan`
- `summary`
- `trace`
- `explain`
- `path`
- `check`
- `tool`

Recommended fixture location:

- `tests/fixtures/cli/`

### End-to-End Coverage

Because the CLI is a user-facing feature, add end-to-end coverage consistent with the repository testing rules. The plan should define the lightest credible e2e path that validates the built CLI in a packaged or production-like form.

## Build and Packaging Impact

### Build Output

Add a dedicated CLI build artifact under `dist/`, such as:

- `dist/cli.js`
- or `dist/graph-it.mjs`

The exact filename can be decided in planning, but the CLI must not piggyback on the extension entry point.

### Distribution Contract

Installing the VS Code extension must not be treated as installing a user-facing shell CLI.

V1 distribution requirements:

- produce a standalone CLI bundle inside the repository for local invocation, testing, and future packaging
- publish installable standalone CLI bundle artifacts through GitHub Releases
- support user-facing CLI installation on macOS, Linux, and Windows
- document a repo-local invocation path for contributors and CI
- do not rely on VSIX installation to place `graph-it` on the user's shell `PATH`
- treat user-facing shell distribution as a separate packaging concern

If the root `package.json` gains a `bin` entry in V1, it is a development convenience only. It is not the primary distribution contract for extension users.

### VS Code Assisted CLI Installation

V1 should provide an explicit extension command such as `Graph-It-Live: Install CLI...` for users who want shell access without manually hunting for release artifacts.

Requirements:

- installation is opt-in and user-initiated
- the command downloads the appropriate standalone CLI bundle from the project's GitHub Releases
- the assisted installation path supports macOS, Linux, and Windows in V1
- the command asks for user consent before downloading or installing anything
- the command targets a shell-usable install location and reports the resulting path and any required `PATH` follow-up
- the command must fail safely with a clear message if the platform is unsupported or installation cannot complete

This command is an assisted installer. It does not change the rule that the VSIX itself is not the shell distribution mechanism.

### Packaging Safety

CLI work must not break:

- extension bundling
- MCP server bundling
- WASM asset availability
- VSIX packaging verification
- extension install size or payload with unused CLI artifacts
- GitHub Release bundle generation for the standalone CLI

The implementation plan must include packaging validation when build configuration changes.

The CLI artifact must be excluded from the VSIX unless a later requirement proves that the extension itself needs that runtime file. Extension users should not pay for dead CLI payload by default.

## Migration Readiness for npm

The implementation should prepare, not force, a later split.

The future target shape is:

- shared runtime and analyzer-facing invocation logic move into a core package
- CLI commands and terminal renderers move into a CLI package
- NPM packaging for the CLI and publishing a standalone CLI bundle on npm

To support that future move, the implementation should avoid:

- command handlers that know worker boot details
- renderers that know analyzer internals
- workspace state code scattered across commands

User-facing shell distribution should later use a dedicated npm packaging manifest, subpackage, or release artifact instead of treating the root extension package as the long-term CLI contract.

## Acceptance Criteria

This design is ready for implementation planning when the planned work delivers all of the following:

- a standalone `graph-it` CLI entry point inside the current repository
- automatic workspace-local `.graph-it/` state creation
- transparent auto-indexing when a command requires cached analysis
- human commands for `scan`, `summary`, `trace`, `explain`, `path`, `check`, and `serve`
- full MCP parity through `graph-it tool <mcp-tool>`
- mixed symbol addressing with deterministic ambiguity handling
- support for `text`, `json`, `toon`, `markdown`, and `mermaid`
- markdown output that can embed Mermaid blocks when appropriate
- clean failures for unsupported command-format combinations
- tests that cover new CLI behavior
- build changes that preserve existing extension and packaging guarantees
- VSIX verification that does not include `dist/graph-it*` or equivalent standalone CLI artifacts by default
- a standalone CLI bundle that can be downloaded from GitHub Releases
- an explicit VS Code command path that lets a user opt into CLI installation
- supported opt-in CLI installation on macOS, Linux, and Windows

## Out of Scope for This Plan

- extracting `packages/core` or `packages/cli`
- introducing a persistent rule configuration file for `check`
- adding HTTP, WebSocket, or browser-based server modes
- designing new MCP tools beyond current parity and the human command layer
