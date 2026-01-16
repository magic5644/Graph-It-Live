# Quick Start: LSP-Based Call Hierarchy Implementation

**Feature**: 001-lsp-call-hierarchy  
**Target Audience**: Developers implementing this feature  
**Time to Read**: 5 minutes

---

## Prerequisites

Before starting implementation:

1. **Read core documents**:
   - [spec.md](./spec.md) - Feature requirements and user scenarios
   - [research.md](./research.md) - Technical decisions and rationale
   - [data-model.md](./data-model.md) - Entity definitions and relationships
   
2. **Understand existing codebase**:
   - `src/analyzer/SymbolAnalyzer.ts` - Existing symbol extraction (ts-morph)
   - `src/extension/GraphProvider.ts` - Main extension orchestrator
   - `src/webview/components/ReactFlowGraph.tsx` - Graph visualization
   - `src/shared/types.ts` - Message protocol definitions

3. **Set up development environment**:
   ```bash
   npm install                    # Install dependencies
   npm run build                  # Build extension
   npm test                       # Run unit tests
   npm run test:vscode            # Run E2E tests (from source)
   ```

---

## Implementation Order (Priority: P1 First)

### Phase 1: Core LSP Integration (P1 - MVP)

**Goal**: Enable basic symbol navigation within TypeScript files

**Tasks**:
1. **Create `LspCallHierarchyAnalyzer.ts`** (analyzer layer)
   - Implement LSP API wrapper (3-command sequence)
   - Filter external calls (intra-file only)
   - Detect cycles using DFS
   - **Tests**: `tests/analyzer/LspCallHierarchyAnalyzer.test.ts`

2. **Create `SymbolViewService.ts`** (extension layer)
   - Orchestrate LSP calls via VS Code API
   - Handle timeouts (5 seconds)
   - Build `IntraFileGraph` from LSP results
   - **Tests**: `tests/extension/services/SymbolViewService.test.ts`

3. **Extend `GraphProvider.handleDrillDown()`** (extension layer)
   - Add symbol mode detection
   - Call `SymbolViewService` instead of file graph service
   - Send `symbolGraph` message to webview
   - **Tests**: Extend existing `GraphProvider.test.ts`

4. **Create `SymbolGraphView.tsx`** (webview layer)
   - React component for symbol visualization
   - Handle `symbolGraph` message from extension
   - Render ReactFlow with symbol nodes
   - **Tests**: `tests/webview/components/SymbolGraphView.test.ts`

5. **Extend `buildReactFlowGraph()`** (webview layer)
   - Add symbol mode support
   - Create `SymbolNode` components
   - Apply hierarchical layout (Dagre TB mode)
   - **Tests**: Extend existing `buildGraph.test.ts`

6. **E2E Test** (vscode-e2e layer)
   - Test drill-down from file node to symbol graph
   - Test symbol node click → editor navigation
   - Test "Back to Project" button
   - **Location**: `tests/vscode-e2e/suite/symbolDrillDown.test.ts`

**Acceptance Criteria**: User can double-click TypeScript file node, see symbol graph, click symbol to navigate to code

---

### Phase 2: Multi-Language Support (P2)

**Goal**: Extend to Python and Rust via LSP

**Tasks**:
1. **Test LSP providers** for Python (Pylance) and Rust (rust-analyzer)
   - Verify `executeDocumentSymbolProvider` works
   - Verify `executeOutgoingCallsProvider` returns results
   - Document any language-specific quirks

2. **Add language-specific handling** in `LspCallHierarchyAnalyzer`
   - Handle different LSP provider names
   - Adjust timeout logic if needed (Pylance can be slow)

3. **E2E Tests** for Python and Rust
   - Create test fixtures in `tests/fixtures/python-project/`
   - Create test fixtures in `tests/fixtures/rust-project/`
   - Test drill-down for each language

**Acceptance Criteria**: Symbol graph works identically for TypeScript, Python, and Rust

---

### Phase 3: Visual Enhancements (P2)

**Goal**: Improve UX with color coding and edge differentiation

**Tasks**:
1. **Extend `SymbolNode.tsx`** component
   - Add color prop based on symbol type (class/function/variable)
   - Apply CSS custom properties (`--symbol-class-color`, etc.)
   - Test in both light and dark themes

2. **Extend edge rendering** in `buildReactFlowGraph()`
   - Add `strokeDasharray` for reference edges
   - Add edge labels ("calls" vs "references")
   - Handle cycle visualization (bidirectional arrows + badge)

3. **Add breadcrumb navigation** component
   - Create `BreadcrumbNav.tsx` component
   - Display path segments (Project → src → utils.ts)
   - Handle click to navigate

**Acceptance Criteria**: Symbols are color-coded, edges are differentiated, breadcrumb shows file path

---

### Phase 4: MCP Tool Integration (P3)

**Goal**: Expose symbol analysis to AI/LLM via MCP

**Tasks**:
1. **Extend `McpWorker.ts`**
   - Add handler for `graphItLive_analyzeFileLogic` tool
   - Implement TOON format serialization
   - Add JSON format fallback

2. **Register tool** in `mcpServer.ts`
   - Add tool definition with WHEN/WHY/WHAT description
   - Add Zod schema for input validation

3. **Test MCP tool** with `scripts/test-mcp.js`
   - Verify TOON format output
   - Verify JSON format output
   - Test error handling (timeout, unsupported file type)

**Acceptance Criteria**: AI agents can query symbol call hierarchy via MCP tool

---

### Phase 5: Live Updates (P3)

**Goal**: Refresh symbol graph when file is edited

**Tasks**:
1. **Add debounce logic** in `GraphProvider`
   - Listen to `vscode.workspace.onDidSaveTextDocument`
   - Debounce 500ms before re-analyzing
   - Send refresh message to webview

2. **Handle refresh** in `SymbolGraphView`
   - Preserve expanded nodes during refresh
   - Show subtle loading indicator
   - Diff old vs new graph to highlight changes

**Acceptance Criteria**: Symbol graph updates automatically when file is saved (after 500ms debounce)

---

## Critical Implementation Patterns

### 1. Path Normalization (Cross-Platform)

**Always use `normalizePath()` before comparing paths:**

```typescript
import { normalizePath } from '@/shared/path';

const fileUri = vscode.Uri.file(filePath);
const normalizedPath = normalizePath(fileUri.fsPath);

// Compare normalized paths
if (normalizePath(source.uri.fsPath) === normalizedPath) {
  // Intra-file call
}
```

**Why**: Windows drive letters (`c:` vs `C:`), backslashes vs forward slashes

---

### 2. LSP Timeout Handling

**Always wrap LSP calls in Promise.race with timeout:**

```typescript
const timeoutPromise = new Promise<never>((_, reject) =>
  setTimeout(() => reject(new Error('LSP timeout')), 5000)
);

const symbolsPromise = vscode.commands.executeCommand(
  'vscode.executeDocumentSymbolProvider',
  fileUri
);

try {
  const symbols = await Promise.race([symbolsPromise, timeoutPromise]);
  // Process symbols
} catch (error) {
  if (error.message === 'LSP timeout') {
    // Return partial results
    return {
      nodes: partialSymbols,
      edges: partialEdges,
      isPartial: true
    };
  }
  throw error;
}
```

**Why**: Prevents UI freeze on slow LSP providers (FR-020)

---

### 3. React Callback Dependencies

**NEVER include callback props in useMemo/useCallback dependencies:**

```typescript
// ❌ WRONG - causes re-render cascade
const graph = useMemo(() => {
  return buildGraph({ data, onNodeClick });
}, [data, onNodeClick]); // Callback causes unnecessary re-renders

// ✅ CORRECT - use ref for callbacks
const callbacksRef = useRef({ onNodeClick });
callbacksRef.current = { onNodeClick };

const graph = useMemo(() => {
  return buildGraph({ data, callbacks: callbacksRef.current });
}, [data]); // No callbacks in deps
```

**Why**: Prevents React state corruption and performance issues

---

### 4. Message Protocol Type Safety

**Always extend base message types in `src/shared/types.ts`:**

```typescript
// Add new message type
export interface SymbolGraphMessage extends ExtensionToWebviewMessage {
  command: 'symbolGraph';
  filePath: string;
  data: { nodes: SymbolNode[]; edges: CallEdge[]; };
}

// Update union type
export type ExtensionToWebviewMessage = 
  | UpdateGraphMessage
  | SymbolGraphMessage  // ADD HERE
  | ...;
```

**Why**: Type safety catches protocol mismatches at compile time

---

## Testing Strategy

### Unit Tests (Vitest)

**What to test**:
- LSP result parsing logic
- Cycle detection algorithm
- Path normalization edge cases
- TOON format serialization/deserialization

**Example**:
```typescript
it('should filter external calls', () => {
  const analyzer = new LspCallHierarchyAnalyzer();
  const calls = [
    { uri: 'file:///workspace/utils.ts', ... },  // Internal
    { uri: 'file:///workspace/external.ts', ... }, // External
  ];
  const filtered = analyzer.filterIntraFileCalls(calls, 'utils.ts');
  expect(filtered).toHaveLength(1);
});
```

---

### E2E Tests (@vscode/test-electron)

**What to test**:
- User interactions (double-click, click symbol node)
- View mode switching (file ↔ symbol)
- Multi-language support (TS, Python, Rust)
- Error states (empty file, LSP timeout)

**Example**:
```typescript
it('should drill down into TypeScript file', async () => {
  const view = await activateExtension();
  const fileNode = await view.findNode('src/utils.ts');
  await fileNode.doubleClick();
  
  const symbolNodes = await view.findAll SymbolNode');
  expect(symbolNodes.length).toBeGreaterThan(0);
  expect(symbolNodes[0].label).toBe('calculateSum');
});
```

---

## Common Pitfalls

1. **Forgetting to normalize paths**: Always use `normalizePath()` before comparing (Windows compatibility)
2. **Including callbacks in React deps**: Use refs for callbacks to prevent re-render cascades
3. **Not handling LSP timeouts**: Always wrap in `Promise.race()` with 5-second timeout
4. **Hardcoding file separators**: Use `path.join()`, never `'/'` or `'\\'`
5. **Skipping E2E tests**: Constitution requires E2E tests for all user-facing features

---

## Development Workflow

1. **Start from spec**: Read user scenarios to understand expected behavior
2. **Follow layered architecture**: analyzer → extension → webview → MCP (no shortcuts)
3. **Test as you go**: Write unit test before implementation (TDD)
4. **E2E test before PR**: Run `npm run test:vscode:vsix` to test from packaged .vsix
5. **Security scan**: Run Snyk for new code
6. **Quality scan**: Run SonarQube for code smells
7. **Package verification**: After build changes, run `npx vsce ls | grep "\.map$"` (must be empty)

---

## Need Help?

- **Architecture questions**: See `.github/copilot-instructions.md`
- **Cross-platform issues**: See `docs/CROSS_PLATFORM_TESTING.md`
- **Constitution compliance**: See `.specify/memory/constitution.md`
- **Message protocol**: See `contracts/message-protocol.md`
- **Data model**: See `data-model.md`

---

## Summary

Implementation order: P1 (TypeScript MVP) → P2 (Multi-language + Visual) → P3 (MCP + Live updates). Critical patterns: path normalization, LSP timeouts, React callback refs, message type safety. Testing strategy: unit tests (logic) + E2E tests (user flows). Follow layered architecture, constitution principles, and development workflow.

**Ready to start? Begin with Phase 1, Task 1: Create `LspCallHierarchyAnalyzer.ts`**
