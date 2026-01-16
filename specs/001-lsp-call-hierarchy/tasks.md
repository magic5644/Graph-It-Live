# Tasks: LSP-Based Call Hierarchy & Symbol Drill-Down

**Input**: Design documents from `/specs/001-lsp-call-hierarchy/`
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅, quickstart.md ✅

**Tests**: E2E tests are MANDATORY per Constitution Principle III for all user-facing features. Unit tests are included for complex logic.

**Organization**: Tasks are grouped by user story (P1 → P2 → P3) to enable independent implementation and testing of each story.

## Format: `- [ ] [ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4, US5)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and TypeScript type definitions

- [x] T001 Add TypeScript type definitions for `SymbolNode`, `CallEdge`, `IntraFileGraph`, `BreadcrumbPath` to src/shared/types.ts
- [x] T002 [P] Add message protocol types for symbol graph communication to src/shared/types.ts (extend `ExtensionToWebviewMessage` and `WebviewToExtensionMessage` unions)
- [x] T003 [P] Create test fixtures for symbol analysis in tests/fixtures/symbol-analysis/ (TypeScript files with known call hierarchies)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core LSP infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T004 Create `LspCallHierarchyAnalyzer.ts` in src/analyzer/ with three-command LSP sequence (executeDocumentSymbolProvider → executePrepareCallHierarchy → executeOutgoingCallsProvider)
- [x] T005 Implement intra-file filtering logic in LspCallHierarchyAnalyzer (exclude external calls from different file URIs)
- [x] T006 Implement cycle detection algorithm in LspCallHierarchyAnalyzer using DFS traversal
- [x] T007 Add path normalization using `normalizePath()` for LSP URI comparison in LspCallHierarchyAnalyzer
- [x] T008 Create unit tests for LspCallHierarchyAnalyzer in tests/analyzer/LspCallHierarchyAnalyzer.test.ts (test filtering, cycle detection, path normalization)

**Checkpoint**: LspCallHierarchyAnalyzer foundation ready - user story implementation can now begin

---

## Phase 3: User Story 1 - Basic Symbol Navigation Within File (Priority: P1) 🎯 MVP

**Goal**: Enable developers to double-click TypeScript file nodes and see symbol-level call hierarchy with navigation to code

**Independent Test**: Open TypeScript file with multiple functions, double-click file node in graph, verify symbol graph displays with call relationships, click symbol to navigate in editor

### Implementation for User Story 1

- [x] T009 [P] Create `SymbolViewService.ts` in src/extension/services/ to orchestrate LSP calls via VS Code API
- [x] T010 [P] Create `SymbolGraphView.tsx` in src/webview/components/ as React component for symbol visualization
- [x] T011 Implement LSP timeout handling in SymbolViewService using Promise.race with 5-second timeout (wrap all LSP commands)
- [x] T012 Implement `buildIntraFileGraph()` method in SymbolViewService to construct IntraFileGraph from LSP results
- [x] T013 Extend `GraphProvider.handleDrillDown()` in src/extension/GraphProvider.ts to detect symbol mode and call SymbolViewService
- [x] T014 Add `symbolGraph` message sending from GraphProvider to webview with IntraFileGraph payload
- [x] T015 Implement message handler in SymbolGraphView.tsx to receive and render symbolGraph message
- [x] T016 [P] Create `SymbolNode.tsx` in src/webview/components/reactflow/ for rendering symbol nodes (basic styling)
- [x] T017 Extend `buildReactFlowGraph()` in src/webview/utils/buildGraph.ts to support symbol mode with SymbolNode components
- [x] T018 Implement Dagre hierarchical layout (TB rankdir) for symbol graphs in buildGraph.ts
- [x] T019 Add "Back to Project" button to SymbolGraphView.tsx that sends `switchMode` message to extension
- [x] T020 Implement `switchMode` message handler in GraphProvider to return to file-level graph
- [x] T021 Implement symbol node click handler in SymbolGraphView.tsx to send `navigateToSymbol` message
- [x] T022 Add `navigateToSymbol` message handler in GraphProvider to execute `vscode.window.showTextDocument()` with line range
- [x] T023 Add unit tests for SymbolViewService in tests/extension/services/SymbolViewService.test.ts (mock VS Code API)
- [x] T024 Add unit tests for buildGraph symbol mode in tests/webview/utils/buildGraph.test.ts

### E2E Tests for User Story 1 (MANDATORY)

- [x] T025 Create E2E test file tests/vscode-e2e/suite/symbolDrillDown.test.ts
- [x] T026 E2E test: Drill-down from file node to symbol graph (double-click file node → verify symbol nodes appear)
- [x] T027 E2E test: Symbol node click navigates to code (click symbol → verify editor opens at correct line)
- [x] T028 E2E test: Back to Project button returns to file graph (click button → verify file nodes reappear)
- [x] T029 E2E test: Symbol graph shows call relationships (verify edges connect caller → callee functions)

**Checkpoint**: At this point, User Story 1 (TypeScript symbol navigation) should be fully functional and testable independently

---

## Phase 4: User Story 2 - Multi-Language Support via LSP (Priority: P2)

**Goal**: Extend symbol navigation to Python and Rust files using their respective LSP providers

**Independent Test**: Drill down into Python file and Rust file, verify symbol graphs display correctly with call hierarchy detected via Pylance and rust-analyzer

### Implementation for User Story 2

- [x] T030 [P] Test Pylance LSP provider with executeDocumentSymbolProvider on Python test fixture in tests/fixtures/python-project/
- [x] T031 [P] Test rust-analyzer LSP provider with executeDocumentSymbolProvider on Rust test fixture in tests/fixtures/rust-project/
- [x] T032 Add language-specific handling in LspCallHierarchyAnalyzer for Python (handle Pylance provider name)
- [x] T033 Add language-specific handling in LspCallHierarchyAnalyzer for Rust (handle rust-analyzer provider name)
- [x] T034 Implement graceful degradation in SymbolViewService when LSP is unavailable (show `symbolEmptyState` message: "Symbol analysis not available for this file type")
- [x] T035 Add `symbolEmptyState` message type to src/shared/types.ts
- [x] T036 Add empty state UI in SymbolGraphView.tsx to display "Symbol analysis not available" message
- [x] T037 Add unit tests for language detection in tests/analyzer/LspCallHierarchyAnalyzer.test.ts

### E2E Tests for User Story 2 (MANDATORY)

- [x] T038 Create Python test fixtures in tests/fixtures/python-project/ with known function calls
- [x] T039 Create Rust test fixtures in tests/fixtures/rust-project/ with known function calls
- [x] T040 E2E test: Drill-down into Python file shows symbol graph (verify Python functions detected via Pylance)
- [x] T041 E2E test: Drill-down into Rust file shows symbol graph (verify Rust functions detected via rust-analyzer)
- [x] T042 E2E test: Unsupported file type shows graceful error (drill into .txt file → verify error message)

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently (TypeScript, Python, Rust all supported)

---

## Phase 5: User Story 3 - Visual Differentiation & Call Types (Priority: P2)

**Goal**: Improve UX with color-coded symbols (classes purple, functions blue, variables amber) and edge differentiation (solid for calls, dashed for references)

**Independent Test**: Drill down into file with mixed symbol types, verify color coding and edge styles match specifications

### Implementation for User Story 3

- [ ] T043 [P] Extend SymbolNode.tsx to add color prop based on symbol type (derive from `SymbolNode.type`: 'class' | 'function' | 'variable')
- [ ] T044 [P] Add CSS custom properties in src/webview/styles/ for symbol colors (--symbol-class-color: #9966CC, --symbol-function-color: #4A9EFF, --symbol-variable-color: #FFA500)
- [ ] T045 [P] Test color rendering in both light and dark VS Code themes
- [ ] T046 Extend edge rendering in buildGraph.ts to add `strokeDasharray` for reference edges (dashed)
- [ ] T047 Add edge labels in buildGraph.ts to show "calls" vs "references" relation type
- [ ] T048 Implement cycle visualization in buildGraph.ts (bidirectional arrows + "cycle" badge on edge)
- [ ] T049 [P] Create `BreadcrumbNav.tsx` component in src/webview/components/ to display path segments
- [ ] T050 Populate breadcrumb path in SymbolViewService (Project → folder → filename.ts)
- [ ] T051 Add breadcrumb to SymbolGraphView.tsx layout (top bar above graph)
- [ ] T052 Implement breadcrumb segment click handler to navigate up hierarchy
- [ ] T053 Add unit tests for edge styling logic in tests/webview/utils/buildGraph.test.ts
- [ ] T054 Add unit tests for BreadcrumbNav component in tests/webview/components/BreadcrumbNav.test.ts

### E2E Tests for User Story 3 (MANDATORY)

- [ ] T055 E2E test: Symbols are color-coded by type (verify classes purple, functions blue, variables amber)
- [ ] T056 E2E test: Edges differentiated by relation (verify solid arrows for calls, dashed for references)
- [ ] T057 E2E test: Recursive calls show cycle badge (drill into file with recursion → verify cycle indicator)
- [ ] T058 E2E test: Breadcrumb shows file path (verify Project → src → utils.ts)
- [ ] T058a E2E test: Anonymous functions use contextual names (drill into file with arrow functions → verify labels like "map callback", "onClick handler")
- [ ] T058b E2E test: External references appear dimmed (drill into file with imports → verify external symbols have opacity: 0.5 and dashed edges per FR-022)

**Checkpoint**: All visual enhancements should be functional, User Stories 1-3 work independently

---

## Phase 6: User Story 4 - AI-Powered Analysis via MCP (Priority: P3)

**Goal**: Expose symbol analysis to AI/LLM via MCP tool `graphItLive_analyzeFileLogic` with TOON format for token efficiency

**Independent Test**: Call MCP tool with file path, verify returned TOON format accurately represents call hierarchy, test with AI agent to confirm code flow explanations

### Implementation for User Story 4

- [ ] T059 [P] Add `graphitlive_analyze_file_logic` tool definition to src/mcp/mcpServer.ts with WHEN/WHY/WHAT description
- [ ] T060 [P] Create Zod schema for AnalyzeFileLogicRequest in src/mcp/types.ts (filePath, includeExternal, format)
- [ ] T061 Extend McpWorker.ts handler switch statement to process `graphitlive_analyze_file_logic` tool
- [ ] T062 Implement TOON format serialization in McpWorker.ts (nodes:Class:Name|Function:Name format)
- [ ] T063 Implement JSON format fallback in McpWorker.ts (full IntraFileGraph structure)
- [ ] T064 Add input validation in McpWorker.ts (absolute path, supported extension check, file existence)
- [ ] T065 Add error response handling in McpWorker.ts (FILE_NOT_FOUND, UNSUPPORTED_FILE_TYPE, LSP_UNAVAILABLE, LSP_TIMEOUT, ANALYSIS_FAILED)
- [ ] T066 Integrate LspCallHierarchyAnalyzer in McpWorker.ts to generate symbol graph
- [ ] T067 Add unit tests for TOON serialization in tests/mcp/McpWorker.test.ts
- [ ] T068 Add unit tests for JSON format in tests/mcp/McpWorker.test.ts
- [ ] T069 Test MCP tool with scripts/test-mcp.js (verify TOON output, JSON output, error handling)

### Integration Tests for User Story 4

- [ ] T070 MCP integration test: Analyze TypeScript file returns correct TOON format
- [ ] T071 MCP integration test: Analyze Python file returns correct TOON format
- [ ] T072 MCP integration test: Invalid file path returns FILE_NOT_FOUND error
- [ ] T073 MCP integration test: Unsupported extension returns UNSUPPORTED_FILE_TYPE error
- [ ] T074 MCP integration test: LSP timeout returns partial results with isPartial flag

**Checkpoint**: MCP tool should be functional, AI agents can query symbol call hierarchy

---

## Phase 7: User Story 5 - Live Updates & Performance (Priority: P3)

**Goal**: Automatically refresh symbol graph when file is edited (500ms debounce) without performance degradation

**Independent Test**: Open symbol graph, edit function to add/remove calls, verify graph updates after debounce period without UI lag

### Implementation for User Story 5

- [ ] T075 Add `vscode.workspace.onDidSaveTextDocument` listener in GraphProvider
- [ ] T076 Implement 500ms debounce logic in GraphProvider for file save events
- [ ] T077 Add re-analysis trigger in GraphProvider to call SymbolViewService on debounce completion
- [ ] T078 Implement refresh message sending from GraphProvider to webview with updated IntraFileGraph
- [ ] T079 Add refresh handler in SymbolGraphView.tsx to preserve expanded nodes during update
- [ ] T080 Implement graph diffing logic in SymbolGraphView.tsx to highlight changes (new edges, removed edges)
- [ ] T081 Add subtle loading indicator to SymbolGraphView.tsx during re-analysis
- [ ] T082 Optimize performance: Only re-analyze if current file path matches edited file
- [ ] T083 Add unit tests for debounce logic in tests/extension/GraphProvider.test.ts
- [ ] T084 Add performance benchmark test in tests/benchmarks/ (measure 100 symbols + 200 edges render time)

### E2E Tests for User Story 5 (MANDATORY)

- [ ] T085 E2E test: Graph updates after file edit (add function call → save → verify new edge appears after 500ms)
- [ ] T086 E2E test: Graph updates after removing call (remove function call → save → verify edge disappears)
- [ ] T087 E2E test: Large file performance (drill into 1000-line file → measure end-to-end time from click to graph rendered → verify < 2s per SC-001 AND verify UI freeze < 100ms per SC-005)
- [ ] T088 E2E test: Rapid edits debounced (edit multiple times within 500ms → verify single re-analysis)

**Checkpoint**: All user stories should now be independently functional with live update support

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Final touches, error handling improvements, documentation

- [ ] T089 [P] Add anonymous function contextual naming in LspCallHierarchyAnalyzer (detect "map callback", "filter predicate", "onClick handler")
- [ ] T090 [P] Implement external reference dimming in SymbolNode.tsx (opacity: 0.5 for isExternal symbols, dashed edges)
- [ ] T091 [P] Add progress indicator to SymbolGraphView.tsx for LSP timeout scenarios (show "Analyzing..." for 5 seconds)
- [ ] T092 [P] Add `symbolAnalysisProgress` message type to src/shared/types.ts for progress updates
- [ ] T093 Add comprehensive error handling for all LSP edge cases in SymbolViewService
- [ ] T094 Add logging for symbol analysis operations in SymbolViewService using extensionLogger
- [ ] T095 Update CHANGELOG.md with feature description and user-facing changes
- [ ] T096 Add documentation to README.md for symbol drill-down feature
- [ ] T097 Run Snyk security scan on new analyzer code: `npm run snyk:code` (FR per constitution)
- [ ] T098 Run SonarQube quality scan: check for code smells in LspCallHierarchyAnalyzer and SymbolViewService
- [x] T099 Run full E2E test suite from packaged .vsix: `npm run test:vscode:vsix`
- [x] T100 Verify package integrity: `npx vsce ls | grep "\.map$"` must be empty (ZERO .map files)

---

## Dependencies

### User Story Dependencies (Completion Order)

```
Phase 1: Setup (T001-T003)
  ↓
Phase 2: Foundational (T004-T008) ⚠️ BLOCKING - must complete first
  ↓
Phase 3: US1 (T009-T029) 🎯 MVP - TypeScript symbol navigation
  ↓
Phase 4: US2 (T030-T042) - Multi-language support (depends on US1)
  ↓
Phase 5: US3 (T043-T058) - Visual enhancements (depends on US1)
  ↓
Phase 6: US4 (T059-T074) - MCP integration (depends on US1, US2)
  ↓
Phase 7: US5 (T075-T088) - Live updates (depends on US1)
  ↓
Phase 8: Polish (T089-T100) - Cross-cutting concerns (can run in parallel with US4, US5)
```

### Task-Level Dependencies

**Critical Path** (must be sequential):
- T004 → T005 → T006 → T007 → T008 (LspCallHierarchyAnalyzer foundation)
- T009 → T012 → T013 (SymbolViewService depends on LspCallHierarchyAnalyzer)
- T013 → T014 → T015 (GraphProvider integration depends on SymbolViewService)
- T017 → T018 (Layout logic depends on buildGraph extension)

**Parallel Opportunities** (marked with [P]):
- T001 and T002 can run in parallel (type definitions in different sections)
- T009 and T010 can run in parallel (extension service and webview component)
- T016 and T017 can run in parallel (component creation and build logic)
- T043, T044, T045 can run in parallel (styling work)
- T059 and T060 can run in parallel (MCP tool definition and schema)
- All Polish tasks (T089-T098) can run in parallel except T099-T100

---

## Parallel Execution Examples

### MVP Sprint (US1) - 4 days

**Day 1**: Foundation
- Sequential: T004 → T005 → T006 → T007
- Parallel: T008 (tests while waiting for review)

**Day 2**: Core Integration
- Parallel: T009 (SymbolViewService) + T010 (SymbolGraphView) + T016 (SymbolNode)
- Sequential: T011 → T012 → T013

**Day 3**: GraphProvider & Layout
- Sequential: T014 → T015
- Parallel: T017 + T018 + T019 + T020 + T021 + T022
- Parallel: T023 + T024 (unit tests)

**Day 4**: E2E Testing
- Sequential: T025 → T026 → T027 → T028 → T029

### Multi-Language Sprint (US2) - 2 days

**Day 1**: LSP Testing & Integration
- Parallel: T030 (Python) + T031 (Rust) + T038 (fixtures) + T039 (fixtures)
- Sequential: T032 → T033 → T034 → T035 → T036
- Parallel: T037 (unit tests)

**Day 2**: E2E Testing
- Sequential: T040 → T041 → T042

### Visual Enhancements Sprint (US3) - 2 days

**Day 1**: Styling
- Parallel: T043 + T044 + T045 + T046 + T047 + T048 + T049
- Sequential: T050 → T051 → T052
- Parallel: T053 + T054 (tests)

**Day 2**: E2E Testing
- Sequential: T055 → T056 → T057 → T058

---

## Implementation Strategy

### MVP-First Approach

**Phase 1-3 (US1)** = Minimum Viable Product
- Delivers core value: TypeScript symbol navigation
- Enables early user feedback
- Can be released independently if needed
- **Estimated effort**: 4 days

**Phase 4 (US2)** = Multi-language expansion
- Extends value to Python/Rust developers
- Leverages US1 infrastructure
- **Estimated effort**: 2 days

**Phase 5 (US3)** = UX polish
- Improves comprehension speed
- Non-blocking for functionality
- **Estimated effort**: 2 days

**Phase 6-7 (US4-US5)** = Advanced features
- MCP integration for AI use cases
- Live updates for active development
- **Estimated effort**: 3 days

**Total estimated effort**: 11 days (US1: 4d, US2: 2d, US3: 2d, US4: 2d, US5: 1d, Polish: 1d)

### Incremental Delivery

Each user story is a complete, independently testable increment:

1. **After US1**: Ship TypeScript symbol navigation (core value delivered)
2. **After US2**: Ship multi-language support (polyglot project value)
3. **After US3**: Ship visual enhancements (improved UX)
4. **After US4**: Ship MCP integration (AI agent value)
5. **After US5**: Ship live updates (active development value)

This enables continuous delivery and early user feedback at each milestone.

---

## Testing Summary

### Unit Tests (Vitest)

- **Analyzer layer**: LspCallHierarchyAnalyzer (filtering, cycles, paths) - T008, T037
- **Extension layer**: SymbolViewService (LSP orchestration) - T023
- **Webview layer**: buildGraph (symbol mode, layout), BreadcrumbNav - T024, T053, T054
- **MCP layer**: TOON serialization, error handling - T067, T068, T069

### E2E Tests (@vscode/test-electron) - MANDATORY

- **US1 (P1)**: Drill-down, navigation, back button - T026-T029
- **US2 (P2)**: Multi-language (Python, Rust), error states - T040-T042
- **US3 (P2)**: Visual styling, cycles, breadcrumb - T055-T058
- **US5 (P3)**: Live updates, performance - T085-T088

### Integration Tests

- **US4 (P3)**: MCP tool with real LSP data - T070-T074

**Total test coverage**: 40 test tasks out of 100 total tasks (40%)

---

## Constitution Compliance Checklist

- ✅ **Principle I - Cross-Platform**: normalizePath() usage in T007, T037
- ✅ **Principle II - Layered Architecture**: Analyzer (T004-T008), Extension (T009-T024), Webview (T010-T024), MCP (T059-T074)
- ✅ **Principle III - Test-First**: E2E tests in T025-T029, T040-T042, T055-T058, T085-T088
- ✅ **Principle IV - Package Integrity**: Security scan T097, quality scan T098, package verification T100
- ✅ **Principle V - Code Quality**: TypeScript types T001-T002, linting T098, conventional commits

---

## Notes

- **Tests are MANDATORY** for all user-facing features per Constitution Principle III
- **Parallelization** is marked with [P] - tasks with different files and no dependencies
- **User story labels** [US1]-[US5] enable independent implementation and testing
- **File paths** are absolute from repository root (src/, tests/)
- **Acceptance criteria** from spec.md are embedded in task descriptions
- **Critical patterns** (normalizePath, Promise.race, callback refs) are called out in task descriptions

---

## Ready to Implement?

Start with **Phase 2 (Foundational)** → T004-T008 to build LspCallHierarchyAnalyzer foundation.

Then proceed to **Phase 3 (US1 MVP)** → T009-T029 for TypeScript symbol navigation.

Each phase is independently testable - run E2E tests after completing each user story phase.
