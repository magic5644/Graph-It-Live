# SDD ledger — plan: docs/superpowers/plans/2026-09-02-graph-context-gateway.md

## Workspace

- Worktree: `/Users/gildaslebournault/github/Graph-It-Live/.worktrees/graph-context-gateway`
- Branch: `codex/graph-context-gateway`
- Base before Task 1: to be recorded immediately before dispatch
- Main branch contains only the plan/specification commit `2e08bd5` and remains untouched by implementation.

## Preflight scan: task self-consistency

| Task | Files vs. behavior | Tests vs. behavior | Result |
|---|---|---|---|
| 1 | Existing `QueryEngine` and MCP query contracts are named consistently. | Same-name scoped nodes, seed preservation, ambiguity and budget tests cover stated contract. | Consistent. |
| 2 | `FileScopeMatcher` is introduced before `QueryEngine` consumes it. | Glob, path normalization and SQL-scope tests match the implementation requirements. | Consistent. |
| 3 | Shared types are created in `src/shared/graph-context-types.ts`. | Serialization and discriminant tests cover the declared unions. | Consistent. |
| 4 | Federator consumes `Spider` and `CallGraphIndexer` and produces `GraphContextSnapshot`. | Fixture covers file, symbol, test, import, call, duplicate names and external calls. | Consistent. |
| 5 | Resolver and path finder are separate pure modules. | Exact, ambiguous, missing, directed, undirected and bounded-path cases are specified. | Consistent. |
| 6 | Retriever consumes federation, resolver and path finder. | Six golden questions assert seed and relation classes rather than only counts. | Consistent. |
| 7 | Evidence is attached by a dedicated mapper and federator/retriever integration. | Extracted, resolved, ambiguous and stale cases are specified. | Consistent. |
| 8 | Budget and cursor modules consume the response and revision. | Seed/path preservation, exact limit, omission counts and invalidation tests are specified. | Consistent. |
| 9 | MCP adapter consumes the pure executor and worker state. | Schema, dispatch, formatting, redaction, scope and cursor cases are specified. | Consistent. |
| 10 | CLI and native LM adapters delegate to the same executor. | CLI parsing, native registration and VS Code E2E coverage are specified. | Consistent. |
| 11 | Community/statistics module feeds `overview` and MCP output. | Dense clusters, bridge edge, isolated node, hubs and confidence counts are specified. | Consistent. |
| 12 | Document indexer extends the federated view and shared node/relation unions. | Markdown, ADR, rationale, malformed and outside-workspace cases are specified. | Consistent. |
| 13 | Benchmark changes existing context-economy script and adds a benchmark test/report. | Six workflows and comparable quality/token/latency metrics are specified. | Consistent. |
| 14 | ADR and user docs consume the final API and benchmark. | Release gate runs lint, types, unit, E2E, build, package and map verification. | Consistent. |

## Preflight scan: shared files and interfaces

| Tasks | Shared file/interface | Finding and ruling |
|---|---|---|
| 1 / 2 | `QueryEngine.test.ts`, `QueryEngine`, `fileFilter` | Task 1 creates the failing contract; Task 2 owns the fix. **Ruling:** preserve the existing query API and add only scope behavior. |
| 1 / 3 | `GraphContextContract.test.ts`, new shared request contract | Task 1 can test the contract through temporary structural fixtures before Task 3 creates the types. **Ruling:** keep the test assertions independent of implementation details. |
| 2 / 6 | `QueryEngine` FTS behavior | Task 6 reuses keyword/FTS behavior after Task 2 adds scope enforcement. **Ruling:** the unified retriever must call the corrected scoped path, never duplicate unscoped scoring. |
| 3 / 4 | `GraphContextSnapshot`, node and edge unions | Task 4 consumes the types created by Task 3. **Ruling:** snapshot remains read-only; no index schema migration. |
| 3 / 5 | `GraphContextSeed`, `GraphContextCandidate` | Task 5 consumes resolver inputs from Task 3. **Ruling:** keep ambiguity in the response instead of throwing for ordinary label collisions. |
| 3 / 6 | `GraphContextRequest`, `GraphContextResponse` | Task 6 produces the pre-budget response defined by Task 3. **Ruling:** budget trimming is a later pure step, not hidden inside ranking. |
| 3 / 7 | `GraphContextEdge`, confidence and evidence | Task 7 enriches edges from Task 3. **Ruling:** no confidence value may be invented when source evidence is absent. |
| 3 / 8 | Response fields and serialization | Task 8 trims Task 3 responses. **Ruling:** required seeds/endpoints are protected even if optional fields are omitted. |
| 3 / 9 | Request schema and `graph_context` name | Task 9 maps the shared request to Zod/MCP. **Ruling:** public MCP uses `response_format`; analyzer types retain `format`. |
| 3 / 10 | Shared executor request/response | Task 10 uses the same executor as MCP. **Ruling:** CLI and native LM adapters must not reimplement ranking or traversal. |
| 3 / 11 | Community node/relation additions | Task 11 consumes the same node/edge unions. **Ruling:** community IDs are deterministic and topology-based for the unified view. |
| 3 / 12 | `GraphContextNodeKind`, `GraphContextRelation` | Task 12 extends the unions with document/rationale values already required by the spec. **Ruling:** preserve code-only behavior when no document scope is requested. |
| 4 / 5 | `GraphContextSnapshot` | Task 5 resolves and traverses the snapshot produced by Task 4. **Ruling:** stable canonical IDs are the only path identity. |
| 4 / 6 | Federated nodes/edges | Task 6 retrieves over the federation. **Ruling:** cross-layer `CONTAINS` edges are added only by the federator. |
| 4 / 7 | Federator edge metadata | Task 7 enriches, but does not mutate source indexes. **Ruling:** provenance stays in the public snapshot. |
| 4 / 8 | Snapshot revision | Task 8 binds cursors to the revision generated by Task 4. **Ruling:** any source/index revision change invalidates continuation. |
| 4 / 9 | Worker-owned index instances | Task 9 reuses worker state. **Ruling:** no second call-graph initialization is allowed. |
| 4 / 11 | Federated graph topology | Task 11 computes macro data over the same canonical view. **Ruling:** exclude unresolved external nodes from internal hub ranking by default. |
| 4 / 12 | Federated document/code view | Task 12 adds document nodes without replacing code federation. **Ruling:** document indexing remains local and scope-controlled. |
| 5 / 6 | Resolver and path finder | Task 6 delegates deterministic modes to Task 5. **Ruling:** search ranking may be heuristic, but path mode remains exact BFS. |
| 5 / 7 | Ambiguity and path edges | Task 7 supplies ambiguity status used by Task 5. **Ruling:** ambiguous edges are excluded from default shortest paths. |
| 5 / 8 | Path endpoints and budget response | Task 8 protects Task 5 endpoints during truncation. **Ruling:** a path response may be marked truncated only for unrelated context. |
| 5 / 9 | `executeGraphContext` path mode | Task 9 exposes Task 5 through MCP. **Ruling:** MCP validation rejects missing endpoints before executor invocation. |
| 6 / 7 | Retriever and evidence | Task 7 enriches the response produced by Task 6. **Ruling:** evidence is attached before token selection. |
| 6 / 8 | Retriever response and token selection | Task 8 consumes Task 6 output. **Ruling:** retrieval and serialization remain separate testable stages. |
| 6 / 9 | Pure retrieval executor | Task 9 is an adapter only. **Ruling:** worker lifecycle and public formatting stay outside analyzer logic. |
| 6 / 10 | Same executor across clients | Task 10 must preserve semantics across CLI, MCP and native LM. **Ruling:** only presentation and cancellation differ. |
| 6 / 11 | `overview` mode | Task 6 has a minimal fallback before Task 11 lands. **Ruling:** the fallback is allowed; Task 11 later upgrades the same response contract. |
| 6 / 12 | Retriever and document nodes | Task 12 adds document-aware seeds without changing code-only defaults. **Ruling:** no source content is injected by the retriever. |
| 7 / 8 | Edge confidence and token selection | Task 8 must preserve evidence on retained edges. **Ruling:** trimming may remove optional evidence only if the edge remains explicitly marked as incomplete; default implementation retains it. |
| 7 / 9 | Public MCP edge evidence | Task 9 serializes Task 7 evidence. **Ruling:** existing response redaction handles paths; no duplicate redaction logic. |
| 8 / 9 | Budget/cursor response | Task 9 exposes the exact cursor and token fields. **Ruling:** MCP output preserves structured content while text uses the requested format. |
| 8 / 10 | Cursor CLI/LM semantics | Task 10 passes cursors unchanged. **Ruling:** no client-specific cursor encoding. |
| 9 / 10 | MCP/CLI/native executor | Both consume the same Task 9 executor. **Ruling:** `graph-it context` is direct invocation, not an MCP subprocess. |
| 9 / 11 | MCP overview output | Task 11 expands `overview` through Task 9. **Ruling:** specialized MCP tools remain backwards compatible. |
| 11 / 12 | Retriever/federator macro view | Task 12 extends the view after Task 11. **Ruling:** document communities are optional and do not alter code-only community IDs. |
| 13 / 14 | Benchmark documentation | Task 14 documents Task 13 output. **Ruling:** published claims must use the common benchmark, never Graphify's benchmark as a direct comparison. |

## Preflight rulings

- Ruling: keep the plan and specification as a committed documentation baseline before creating the feature worktree — this preserves the user's requested plan in Git and costs one documentation commit if the user later prefers a different branch layout.
- Ruling: use a federated read model instead of merging SQLite and cache schemas — this minimizes migration risk and costs some adapter complexity if the two indexes later need a common storage layer.
- Ruling: retain a minimal `overview` fallback in Task 6 and upgrade it in Task 11 — this lets the retrieval core remain independently testable and costs a temporary lower-fidelity overview during intermediate commits.
- Ruling: do not promise Graphify parity for media, PR triage, HTTP multi-project serving or unsupported languages in this plan — this keeps the core release code-centric and costs those capabilities as separate future work.

## Task status

No implementation task has started.
