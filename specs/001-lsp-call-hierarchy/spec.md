# Feature Specification: LSP-Based Call Hierarchy & Symbol Drill-Down

**Feature Branch**: `001-lsp-call-hierarchy`  
**Created**: 2026-01-15  
**Status**: Draft  
**Input**: User description: "Symbol-Level Drill-Down & Call Hierarchy using VS Code LSP for multi-language support"

## Existing Implementation Analysis *(mandatory for enhancements)*

### Current State

Graph-It-Live currently implements **file-level dependency analysis** with the following capabilities:

**✅ Already Implemented:**
- File-to-file dependency crawling using AST-based import parsing (TypeScript, JavaScript, Python, Rust)
- ReactFlow-based graph visualization with Force-Directed layout
- Double-click interaction on file nodes (currently shows file content preview)
- MCP server with `graphItLive_crawlDependencyGraph` tool exposing file-level dependencies
- Background indexing with `ReverseIndex` for "find referencing files" queries
- Multi-language support via ts-morph (TS/JS) and tree-sitter (Python/Rust)
- Symbol-level analysis infrastructure in `SymbolAnalyzer.ts` (extracts function/class names from AST)

**Partial Implementation:**
- `SymbolAnalyzer.ts` already parses symbols (functions, classes, methods) from files
- Symbol names are extracted but **not used for visualization** (only for internal indexing)
- No call hierarchy analysis exists (no function-to-function relationship mapping)
- No LSP integration (current analysis is custom AST parsing, not LSP-based)

**❌ Not Implemented:**
- Intra-file symbol graph visualization (symbol-level nodes and edges)
- LSP API integration (`vscode.executePrepareCallHierarchy`, `vscode.executeOutgoingCallsProvider`)
- Symbol node click navigation to code location
- Hierarchical (Sugiyama) layout for top-down call flow
- Call type differentiation (calls vs references)
- MCP tool `graphItLive_analyzeFileLogic` for symbol-level analysis
- Live updates on file edits with debouncing

### Migration Path

**Reusable Components:**
- `src/analyzer/SymbolAnalyzer.ts` - Can be extended to use LSP instead of custom AST parsing
- `src/webview/components/GraphView.tsx` - ReactFlow wrapper can support new node types
- `src/extension/GraphProvider.ts` - Service orchestration layer can add symbol view state
- `src/mcp/McpWorker.ts` - Tool registration pattern can be replicated for new MCP tool

**New Components Required:**
- `src/analyzer/LspCallHierarchyAnalyzer.ts` - New module to wrap LSP API calls
- `src/webview/components/SymbolGraphView.tsx` - New React component for symbol visualization
- `src/extension/services/SymbolViewService.ts` - New service to manage symbol view state
- `src/shared/types.ts` - Add `SymbolNode`, `CallEdge`, `IntraFileGraph` types

**Compatibility Considerations:**
- Must not break existing file-level graph functionality (views should be toggleable)
- Symbol analysis should be lazy (don't slow down initial file scan)
- MCP server must continue supporting existing tools while adding new symbol tool

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Basic Symbol Navigation Within File (Priority: P1)

A developer working on a large TypeScript file wants to understand how functions call each other without reading through hundreds of lines of code. They double-click a file node in the dependency graph, and the view transitions to show all functions and classes as nodes, with arrows showing which functions call which. Clicking a function node scrolls the editor to that function's definition.

**Why this priority**: This is the core MVP - users can immediately understand code structure within a single file without external dependencies or complex LSP features. Delivers value for the most common use case (TypeScript/JavaScript).

**Independent Test**: Can be fully tested by opening a TypeScript file with multiple functions, double-clicking its node in the graph, verifying the symbol graph displays with call relationships, and clicking a symbol to navigate in the editor.

**Acceptance Scenarios**:

1. **Given** a file node in the global dependency graph, **When** user double-clicks the node, **Then** the view smoothly transitions to show an intra-file symbol graph with all functions and classes as nodes
2. **Given** the intra-file symbol graph is displayed, **When** user clicks on a function/class node, **Then** VS Code editor scrolls to the corresponding line of code
3. **Given** the intra-file symbol graph is displayed, **When** user clicks "Back to Project" button, **Then** view returns to the global file dependency graph
4. **Given** multiple functions in a file, **When** function A calls function B, **Then** a solid arrow connects A → B in the symbol graph

---

### User Story 2 - Multi-Language Support via LSP (Priority: P2)

A developer working in a polyglot codebase (TypeScript, Python, Rust) wants consistent symbol-level navigation across all languages. They drill down into a Python file, then a Rust file, and see the same graph-based representation of functions and their relationships, automatically detected via the LSP.

**Why this priority**: Extends core functionality to all supported languages (Python, Rust) without custom parsers. Critical for multi-language projects but depends on P1 infrastructure.

**Independent Test**: Can be tested by drilling down into Python and Rust files with known function calls, verifying symbol graphs display correctly with call hierarchy detected via LSP providers.

**Acceptance Scenarios**:

1. **Given** a Python file with multiple functions, **When** user drills down, **Then** symbol graph displays Python functions with call relationships using LSP
2. **Given** a Rust file with functions and methods, **When** user drills down, **Then** symbol graph displays Rust symbols with proper visibility detection (pub vs private)
3. **Given** a file in unsupported language (no LSP available), **When** user attempts drill-down, **Then** system shows graceful error: "Symbol analysis not available for this file type"

---

### User Story 3 - Visual Differentiation & Call Types (Priority: P2)

A developer analyzing complex code wants to quickly distinguish between different symbol types and relationship kinds. Classes appear in deep purple, functions in blue, and variables in amber. Solid arrows show direct function calls, while dashed arrows show variable/constant references.

**Why this priority**: Improves comprehension speed through visual encoding. Important for UX but not blocking for basic functionality.

**Independent Test**: Can be tested by drilling down into a file with mixed symbol types (classes, functions, variables) and verifying color coding and edge styles match specifications.

**Acceptance Scenarios**:

1. **Given** an intra-file graph with multiple symbol types, **When** rendered, **Then** classes are deep purple, functions are vibrant blue, variables are amber
2. **Given** function A calls function B, **When** displayed in graph, **Then** edge is solid arrow labeled "calls"
3. **Given** function A references constant X, **When** displayed in graph, **Then** edge is dashed arrow labeled "references"

---

### User Story 4 - AI-Powered Analysis via MCP (Priority: P3)

An AI assistant (Claude, GitHub Copilot) needs to explain code logic or suggest refactoring. The MCP server exposes a new `analyze_file_logic` tool that returns the call graph in TOON format. The AI uses this to understand execution flow and provide accurate architectural insights.

**Why this priority**: Extends the feature to AI use cases. Valuable but depends on P1/P2 being stable and can be added after core human UX is solid.

**Independent Test**: Can be tested by calling the MCP tool with a file path and verifying the returned TOON format accurately represents the call hierarchy, then testing with an AI agent to confirm it can explain code flow.

**Acceptance Scenarios**:

1. **Given** MCP server is running, **When** AI calls `analyze_file_logic(file_path)`, **Then** returns symbol graph in TOON format with nodes and edges
2. **Given** AI receives call graph data, **When** asked "What does function X do?", **Then** AI accurately explains function's role based on call relationships
3. **Given** complex nested function calls, **When** AI analyzes via MCP, **Then** response uses minimal tokens due to TOON optimization

---

### User Story 5 - Live Updates & Performance (Priority: P3)

A developer edits a function in the file while the symbol graph is displayed. After 500ms of no typing, the graph automatically updates to reflect new function calls or removed relationships. The update is incremental and doesn't cause UI lag.

**Why this priority**: Nice-to-have polish for active development workflows. Can be deferred until core functionality is proven stable.

**Independent Test**: Can be tested by opening symbol graph, editing function bodies to add/remove calls, and verifying graph updates after debounce period without performance degradation.

**Acceptance Scenarios**:

1. **Given** intra-file symbol graph is displayed, **When** developer adds new function call in editor, **Then** graph updates after 500ms to show new edge
2. **Given** intra-file symbol graph is displayed, **When** developer removes function call, **Then** corresponding edge disappears from graph after 500ms
3. **Given** large file (500+ lines), **When** symbol graph is computed, **Then** UI remains responsive (< 100ms freeze)

---

### Edge Cases

- ✅ **Empty files**: Display empty state with message "This file contains no functions or classes to visualize" + suggestion (FR-018)
- ✅ **Circular calls (recursion)**: Show bidirectional arrows with "cycle" badge on edge (FR-019)
- ✅ **Slow LSP providers**: Progress indicator for 5 seconds, then show partial results with timeout warning (FR-020)
- ✅ **Anonymous functions/lambdas**: Use contextual naming like "map callback", "onClick handler" (FR-021)
- ✅ **External references**: Display as dimmed nodes with dashed edges to distinguish from internal symbols (FR-022)
- What if a file has deeply nested classes (class within class within class)? - Recursive processing handles nesting (FR-013)

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST use `vscode.executeDocumentSymbolProvider` to discover all symbols (functions, classes, methods) within a file
- **FR-002**: System MUST use `vscode.executePrepareCallHierarchy` and `vscode.executeOutgoingCallsProvider` to determine call relationships
- **FR-003**: System MUST filter LSP results to show only intra-file relationships (exclude external imports)
- **FR-004**: System MUST provide "Drill-Down" trigger via double-click on file node in global dependency graph
- **FR-005**: System MUST render symbol graph using ReactFlow with distinct node types for Classes, Functions, Variables
- **FR-006**: System MUST implement breadcrumb navigation showing `Project > Folder > filename.ts`
- **FR-007**: System MUST provide "Back to Project" button to exit symbol view and return to file dependency graph
- **FR-008**: System MUST support TypeScript, JavaScript, Python, and Rust symbol analysis via LSP
- **FR-009**: System MUST show graceful degradation when LSP is unavailable or unsupported for a language
- **FR-010**: System MUST use color coding: Classes (deep purple), Functions (vibrant blue), Variables (amber)
- **FR-011**: System MUST differentiate call types: solid arrows for function calls, dashed arrows for references
- **FR-012**: System MUST enable clicking on symbol nodes to navigate editor to corresponding line
- **FR-013**: System MUST recursively process nested symbols (methods inside classes)
- **FR-014**: MCP server MUST expose new tool `graphItLive_analyzeFileLogic` with TOON format output
- **FR-015**: Symbol graph rendering MUST use Hierarchical (Sugiyama) layout instead of Force-Directed for top-down execution flow
- **FR-016**: System MUST implement 500ms debounce for live updates when file is edited
- **FR-017**: Symbol graph computation MUST be lazy-loaded only on drill-down action (not pre-computed)
- **FR-018**: When file has no analyzable symbols, system MUST display empty state with message "This file contains no functions or classes to visualize" and suggest trying another file
- **FR-019**: Circular function calls (recursion) MUST be displayed with bidirectional arrows and a "cycle" badge on the edge
- **FR-020**: When LSP provider is slow (>5 seconds), system MUST show progress indicator for 5 seconds, then display partial results if available with warning "Symbol analysis incomplete (LSP timeout)"
- **FR-021**: Anonymous functions or lambdas MUST be represented with contextual naming based on assignment/usage (e.g., "map callback", "filter predicate", "onClick handler")
- **FR-022**: External function calls (to imported functions from other files) MUST be shown as dimmed/grayed-out nodes (opacity: 0.5) with dashed edges to visually distinguish them from internal symbols

## Clarifications

### Session 2026-01-15

- Q: When a user drills down into a file with no analyzable symbols (empty file, only comments, or all imports), what should the graph display? → A: Display empty state with message: "This file contains no functions or classes to visualize" + suggestion to try another file
- Q: When the system detects circular function calls (function A calls B, B calls A, or deeper cycles), how should recursive relationships be shown in the graph? → A: Display bidirectional arrow with small "cycle" badge on the edge
- Q: When an LSP provider is slow or unresponsive (takes >5 seconds to return symbols), what should the user experience be? → A: Show progress indicator for 5 seconds, then display partial results if any, with warning: "Symbol analysis incomplete (LSP timeout)"
- Q: How should anonymous functions or lambdas (e.g., `array.map(x => x * 2)` or Python lambdas) be represented in the symbol graph? → A: Use contextual naming based on assignment/usage: "map callback", "filter predicate", "onClick handler"
- Q: When the system encounters calls to imported functions from other files (external references), how should these be handled in the intra-file symbol graph? → A: Show external calls as dimmed/grayed-out nodes with dashed edges to indicate they're from other files

### Session 2026-01-16

- Q: When a SymbolNode represents an anonymous function like `array.map(x => x * 2)`, which name should appear in the graph visualization? → A: Display contextual name (e.g., "map callback") in the graph, store original AST name (if any) in separate `originalName` field for traceability. The `name` field is for human-readable display, `originalName` preserves AST identity.
- Q: Are the 5-second LSP timeout (FR-020) and 600ms live update target (SC-006) in conflict or measuring different operations? → A: They are separate concerns with no conflict. 5s LSP timeout applies to initial symbol discovery when drilling down into a file. 600ms live update is: 500ms debounce (waiting for user to stop typing) + 100ms render (graph update) during active editing.
- Q: Should the breadcrumb component use ">" as a hardcoded visual separator in the UI regardless of the underlying platform path separator? → A: Yes. Always display ">" for cross-platform UI consistency. Internally, use `path.sep` for path operations, then convert to ">" only for display rendering in BreadcrumbNav component.
- Q: Should the E2E performance test (T087) measure full drill-down time or just UI freeze time? → A: Measure full end-to-end drill-down time (from double-click file node to graph fully rendered) and verify < 2 seconds for 1000-line files per SC-001. Also verify UI freeze < 100ms per SC-005.
- Q: What opacity value should be used for dimming external symbols (FR-022)? → A: Use opacity: 0.5 (50% transparent). This provides standard semi-transparent effect that clearly distinguishes external from internal symbols while maintaining readability across both light and dark themes.

### Key Entities

**Note**: For complete field definitions including validation rules and state transitions, see [data-model.md](./data-model.md).

- **SymbolNode**: Represents a code symbol (function, class, method, variable) with attributes: name, kind (from `vscode.SymbolKind`), range (line numbers), type (Class/Function/Variable)
- **CallEdge**: Represents a relationship between symbols with attributes: source (caller symbol name), target (callee symbol name), relation ('calls' or 'references')
- **IntraFileGraph**: Container holding all SymbolNodes and CallEdges for a specific file, generated on-demand when user drills down
- **BreadcrumbPath**: Navigation component showing hierarchical path from project root to current file being analyzed

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can drill down into any TypeScript file and see symbol-level graph within 2 seconds on files up to 1000 lines
- **SC-002**: Symbol graph correctly identifies at least 95% of function calls in TypeScript test suite (verified against known call relationships)
- **SC-003**: Multi-language support works for Python and Rust with same interaction model as TypeScript (no language-specific UI differences)
- **SC-004**: AI agents using MCP tool can explain code flow with 90% accuracy when tested against 20 sample files with documented logic
- **SC-005**: Graph rendering remains responsive (<100ms UI freeze) for files with up to 100 symbols and 200 call relationships
- **SC-006**: Live updates reflect code changes within 600ms (500ms debounce + 100ms render) without full graph recomputation
- **SC-007**: Users can navigate from symbol node to code editor within 1 click/action (single click on node)
- **SC-008**: Breadcrumb navigation and "Back to Project" button allow users to return to file view within 1 click

## Assumptions *(optional)*

- LSP providers are correctly configured in VS Code for TypeScript, Python, and Rust
- VS Code API (`vscode.executeDocumentSymbolProvider`, `vscode.executePrepareCallHierarchy`) remains stable across VS Code versions 1.96+
- ReactFlow library supports Hierarchical layout algorithm (Sugiyama) without additional dependencies
- Performance targets assume standard developer hardware (4GB+ RAM, quad-core CPU)
- MCP server consumers (AI agents) can parse TOON format efficiently

## Out of Scope *(optional)*

- Cross-file call hierarchy (calls from File A → File B remain in global dependency graph, not symbol view)
- Editing capabilities within symbol graph (read-only visualization)
- Real-time collaboration features (multiple users viewing same symbol graph)
- Historical analysis (showing how call graph evolved over git commits)
- Integration with debugger (setting breakpoints from graph nodes)
- Performance profiling integration (showing hot paths in call graph)
- Support for languages without LSP providers (C, C++ without clangd)
- Custom layout algorithms beyond Hierarchical (no user-configurable layouts)

## Technical Notes *(optional - for complex features)*

### LSP Integration Strategy

The feature leverages three VS Code LSP commands:

1. **`vscode.executeDocumentSymbolProvider(uri)`**: Returns all symbols (functions, classes, variables) with their ranges
2. **`vscode.executePrepareCallHierarchy(uri, position)`**: Prepares call hierarchy for a specific symbol at given position
3. **`vscode.executeOutgoingCallsProvider(item)`**: Returns all outgoing calls from a prepared hierarchy item

**Critical Implementation Detail**: The system must filter results to exclude external calls (calls to symbols outside the current file URI). This ensures the graph only shows intra-file relationships.

### Performance Optimization

- **Lazy Computation**: Symbol graph is only computed on drill-down trigger, not pre-indexed during file scan
- **Debouncing**: Live updates use 500ms debounce to prevent excessive recomputation during active editing
- **Layout Caching**: Hierarchical layout computation is expensive; cache results until graph structure changes

### TOON Format for MCP

TOON (Tree Object Oriented Notation) is used to minimize token consumption when transmitting call graphs to AI:

```
nodes:Class:ClassName|Function:functionName|Variable:varName
edges:functionName>targetFunc|functionName~constantRef
```

This compressed format reduces token usage by ~40% compared to JSON for deep call stacks.
