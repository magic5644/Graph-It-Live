# Research: LSP-Based Call Hierarchy Implementation

**Feature**: 001-lsp-call-hierarchy  
**Date**: 2026-01-15  
**Status**: Phase 0 - Research Complete

## Research Tasks

### 1. VS Code LSP API Best Practices

**Decision**: Use three LSP commands sequentially for call hierarchy analysis

**Rationale**:
- `vscode.executeDocumentSymbolProvider(uri)` returns all symbols (functions, classes, methods) with their ranges and kinds
- `vscode.executePrepareCallHierarchy(uri, position)` prepares call hierarchy for a specific symbol at a position
- `vscode.executeOutgoingCallsProvider(item)` returns outgoing calls from a prepared hierarchy item

**Alternatives Considered**:
1. **Custom AST parsing** (current approach for SymbolAnalyzer): Rejected because it requires maintaining parsers for each language. LSP provides unified interface across all languages with LSP servers.
2. **Static analysis only** (no LSP): Rejected because it misses cross-file call resolution and doesn't leverage language servers that IDEs already run.
3. **TextDocument.getText() + regex**: Rejected because regex cannot accurately parse nested scopes, generics, or complex call expressions.

**Implementation Notes**:
- LSP URIs must be normalized with `normalizePath()` before comparison (Windows drive letters: `c:` vs `C:`)
- Filter `vscode.executeOutgoingCallsProvider` results to exclude external calls (calls to symbols in different file URIs)
- Timeout handling: Wrap LSP calls in `Promise.race()` with 5-second timeout (FR-020)
- Graceful degradation: Catch LSP errors and show "Symbol analysis not available for this file type" (FR-009)

---

### 2. ReactFlow Hierarchical Layout Integration

**Decision**: Use Dagre layout algorithm with `rankdir: 'TB'` (top-bottom) for symbol graphs

**Rationale**:
- Existing codebase uses Dagre for file-level graph layout (see `src/webview/components/reactflow/layout.ts`)
- Hierarchical (Sugiyama) layout is Dagre's default algorithm, suitable for call hierarchy visualization
- Top-down orientation matches execution flow (caller → callee reads naturally top-to-bottom)

**Alternatives Considered**:
1. **Force-directed layout** (current default for file graphs): Rejected because it doesn't convey hierarchical structure—symbols appear randomly positioned without indicating call direction.
2. **Radial layout**: Rejected because it's optimized for tree structures with single root; call graphs have multiple entry points and cycles.
3. **Manual layout** (user drags nodes): Rejected because it's too labor-intensive for large files and doesn't scale.

**Implementation Notes**:
- Reuse `dagreLayout()` function from `src/webview/components/reactflow/layout.ts`
- Change `rankdir: 'LR'` (left-right, used for file graphs) to `rankdir: 'TB'` (top-bottom) for symbol graphs
- Adjust `nodesep` and `ranksep` for denser symbol packing (more symbols per screen than file nodes)
- Handle cycles with bidirectional edges + "cycle" badge (FR-019)

---

### 3. Symbol Type Color Encoding

**Decision**: Use VS Code theme-compatible colors with semantic meaning

**Rationale**:
- Classes (deep purple `#9966CC`): Visually distinct from functions, suggests "container" metaphor
- Functions (vibrant blue `#4A9EFF`): Primary executable units, most common symbol type
- Variables (amber `#FFA500`): Passive data holders, differentiated from active functions
- Colors pass WCAG AA contrast ratio on both light and dark VS Code themes

**Alternatives Considered**:
1. **Single color for all symbols**: Rejected because users can't quickly distinguish symbol types at a glance.
2. **Shape differentiation only** (no color): Rejected because color is faster to perceive than shape analysis.
3. **User-configurable colors**: Rejected because it adds configuration complexity without clear user benefit (spec doesn't mention customization need).

**Implementation Notes**:
- Use CSS custom properties: `--symbol-class-color`, `--symbol-function-color`, `--symbol-variable-color`
- Reference VS Code theme variables for borders/backgrounds to ensure theme compatibility
- Test colors in both "Dark+ (default dark)" and "Light+ (default light)" themes

---

### 4. Edge Type Differentiation (Calls vs References)

**Decision**: Solid arrows for function calls, dashed arrows for variable references

**Rationale**:
- Solid = active action (calling a function executes code)
- Dashed = passive connection (referencing a variable reads data)
- Matches common diagramming conventions (UML uses similar patterns)

**Alternatives Considered**:
1. **Color differentiation**: Rejected because color alone is not accessible (color-blind users).
2. **Arrow thickness**: Rejected because subtle differences are hard to perceive at zoom levels.
3. **Labels only** ("calls", "references"): Rejected because labels clutter the graph and don't visually distinguish at a glance.

**Implementation Notes**:
- Use ReactFlow's `style` prop: `{ strokeDasharray: '5,5' }` for dashed edges
- Add edge labels: `label: 'calls'` or `label: 'references'` for accessibility
- Differentiate via `vscode.CallHierarchyItem` (has `fromRanges` for call sites) vs import/export analysis

---

### 5. Anonymous Function Naming Strategy

**Decision**: Contextual naming based on assignment or usage location

**Rationale**:
- Anonymous functions are common in modern JavaScript/TypeScript (arrow functions, lambdas)
- Users need identifiable names to understand call flow
- Context provides semantic meaning: `array.map(x => x * 2)` → "map callback" is more helpful than "anonymous function"

**Alternatives Considered**:
1. **Generic names** ("anonymous function 1", "anonymous function 2"): Rejected because they don't convey purpose.
2. **Omit anonymous functions**: Rejected because they're often critical to understanding data flow (e.g., event handlers).
3. **Show code snippet**: Rejected because it's too verbose for node labels (clutters graph).

**Implementation Notes**:
- Extract parent node context from AST: if function is argument to `map`, name it "map callback"
- Handle common patterns: `onClick={...}` → "onClick handler", `filter(...)` → "filter predicate"
- Fallback: Use line number if no context available ("function at line 42")
- Store mapping in `SymbolNode` data: `{ name: "map callback", originalName: undefined }`

---

### 6. External Reference Visualization

**Decision**: Dimmed nodes with dashed edges for calls to imported functions

**Rationale**:
- Users need to see external dependencies to understand full call flow
- Visual dimming distinguishes external vs internal symbols (focus on internal by default)
- Dashed edges reinforce "boundary crossing" metaphor

**Alternatives Considered**:
1. **Omit external references entirely**: Rejected because users lose context about what external libraries are being called.
2. **Separate section/group**: Rejected because it breaks the flow of the call hierarchy (harder to trace execution path).
3. **Full opacity** (same as internal symbols): Rejected because it visually clutters the graph and doesn't highlight internal vs external.

**Implementation Notes**:
- Filter `vscode.executeOutgoingCallsProvider` to identify external calls (target URI ≠ current file URI)
- Apply CSS: `opacity: 0.5` for external nodes
- Use `style: { strokeDasharray: '3,3' }` for edges pointing to external nodes
- Store in `SymbolNode` data: `{ isExternal: true }` for rendering logic

---

### 7. LSP Timeout and Progress Handling

**Decision**: 5-second timeout with progress indicator and partial results fallback

**Rationale**:
- LSP providers can be slow for large files or complex analysis (especially Python with Pylance)
- Users expect feedback within seconds (SC-001: 2-second target)
- Partial results better than no results (show what's available, warn about missing data)

**Alternatives Considered**:
1. **No timeout** (wait indefinitely): Rejected because it freezes UI indefinitely on slow LSP.
2. **Hard failure after timeout**: Rejected because partial results are valuable (some symbols discovered, even if incomplete).
3. **1-second timeout**: Rejected because it's too aggressive (many valid LSP responses take 2-3 seconds).

**Implementation Notes**:
- Use `Promise.race([lspCall, timeout(5000)])` pattern
- Show progress spinner via webview message: `{ command: 'symbolAnalysisProgress', status: 'in-progress' }`
- If timeout, send partial results + warning: `{ command: 'symbolGraph', warning: 'Symbol analysis incomplete (LSP timeout)' }`
- Log timeout events for telemetry: track which file types/sizes trigger timeouts most often

---

## Summary

All research tasks resolved. No `NEEDS CLARIFICATION` items remain. Key decisions:
- Use VS Code LSP APIs (three-command sequence) for cross-language call hierarchy
- Dagre hierarchical layout with top-bottom orientation
- Color-coded symbol types (purple/blue/amber) with semantic meaning
- Solid vs dashed edges for calls vs references
- Contextual naming for anonymous functions
- Dimmed visualization for external references
- 5-second LSP timeout with partial results fallback

Ready to proceed to **Phase 1: Design & Contracts**.
