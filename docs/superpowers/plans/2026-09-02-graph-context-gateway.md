# Graph Context Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified, provenance-aware, token-bounded graph retrieval surface so Graph-It-Live becomes the default Graphify replacement for code navigation and refactoring workflows.

**Architecture:** Keep `Spider` and `CallGraphIndexer` as independent storage/indexing implementations, then add a read-only federation layer that exposes one stable graph model. The same pure analyzer executor will be called by MCP, CLI and the native VS Code Language Model tool. Existing specialized tools remain available for exact operations and act as implementation primitives for the new context gateway.

**Tech Stack:** TypeScript strict mode, Tree-sitter/WASM, `sql.js`, existing `Spider` reverse index, FTS5, Vitest, VS Code Language Model Tools, MCP stdio, CLI formatter and existing TOON/tokenizer utilities.

**Spec:** `docs/superpowers/specs/2026-09-02-graph-context-gateway.md`

## Global Constraints

- Keep `src/analyzer/**`, `src/mcp/**` and `src/shared/**` VS Code-agnostic.
- Normalize paths with `normalizePath()` before storing or comparing them.
- Preserve existing MCP, CLI and native LM tool names and response contracts.
- Keep code extraction and retrieval functional without an LLM or network.
- Use parameterized SQL; never interpolate user-provided scope patterns or labels into SQL.
- Return workspace-relative paths from public MCP and native LM responses.
- Do not add a runtime dependency for glob matching, graph traversal or token counting.
- Keep the existing lazy cleanup behavior for reverse-index maps.
- Use the actual tokenizer for budget enforcement; label `chars / 4` measurements as estimates only.
- Add E2E coverage for the new user-facing native tool and CLI command.
- Run `rtk npm run lint`, `rtk npm run check:types`, targeted tests, full tests and `rtk npm run package:verify` before completion.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `docs/superpowers/specs/2026-09-02-graph-context-gateway.md` | Create | Functional and non-functional contract for the gateway |
| `src/shared/graph-context-types.ts` | Create | Shared request, seed, snapshot, node, edge, path, provenance and response types |
| `src/analyzer/graph-context/FileScopeMatcher.ts` | Create | Normalized workspace-relative glob matching |
| `src/analyzer/graph-context/GraphContextFederator.ts` | Create | Read-only federation of file and symbol indexes |
| `src/analyzer/graph-context/GraphContextResolver.ts` | Create | Exact and fuzzy entity resolution with ambiguity reporting |
| `src/analyzer/graph-context/GraphContextPathFinder.ts` | Create | Directed/undirected shortest paths |
| `src/analyzer/graph-context/GraphContextRetriever.ts` | Create | Search, neighbors, impact, refactor and overview retrieval modes |
| `src/analyzer/graph-context/GraphContextBudget.ts` | Create | Token-aware node/edge selection and truncation |
| `src/analyzer/graph-context/GraphContextCursor.ts` | Create | Revision-bound continuation cursors |
| `src/analyzer/graph-context/GraphContextCommunities.ts` | Create | Hubs, communities and statistics over the federated view |
| `src/mcp/tools/graphContext.ts` | Create | Pure MCP executor adapter |
| `src/mcp/types.ts` | Modify | Public schema and tool-name registration |
| `src/mcp/worker/invokeTool.ts` | Modify | Worker dispatch for the new executor |
| `src/mcp/tools/index.ts` | Modify | Export the new MCP executor |
| `src/mcp/mcpServer.ts` | Modify | Register `graphitlive_graph_context` |
| `src/cli/commands/context.ts` | Create | Non-interactive `graph-it context` command |
| `src/cli/commands/tool.ts` | Modify | CLI passthrough support |
| `src/cli/index.ts` | Modify | CLI help and command routing |
| `src/cli/commandHelp.ts` | Modify | Detailed command help |
| `src/extension/services/LmToolsService.ts` | Modify | Native `graph-it-live_graph_context` registration |
| `package.json` | Modify | Add the native LM contribution and description |
| `tests/analyzer/graph-context/*.test.ts` | Create | Pure federation, resolution, path, provenance and budget tests |
| `tests/mcp/tools/graphContext.test.ts` | Create | MCP schema and executor tests |
| `tests/cli/context.test.ts` | Create | CLI parsing and output tests |
| `tests/extension/services/LmToolsService.test.ts` | Modify | Native tool registration and invocation tests |
| `tests/vscode-e2e/suite/graphContext.test.ts` | Create | User-facing VS Code LM tool E2E coverage |
| `scripts/context-economy-corpus.mjs` | Modify | Shared budget and tool-call measurements |
| `tests/benchmarks/graphContextBenchmark.test.ts` | Create | Reproducible Graph-It-Live benchmark assertions |
| `docs/architecture/ADR-F5-01-graph-context-gateway.md` | Create | Architectural decision record |
| `docs/CLI.md` | Modify | CLI usage and examples |
| `README.md` | Modify | Feature overview, limitations and benchmark method |

## Delivery Sequence

```text
Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7
                                      ↘ Task 8 → Task 9 → Task 10
                                                   ↘ Task 11 → Task 12
```

Tasks 1–7 are the correctness core. Tasks 8–10 expose it to consumers. Task 11 adds macro graph context, and Task 12 adds documentation ingestion. Task 13 validates the full claim with a common benchmark. Task 14 closes documentation and release validation.

---

### Task 1: Lock the contracts and reproduce the current query defect

**Files:**
- Modify: `tests/analyzer/QueryEngine.test.ts`
- Modify: `tests/mcp/tools/query.test.ts`
- Create: `tests/analyzer/graph-context/GraphContextContract.test.ts`

**Interfaces:**
- Consumes: current `QueryRequest`, `QueryEngine`, `QueryNaturalLanguageSchema`.
- Produces: regression tests proving `fileFilter` scope, seed preservation and the new request invariants.

- [ ] **Step 1: Add a failing `fileFilter` test**

Create two in-memory nodes with the same searchable name, one under `src/analyzer/` and one under `src/webview/`. Query with `fileFilter: 'src/analyzer/**'` and assert that only the analyzer node is a seed and appears in the result.

```typescript
it('restricts seed scoring and traversal to fileFilter', async () => {
  const engine = makeEngineWithNodes([
    { id: 'a', name: 'resolvePath', type: 'function', path: '/workspace/src/analyzer/path.ts', startLine: 4 },
    { id: 'b', name: 'resolvePath', type: 'function', path: '/workspace/src/webview/path.ts', startLine: 8 },
  ]);
  const result = await engine.query({
    question: 'resolvePath',
    workspaceRoot: '/workspace',
    fileFilter: 'src/analyzer/**',
  });
  expect(result.seedNodeIds).toEqual(['a']);
  expect(result.nodes.every((node) => node.path.startsWith('/workspace/src/analyzer/'))).toBe(true);
});
```

- [ ] **Step 2: Add budget and identity contract tests**

Assert that a requested seed is always present when `tokenBudget` is 500, a missing `question` is rejected when no seed/path is supplied, and an ambiguous label returns candidates instead of selecting an arbitrary node.

- [ ] **Step 3: Run the tests and verify the scope test fails**

Run: `rtk npx vitest run tests/analyzer/QueryEngine.test.ts tests/mcp/tools/query.test.ts tests/analyzer/graph-context/GraphContextContract.test.ts`

Expected: existing tests pass; the new `fileFilter` test fails because the current SQL seed scoring ignores the field.

- [ ] **Step 4: Commit the regression contract**

```bash
rtk git add tests/analyzer/QueryEngine.test.ts tests/mcp/tools/query.test.ts tests/analyzer/graph-context/GraphContextContract.test.ts
rtk git commit -m "test(query): lock graph context retrieval contracts"
```

---

### Task 2: Implement scoped seed scoring

**Files:**
- Create: `src/analyzer/graph-context/FileScopeMatcher.ts`
- Modify: `src/analyzer/QueryEngine.ts`
- Modify: `src/shared/query-types.ts`
- Modify: `tests/analyzer/QueryEngine.test.ts`
- Create: `tests/analyzer/graph-context/FileScopeMatcher.test.ts`

**Interfaces:**
- Consumes: `QueryRequest.workspaceRoot`, `QueryRequest.fileFilter`, normalized paths.
- Produces: `compileFileScope(workspaceRoot, pattern)` and SQL seed queries constrained by the compiled scope.

- [ ] **Step 1: Write matcher tests before implementation**

Cover `src/analyzer/**`, `src/*.ts`, `src/**/path?.ts`, an empty pattern, Windows separators, a pattern that escapes the workspace root, and a path outside the workspace.

```typescript
expect(compileFileScope('/workspace', 'src/analyzer/**').matches('/workspace/src/analyzer/path.ts')).toBe(true);
expect(compileFileScope('/workspace', 'src/analyzer/**').matches('/workspace/src/webview/path.ts')).toBe(false);
expect(compileFileScope('/workspace', 'src/*.ts').matches('/workspace/src/index.ts')).toBe(true);
expect(compileFileScope('/workspace', 'src/*.ts').matches('/workspace/src/nested/index.ts')).toBe(false);
```

- [ ] **Step 2: Run the matcher tests and verify they fail**

Run: `rtk npx vitest run tests/analyzer/graph-context/FileScopeMatcher.test.ts`

Expected: FAIL because `FileScopeMatcher.ts` does not exist.

- [ ] **Step 3: Implement normalized, parameterized scope matching**

Convert the user pattern to a workspace-qualified SQLite `GLOB` pattern using normalized `/` separators. Escape literal SQL pattern characters before replacing `*`, `**` and `?`. Return a predicate for post-query validation and a SQL pattern for the seed query. Reject patterns resolving outside the workspace.

Change both FTS5 and `LIKE` fallback queries in `QueryEngine.scoreSeedNodes()` to add `AND path GLOB ?`. Pass the scope parameter separately from the FTS query parameter. Apply the same predicate in `fetchNodes()` so a traversed node cannot escape the scope.

- [ ] **Step 4: Run query tests and verify the original failure passes**

Run: `rtk npx vitest run tests/analyzer/QueryEngine.test.ts tests/analyzer/graph-context/FileScopeMatcher.test.ts`

Expected: PASS, including the two same-name nodes test.

- [ ] **Step 5: Commit the fix**

```bash
rtk git add src/analyzer/graph-context/FileScopeMatcher.ts src/analyzer/QueryEngine.ts src/shared/query-types.ts tests/analyzer/QueryEngine.test.ts tests/analyzer/graph-context/FileScopeMatcher.test.ts
rtk git commit -m "fix(query): enforce workspace file filters during retrieval"
```

---

### Task 3: Define the federated graph contract

**Files:**
- Create: `src/shared/graph-context-types.ts`
- Create: `tests/shared/graph-context-types.test.ts`

**Interfaces:**
- Consumes: `RelationType`, existing file and symbol result types.
- Produces: `GraphContextRequest`, `GraphContextSeed`, `GraphContextSnapshot`, `GraphContextResponse`, `GraphContextNode`, `GraphContextEdge`, `GraphContextPath`, `GraphContextCandidate`, `GraphContextEvidence`.

- [ ] **Step 1: Add discriminated types**

Define:

```typescript
export type GraphContextMode = 'search' | 'neighbors' | 'path' | 'impact' | 'refactor' | 'overview';
export type GraphContextNodeKind = 'file' | 'symbol' | 'test' | 'community' | 'document' | 'rationale' | 'external';
export type GraphContextRelation = 'CONTAINS' | 'IMPORTS' | 'CALLS' | 'INHERITS' | 'IMPLEMENTS' | 'USES' | 'TESTED_BY' | 'IMPACTED_BY' | 'BELONGS_TO' | 'REFERENCES' | 'EXPLAINS' | 'DOCUMENTS';
export type GraphContextConfidence = 'EXTRACTED' | 'RESOLVED' | 'INFERRED' | 'AMBIGUOUS' | 'STALE';

export interface GraphContextSeed {
  id?: string;
  filePath?: string;
  symbolName?: string;
  label?: string;
}

export interface GraphContextSnapshot {
  revision: string;
  fresh: boolean;
  nodes: GraphContextNode[];
  edges: GraphContextEdge[];
}
```

Each node carries `id`, `kind`, `name`, optional `path`, optional `startLine`/`endLine`, optional `language`, `score`, and optional `isSeed`. Each edge carries `source`, `target`, `relation`, `confidence`, optional `sourcePath`, `sourceLine`, `sourceEndLine`, and `evidence`. The response includes `indexRevision`, `fresh`, `seeds`, `nodes`, `edges`, `paths`, `ambiguous`, `omitted`, `nextQueries`, `nextCursor`, `tokenEstimate` and `truncated`.

- [ ] **Step 2: Test serializability and discriminants**

Assert that every union member can be serialized to JSON, that unsupported relation/confidence values are rejected by the type-level fixtures, and that a path contains ordered node IDs and edge IDs.

- [ ] **Step 3: Run and commit**

Run: `rtk npx vitest run tests/shared/graph-context-types.test.ts`

```bash
rtk git add src/shared/graph-context-types.ts tests/shared/graph-context-types.test.ts
rtk git commit -m "feat(graph): define unified graph context types"
```

---

### Task 4: Federate file and symbol indexes

**Files:**
- Create: `src/analyzer/graph-context/GraphContextFederator.ts`
- Create: `tests/analyzer/graph-context/GraphContextFederator.test.ts`
- Modify: `src/analyzer/callgraph/CallGraphIndexer.ts` only if a read-only query accessor is missing

**Interfaces:**
- Consumes: `Spider`, `CallGraphIndexer`, `GraphContextRequest`, `normalizePath()`.
- Produces: `GraphContextFederator.buildSnapshot(request): Promise<GraphContextSnapshot>`.

- [ ] **Step 1: Create fixture indexes for files, symbols, calls and imports**

Use existing test helpers to build a four-file graph containing one exported function, one caller, one implementation, one test and one type-only import. Include two identical symbol names in different files and one unresolved external call.

- [ ] **Step 2: Write federation tests**

Assert stable IDs use workspace-relative paths and line numbers, file nodes connect to symbol nodes through `CONTAINS`, file imports remain `IMPORTS`, symbol calls remain `CALLS`, unresolved external calls become `external` nodes or are explicitly omitted, and repeated snapshot construction is deterministic.

- [ ] **Step 3: Implement the read-only adapter**

Use IDs in these forms:

```text
file:src/services/UserService.ts
symbol:src/services/UserService.ts:UserService:12
test:tests/services/UserService.test.ts:UserServiceTest:7
```

Build the file layer from `Spider` results and the symbol layer from SQLite rows. Add only cross-layer `CONTAINS` edges in the federator. Do not mutate either existing index. Apply scope before adding nodes and edges.

- [ ] **Step 4: Add index revision and freshness inputs**

Compute a deterministic revision from workspace root, indexed file paths, file modification times and indexer state. Expose `fresh=false` when a source file changed after the corresponding index entry.

- [ ] **Step 5: Run tests and commit**

Run: `rtk npx vitest run tests/analyzer/graph-context/GraphContextFederator.test.ts tests/analyzer/callgraph/CallGraphIndexer.test.ts`

```bash
rtk git add src/analyzer/graph-context/GraphContextFederator.ts tests/analyzer/graph-context/GraphContextFederator.test.ts src/analyzer/callgraph/CallGraphIndexer.ts
rtk git commit -m "feat(graph): federate file and symbol indexes"
```

---

### Task 5: Resolve entities and implement shortest paths

**Files:**
- Create: `src/analyzer/graph-context/GraphContextResolver.ts`
- Create: `src/analyzer/graph-context/GraphContextPathFinder.ts`
- Create: `tests/analyzer/graph-context/GraphContextResolver.test.ts`
- Create: `tests/analyzer/graph-context/GraphContextPathFinder.test.ts`

**Interfaces:**
- Consumes: `GraphContextSnapshot`, `GraphContextSeed` and `GraphContextCandidate` from Task 3.
- Produces: `resolveSeeds(seed, snapshot, scope): GraphContextResolution` and `findShortestPath(snapshot, from, to, options): GraphContextPath | null`.

The resolver result is:

```typescript
interface GraphContextResolution {
  selected?: GraphContextNode;
  candidates: GraphContextCandidate[];
  ambiguous: boolean;
  notFound: boolean;
}
```

- [ ] **Step 1: Write ambiguity tests**

Verify exact file-plus-symbol ID wins; exact relative path wins over a label; two same-name symbols produce two candidates; a missing entity produces a typed not-found result; and a label match never crosses the requested scope.

- [ ] **Step 2: Write path tests**

Cover a directed path, a reverse-only path, no path, `maxHops`, relation filtering, deterministic tie-breaking by node ID, and `directed=false`.

```typescript
const path = findShortestPath(snapshot, { label: 'UserController' }, { label: 'DatabasePool' }, { directed: true, maxHops: 8 });
expect(path?.nodeIds).toEqual(['symbol:src/api/controller.ts:UserController:4', 'symbol:src/db/repository.ts:UserRepository:9', 'file:src/db/pool.ts']);
```

- [ ] **Step 3: Implement resolver precedence**

Use stable ID, normalized relative path, exact name plus path, exact name, then case-insensitive label scoring. Return `ambiguous` candidates when the top score is tied or when multiple exact symbols share a name without a path.

- [ ] **Step 4: Implement BFS shortest path**

Use a queue with predecessor maps, preserve directed edge orientation, apply relation and scope filters before expansion, stop at `maxHops`, and return nodes plus edges in order. Do not use DFS for shortest-path correctness.

- [ ] **Step 5: Run tests and commit**

Run: `rtk npx vitest run tests/analyzer/graph-context/GraphContextResolver.test.ts tests/analyzer/graph-context/GraphContextPathFinder.test.ts`

```bash
rtk git add src/analyzer/graph-context/GraphContextResolver.ts src/analyzer/graph-context/GraphContextPathFinder.ts tests/analyzer/graph-context/GraphContextResolver.test.ts tests/analyzer/graph-context/GraphContextPathFinder.test.ts
rtk git commit -m "feat(graph): resolve entities and find shortest paths"
```

---

### Task 6: Implement retrieval modes and ranking

**Files:**
- Create: `src/analyzer/graph-context/GraphContextRetriever.ts`
- Create: `src/analyzer/graph-context/GraphContextScorer.ts`
- Create: `tests/analyzer/graph-context/GraphContextRetriever.test.ts`

**Interfaces:**
- Consumes: federated snapshot, `QueryEngine` keyword/FTS behavior, resolver and path finder.
- Produces: `GraphContextRetriever.retrieve(request): Promise<GraphContextResponse>` before budget selection.

- [ ] **Step 1: Add golden retrieval tests**

Create six questions: authentication flow, exact callers, file impact, refactor an interface, path from controller to database, and overview. Assert the expected seed and relationship classes, not just node counts.

- [ ] **Step 2: Implement search mode**

Extract keywords locally with the existing identifier splitter and stopword rules. Reuse FTS5 seed ranking, add path/name/type boosts, apply scope before scoring, cap seeds at 20, then expand by relation-aware BFS.

- [ ] **Step 3: Implement deterministic modes**

`neighbors` calls the resolver and returns one-hop incoming/outgoing edges. `path` calls the path finder. `impact` uses existing symbol/file dependents and marks depth. `refactor` prioritizes breaking changes, runtime dependents, implementations, callers and tests. `overview` delegates to Task 11 when available and returns a minimal graph fallback otherwise.

- [ ] **Step 4: Add next-query suggestions**

Generate deterministic suggestions from omitted relation groups, ambiguous candidates, and high-degree nodes. Examples must be concrete relative paths or symbol names, never generic text such as `ask another question`.

- [ ] **Step 5: Run tests and commit**

Run: `rtk npx vitest run tests/analyzer/graph-context/GraphContextRetriever.test.ts tests/analyzer/QueryEngine.test.ts`

```bash
rtk git add src/analyzer/graph-context/GraphContextRetriever.ts src/analyzer/graph-context/GraphContextScorer.ts tests/analyzer/graph-context/GraphContextRetriever.test.ts
rtk git commit -m "feat(graph): add unified retrieval modes"
```

---

### Task 7: Add provenance, freshness and ambiguity evidence

**Files:**
- Create: `src/analyzer/graph-context/GraphContextEvidence.ts`
- Modify: `src/analyzer/graph-context/GraphContextFederator.ts`
- Modify: `src/analyzer/graph-context/GraphContextRetriever.ts`
- Create: `tests/analyzer/graph-context/GraphContextEvidence.test.ts`

**Interfaces:**
- Consumes: AST edge source lines, import line metadata, index revisions and resolver candidates.
- Produces: `toEvidence(edge)` and confidence-aware public edges.

- [ ] **Step 1: Write evidence tests**

Assert `CALLS` from an AST node is `EXTRACTED`, a module-resolved edge is `RESOLVED`, an unresolved multi-target edge is `AMBIGUOUS`, a source modified after indexing is `STALE`, and every evidence line is workspace-relative.

- [ ] **Step 2: Implement evidence mapping**

Map existing source line and relation fields without inventing precision. If a source line is unavailable, omit the line rather than using line zero. Preserve the original relation and direction.

- [ ] **Step 3: Attach ambiguity diagnostics**

Add candidate IDs and reasons to the response-level `ambiguous` array. Mark affected edges `AMBIGUOUS` and exclude them from a shortest path unless the caller explicitly requests ambiguous edges.

- [ ] **Step 4: Run tests and commit**

Run: `rtk npx vitest run tests/analyzer/graph-context/GraphContextEvidence.test.ts tests/analyzer/graph-context/GraphContextFederator.test.ts`

```bash
rtk git add src/analyzer/graph-context/GraphContextEvidence.ts src/analyzer/graph-context/GraphContextFederator.ts src/analyzer/graph-context/GraphContextRetriever.ts tests/analyzer/graph-context/GraphContextEvidence.test.ts
rtk git commit -m "feat(graph): expose edge provenance and freshness"
```

---

### Task 8: Enforce token budgets and continuation cursors

**Files:**
- Create: `src/analyzer/graph-context/GraphContextBudget.ts`
- Create: `src/analyzer/graph-context/GraphContextCursor.ts`
- Create: `tests/analyzer/graph-context/GraphContextBudget.test.ts`
- Create: `tests/analyzer/graph-context/GraphContextCursor.test.ts`

**Interfaces:**
- Consumes: retrieved response, existing `estimateTokens`, index revision.
- Produces: `applyGraphContextBudget(response, tokenBudget)` and `create/parseGraphContextCursor()`.

- [ ] **Step 1: Write selection tests**

Use a graph whose serialized JSON exceeds 500 tokens. Assert seeds and path endpoints survive, only edges with two retained endpoints are returned, token estimate is at or below budget, and omitted counts are correct.

- [ ] **Step 2: Implement priority selection**

Rank items in this order: requested seeds, path endpoints, path edges, direct neighbors, tests, runtime impact, resolved edges, hubs, then low-score transitive nodes. Use the existing tokenizer rather than `chars / 4` for the final decision. Recompute the edge set after every node selection.

- [ ] **Step 3: Implement revision-bound cursors**

Serialize `{ revision, requestHash, offset, scope, mode }` as URL-safe base64 JSON. Validate all fields, reject a cursor from another revision or request, and never include source content in the cursor.

- [ ] **Step 4: Add continuation tests**

Assert a changed file invalidates the cursor, a changed budget invalidates the cursor, and the next page contains no duplicate node IDs from the first page.

- [ ] **Step 5: Run tests and commit**

Run: `rtk npx vitest run tests/analyzer/graph-context/GraphContextBudget.test.ts tests/analyzer/graph-context/GraphContextCursor.test.ts`

```bash
rtk git add src/analyzer/graph-context/GraphContextBudget.ts src/analyzer/graph-context/GraphContextCursor.ts tests/analyzer/graph-context/GraphContextBudget.test.ts tests/analyzer/graph-context/GraphContextCursor.test.ts
rtk git commit -m "feat(graph): add token budgets and continuation cursors"
```

---

### Task 9: Expose the gateway through MCP

**Files:**
- Create: `src/mcp/tools/graphContext.ts`
- Modify: `src/mcp/types.ts`
- Modify: `src/mcp/tools/index.ts`
- Modify: `src/mcp/worker/invokeTool.ts`
- Modify: `src/mcp/mcpServer.ts`
- Create: `tests/mcp/tools/graphContext.test.ts`

**Interfaces:**
- Consumes: pure executor from Tasks 4–8 and `workerState`.
- Produces: `executeGraphContext(params)` and public MCP tool `graphitlive_graph_context`.

- [ ] **Step 1: Add the Zod schema**

Add `GraphContextParamsSchema` with `question` max 1024, `seeds`, `mode`, `from`, `to`, `relations`, `scope` max 256, `depth` 1–5, `maxNodes` 1–500, `tokenBudget` 500–16000, `directed`, `cursor`, `format`, and `response_format`. Require a question, seeds, or both endpoints through a refinement.

- [ ] **Step 2: Register the typed tool name and dispatcher**

Add `graph_context` to `McpToolName`, `toolSchemas`, `invokeTool.ts` and `src/mcp/tools/index.ts`. Reuse the existing worker initialization and call-graph singleton; do not trigger a second index build.

- [ ] **Step 3: Register the MCP tool**

Register `graphitlive_graph_context` as read-only, idempotent and closed-world. Default public response format to TOON, preserve structured JSON in `structuredContent`, and let the existing formatter redact absolute paths.

- [ ] **Step 4: Test the public contract**

Test valid search/path/impact requests, invalid empty requests, path traversal rejection, scope filtering, TOON output, JSON output, cursor rejection, and workspace-relative paths.

- [ ] **Step 5: Run tests and commit**

Run: `rtk npx vitest run tests/mcp/tools/graphContext.test.ts tests/mcp/responseFormatter.test.ts tests/mcp/types.test.ts`

```bash
rtk git add src/mcp/tools/graphContext.ts src/mcp/types.ts src/mcp/tools/index.ts src/mcp/worker/invokeTool.ts src/mcp/mcpServer.ts tests/mcp/tools/graphContext.test.ts
rtk git commit -m "feat(mcp): expose unified graph context tool"
```

---

### Task 10: Expose the gateway through CLI and native VS Code LM tools

**Files:**
- Create: `src/cli/commands/context.ts`
- Modify: `src/cli/commands/tool.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/cli/commandHelp.ts`
- Modify: `src/extension/services/LmToolsService.ts`
- Modify: `package.json`
- Create: `tests/cli/context.test.ts`
- Modify: `tests/extension/services/LmToolsService.test.ts`
- Create: `tests/vscode-e2e/suite/graphContext.test.ts`

**Interfaces:**
- Consumes: `executeGraphContext()` and the MCP schema from Task 9.
- Produces: `graph-it context` and `graph-it-live_graph_context` with identical semantics.

- [ ] **Step 1: Define CLI syntax tests**

Cover:

```bash
graph-it context "how does authentication reach the database" --mode search --scope 'src/**' --depth 2 --token-budget 2000 --format toon
graph-it context --from 'src/api/controller.ts#UserController' --to 'DatabasePool' --mode path --format json
```

Assert parsed values match the shared request and invalid combinations fail with a non-zero exit code.

- [ ] **Step 2: Implement the CLI command**

Use the existing `CliRuntime`, `ensureIndexed()`, `formatOutput()` and error classification. Do not shell out to the MCP server. Return the same response fields and use relative paths.

- [ ] **Step 3: Add CLI help and passthrough**

Add `context` to `src/cli/index.ts`, `commandHelp.ts` and `TOOL_NAMES` in `tool.ts`. Keep `graph-it tool graph_context` as a low-level alternative for scripts.

- [ ] **Step 4: Register the native LM tool**

Add `registerGraphContext()` to `registerAll()` in `LmToolsService`, using the existing cancellation, workspace path validation, error result and result redaction helpers. Add `graph-it-live_graph_context` to `package.json` under `contributes.languageModelTools`.

- [ ] **Step 5: Add tests and commit**

Run: `rtk npx vitest run tests/cli/context.test.ts tests/extension/services/LmToolsService.test.ts`

Run the VS Code suite with: `rtk npm run test:vscode`

```bash
rtk git add src/cli/commands/context.ts src/cli/commands/tool.ts src/cli/index.ts src/cli/commandHelp.ts src/extension/services/LmToolsService.ts package.json tests/cli/context.test.ts tests/extension/services/LmToolsService.test.ts tests/vscode-e2e/suite/graphContext.test.ts
rtk git commit -m "feat: expose graph context in cli and vscode"
```

---

### Task 11: Add hubs, communities and graph statistics

**Files:**
- Create: `src/analyzer/graph-context/GraphContextCommunities.ts`
- Modify: `src/analyzer/graph-context/GraphContextRetriever.ts`
- Modify: `src/mcp/tools/graphContext.ts`
- Create: `tests/analyzer/graph-context/GraphContextCommunities.test.ts`
- Modify: `tests/mcp/tools/graphContext.test.ts`

**Interfaces:**
- Consumes: federated nodes and edges from Task 4.
- Produces: deterministic `graphStats`, `topHubs` and `getCommunity(communityId)` data used by `overview` mode.

- [ ] **Step 1: Write topology tests**

Use two dense subgraphs connected by one edge plus one isolated node. Assert deterministic community IDs, hub ordering, isolated-node handling, node/edge counts and confidence breakdown.

- [ ] **Step 2: Implement deterministic community detection**

Use the existing pure community implementation pattern, but run it on the federated graph and retain stable IDs by sorting canonical node IDs before assignment. Do not label communities with an LLM in the core path.

- [ ] **Step 3: Implement hub and statistics extraction**

Calculate in-degree, out-degree, total degree, relation counts, node-kind counts, community count and confidence counts. Exclude unresolved external nodes from internal hub ranking unless explicitly requested.

- [ ] **Step 4: Add overview response and MCP tests**

Return a compact overview that identifies the highest-degree internal nodes, communities and suggested follow-up queries. Verify TOON output contains only the requested overview fields.

- [ ] **Step 5: Run tests and commit**

Run: `rtk npx vitest run tests/analyzer/graph-context/GraphContextCommunities.test.ts tests/mcp/tools/graphContext.test.ts`

```bash
rtk git add src/analyzer/graph-context/GraphContextCommunities.ts src/analyzer/graph-context/GraphContextRetriever.ts src/mcp/tools/graphContext.ts tests/analyzer/graph-context/GraphContextCommunities.test.ts tests/mcp/tools/graphContext.test.ts
rtk git commit -m "feat(graph): add hubs communities and graph statistics"
```

---

### Task 12: Add local documentation and rationale nodes

**Files:**
- Create: `src/analyzer/graph-context/DocumentReferenceIndexer.ts`
- Modify: `src/analyzer/graph-context/GraphContextFederator.ts`
- Modify: `src/analyzer/graph-context/GraphContextRetriever.ts`
- Create: `tests/analyzer/graph-context/DocumentReferenceIndexer.test.ts`
- Modify: `src/shared/graph-context-types.ts`

**Interfaces:**
- Consumes: Markdown/MDX/RST/YAML files, source comments and existing file graph.
- Produces: `document` and `rationale` nodes with `REFERENCES`, `EXPLAINS` and `DOCUMENTS` edges.

- [ ] **Step 1: Write local-only parsing tests**

Cover Markdown links, relative ADR links, headings, `# WHY:`, `# NOTE:` and `# HACK:` comments, ignored binary files, malformed Markdown, and links outside the workspace.

- [ ] **Step 2: Implement the reference indexer**

Parse links and rationale markers locally without an LLM. Use workspace-relative IDs, preserve source line numbers, skip links outside the workspace, and mark edges `EXTRACTED`.

- [ ] **Step 3: Add document-aware search tests**

Query a code concept whose only explanation is in an ADR and assert the response returns both the code symbol and the rationale node with an `EXPLAINS` edge.

- [ ] **Step 4: Keep documents opt-in by scope**

Make document nodes available to `search` and `overview` when the caller includes documentation or uses `scope: '**'`; do not increase default code-only query payloads with full document contents.

- [ ] **Step 5: Run tests and commit**

Run: `rtk npx vitest run tests/analyzer/graph-context/DocumentReferenceIndexer.test.ts tests/analyzer/graph-context/GraphContextRetriever.test.ts`

```bash
rtk git add src/analyzer/graph-context/DocumentReferenceIndexer.ts src/analyzer/graph-context/GraphContextFederator.ts src/analyzer/graph-context/GraphContextRetriever.ts src/shared/graph-context-types.ts tests/analyzer/graph-context/DocumentReferenceIndexer.test.ts
rtk git commit -m "feat(graph): index local documentation and rationale"
```

---

### Task 13: Build a common Graphify comparison benchmark

**Files:**
- Modify: `scripts/context-economy-corpus.mjs`
- Create: `tests/benchmarks/graphContextBenchmark.test.ts`
- Create: `docs/benchmarks/graph-context-benchmark.md`

**Interfaces:**
- Consumes: the shared fixture corpus, `graph-it context`, and a separately installed Graphify CLI when available.
- Produces: JSON metrics for retrieval quality, path correctness, tool calls, latency, index freshness and tokens.

- [ ] **Step 1: Define the shared corpus**

Create fixtures covering TypeScript, Python, Rust, same-name symbols, type-only imports, cycles, tests, ambiguous calls, Markdown ADR links and a changed file. The corpus must be small enough for CI and include expected node IDs and paths.

- [ ] **Step 2: Define the six reference workflows**

Measure:

1. locate an unknown concept;
2. explain a file;
3. find callers and callees;
4. trace controller to database;
5. refactor an interface;
6. identify documentation explaining a symbol.

- [ ] **Step 3: Record comparable metrics**

Record `precision@10`, `recall@10`, exact path success, ambiguity rate, stale-edge rate, MCP initialization tokens, request tokens, response tokens, continuation tokens, number of tool calls, cold latency, warm latency and incremental-update latency.

- [ ] **Step 4: Add Graphify as an optional adapter**

Run Graphify with the same corpus, scope, question, depth and budget. Mark missing Graphify capabilities as `not-supported`, not as zero. Never compare Graphify's published ERPNext result directly with Graph-It-Live's local TOON report.

- [ ] **Step 5: Validate token measurements**

Use the same tokenizer for both serialized payloads where possible, separately report provider billing tokens, and retain raw outputs for audit. Keep the existing assertion that code-only indexing performs zero LLM calls.

- [ ] **Step 6: Run and commit**

Run: `rtk npm run test:context-economy`

Run: `rtk npx vitest run tests/benchmarks/graphContextBenchmark.test.ts`

```bash
rtk git add scripts/context-economy-corpus.mjs tests/benchmarks/graphContextBenchmark.test.ts docs/benchmarks/graph-context-benchmark.md
rtk git commit -m "test(benchmark): compare graph context retrieval fairly"
```

---

### Task 14: Documentation, ADR and release validation

**Files:**
- Create: `docs/architecture/ADR-F5-01-graph-context-gateway.md`
- Modify: `docs/CLI.md`
- Modify: `README.md`
- Modify: `docs/architecture/TOON_FORMAT.md`
- Modify: `docs/architecture/MCP_PAYLOAD_LIMITS.md`

**Interfaces:**
- Consumes: final API and benchmark output from Tasks 9–13.
- Produces: user-facing documentation and a reproducible release checklist.

- [ ] **Step 1: Write the ADR**

Record why federation is preferred over replacing the two indexes, the stable ID format, provenance classes, scope semantics, token selection policy, and rejected alternatives such as a vector database or immediate multimedia ingestion.

- [ ] **Step 2: Document all entry points**

Add exact examples for MCP, CLI, VS Code LM tools, path queries, impact queries, scope filters, cursors and JSON/TOON output. Document that source contents are not returned by default.

- [ ] **Step 3: Correct token-economy wording**

Separate representation-size estimates from billing tokens. Include the current corpus result as a measured example, not a universal guarantee, and document the actual tokenizer used for truncation.

- [ ] **Step 4: Document limits and failure modes**

Document maximum depth, maximum nodes, token range, ambiguous entities, stale cursors, unsupported languages, unresolved external calls and files outside the workspace.

- [ ] **Step 5: Run the complete validation gate**

Run:

```bash
rtk npm run lint
rtk npm run check:types
rtk npm test -- --run
rtk npm run test:vscode
rtk npm run build
rtk npm run package
rtk npm run package:verify
rtk git status --short
```

Expected: all commands pass, the package contains zero `.map` files, and `git status --short` shows only intentional documentation/source changes before commit.

- [ ] **Step 6: Commit the completed release documentation**

```bash
rtk git add docs/architecture/ADR-F5-01-graph-context-gateway.md docs/CLI.md README.md docs/architecture/TOON_FORMAT.md docs/architecture/MCP_PAYLOAD_LIMITS.md
rtk git commit -m "docs: document graph context gateway and benchmark"
```

---

## Post-implementation decision gate

Do not claim that Graph-It-Live globally replaces Graphify until the benchmark shows comparable code-only quality on the shared corpus. The first defensible release claim is narrower:

> Graph-It-Live provides a unified, evidence-backed, token-bounded graph context for local code navigation and refactoring across its supported languages.

Graphify parity for PR triage, multi-project HTTP serving, broad language coverage and multimedia knowledge graphs remains a separate roadmap, not an implicit result of this plan.
