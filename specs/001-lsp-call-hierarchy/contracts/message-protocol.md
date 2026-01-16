# Extension ↔ Webview Message Protocol

**Feature**: 001-lsp-call-hierarchy  
**Protocol**: Typed messages via `postMessage` API  
**Location**: `src/shared/types.ts` (extend existing types)

---

## New Message Types

### Extension → Webview Messages

#### 1. `symbolGraph` Message

Sent when symbol graph is ready to display.

```typescript
interface SymbolGraphMessage extends ExtensionToWebviewMessage {
  command: 'symbolGraph';
  filePath: string;           // File being analyzed
  isRefresh: boolean;         // True if refresh (preserve state), false if navigation
  data: {
    nodes: SymbolNode[];
    edges: CallEdge[];
    cycles: string[][];       // Array of symbol ID chains forming cycles
    breadcrumb: BreadcrumbPath;
  };
  warning?: string;           // Optional warning message (e.g., LSP timeout)
}
```

**When Sent**: After `SymbolViewService.buildSymbolGraph()` completes successfully

**Example**:
```json
{
  "command": "symbolGraph",
  "filePath": "/workspace/src/utils.ts",
  "isRefresh": false,
  "data": {
    "nodes": [
      {
        "id": "utils.ts:calculateSum",
        "name": "calculateSum",
        "type": "function",
        "range": { "start": 10, "end": 15 },
        "isExternal": false
      },
      {
        "id": "utils.ts:Logger",
        "name": "Logger",
        "type": "class",
        "range": { "start": 20, "end": 40 },
        "isExternal": false
      }
    ],
    "edges": [
      {
        "source": "utils.ts:calculateSum",
        "target": "utils.ts:Logger",
        "relation": "calls",
        "line": 12,
        "isCycle": false
      }
    ],
    "cycles": [],
    "breadcrumb": {
      "segments": [
        { "label": "Project", "isActive": false },
        { "label": "src", "path": "/workspace/src", "isActive": false },
        { "label": "utils.ts", "path": "/workspace/src/utils.ts", "isActive": true }
      ]
    }
  }
}
```

---

#### 2. `symbolAnalysisProgress` Message

Sent to show progress during LSP analysis.

```typescript
interface SymbolAnalysisProgressMessage extends ExtensionToWebviewMessage {
  command: 'symbolAnalysisProgress';
  status: 'started' | 'in-progress' | 'completed' | 'timeout' | 'error';
  processed?: number;   // Symbols processed so far (optional)
  total?: number;       // Total symbols to process (optional, may be unknown)
  message?: string;     // Optional status message
}
```

**When Sent**: 
- `started`: Immediately when drill-down triggered
- `in-progress`: Every 500ms during LSP calls (if available)
- `completed`: When LSP analysis finishes successfully
- `timeout`: After 5 seconds if LSP hasn't responded
- `error`: If LSP call fails

**Example**:
```json
{
  "command": "symbolAnalysisProgress",
  "status": "in-progress",
  "processed": 15,
  "total": 42,
  "message": "Analyzing symbols..."
}
```

---

#### 3. `symbolEmptyState` Message

Sent when file has no analyzable symbols.

```typescript
interface SymbolEmptyStateMessage extends ExtensionToWebviewMessage {
  command: 'symbolEmptyState';
  filePath: string;
  reason: 'no-symbols' | 'lsp-unavailable' | 'unsupported-file-type';
  message: string;      // User-facing message
}
```

**When Sent**: When symbol analysis completes but returns empty result

**Example**:
```json
{
  "command": "symbolEmptyState",
  "filePath": "/workspace/src/constants.ts",
  "reason": "no-symbols",
  "message": "This file contains no functions or classes to visualize. Try opening a file with executable code."
}
```

---

### Webview → Extension Messages

#### 1. `drillDown` Message (Enhanced)

Existing message extended to support symbol drill-down.

```typescript
interface DrillDownMessage extends WebviewToExtensionMessage {
  command: 'drillDown';
  filePath: string;           // File to drill into
  symbolId?: string;          // Optional: Drill into specific symbol within file
}
```

**When Sent**: User double-clicks file node or symbol node

**Example (file drill-down)**:
```json
{
  "command": "drillDown",
  "filePath": "/workspace/src/utils.ts"
}
```

**Example (symbol drill-down)**:
```json
{
  "command": "drillDown",
  "filePath": "/workspace/src/utils.ts",
  "symbolId": "utils.ts:calculateSum"
}
```

---

#### 2. `navigateToSymbol` Message

Navigate editor to symbol definition.

```typescript
interface NavigateToSymbolMessage extends WebviewToExtensionMessage {
  command: 'navigateToSymbol';
  filePath: string;
  symbolId: string;
  line: number;         // Line number to scroll to
}
```

**When Sent**: User clicks on symbol node in graph

**Example**:
```json
{
  "command": "navigateToSymbol",
  "filePath": "/workspace/src/utils.ts",
  "symbolId": "utils.ts:calculateSum",
  "line": 10
}
```

---

#### 3. `switchMode` Message (Enhanced)

Existing message extended to support view mode switching.

```typescript
interface SwitchModeMessage extends WebviewToExtensionMessage {
  command: 'switchMode';
  mode: 'file' | 'symbol';
}
```

**When Sent**: User clicks "Back to Project" button or "Symbol View" button

**Example**:
```json
{
  "command": "switchMode",
  "mode": "file"
}
```

---

## State Management

### Extension State (ProviderStateManager)

Extended to track symbol view state:

```typescript
interface ProviderState {
  // Existing fields...
  viewMode: 'file' | 'symbol';
  currentSymbol?: string;              // Current symbol being viewed (symbolId)
  symbolExpandedNodes: Set<string>;    // Expanded symbols in graph
}
```

### Webview State (React)

Extended to track symbol-specific state:

```typescript
interface AppState {
  // Existing fields...
  viewMode: 'file' | 'symbol';
  symbolGraph?: {
    nodes: SymbolNode[];
    edges: CallEdge[];
    cycles: string[][];
    breadcrumb: BreadcrumbPath;
  };
  symbolAnalysisInProgress: boolean;
}
```

---

## Message Flow Examples

### Scenario 1: User drills down into file

1. **User**: Double-clicks file node `src/utils.ts`
2. **Webview** → **Extension**: `{ command: 'drillDown', filePath: '/workspace/src/utils.ts' }`
3. **Extension**: Calls `SymbolViewService.buildSymbolGraph()`
4. **Extension** → **Webview**: `{ command: 'symbolAnalysisProgress', status: 'started' }`
5. **Extension**: Makes LSP calls (executeDocumentSymbolProvider, etc.)
6. **Extension** → **Webview**: `{ command: 'symbolAnalysisProgress', status: 'in-progress', processed: 10, total: 25 }`
7. **Extension**: LSP analysis completes
8. **Extension** → **Webview**: `{ command: 'symbolGraph', filePath: '...', data: { nodes, edges, cycles, breadcrumb } }`
9. **Webview**: Renders symbol graph with ReactFlow

---

### Scenario 2: User clicks symbol node

1. **User**: Clicks symbol node `calculateSum` in graph
2. **Webview** → **Extension**: `{ command: 'navigateToSymbol', filePath: '/workspace/src/utils.ts', symbolId: 'utils.ts:calculateSum', line: 10 }`
3. **Extension**: Calls `vscode.window.showTextDocument()` with range
4. **VS Code**: Scrolls editor to line 10 and highlights function

---

### Scenario 3: LSP timeout

1. **User**: Double-clicks large Python file
2. **Webview** → **Extension**: `{ command: 'drillDown', filePath: '/workspace/analyzer.py' }`
3. **Extension**: Calls `SymbolViewService.buildSymbolGraph()`
4. **Extension** → **Webview**: `{ command: 'symbolAnalysisProgress', status: 'started' }`
5. **Extension**: Makes LSP calls with 5-second timeout
6. **Extension**: Timeout fires, LSP hasn't responded
7. **Extension** → **Webview**: `{ command: 'symbolGraph', data: { nodes: [...partialResults], ... }, warning: 'Symbol analysis incomplete (LSP timeout)' }`
8. **Webview**: Displays partial graph + warning banner

---

### Scenario 4: File has no symbols

1. **User**: Double-clicks empty file or file with only imports
2. **Webview** → **Extension**: `{ command: 'drillDown', filePath: '/workspace/src/constants.ts' }`
3. **Extension**: Calls `SymbolViewService.buildSymbolGraph()`
4. **Extension**: LSP returns empty symbol list
5. **Extension** → **Webview**: `{ command: 'symbolEmptyState', filePath: '...', reason: 'no-symbols', message: 'This file contains no functions or classes to visualize' }`
6. **Webview**: Displays empty state with helpful message

---

## Type Safety

All message types must extend base types defined in `src/shared/types.ts`:

```typescript
// Extend existing union types
export type ExtensionToWebviewMessage = 
  | UpdateGraphMessage
  | ExpandedGraphMessage
  | SymbolGraphMessage           // NEW
  | SymbolAnalysisProgressMessage // NEW
  | SymbolEmptyStateMessage      // NEW
  // ... existing types

export type WebviewToExtensionMessage =
  | OpenFileMessage
  | DrillDownMessage             // ENHANCED
  | NavigateToSymbolMessage       // NEW
  | SwitchModeMessage            // ENHANCED
  // ... existing types
```

---

## Summary

Message protocol extended with 5 new/enhanced message types: `symbolGraph`, `symbolAnalysisProgress`, `symbolEmptyState`, `drillDown` (enhanced), `navigateToSymbol`, `switchMode` (enhanced). State management extended to track view mode and symbol-specific state. Message flow documented for 4 common scenarios. Ready for implementation in `src/shared/types.ts`.
