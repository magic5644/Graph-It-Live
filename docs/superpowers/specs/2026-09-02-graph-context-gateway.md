# Graph Context Gateway — Design Specification

**Date:** 2026-09-02  
**Status:** Proposed  
**Scope:** Core replacement path for Graphify in code-centric agent workflows

## Goal

Provide one deterministic, token-bounded graph retrieval surface that combines Graph-It-Live's file dependency graph, symbol call graph, impact analysis, test relationships, provenance, and VS Code/CLI/MCP integrations.

The feature must make Graph-It-Live the default source of context for code navigation and refactoring while preserving the existing specialized tools.

## Problem

Graph-It-Live currently has strong specialized analyzers but exposes two distinct graph models:

- a file dependency graph maintained by `Spider`;
- a symbol/call graph maintained by `CallGraphIndexer`.

The natural-language query uses the call graph, while architecture and dependency tools use the file graph. An agent must select among many tools and cannot request a single evidence-backed context containing files, symbols, calls, tests, impact and paths.

The public natural-language schema also accepts `fileFilter`, but the current `QueryEngine` does not apply it while scoring seeds. This causes avoidable false positives and token usage.

## Functional requirements

### FR-001 — Unified read model

Expose a federated view with stable IDs for:

- `file` nodes;
- `symbol` nodes;
- `test` nodes when test evidence is available;
- `community` nodes when community analysis is requested.

The first implementation may federate existing indexes at read time. It must not require a risky physical migration of the existing SQLite and cache formats.

### FR-002 — Query modes

Support these modes:

- `search`: retrieve a relevant subgraph from a natural-language question;
- `neighbors`: inspect direct incoming and outgoing relationships;
- `path`: find the shortest path between two entities;
- `impact`: find direct and transitive dependents;
- `refactor`: prioritize breaking-change, caller, implementation and test evidence;
- `overview`: return graph statistics, hubs and communities.

### FR-003 — Entity resolution

Resolve entities by exact file path, exact file-plus-symbol identity, stable ID, or label. If more than one candidate matches, return candidates with scores and do not silently choose one.

### FR-004 — Relationship controls

Allow filtering by `CONTAINS`, `IMPORTS`, `CALLS`, `INHERITS`, `IMPLEMENTS`, `USES`, `TESTED_BY`, `IMPACTED_BY`, and `BELONGS_TO`.

### FR-005 — Provenance

Every returned edge must include a confidence class and evidence when available:

- `EXTRACTED`: explicit AST/import/test evidence;
- `RESOLVED`: resolved through module or symbol identity;
- `INFERRED`: derived by analysis;
- `AMBIGUOUS`: multiple possible endpoints;
- `STALE`: source changed after the index revision.

Evidence must include relative file path and line span where available.

### FR-006 — Scope filtering

`scope`/`fileFilter` must be applied before seed scoring and traversal. Patterns must use normalized workspace-relative paths, support `*`, `**` and `?`, and be parameterized rather than interpolated into SQL.

### FR-007 — Token budget

The request accepts a token budget from 500 to 16,000. Selection must use the existing real tokenizer, preserve requested seeds and path endpoints, and report truncation and omitted counts.

### FR-008 — Continuation

Truncated results must provide an opaque continuation cursor bound to the question, workspace, index revision, filters and budget. A continuation must never repeat the complete previous result.

### FR-009 — Integrations

Expose the same executor through:

- MCP tool `graphitlive_graph_context`;
- CLI command `graph-it context`;
- native VS Code Language Model tool `graph-it-live_graph_context`.

Existing specialized tools remain available and backwards compatible.

### FR-010 — Offline-first behavior

Code extraction and retrieval must work without an LLM or network. LLM keyword extraction remains optional and must never be required for correctness.

## Public request shape

```typescript
type GraphContextMode = "search" | "neighbors" | "path" | "impact" | "refactor" | "overview";
type GraphContextNodeKind = "file" | "symbol" | "test" | "community" | "document" | "rationale" | "external";
type GraphContextRelation = "CONTAINS" | "IMPORTS" | "CALLS" | "INHERITS" | "IMPLEMENTS" | "USES" | "TESTED_BY" | "IMPACTED_BY" | "BELONGS_TO" | "REFERENCES" | "EXPLAINS" | "DOCUMENTS";
type GraphContextConfidence = "EXTRACTED" | "RESOLVED" | "INFERRED" | "AMBIGUOUS" | "STALE";

interface GraphContextSeed {
  id?: string;
  filePath?: string;
  symbolName?: string;
  label?: string;
}

interface GraphContextRequest {
  question?: string;
  seeds?: GraphContextSeed[];
  mode?: GraphContextMode;
  from?: GraphContextSeed;
  to?: GraphContextSeed;
  relations?: GraphContextRelation[];
  scope?: string;
  depth?: number;
  maxNodes?: number;
  tokenBudget?: number;
  directed?: boolean;
  cursor?: string;
  format?: "toon" | "json";
}
```

At least one of `question`, `seeds`, or both `from` and `to` is required.

## Public response shape

```typescript
interface GraphContextNode {
  id: string;
  kind: GraphContextNodeKind;
  name: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  language?: string;
  score?: number;
  isSeed?: boolean;
}

interface GraphContextEvidence {
  sourcePath?: string;
  sourceLine?: number;
  sourceEndLine?: number;
  reason: string;
}

interface GraphContextEdge {
  source: string;
  target: string;
  relation: GraphContextRelation;
  confidence: GraphContextConfidence;
  sourcePath?: string;
  sourceLine?: number;
  sourceEndLine?: number;
  evidence?: GraphContextEvidence;
}

interface GraphContextPath {
  nodeIds: string[];
  edgeIndexes: number[];
  hops: number;
}

interface GraphContextCandidate {
  node: GraphContextNode;
  score: number;
  reason: string;
}

interface GraphContextResolution {
  selected?: GraphContextNode;
  candidates: GraphContextCandidate[];
  ambiguous: boolean;
  notFound: boolean;
}

interface GraphContextResponse {
  indexRevision: string;
  fresh: boolean;
  mode: GraphContextMode;
  seeds: GraphContextNode[];
  nodes: GraphContextNode[];
  edges: GraphContextEdge[];
  paths: GraphContextPath[];
  ambiguous: GraphContextCandidate[];
  omitted: { nodes: number; edges: number };
  nextQueries: string[];
  nextCursor?: string;
  tokenEstimate: number;
  truncated: boolean;
}
```

The internal federation snapshot is:

```typescript
interface GraphContextSnapshot {
  revision: string;
  fresh: boolean;
  nodes: GraphContextNode[];
  edges: GraphContextEdge[];
}
```

Source content is excluded by default. A caller must use an existing file-reading mechanism after the graph has identified precise files and line spans.

## Non-functional requirements

- No `vscode` imports in `src/analyzer/**`, `src/mcp/**`, or `src/shared/**`.
- All stored and compared paths use `normalizePath()`.
- MCP paths are workspace-relative in public responses and validated against the workspace root.
- Existing tool names and response contracts remain compatible.
- Incremental file invalidation must update the revision and prevent stale continuation cursors.
- No new runtime dependency is introduced for glob matching, graph traversal, or token counting.
- The feature must pass lint, typecheck, unit tests, CLI tests, VS Code E2E tests, package verification, and the context-economy benchmark.

## Success criteria

The implementation is ready for a Graphify replacement claim in code-centric workflows only when it demonstrates on a shared fixture corpus:

1. exact path results for all directed and undirected path fixtures;
2. no out-of-scope seed when a scope filter is provided;
3. no dropped requested seed under the minimum token budget;
4. provenance for every returned edge or an explicit `AMBIGUOUS`/`STALE` status;
5. lower tool-call count than the equivalent sequence of existing specialized tools for the six reference workflows;
6. measured token counts for MCP initialization, request payload, response payload and follow-up continuation;
7. Graphify and Graph-It-Live evaluated with the same corpus, questions, depth and budget before making quality claims.

## Out of scope for the core release

- PDF, image, video or audio ingestion;
- GitHub PR dashboard and cross-PR triage;
- HTTP multi-project server;
- replacing the existing SQLite schema;
- using an external vector database;
- automatic source-file content injection into the response.
