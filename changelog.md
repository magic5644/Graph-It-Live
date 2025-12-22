# Changelog

## v1.4.1

### Performance Improvements

- **Major Bundle Size Optimization**: 
  - ts-morph AST analysis now runs in dedicated worker thread for improved responsiveness

- **React Production Mode**: Enabled production builds for webview
  - React/React-DOM optimized for production (removed dev warnings and checks)

### Improvements
- Optimize esbuild builds by generating and saving metafiles for bundle analysis when `--metafile` argument is provided.
- Reduce esbuild bundle size by defining `process.env.NODE_ENV` as `"production"` during the webview build.
- Dependency update: Upgrade `zod` to v4 for improved type safety and features.
- Added `AstWorkerHost` and `AstWorker` for lazy-loading ts-morph analysis
- Spider now supports `getCacheStats()` (sync) and `getCacheStatsAsync()` (with AST worker stats)

## v1.4.0

### New Features

- **TOON Format as Default**: TOON format is now the default response format for all MCP tools
  - Automatically reduces token consumption by 30-60% without configuration
  - All 17 MCP tools now use TOON by default
  - Clear documentation promoting TOON as the recommended format
  - LLMs will automatically benefit from token savings

- **Enhanced SEO and Discoverability**: Improved MCP tool descriptions for better LLM discoverability
  - Added concrete examples to all 7 symbol-level analysis tools
  - 100% of tools now include usage examples
  - Updated parameter descriptions to promote TOON format benefits
  - SEO score improved from 72% to 80%

- **TOON Format Support**: Added Token-Oriented Object Notation (TOON) format for optimized token consumption
  - New `response_format` parameter on all MCP tools (`json`, `toon`, `markdown`)
  - Reduces token usage by 30-60% for large structured datasets
  - Automatic token savings reporting in responses
  - Complete documentation in `docs/TOON_FORMAT.md`
  - Full round-trip conversion support with `jsonToToon()` and `toonToJson()`
  - Special character escaping and array serialization
  - Smart object name inference based on data structure

### Improvements

- **Tool Descriptions**: All MCP tool descriptions now follow WHEN/WHY/RETURNS pattern consistently
- **Examples Added**: 
  - `graphitlive_get_symbol_graph`: 3 concrete usage examples
  - `graphitlive_find_unused_symbols`: 3 dead code detection examples
  - `graphitlive_get_symbol_dependents`: 3 impact analysis examples
  - `graphitlive_trace_function_execution`: 3 execution tracing examples
  - `graphitlive_get_symbol_callers`: 3 reverse dependency examples
  - `graphitlive_analyze_breaking_changes`: 3 signature validation examples
  - `graphitlive_get_impact_analysis`: 3 blast radius analysis examples

### API Changes

- **Breaking Change**: Default `response_format` changed from `json` to `toon` for all MCP tools
  - To use JSON format explicitly, set `response_format: 'json'` in tool calls
  - TOON format provides 30-60% token savings and is now the recommended default
- **New shared exports**: Added `jsonToToon`, `toonToJson`, `estimateTokenSavings` to `src/shared/index.ts`
- **Enhanced response formatter**: All MCP tool responses now support TOON format output
- **Type definitions**: New `OutputFormat` type and `OutputFormatSchema` for format validation

## v1.3.6

### Bug Fixes

- **Fix file change event handling**: Resolved issues with file change detection that could lead to missed or duplicate analyses
  - Correctly prioritizes delete > change > create events
  - Ensures single analysis per file change, even with multiple rapid events
  - Improved debouncing logic to prevent redundant refreshes
  - Addresses edge cases with external file watchers interfering with save events

### Improvements

- **MCP tool names renamed**: Tool names now use `graphitlive_*` (snake_case) instead of `graphItLive_*`. Update any hardcoded tool references accordingly. If tool names are discovered dynamically and not hardcoded in scripts or prompts, there is no impact.
- **MCP Server**: Added tool response schemas, annotations, and structured responses to improve compatibility and validation.


## v1.3.5

### Improvements

- **File Change Event Coalescence**: Optimized file change detection to prevent redundant analysis
  - Intelligently coalesces save events and file watcher events into single processing pass
  - Event priority system (delete > change > create) ensures correct handling
  - Per-file debouncing (300ms) reduces unnecessary refreshes
  - Prevents duplicate analysis when saving files with external watchers active

## v1.3.4

### New Features

- **Node Expansion Progress Tracking**: Real-time visualization of expansion progress with cancellation support
  - Overlay displays file count and progress during expansion
  - Cancel button to stop ongoing operations
  - Status indicators (in-progress, completed, cancelled, error)
- **Auto Fit View on Resize**: Graph automatically adjusts zoom and position when the webview is resized
  - Debounced RAF scheduler for smooth, performant updates
  - Maintains optimal view of the graph when switching panel positions

### Improvements

- **Better Expand/Collapse Handling**: Significantly improved logic for managing node expansion and collapse states
  - Fixed issues where nodes would disappear after expand/collapse operations
  - More reliable state synchronization between expanded and visible nodes
  - Enhanced merge algorithm for graph updates
- **Unused Symbol Detection**: Improved accuracy by checking internal dependencies within the file
  - Now considers references between exported symbols (e.g., exported types used in exported functions)
  - Reduces false positives when detecting dead code
  - Uses AST-based internal export dependency graph

### Architecture

- **Modular Spider Service Layer**: Refactored core analyzer into specialized services for better maintainability
  - `SpiderCacheCoordinator`: Centralized cache coherence management
  - `SpiderGraphCrawler`: Dependency graph traversal logic
  - `SpiderSymbolService`: Symbol-level analysis features
  - `SpiderIndexingService`: Background indexing operations
  - `SpiderDependencyAnalyzer`: Single file dependency analysis
  - `SpiderReferenceLookup`: Reverse dependency lookups

## v1.3.3

### Improvements

**Architecture Refactoring**:
- **Enhanced service layer architecture**: Refactored `GraphProvider` by extracting functionality into 10 specialized service modules for improved maintainability and reliability

**Analyzer Enhancements**:
- **New helper modules**: Added specialized modules for better code organization and performance

**Performance & Reliability**:
- Improved background indexing stability with better state synchronization
- Enhanced file change detection with clearer separation of concerns
- More robust cache invalidation and index updates
- Better error handling across the codebase

## v1.3.2

### Bug Fixes

**Critical ReverseIndex Bug Fix**:
- **Fixed reference persistence issue**: References would disappear from the reverse index after file re-analysis, causing the "Get References" button to incorrectly show no parent files. This affected both the VS Code extension and the MCP server.

**Webview State Management**:
- **Fixed stale references display**: After navigating to a new file, the webview would retain old references and not request new ones

**Initial Indexing Display**:
- **Fixed missing parent counts on initial load**: When opening a file before background indexing completed, parent counts wouldn't appear

**Refresh Button Bug**:
- **Fixed refresh clearing symbol view**: Clicking the refresh button in symbol view would incorrectly switch back to file view, causing GraphQL files and other files in symbol mode to appear empty

**ReverseIndex Degradation During Navigation**:
- **Fixed progressive loss of dependencies and references**: When navigating between files through the webview, references would progressively disappear because cached files weren't updating the ReverseIndex

## v1.3.1

### Bug Fixes

<div align="center">
  <img src="media/Graph-It-Live-small-ui-fix.png" alt="small UI fix" width="600"/>
  <p><em>small UI fix</em></p>
</div>

- UI Fix: Correct **icon display** for symbol view button in drill-down mode.
- UI Fix: Remove redundant button in webview.
- UI Fix: **Adjust node height**.
- UI Fix: Correct symbol view icon.
- UI Fix: All **actions buttons** (refresh, expand/collapse, switch view) are now in the top-right corner of webview or panel menu for consistency.
- Logging Fix: Ensure log messages from webview are correctly sent to extension logger.

## v1.3.0

### New Features

- **Symbol-Level Drill-Down View**: Double-click any file node to explore function-to-function and class-to-class dependencies within files. Navigate back with the "Back to Files" button.

<div align="center">
  <img src="media/drill-down-symbol-view.png" alt="Symbol-level drill-down view" width="600"/>
  <p><em>Symbol-level dependencies: see how functions and classes relate within a file</em></p>
</div>

- **O(1) Symbol Reverse Index**: Instant lookup of symbol callers via `SymbolReverseIndex`
  - Separates runtime callers from type-only imports (`isTypeOnly`)
  - Background indexing builds symbol-level reverse lookup table
  - 6x+ faster than O(n) scanning for caller queries
- **Breaking Change Detection**: Analyze impact of function signature changes
  - Detects added/removed/modified parameters and return type changes
  - Reports all affected callers that may need updates
- **Enhanced MCP Tools**: Added 8 new tools for AI/LLM integration (17 total)
  - `graphItLive_setWorkspace`: Set project directory for analysis
  - `graphItLive_getSymbolGraph`: Analyze symbol-level dependencies within a file
  - `graphItLive_findUnusedSymbols`: Detect unused exported symbols (dead code)
  - `graphItLive_getSymbolDependents`: Find all symbols depending on a specific symbol
  - `graphItLive_traceFunctionExecution`: Trace complete execution path through function calls
  - `graphItLive_getSymbolCallers`: O(1) instant lookup of symbol callers
  - `graphItLive_analyzeBreakingChanges`: Detect breaking changes in function signatures
  - `graphItLive_getImpactAnalysis`: Full impact analysis combining callers and breaking changes

### Improvements

- **Inline class expansion**: Class members expand inside the node (accordion-style), not as separate graph nodes
- **Line navigation**: Clicking on a symbol navigates to its exact line in the editor
- **Webview default position**: Now, in first installation, the graph view panel appears in the bottom panel by default for better visibility. You can move it back to the side panel or wherever you prefer.

<div align="center">
  <img src="media/Graph-It-Live-default-panel.png" alt="Webview default position in bottom panel" width="600"/>
  <p><em>Webview default position: bottom panel for better visibility</em></p>
</div>

- **New commands**: You can check current indexing status with `Graph-It-Live: Show Indexing Status` and reindex the workspace with `Graph-It-Live: Reindex Workspace`.

## v1.2.1

- Enhance file dependencies resolution with better support of monorepos workspaces.

## v1.2.0


- Introduce support for MCP (Multi-Context Processing) server to enable AI/LLM integrations. Use it with Github Copilot, Cursor, Antigravity, etc. Let's chat about your code!

<div align="center">
  <img src="media/graph-it-live-tools-in-copilot.gif" alt="Using Graph-It-Live tools with GitHub Copilot" width="800"/>
  <p><em>Using Graph-It-Live dependency analysis tools with GitHub Copilot</em></p>
</div>

- Add new configuration option `graph-it-live.enableMcpServer` to enable/disable MCP server.
<div align="center">
  <img src="media/enable-mcp-server-tools.gif" alt="Enable MCP Server in VS Code Settings" width="800"/>
  <p><em>Enabling the MCP Server in VS Code Settings</em></p>
</div>

- Better indexation performance with configurable concurrency via `graph-it-live.indexingConcurrency`.

## v1.1.5

- Add support for GraphQL schema files (`.gql` and `.graphql`).
- GraphQL nodes are now displayed with a pink border (#e535ab) matching the official GraphQL brand color.
- Implement import parsing for GraphQL `#import` directives.
- Enhance reference lookup by indexing files

## v1.1.4

- Fix a bug that caused incorrect display on Windows systems.

## v1.1.3

- Improve cross-platform path handling.

## v1.1.2

- Fix a bug that show orphan cycle edge in certain cases.
