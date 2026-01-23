# Data Model: LSP-Based Call Hierarchy

**Feature**: 001-lsp-call-hierarchy  
**Date**: 2026-01-15  
**Status**: Phase 1 - Data Model Complete

## Core Entities

### SymbolNode

Represents a code symbol (function, class, method, variable) discovered via LSP.

**Fields**:

- `id: string` - Unique identifier: `${filePath}:${symbolName}` (e.g., `src/utils.ts:calculateSum`)
- `name: string` - Display name (may be contextual for anonymous functions, e.g., "map callback")
- `originalName?: string` - Original AST name if different from display name (for anonymous functions)
- `kind: vscode.SymbolKind` - LSP symbol kind enum: Function, Class, Method, Variable, etc.
- `type: 'class' | 'function' | 'variable'` - Simplified category for color coding
- `range: { start: number; end: number }` - Line range in file (1-indexed)
- `isExported: boolean` - Whether symbol is exported (for external call detection)
- `isExternal: boolean` - Whether symbol is defined in a different file (dimmed rendering)
- `parentSymbolId?: string` - ID of containing symbol (for nested methods in classes)

**Validation Rules**:

- `id` must be unique within an `IntraFileGraph`
- `range.start` must be ≤ `range.end`
- `kind` must be a valid `vscode.SymbolKind` value
- `type` must be derived from `kind` (Function/Method → 'function', Class/Interface → 'class', Variable/Constant → 'variable')

**State Transitions**:

- Created: When LSP `executeDocumentSymbolProvider` returns symbol
- External flag set: When call hierarchy detects target symbol is from different file URI
- Updated: When file is edited and LSP re-analysis occurs (lazy via debounce)

---

### CallEdge

Represents a relationship between symbols (function call or variable reference).

**Fields**:

- `source: string` - Caller symbol ID (SymbolNode.id)
- `target: string` - Callee symbol ID (SymbolNode.id)
- `relation: 'calls' | 'references'` - Type of relationship

- `line: number` - Line number where call/reference occurs in source (for navigation)
- `isCycle: boolean` - Whether this edge participates in a circular dependency

**Validation Rules**:

- `source` must reference an existing `SymbolNode.id`
- `target` must reference an existing `SymbolNode.id`

- `source` ≠ `target` (no self-loops, except for recursive calls which are valid)
- `relation` must be either 'calls' or 'references'
- `line` must be within source symbol's range

**State Transitions**:

- Created: When LSP `executeOutgoingCallsProvider` returns call relationship
- Cycle flag set: When graph analysis detects circular path (source → ... → source)
- Updated: When file is edited and LSP re-analysis occurs

---

### IntraFileGraph

Container for all symbols and relationships within a single file.

**Fields**:

- `filePath: string` - Absolute path to the file being analyzed (normalized)

- `nodes: SymbolNode[]` - All symbols discovered in the file
- `edges: CallEdge[]` - All call/reference relationships between symbols
- `generatedAt: Date` - Timestamp of graph generation (for cache invalidation)
- `lspProvider: string` - Name of LSP that provided data (e.g., "typescript", "pylance", "rust-analyzer")
- `isPartial: boolean` - Whether graph is incomplete due to LSP timeout

**Validation Rules**:

- `filePath` must be absolute and normalized (forward slashes, lowercase drive letters)
- All `edges[].source` and `edges[].target` must reference `nodes[].id`
- `nodes[].id` must be unique within this graph
- `lspProvider` must be non-empty string

**State Transitions**:

- Created: When user drills down into file node
- Updated: When file is saved and debounce timer fires (500ms, FR-016)

- Invalidated: When file is closed or different file is drilled into

---

### BreadcrumbPath

Navigation component showing hierarchical path from project root to current file.

**Fields**:

- `segments: BreadcrumbSegment[]` - Ordered list of path segments

**BreadcrumbSegment**:

- `label: string` - Display text (e.g., "Project", "src", "utils.ts")
- `path?: string` - Absolute file path (only for file segments, undefined for "Project")
- `isActive: boolean` - Whether this is the current location

**Validation Rules**:

- `segments` must have at least 2 elements (["Project", ...filename])
- Exactly one segment must have `isActive: true`
- File segments must have `path` defined

**State Transitions**:

- Created: When symbol graph is displayed
- Updated: When navigating to different file or switching back to project view

---

## Relationships

```
IntraFileGraph (1) ──< (N) SymbolNode
IntraFileGraph (1) ──< (N) CallEdge
SymbolNode (1) ──< (N) CallEdge [as source]
SymbolNode (1) ──< (N) CallEdge [as target]
SymbolNode (0..1) ──< (N) SymbolNode [parent-child for nested symbols]
```

---

## Data Flow

1. **User Action**: Double-click file node in global dependency graph
2. **Extension**: `GraphProvider.handleDrillDown(filePath)` called
3. **Service**: `SymbolViewService.buildSymbolGraph(filePath)` invoked
4. **LSP Calls**:
   - `vscode.executeDocumentSymbolProvider(uri)` → array of symbols
   - For each symbol: `vscode.executePrepareCallHierarchy(uri, position)` → call hierarchy item
   - For each item: `vscode.executeOutgoingCallsProvider(item)` → array of calls
5. **Analyzer**: `LspCallHierarchyAnalyzer.analyze()` parses LSP results:
   - Creates `SymbolNode[]` from document symbols
   - Filters out external calls (different file URI)
   - Creates `CallEdge[]` from call hierarchy with `relation: 'calls'`
   - Detects cycles using DFS traversal

6. **Graph**: `IntraFileGraph` constructed with nodes + edges
7. **Webview**: `SymbolGraphView` receives graph via message protocol
8. **ReactFlow**: `buildReactFlowGraph()` converts to ReactFlow nodes/edges
9. **Layout**: Dagre hierarchical layout applied (top-bottom, FR-015)
10. **Render**: Symbol nodes displayed with color coding (FR-010)

---

## Cache Strategy

**No persistent caching**: Symbol graphs are computed on-demand (lazy loading, FR-017)

**In-memory caching**:

- Last generated `IntraFileGraph` stored in `SymbolViewService`
- Cache invalidated on:
  - File save (after 500ms debounce, FR-016)
  - File close

  - User navigates to different file
- Cache key: Normalized file path

**Rationale**: LSP responses are fast enough (< 2 seconds, SC-001) that disk caching adds complexity without measurable benefit. In-memory cache prevents redundant LSP calls during rapid view switches.

---

## Error States

**Empty Graph** (FR-018):

- `IntraFileGraph` with empty `nodes[]` and `edges[]`
- UI displays: "This file contains no functions or classes to visualize"

**Partial Graph** (FR-020):

- `IntraFileGraph` with `isPartial: true` flag
- UI displays warning: "Symbol analysis incomplete (LSP timeout)"
- Graph shows symbols discovered before timeout

**LSP Unavailable** (FR-009):

- Service catches LSP error (e.g., `TypeError: vscode.executeDocumentSymbolProvider is not a function`)
- UI displays: "Symbol analysis not available for this file type"

**Unsupported File Type**:

- Pre-checked before LSP call (file extension not in supported list)
- UI displays same message as LSP unavailable

---

## Type Definitions (TypeScript)

```typescript
// src/shared/types.ts additions

export interface SymbolNode {
  id: string;
  name: string;
  originalName?: string;
  kind: vscode.SymbolKind;
  type: 'class' | 'function' | 'variable';
  range: { start: number; end: number };
  isExported: boolean;
  isExternal: boolean;
  parentSymbolId?: string;
}

export interface CallEdge {
  source: string;
  target: string;
  relation: 'calls' | 'references';
  line: number;
  isCycle: boolean;
}

export interface IntraFileGraph {
  filePath: string;
  nodes: SymbolNode[];
  edges: CallEdge[];
  generatedAt: Date;
  lspProvider: string;
  isPartial: boolean;
}

export interface BreadcrumbSegment {
  label: string;
  path?: string;
  isActive: boolean;
}

export interface BreadcrumbPath {
  segments: BreadcrumbSegment[];
}
```

---

## Summary

Data model complete with 4 core entities: `SymbolNode`, `CallEdge`, `IntraFileGraph`, `BreadcrumbPath`. All validation rules defined. Data flow documented from user action → LSP → analyzer → webview. Cache strategy: in-memory only, no disk persistence. Error states mapped to user-visible messages (FR-009, FR-018, FR-020).

Ready to proceed to **API Contracts** generation.
