# Architecture Overview

**Last Updated:** 2026-10-09
**Total Source Files:** 213 TypeScript/TSX files (analyzer 76, cli 37, webview 28, extension 26, mcp 25, shared 20 — some files span multiple sub-areas)

## Architecture Diagrams

- **System architecture (HTML):** [`../graph-it-live-architecture-diagram.html`](../graph-it-live-architecture-diagram.html)
- **Runtime flows (HTML):** [`../graph-it-live-runtime-flows-diagram.html`](../graph-it-live-runtime-flows-diagram.html)
- **System architecture (SVG):** [`../graph-it-live-architecture.svg`](../graph-it-live-architecture.svg)

## High-Level Architecture (5 Layers)

```
┌─────────────┐
│   WEBVIEW   │  React + ReactFlow (Browser Context)
└──────┬──────┘
       │ postMessage Protocol
┌──────▼──────┐
│  EXTENSION  │  VS Code Extension Host Services
└──────┬──────┘
       │ API Calls
┌──────▼──────┐
│   ANALYZER  │  Pure Node.js (NO vscode imports)
└──────┬──────┘
       │ Types & Utils
┌──────▼──────┐
│   SHARED    │  Common Types, Protocol, Utilities
└─────────────┘
     │           │
     │ MCP       │ CLI
┌────▼────┐  ┌───▼──────┐
│   MCP   │  │   CLI    │  Standalone Terminal (graph-it)
│ Server  │  │  Layer   │  VS Code Agnostic
└─────────┘  └──────────┘
```

## Layer Responsibilities

### 1. ANALYZER Layer (`src/analyzer/`)

**Role:** Core dependency analysis engine (VS Code agnostic)

**Key Components:**

- `Spider.ts` - Main facade orchestrating all services
- `SpiderBuilder.ts` - Builder pattern for constructing Spider instances (955 lines)
- `LanguageService.ts` - Factory for language-specific analyzers (✅ Protected against symbol IDs)
- `Parser.ts`, `PythonParser.ts`, `RustParser.ts`, `CSharpParser.ts`, `GoParser.ts`, `JavaParser.ts` - Language parsers (✅ Protected)
- `SymbolAnalyzer.ts` - TypeScript/JavaScript AST analysis
- `PythonSymbolAnalyzer.ts`, `RustSymbolAnalyzer.ts` - Symbol analysis via tree-sitter
- `SignatureAnalyzer.ts` - Breaking change detection via function/method signatures (767 lines)
- `SourceFileCollector.ts` - Recursive workspace source file discovery (85 lines)
- `SourceFileFilters.ts` - File extension and directory filtering predicates (17 lines)
- `SymbolDependencyHelper.ts` - Helper for resolving symbol dependencies (96 lines)

**Services:**

- `spider/SpiderDependencyAnalyzer.ts` - File-level dependency analysis
- `spider/SpiderSymbolService.ts` - Symbol-level analysis
- `spider/SpiderGraphCrawler.ts` - Recursive graph traversal
- `spider/SpiderIndexingService.ts` - Background indexing
- `spider/SpiderIndexingCancellation.ts` - Cancellation support for indexing
- `spider/SpiderReferenceLookup.ts` - Find referencing files
- `spider/SpiderWorkerManager.ts` - Worker thread pool management
- `spider/SpiderCacheCoordinator.ts` - Cache invalidation coordination
- `ReverseIndexManager.ts` - Reverse dependency lookup

**Call Graph Sub-Package** (`callgraph/`):

- `callgraph/GraphExtractor.ts` - Tree-sitter queries extracting symbol nodes & call edges (521 lines)
- `callgraph/CallGraphIndexer.ts` - sql.js SQLite in-memory indexer with `indexFile`, `invalidateFile`, `markCycles`, `exportDb` (596 lines)
- `callgraph/CallGraphQuery.ts` - BFS/CTE neighbourhood queries returning `NeighbourhoodResult` with compound folder nodes (355 lines)
- `callgraph/cycleUtils.ts` - Cycle detection utilities shared from webview (103 lines)

**Utilities:**

- `utils/PathResolver.ts` - Module path resolution (TS/Python/Rust)
- `utils/PathPredicates.ts` - Path filtering helpers
- `utils/PathExtractor.ts` - Extract file path from symbol IDs
- `utils/EventLoopYield.ts` - Non-blocking event loop helpers

**AST Workers:**

- `ast/AstWorkerHost.ts` - Worker thread manager for AST parsing
- `ast/AstWorker.ts` - Parallel AST parsing worker thread
- `IndexerWorkerHost.ts` - Host for background dependency indexer worker (249 lines)
- `IndexerWorker.ts` - Worker thread for parallel file dependency indexing (292 lines)
- `SymbolReverseIndex.ts` - O(1) reverse lookup: "who calls symbolX?" with persistence and hash-based staleness detection

**WASM:**

- `languages/WasmParserFactory.ts` - Factory for loading tree-sitter WASM parsers

**Critical Rule:** NO `vscode` imports allowed in this layer

### 2. EXTENSION Layer (`src/extension/`)

**Role:** VS Code integration and orchestration

Branch Watch adds a native path alongside the existing webview: `BranchWatchService` owns opt-in lifecycle, Git/index barriers and stale-result rejection; `BranchWatchTreeProvider` projects the state into `graph-it-live.branchWatchView`; `BranchWatchAnalyzer` remains a pure Node analyzer. The graph provider supplies the existing Spider and index preparation barrier; the webview protocol is unchanged.

**Main Provider:**

- `GraphProvider.ts` - Main extension entry point, implements `WebviewViewProvider`

**Services:**

- `WebviewManager.ts` - Webview lifecycle, HTML generation, and CSP configuration (94 lines)
- `extensionLogger.ts` - Extension-scoped structured logging (205 lines)
- `services/SymbolViewService.ts` - Symbol graph construction
- `services/GraphViewService.ts` - File-level graph construction
- `services/WebviewMessageRouter.ts` - Message dispatch webview ↔ extension
- `services/BackgroundIndexingManager.ts` - Manages reverse index
- `services/CallGraphViewService.ts` - Orchestrates call graph extraction → indexing → query → webview
- `services/ICallGraphQueryService.ts` - Interface decoupling symbol view from call graph service (35 lines)
- `services/CommandRegistrationService.ts` - VS Code command registration
- `services/CommandCoordinator.ts` - Command coordination and sequencing
- `services/EditorEventsService.ts` - Editor event subscriptions
- `services/EditorNavigationService.ts` - Navigate to source locations
- `services/FileChangeScheduler.ts` - Debounced file change handling
- `services/NodeInteractionService.ts` - Node expansion/collapse logic
- `services/ProviderStateManager.ts` - Graph provider state management
- `services/SourceFileWatcher.ts` - File system monitoring
- `services/UnusedAnalysisCache.ts` - Caches unused-symbol analysis
- `services/ExtensionEventHub.ts` - Internal event bus for service-to-service communication
- `services/GraphState.ts` - Shared mutable graph state (current nodes, depth, root)
- `services/MessageDispatcher.ts` - Typed message dispatching to webview
- `services/LmToolsService.ts` - Language model tools registration for Copilot inline chat
- `services/ServiceContainer.ts` - Dependency injection container for all extension services
- `services/graphProviderServiceContainer.ts` - Service wiring/bootstrap for GraphProvider

**Activation:**

- `extension.ts` - Extension activation entry point

### 3. WEBVIEW Layer (`src/webview/`)

**Role:** React-based UI (browser context)

**Main Components:**

- `index.tsx` - Main webview entry point (→ `dist/webview.js`)
- `App.tsx` - Root React component
- `components/AtomicSymbolGraph.tsx` - Symbol-level visualization
- `components/SymbolCardView.tsx` - Symbol detail cards
- `components/ReactFlowGraph.tsx` - Main graph component (file-level)
- `components/reactflow/buildGraph.ts` - Graph data transformation
- `components/reactflow/ExpansionOverlay.tsx` - Node expansion overlay
- `components/reactflow/FileNode.tsx` - File node renderer
- `components/reactflow/LanguageIcon.tsx` - Language badge
- `components/reactflow/SymbolNode.tsx` - Symbol node renderer
- `components/reactflow/cycles.ts` - Cycle detection helpers
- `components/reactflow/layout.ts` - Dagre layout helpers

**Call Graph Panel** (separate bundle → `dist/callgraph.js`):

- `callgraph/index.tsx` - Separate call graph panel entry point (19 lines)
- `components/cytoscape/CytoscapeGraph.tsx` - Cytoscape.js graph with fCoSE layout and compound nodes (755 lines)
- `components/cytoscape/CytoscapeTheme.ts` - Style objects derived from `LANGUAGE_COLORS`, red dashed cyclic edges (366 lines)
- `components/cytoscape/GraphLegend.tsx` - Filter overlay with accessible checkboxes posting `callGraphFilterChanged` (259 lines)

**Hooks:**

- `hooks/useGraphData.ts` - Custom hook for graph data management and updates (442 lines)

**Utilities:**

- `utils/graphUtils.ts` - Graph filter & hierarchy
- `utils/graphMerge.ts` - Merge graph datasets
- `utils/graphTraversal.ts` - Graph traversal algorithms
- `utils/clusterUtils.ts` - Node clustering helpers
- `utils/nodeUtils.ts` - Node label formatting
- `utils/symbolUtils.ts` - Symbol node helpers
- `utils/updateGraphReducer.ts` - State reducer
- `utils/fitViewScheduler.ts` - Scheduled fit-view calls
- `utils/path.ts` - Path utilities for webview

### 4. SHARED Layer (`src/shared/`)

**Role:** Common types, protocols, and utilities

**Key Files:**

- `types.ts` - Core type definitions (GraphData, SymbolInfo, Dependency, etc.)
- `graph-types.ts` - Graph-specific type definitions
- `symbol-types.ts` - Symbol-specific type definitions
- `callgraph-types.ts` - Call graph message types (ShowCallGraph, CallGraphIndexing, extension↔webview protocol for call graph panel)
- `messages.ts` - Extension ↔ webview message protocol
- `constants.ts` - Application-wide constants
- `path.ts` - Cross-platform path normalization
- `logger.ts` - Logging infrastructure
- `toon.ts` - Token-Oriented Object Notation formatter
- `converters.ts` - Spider AST → LSP format conversion utilities shared between extension and MCP layers
- `index.ts` - Barrel file re-exporting shared module public API
- `utils/languageDetection.ts` - Language detection utilities

### 5. CLI Layer (`src/cli/`)

34 files, 20 commands plus the REPL. See the dedicated [cli.md](cli.md) codemap for full details.

### 6. MCP Layer (`src/mcp/`)

**Role:** Model Context Protocol for AI/LLM integration

**Server:**

- `mcpServer.ts` - MCP server entry point; registers all 22 tools, includes an in-memory sliding-window rate limiter (`checkRateLimit`) for `set_workspace`/`rebuild_index` (5 calls/10s) and `invalidate_files` (20 calls/10s)
- `McpWorker.ts` - Worker thread (NO vscode imports)
- `McpWorkerHost.ts` - Worker communication
- `McpServerProvider.ts` - VS Code MCP server provider
- `responseFormatter.ts` - Tool response formatting
- `tools/` - Tool implementations: `analysis.ts`, `callgraph.ts`, `codemap.ts`, `deadcode.ts`, `execution.ts`, `graph.ts`, `graphContext.ts`, `impact.ts`, `logic.ts`, `query.ts`, `resolve.ts`, `stats.ts`, `symbol.ts`, `wiki.ts`, `workspace.ts` (`index.ts` barrel)
- `worker/fileWatcher.ts` - chokidar-based file watcher for cache invalidation
- `worker/invokeTool.ts` - Tool invocation dispatcher in worker thread
- `shared/helpers.ts` - Shared MCP worker utilities
- `shared/state.ts` - MCP worker shared state management

**22 Tools Available** (`graphitlive_` prefix in MCP protocol):

1. `set_workspace` - Set workspace directory
2. `analyze_dependencies` - Single-file dependency analysis
3. `crawl_dependency_graph` - Recursive file-level crawl
4. `find_referencing_files` - Reverse file lookup
5. `verify_dependency_usage` - Verify if import is used
6. `resolve_module_path` - Resolve a module specifier
7. `get_index_status` - Index health & stats
8. `invalidate_files` - Invalidate cache entries
9. `rebuild_index` - Full index rebuild
10. `get_symbol_graph` - Symbol-level dependency graph
11. `find_unused_symbols` - Dead code detection
12. `trace_function_execution` - Execution path tracing
13. `analyze_breaking_changes` - Detect breaking API changes
14. `review_pr` - Review a local Git diff (risk score, evidence, capability limits)
15. `get_impact_analysis` - Full change impact analysis
16. `generate_codemap` - AI-friendly code map for a single file (TOON format)
17. `query_call_graph` - Cross-file caller/callee queries via SQLite BFS
18. `scan_dead_code` - Workspace-wide or scoped unused export scan
19. `graph_context` - Token-bounded subgraph answering a question (default entry point)
20. `query_natural_language` - Subgraph relevant to a plain-language question
21. `generate_wiki` - Navigable Markdown wiki from the call graph index
22. `get_session_stats` - TOON vs JSON token savings for the session

`expand_node`, `parse_imports`, `get_symbol_callers`, `get_symbol_dependents` and `analyze_file_logic` are no longer MCP tools (v1.17.0). `graph-it tool` still accepts them as transition aliases.

## Graph-It Review Gate

```
Consumer pull-request workflow
       -> .github/actions/graph-it-review-gate
       -> npm CLI in an isolated temporary prefix
       -> graph-it review-pr / graphitlive_review_pr
       -> ReviewGateAnalyzer (local Git diff)
       -> optional sticky GitHub report / optional VS Code call-graph link
```

`ReviewGateAnalyzer` is a pure Node analyzer that executes a local Git diff with argument-array process invocation, validates changed paths under the workspace, normalizes them, and composes `SignatureAnalyzer`, the reverse symbol index, cycle detection, unused-export detection, and bounded conventional test-file discovery. It produces deterministic score factors, evidence, and partial-result data, and records capability limitations rather than fabricating unavailable findings. The CLI (`review-pr`) and read-only MCP tool (`graphitlive_review_pr`) expose the same bounded contract.

The composite Action at `.github/actions/graph-it-review-gate` is invoked by a consumer-owned `pull_request` workflow; it has no trigger itself. It installs `@magic5644/graph-it-live@latest` into an isolated temporary npm prefix by default, or uses the optional `cli-version` npm version, tag, or range. It validates and exposes the installed CLI version, rejecting every version below `1.12.0`, and never installs dependencies or runs build scripts from the consumer checkout. The Action invokes the CLI against `$GITHUB_WORKSPACE`, optionally upserts one sanitized marker-owned PR comment after checking GitHub REST responses, and only fails when `fail-on-risk` is configured for `high` or `critical`.

The sticky report and the `vscode://magic5644.graph-it-live/graph-it-live.reviewCallGraph` deep link are optional. A link is emitted only for an encoded workspace-relative risky symbol; the extension validates canonical depth and workspace containment before `CallGraphViewService` focuses the existing Cytoscape call graph. External consumers pin the Action to a release tag, such as `magic5644/Graph-It-Live/.github/actions/graph-it-review-gate@v1.18.0`; the Action rejects CLI versions below `1.13.0`.

## Design Patterns

1. **Facade Pattern** - Spider wraps complex services
2. **Factory Pattern** - LanguageService creates parsers
3. **Strategy Pattern** - ILanguageAnalyzer implementations
4. **Service Layer** - Extension services with single responsibilities
5. **Worker Thread Pattern** - AST parsing in separate threads
6. **Message Protocol** - Typed messages for webview ↔ extension
7. **Defensive Programming** - Multi-layer protection against invalid inputs ✅

## Recent Security Enhancements (2026-01-21)

### Symbol ID Protection ✅

**Problem:** Symbol IDs (`filePath:symbolName`) were being passed where file paths were expected, causing crashes.

**Solution:** Added `extractFilePath()` defense mechanism in:

- `LanguageService.ts` (all public methods)
- `Parser.ts`, `PythonParser.ts`, `RustParser.ts` (parseImports, resolvePath)

**Protection Layers:**

```
Layer 1: LanguageService.extractFilePath()
Layer 2: Parser.extractFilePath()
Layer 3: FileReader.readFile()
Layer 4: File system operations
```

### Deduplication Fix ✅

**Problem:** Duplicate nodes in symbol graph (e.g., two "shared" nodes)

**Solution:** Fixed `SymbolViewService.buildPayload()` to extract file path from symbol ID before comparison:

```typescript
// Before: "shared.ts:shared".startsWith("component1.ts") → false (wrong logic)
// After:  "shared.ts" !== "component1.ts" → correct comparison
```

## Recent Security Enhancements (2026-09-15)

**MCP Security Audit (Nathan/Adrien):**

- Rate limiting on `set_workspace`/`rebuild_index`/`invalidate_files` to bound repeated full re-index / cache-invalidation calls (see `mcpServer.ts` `checkRateLimit`, [MCP_PAYLOAD_LIMITS.md](../MCP_PAYLOAD_LIMITS.md))
- Markdown/HTML escaping of source-derived symbol names and titles in `WikiGenerator.renderArticle()`
- Accepted risk (documented, not blocked): `set_workspace` has no root allowlist — see [MCP_PAYLOAD_LIMITS.md](../MCP_PAYLOAD_LIMITS.md#accepted-risk-set_workspace-has-no-root-allowlist)

## Build & Bundle

**Build Tool:** esbuild
**Entry Points:**

- `dist/extension.js` - Extension host
- `dist/astWorker.js` - AST worker thread
- `dist/indexerWorker.js` - Background indexer worker thread
- `dist/mcpServer.mjs` - MCP server standalone
- `dist/mcpWorker.js` - MCP worker thread
- `dist/webview.js` - Main webview React bundle (file + symbol graph)
- `dist/callgraph.js` - Call graph panel React bundle (Cytoscape.js)
- `dist/wasm/` - WASM files (tree-sitter parsers + sql.js)

## Testing Strategy

**Total Tests:** 243 test files
**Coverage:** ~80%+ per touched file (per-file gate); global threshold check is informational, not a merge blocker

**Test Types:**

- Unit tests (Vitest)
- Integration tests
- VS Code E2E tests
- Benchmark tests
- Cross-platform path tests

## Key Principles

1. **Layered Architecture** - Strict separation of concerns
2. **VS Code Agnostic Analyzer** - Reusable core logic
3. **Cross-Platform Compatibility** - Windows/Linux/macOS support
4. **Performance** - Lazy loading, caching, worker threads
5. **Type Safety** - Strict TypeScript, no `any`
6. **Defensive Programming** - Input validation, error handling ✅

---

## Related Documentation

| Document | Purpose |
|----------|---------|
| [class-hierarchy.md](./class-hierarchy.md) | **Detailed class diagram** — interfaces, implementations, design patterns (45+ core classes) |
| [backend.md](./backend.md) | Analyzer, MCP, and extension services breakdown |
| [frontend.md](./frontend.md) | Webview and React component structure |
| [data.md](./data.md) | Data flow and shared type definitions |
| [cli.md](./cli.md) | Standalone CLI layer (`graph-it` command) |
| [../PERFORMANCE_OPTIMIZATIONS.md](../PERFORMANCE_OPTIMIZATIONS.md) | Caching, batching, concurrency strategies |
| [../MCP_PAYLOAD_LIMITS.md](../MCP_PAYLOAD_LIMITS.md) | MCP tool parameter validation |
