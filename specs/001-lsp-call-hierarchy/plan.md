# Implementation Plan: LSP-Based Call Hierarchy & Symbol Drill-Down

**Branch**: `001-lsp-call-hierarchy` | **Date**: 2026-01-15 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-lsp-call-hierarchy/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/commands/plan.md` for the execution workflow.

## Summary

Add symbol-level dependency visualization using VS Code's LSP APIs (`vscode.executeDocumentSymbolProvider`, `vscode.executePrepareCallHierarchy`, `vscode.executeOutgoingCallsProvider`) to enable intra-file function/class call hierarchy analysis. Users can drill down from file nodes in the existing dependency graph to see symbol-level relationships with hierarchical (Sugiyama) layout, supporting TypeScript/JavaScript, Python, and Rust through language servers.

## Technical Context

**Language/Version**: TypeScript 5.9, JavaScript (via ts-morph), Python (tree-sitter), Rust (tree-sitter)  
**Primary Dependencies**: VS Code Extension API 1.96+, ReactFlow 11.x, ts-morph 27.x, tree-sitter 0.25.x, dagre (layout)  
**Storage**: In-memory graph state, optional disk-based index caching via ReverseIndex  
**Testing**: Vitest (unit), @vscode/test-electron (E2E), XCTest N/A  
**Target Platform**: VS Code Extension Host (Node.js) + Webview (Browser/Electron renderer)  
**Project Type**: VS Code Extension (multi-layer: extension host, webview React app, analyzer, MCP server)  
**Performance Goals**: 
- Symbol graph generation < 2 seconds for files up to 1000 lines (SC-001)
- Graph rendering < 100ms UI freeze for 100 symbols + 200 relationships (SC-005)
- Live updates < 600ms (500ms debounce + 100ms render) (SC-006)
- 95% call relationship accuracy for TypeScript test suite (SC-002)

**Constraints**: 
- ZERO source map files in production .vsix (package integrity)
- Cross-platform compatibility (Windows/Linux/macOS path handling mandatory)
- LSP provider availability (graceful degradation when unavailable)
- No breaking changes to existing file-level graph functionality
- Lazy computation (symbol analysis only on drill-down, not during initial file scan)

**Scale/Scope**: 
- Support 4 languages (TypeScript, JavaScript, Python, Rust) via LSP
- Handle files up to 1000 lines / 100 symbols per file efficiently
- Extend existing extension with 1 new MCP tool, 1 new service, 2 new React components

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**Principle I - Cross-Platform Compatibility**: ✅ COMPLIANT
- Plan uses `path.join`, `path.resolve` for all path operations
- Plan mandates `normalizePath()` from `src/shared/path.ts` for LSP URI handling
- Tests must verify Windows drive letters (C:\) and backslashes in symbol URIs
- Cross-platform E2E test coverage required (per constitution requirement)

**Principle II - Layered Architecture**: ✅ COMPLIANT
- New `LspCallHierarchyAnalyzer.ts` in `src/analyzer/` (NO vscode imports - uses passed LSP results)
- Extension layer (`src/extension/services/SymbolViewService.ts`) calls VS Code LSP APIs
- Webview React component (`src/webview/components/SymbolGraphView.tsx`) in browser context
- Message protocol extended in `src/shared/types.ts` for extension ↔ webview communication
- MCP server adds `graphItLive_analyzeFileLogic` tool (standalone, NO vscode imports)

**Principle III - Test-First Development**: ✅ COMPLIANT
- E2E test MANDATORY for drill-down interaction (double-click file node → symbol graph)
- E2E test MANDATORY for symbol node click → editor navigation
- E2E test MANDATORY for Python/Rust LSP integration (multi-language support)
- Unit tests for LSP result parsing and intra-file filtering logic
- Test from `.vsix` before release: `npm run test:vscode:vsix`

**Principle IV - Package Integrity**: ✅ COMPLIANT
- No new external dependencies requiring bundle inclusion (uses existing VS Code LSP APIs)
- Security scan: Snyk for new LSP integration code
- Quality scan: SonarQube for call hierarchy analyzer logic
- Package verification workflow unchanged (no build config changes)

**Principle V - Code Quality**: ✅ COMPLIANT
- TypeScript strict mode for all new modules
- ESLint compliance checked via `npm run lint`
- Path alias `@/` used for imports (e.g., `@/analyzer/LspCallHierarchyAnalyzer`)
- Function nesting depth ≤ 4 (extract helpers for complex LSP parsing)
- Conventional commits: `feat: Add LSP-based call hierarchy visualization`

**GATE STATUS**: ✅ **PASS** - All principles satisfied, proceed to Phase 0 research

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── analyzer/                    # EXISTING - Pure Node.js analysis (NO vscode imports)
│   ├── Spider.ts               # EXISTING - File-level dependency crawler
│   ├── SymbolAnalyzer.ts       # EXISTING - TS/JS symbol extraction (ts-morph)
│   ├── languages/              # EXISTING - Multi-language support
│   │   ├── PythonSymbolAnalyzer.ts  # EXISTING - Python (tree-sitter)
│   │   └── RustSymbolAnalyzer.ts    # EXISTING - Rust (tree-sitter)
│   ├── LspCallHierarchyAnalyzer.ts  # NEW - LSP wrapper for call hierarchy
│   └── types.ts                # EXISTING (extend) - Add SymbolNode, CallEdge types
│
├── extension/                   # EXISTING - VS Code extension host
│   ├── GraphProvider.ts        # EXISTING (extend) - Add handleDrillDown enhancement
│   └── services/               # EXISTING - Service layer
│       ├── SymbolViewService.ts      # NEW - Symbol graph orchestration
│       ├── GraphViewService.ts       # EXISTING - File graph service
│       └── EditorNavigationService.ts # EXISTING (extend) - Add symbol navigation
│
├── webview/                     # EXISTING - React app (browser context)
│   ├── components/
│   │   ├── ReactFlowGraph.tsx       # EXISTING (extend) - Add symbol mode
│   │   ├── SymbolGraphView.tsx      # NEW - Symbol-specific visualization
│   │   └── reactflow/
│   │       ├── buildGraph.ts        # EXISTING (extend) - Add symbol graph builder
│   │       ├── SymbolNode.tsx       # NEW - Symbol node component
│   │       └── layout.ts            # EXISTING (extend) - Add hierarchical layout
│   └── App.tsx                 # EXISTING (extend) - Add view mode toggle
│
├── mcp/                         # EXISTING - MCP server (NO vscode imports)
│   ├── mcpServer.ts            # EXISTING (extend) - Register new tool
│   ├── McpWorker.ts            # EXISTING (extend) - Add handler
│   └── types.ts                # EXISTING (extend) - Add tool types
│
└── shared/                      # EXISTING - Common types/utilities
    ├── types.ts                # EXISTING (extend) - Add message types
    ├── constants.ts            # EXISTING - Shared constants
    └── path.ts                 # EXISTING - Path normalization

tests/
├── analyzer/                    # EXISTING
│   └── LspCallHierarchyAnalyzer.test.ts  # NEW - LSP integration tests
├── extension/                   # EXISTING
│   └── services/
│       └── SymbolViewService.test.ts     # NEW - Service unit tests
├── webview/                     # EXISTING
│   └── components/
│       └── SymbolGraphView.test.ts       # NEW - React component tests
└── vscode-e2e/                  # EXISTING
    └── suite/
        └── symbolDrillDown.test.ts       # NEW - E2E drill-down tests
```

**Structure Decision**: Extending existing VS Code extension architecture. New LSP-based symbol analysis follows established layered pattern: analyzer (pure logic) → extension services (VS Code integration) → webview (React UI) → MCP (AI/LLM tools). Reuses existing ReactFlow infrastructure and multi-language symbol analyzers as foundation.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

**Status**: ✅ No violations - all constitution principles satisfied

---

## Phase Status

### ✅ Phase 0: Research Complete

**Output**: [research.md](./research.md)

**Completed Tasks**:
- VS Code LSP API best practices research
- ReactFlow hierarchical layout integration strategy
- Symbol type color encoding decisions
- Edge type differentiation (calls vs references)
- Anonymous function naming strategy
- External reference visualization approach
- LSP timeout and progress handling patterns

**Key Decisions**:
- Use three-command LSP sequence: `executeDocumentSymbolProvider` → `executePrepareCallHierarchy` → `executeOutgoingCallsProvider`
- Dagre layout with `rankdir: 'TB'` (top-bottom) for symbol graphs
- Color-coded symbols: Classes (purple), Functions (blue), Variables (amber)
- Solid arrows for calls, dashed arrows for references
- Contextual naming for anonymous functions (e.g., "map callback")
- Dimmed nodes with dashed edges for external references
- 5-second LSP timeout with progress indicator and partial results

**No NEEDS CLARIFICATION items remain**

---

### ✅ Phase 1: Design & Contracts Complete

**Output**:
- [data-model.md](./data-model.md) - Entity definitions and relationships
- [contracts/mcp-tool-api.md](./contracts/mcp-tool-api.md) - MCP tool specification
- [contracts/message-protocol.md](./contracts/message-protocol.md) - Extension ↔ Webview protocol
- [quickstart.md](./quickstart.md) - Implementation guide

**Completed Tasks**:
- Defined 4 core entities: `SymbolNode`, `CallEdge`, `IntraFileGraph`, `BreadcrumbPath`
- Specified MCP tool `graphItLive_analyzeFileLogic` with TOON format (40% token reduction)
- Extended message protocol with 5 new/enhanced message types
- Created implementation quickstart with critical patterns and testing strategy

**Key Deliverables**:
- TypeScript type definitions for all entities
- TOON format specification for token-efficient AI consumption
- Message flow documentation for 4 common user scenarios
- Development workflow and common pitfalls guide

**Constitution Re-Check**: ✅ **PASS** - Design maintains compliance with all principles

---

### ⏳ Phase 2: Task Breakdown (Next Step)

**Command**: Run `/speckit:tasks` to generate `tasks.md`

**Expected Output**: Granular task list with:
- Subtasks for each implementation phase (P1, P2, P3)
- Time estimates per task
- Dependencies between tasks
- Acceptance criteria per task
- Assignment of tasks to implementation areas (analyzer, extension, webview, MCP)

---

## Implementation Roadmap

### Phase 1: Core LSP Integration (P1 - MVP)
**Goal**: Basic symbol navigation for TypeScript files  
**Estimated Effort**: 3-4 days  
**Acceptance**: User can drill down into TS file, see symbol graph, click symbol to navigate

**Key Files**:
- `src/analyzer/LspCallHierarchyAnalyzer.ts` (NEW)
- `src/extension/services/SymbolViewService.ts` (NEW)
- `src/webview/components/SymbolGraphView.tsx` (NEW)
- `tests/vscode-e2e/suite/symbolDrillDown.test.ts` (NEW)

---

### Phase 2: Multi-Language + Visual (P2)
**Goal**: Python/Rust support + color coding + edge differentiation  
**Estimated Effort**: 2-3 days  
**Acceptance**: Symbol graph works for all 3 languages with visual enhancements

**Key Files**:
- `src/webview/components/reactflow/SymbolNode.tsx` (NEW)
- `src/webview/components/BreadcrumbNav.tsx` (NEW)
- Extend `buildGraph.ts` for edge styling

---

### Phase 3: MCP + Live Updates (P3)
**Goal**: AI/LLM integration + real-time refresh on file edits  
**Estimated Effort**: 2 days  
**Acceptance**: MCP tool works, symbol graph refreshes automatically on save

**Key Files**:
- `src/mcp/McpWorker.ts` (EXTEND)
- `src/mcp/mcpServer.ts` (EXTEND)
- Extend `GraphProvider` for file save debounce

---

## Summary

**Planning complete**: Phase 0 (Research) and Phase 1 (Design & Contracts) finished. All technical decisions documented, data model defined, API contracts specified. Constitution compliance verified. Ready for task breakdown (`/speckit:tasks`) and implementation.

**Next Action**: Run `/speckit:tasks` to generate granular task list for implementation phases.

**Artifacts Created**:
1. `research.md` - 7 research tasks with decisions and rationale
2. `data-model.md` - 4 entities with validation rules and state transitions
3. `contracts/mcp-tool-api.md` - MCP tool specification with TOON format
4. `contracts/message-protocol.md` - 5 message types with flow diagrams
5. `quickstart.md` - Implementation guide with critical patterns

**Branch**: `001-lsp-call-hierarchy`  
**Status**: Ready for implementation  
**Estimated Total Effort**: 7-9 days (P1: 4 days, P2: 3 days, P3: 2 days)
