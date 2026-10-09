# Frontend/Webview Structure

**Last Updated:** 2026-09-15
**Layer:** React + ReactFlow (Browser Context)
**Files:** 28 in `src/webview/`

## Directory: `src/webview/`

### Main Components

#### Root Component & Entry Points

```
index.tsx
└→ Main webview entry point → dist/webview.js (file + symbol graph)

App.tsx (450+ lines)
├─→ Main webview entry point
├─→ State management: graph data, filters, view mode
├─→ Handles messages from extension
├─→ Command panel integration
└─→ Coordinates all child components
```

**State:**

- `graphData` - Current graph (nodes, edges, labels)
- `unusedFilter` - Toggle unused dependencies
- `expandAll` - Expand/collapse all nodes
- `viewMode` - 'hierarchy' | 'dependency'
- `rootFilePath` - Entry file for the graph

#### Main Graph View

```
components/reactflow/ReactFlowGraph.tsx (300+ lines)
├─→ ReactFlow wrapper component
├─→ Custom node types (file nodes, symbol nodes)
├─→ Custom edge types (dependency edges, call edges)
├─→ Layout: Dagre hierarchical layout
├─→ Interactions: zoom, pan, fit view
└─→ React.memo for performance
```

**Features:**

- Auto-layout on data change
- Fit view on mount/reset
- Custom node styling
- Edge animations
- Cycle highlighting

#### Call Graph Panel (Separate Bundle)

```
callgraph/index.tsx (19 lines)
└→ Separate React entry point → dist/callgraph.js (Cytoscape.js panel)
```

**Cytoscape Components:**

```
components/cytoscape/CytoscapeGraph.tsx (755 lines)
├→ Cytoscape.js graph with cytoscape-fcose compound layout
├→ Compound parent nodes grouped by folder
├→ Handles showCallGraph / callGraphIndexing extension messages
├→ Node tap → callGraphOpenFile command to extension
└→ Cycle indicator: red dashed edges for cyclic relationships

components/cytoscape/CytoscapeTheme.ts (366 lines)
├→ Style objects derived from LANGUAGE_COLORS constants
├→ Language-based node colouring (TS/JS/Python/Rust)
└→ Red dashed edges for cyclic relationships

components/cytoscape/GraphLegend.tsx (259 lines)
├→ Filter overlay for call graph panel
├→ Accessible <label> checkboxes for language/type filters
└→ Posts callGraphFilterChanged on toggle
```

**Critical rules for Cytoscape:**

- `NodeSingular` has no `.hide()`/`.show()`. Use collection API: `cy.elements().removeStyle("display")` then `cy.nodes('[type="X"]').style("display", "none")`
- Messages use discriminated union on `type` (extension→webview) and `command` (webview→extension)

#### Graph Building

```
components/reactflow/buildGraph.ts (500+ lines)
├─→ Transforms data → ReactFlow format
├─→ buildReactFlowGraph(data, callbacks)
├─→ Node creation & positioning
├─→ Edge creation & styling
└─→ Cycle detection markers
```

**Callbacks:**

```typescript
interface BuildGraphCallbacks {
  onDrillDown: (nodeId: string) => void;
  onFindReferences: (nodeId: string) => void;
  onToggleParents: (nodeId: string) => void;
  onToggle: (nodeId: string, expanded: boolean) => void;
  onExpandRequest: (nodeId: string) => void;
}
```

#### Symbol Views

```
components/AtomicSymbolGraph.tsx (400+ lines)
├─→ Symbol-level dependency visualization
├─→ Drill-down into files
├─→ Symbol detail cards
├─→ Unused symbol highlighting
└→ Call hierarchy view with cross-file callers from Call Graph SQLite DB

components/SymbolCardView.tsx (200+ lines)
├→ Symbol information cards
├→ Shows: name, type, export status
├→ Actions: expand, find refs
└→ Used vs unused indicators
```

#### Hooks

```
hooks/useGraphData.ts (442 lines)
├→ Custom hook for graph data fetching and state management
├→ Handles graph data updates, merging, and expansion state
└→ Used by App.tsx to separate data logic from rendering
```

#### ReactFlow Custom Components

```
components/reactflow/FileNode.tsx
├─→ Custom file node renderer
└─→ Shows filename, language icon, collapse toggle

components/reactflow/SymbolNode.tsx
├─→ Custom symbol node renderer
└─→ Color-coded by symbol type

components/reactflow/LanguageIcon.tsx
└─→ Language badge (TS/JS/Python/Rust/GraphQL)

components/reactflow/ExpansionOverlay.tsx
└─→ Overlay indicator for nodes with unexpanded children

components/reactflow/layout.ts
└─→ Dagre layout helpers, auto-layout on data change

components/reactflow/CommunityLegend.tsx
└─→ Legend overlay for community/cluster color coding (file graph)
```

**Note:** Cycle detection helpers (`cycles.ts`) moved to `src/analyzer/callgraph/cycleUtils.ts` — shared between the file graph and the call graph panel rather than duplicated per-webview.

### Utilities

#### Graph Manipulation

```
utils/graphUtils.ts (500+ lines)
├─→ calculateVisibleGraph() - Filter & hierarchy
├─→ detectCycles() - Cycle detection algorithm
├─→ isExternalPackage() - node_modules detection
├─→ getDisambiguatedLabel() - Unique labels
└─→ countFileNames() - Duplicate detection

utils/graphMerge.ts
├─→ mergeGraphData() - Combine graph datasets
└─→ Used when expanding nodes

utils/graphTraversal.ts
├─→ DFS/BFS traversal utilities
└─→ Path finding in the graph

utils/clusterUtils.ts
├─→ Group nodes into clusters
└─→ Folder-level grouping support

utils/symbolUtils.ts
├─→ Symbol-specific node helpers
└─→ Color mapping by symbol type

utils/path.ts
└─→ Path normalization for webview context

utils/communityColor.ts
└─→ Deterministic color assignment for graph communities/clusters

utils/fileGraphPresentation.ts
└─→ File-graph presentation/formatting helpers shared by App.tsx and buildGraph.ts
```

**Key Functions:**

```typescript
// Filter graph based on expansion state
calculateVisibleGraph(data, expanded, expandAll): GraphData

// Merge multiple graphs
mergeGraphData(base, additional): GraphData

// Find cycles in dependency graph
detectCycles(nodes, edges): string[][]

// Path utilities
getFileName(path): string
getParentDir(path): string
```

#### Node Utilities

```
utils/nodeUtils.ts (150+ lines)
├─→ getNodeLabel() - Format node labels
├─→ getNodeStyle() - Node styling
├─→ getEdgeStyle() - Edge styling
└─→ Symbol vs file node differentiation
```

#### State Management

```
utils/updateGraphReducer.ts (200+ lines)
├─→ Graph state reducer
├─→ Actions: expand, collapse, filter, refresh
├─→ Immutable updates
└─→ Type-safe state transitions
```

**Actions:**

```typescript
type GraphAction =
  | { type: "SET_GRAPH"; payload: GraphData }
  | { type: "EXPAND_NODE"; nodeId: string }
  | { type: "COLLAPSE_NODE"; nodeId: string }
  | { type: "TOGGLE_FILTER"; enabled: boolean }
  | { type: "RESET" };
```

#### Fit View Scheduling

```
utils/fitViewScheduler.ts (100+ lines)
├─→ Debounced fitView calls
├─→ Prevents layout thrashing
└─→ requestAnimationFrame optimization
```

### Message Protocol

#### Extension → Webview

```typescript
type ExtensionMessage =
  | { command: "showGraph"; data: GraphData }
  | { command: "updateGraph"; data: GraphData }
  | { command: "showSymbolGraph"; data: SymbolGraphData }
  | { command: "highlightUnused"; nodeIds: string[] }
  | { command: "showError"; message: string };
```

#### Webview → Extension

```typescript
type WebviewMessage =
  | { command: "refresh" }
  | { command: "expandAll" }
  | { command: "collapseAll" }
  | { command: "drillDown"; nodeId: string }
  | { command: "findReferences"; nodeId: string }
  | { command: "navigateToSource"; filePath: string; line?: number }
  | { command: "toggleUnusedFilter"; enabled: boolean };
```

### Styling & Theming

#### VS Code Theme Integration

```typescript
// CSS variables from VS Code
--vscode - foreground;
--vscode - background;
--vscode - editor - foreground;
--vscode - editor - background;
--vscode - button - background;
--vscode - input - background;
```

#### Custom Styles

```
src/webview/styles/
├─→ App.css - Global styles
├─→ ReactFlow overrides
└─→ Theme-aware colors
```

### ReactFlow Configuration

**Node Types:**

```typescript
const nodeTypes = {
  file: FileNode, // Standard file nodes
  symbol: SymbolNode, // Symbol-level nodes
  external: ExternalNode, // node_modules packages
};
```

**Edge Types:**

```typescript
const edgeTypes = {
  dependency: DependencyEdge, // File dependencies
  call: CallEdge, // Function calls
  import: ImportEdge, // Import statements
};
```

**Layout:**

```typescript
// Dagre hierarchical layout
const dagreGraph = new dagre.graphlib.Graph();
dagreGraph.setGraph({
  rankdir: "LR", // Left-to-right
  nodesep: 100, // Node separation
  ranksep: 150, // Rank separation
  edgesep: 50, // Edge separation
});
```

### Performance Optimizations

1. **React.memo** - Prevent unnecessary re-renders
2. **useMemo** - Memoize expensive calculations
3. **useCallback** - Stable callback references
4. **Virtualization** - Large graphs (future enhancement)
5. **Debouncing** - fitView, search, filters
6. **requestAnimationFrame** - Smooth animations

**Critical Pattern:**

```typescript
// ✅ Correct: Callbacks in ref, not deps
const callbacksRef = useRef({ onDrillDown, onFindReferences });
callbacksRef.current = { onDrillDown, onFindReferences };

const graph = useMemo(() => {
  return buildGraph(data, callbacksRef.current);
}, [data]); // Only data in deps, not callbacks
```

### State Management Patterns

**Local State:**

- Component-level with `useState`
- Derived state with `useMemo`
- Refs for non-reactive values

**Global State:**

- VS Code state API for persistence
- Message passing for cross-component communication

### Error Handling

**User-Facing Errors:**

- Parse errors → Show notification
- File not found → Highlight in graph
- Analysis timeout → Progress indicator

**Error Boundaries:**

- Catch React errors
- Display fallback UI
- Report to extension

### Testing

**Webview Tests:**

- Component tests with @testing-library/react
- Graph utility tests
- Message protocol tests
- Integration tests with mock vscode API

**Coverage:** ~85% of webview code

### Build Output

**Bundle:**

```
dist/
├→ webview.js - Main React app bundle (file graph + symbol graph)
├→ callgraph.js - Separate React bundle for call graph panel (Cytoscape.js)
├→ wasm/ - WASM files (tree-sitter parsers, sql-wasm)
└→ *.js - Extension, worker, MCP bundles
```

**Build Tool:** esbuild via `esbuild.js`

- Dual entry points: `webview/index.tsx` → `dist/webview.js`, `webview/callgraph/index.tsx` → `dist/callgraph.js`
- React JSX transformation
- CSS bundling
- Minification for production

### Accessibility

**Keyboard Navigation:**

- Tab through nodes
- Enter to expand/collapse
- Arrow keys for graph navigation

**Screen Reader Support:**

- Semantic HTML
- ARIA labels
- Focus management

**Theme Support:**

- High contrast mode
- Dark/light theme switching
- VS Code theme integration
