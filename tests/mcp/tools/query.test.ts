/**
 * Unit tests for the MCP natural language query tool (executeQueryNaturalLanguage).
 *
 * Uses a mock CallGraphIndexer (no sql.js WASM dependency) and mocks
 * QueryEngine.query to isolate the tool logic.
 *
 * Contract under test (ADR-S2-01-toon-field-mcp-compat.md):
 *  - QueryResult.json (analyzer) is a compact JSON string, NEVER toon.
 *  - MCP tool field `toon` (outputFormat='toon', default) must be a REAL
 *    TOON encoding (2 blocks nodes/edges + a meta line), reconstructed from
 *    QueryResult.json via encodeCompositeAsToon().
 *
 * Test cases:
 *  1. Valid params → QueryResult returned
 *  2. Question too long (>1024 chars) → Zod validation error
 *  3. depth out of bounds → Zod validation error
 *  4. outputFormat 'toon' → returns a real TOON-encoded string (not passthrough JSON)
 *  5. outputFormat 'json' → returns nodes/edges arrays (JSON-serializable), unaffected by toon change
 *  6. tokenBudget out of bounds → Zod validation error
 *  7. Throws when indexer not initialized
 *  8. encodeCompositeAsToon: composite nodes+edges, empty edges;
 *     8a. small payload already under budget (no truncation involved);
 *     8b. real end-to-end budget respect at the analyzer's exact truncation
 *         boundary (tokenBudget === jsonTokens, multi-node truncated payload) —
 *         the genuine regression test for the residual MCP-side risk that
 *         encodeCompositeAsToon() re-encoding could exceed the budget that
 *         was only guaranteed on the compact JSON representation.
 *  9. outputFormat Zod description contains expected keywords
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallGraphIndexer } from "../../../src/analyzer/callgraph/CallGraphIndexer";
import { QueryEngine } from "../../../src/analyzer/QueryEngine";
import { workerState } from "../../../src/mcp/shared/state";
import {
  executeQueryNaturalLanguage,
  QueryNaturalLanguageSchema,
} from "../../../src/mcp/tools/query";
import { validateToolParams } from "../../../src/mcp/types";
import type { QueryResult } from "../../../src/shared/query-types";
import { estimateTokens } from "../../../src/shared/toon";

// ---------------------------------------------------------------------------
// Minimal mock database (sql.js-compatible shape)
// ---------------------------------------------------------------------------

type MockDb = { exec: ReturnType<typeof vi.fn> };

function makeMockDb(): MockDb {
  return { exec: vi.fn().mockReturnValue([]) };
}

// ---------------------------------------------------------------------------
// Mock QueryResult — target contract: `.json` (compact JSON), NOT `.toon`
// ---------------------------------------------------------------------------

const WORKSPACE = "/workspace";
const FILE_A = `${WORKSPACE}/src/a.ts`;

const DEFAULT_COMPACT_JSON = JSON.stringify({
  nodes: [{ id: "main", n: "main", t: "Function", p: FILE_A, l: 1, r: 0.9 }],
  edges: [],
  nodeCount: 1,
  edgeCount: 0,
  truncated: false,
});

function makeMockQueryResult(overrides: Partial<QueryResult> = {}): QueryResult {
  return {
    question: "How does the indexer work?",
    extractedKeywords: ["indexer", "work"],
    seedNodeIds: [`${FILE_A}::main`],
    nodes: [
      {
        id: `${FILE_A}::main`,
        name: "main",
        type: "Function",
        path: FILE_A,
        startLine: 1,
        relevanceScore: 0.9,
      },
    ],
    edges: [],
    nodeCount: 1,
    edgeCount: 0,
    json: DEFAULT_COMPACT_JSON,
    meta: {
      llmProvider: "none",
      keywordExtractionMs: 1,
      bfsMs: 2,
      totalMs: 3,
      tokenEstimate: 50,
      truncated: false,
    },
    ...overrides,
  } as QueryResult;
}

// ---------------------------------------------------------------------------
// Helpers to set up workerState with a mock indexer
// ---------------------------------------------------------------------------

function setupWorkerState(db = makeMockDb()): void {
  const mockIndexer = {
    getDb: vi.fn().mockReturnValue(db),
    dispose: vi.fn(),
  } as unknown as CallGraphIndexer;

  workerState.callGraphIndexer = mockIndexer;
  workerState.callGraphIndexedRoot = WORKSPACE;
  workerState.config = {
    rootDir: WORKSPACE,
    excludeNodeModules: true,
    maxDepth: 10,
  };
  workerState.isReady = true;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("executeQueryNaturalLanguage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    workerState.reset();
  });

  // -----------------------------------------------------------------------
  // 1. Valid params → QueryResult returned
  // -----------------------------------------------------------------------

  it("returns QueryResult for valid params", async () => {
    setupWorkerState();
    const mockResult = makeMockQueryResult();
    vi.spyOn(QueryEngine.prototype, "query").mockResolvedValue(mockResult);

    const result = await executeQueryNaturalLanguage({
      question: "How does the indexer work?",
    });

    expect(result.question).toBe("How does the indexer work?");
    expect(result.extractedKeywords).toEqual(["indexer", "work"]);
    expect(result.nodeCount).toBe(1);
    expect(result.edgeCount).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 2. Question too long (>1024 chars) → Zod validation error
  // -----------------------------------------------------------------------

  it("validates question length via toolSchemas", () => {
    const longQuestion = "a".repeat(1025);
    const validation = validateToolParams("query_natural_language", {
      question: longQuestion,
    });

    expect(validation.success).toBe(false);
    if (!validation.success) {
      expect(validation.error).toMatch(/1024/);
    }
  });

  // -----------------------------------------------------------------------
  // 3. depth out of bounds → Zod validation error
  // -----------------------------------------------------------------------

  it("validates depth bounds via toolSchemas", () => {
    const resultBelow = validateToolParams("query_natural_language", {
      question: "valid question",
      depth: 0,
    });
    expect(resultBelow.success).toBe(false);

    const resultAbove = validateToolParams("query_natural_language", {
      question: "valid question",
      depth: 6,
    });
    expect(resultAbove.success).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 4. outputFormat 'toon' → returns a REAL TOON-encoded string
  //    (no longer a passthrough of the analyzer's compact JSON)
  // -----------------------------------------------------------------------

  it("returns a real TOON-encoded string when outputFormat is toon", async () => {
    setupWorkerState();
    const mockResult = makeMockQueryResult();
    vi.spyOn(QueryEngine.prototype, "query").mockResolvedValue(mockResult);

    const result = await executeQueryNaturalLanguage({
      question: "test",
      outputFormat: "toon",
    });

    expect(typeof result.toon).toBe("string");
    // Never a passthrough of the compact JSON payload.
    expect(result.toon).not.toBe(mockResult.json);
    expect(result.toon).not.toMatch(/^\s*\{/);
    // Real TOON structure: meta line + 2 header/rows blocks.
    expect(result.toon).toMatch(/^# nodeCount=1 edgeCount=0 truncated=false/);
    expect(result.toon).toContain("nodes(id,n,t,p,l,r)");
    expect(result.toon).toContain("edges(");
    expect(result.nodes).toBeUndefined();
    expect(result.edges).toBeUndefined();
    // tokenEstimate is recomputed on the real TOON output, not passed through.
    expect(result.meta.tokenEstimate).toBeGreaterThan(0);
  });

  it("handles empty edges in toon output (edges() header only)", async () => {
    setupWorkerState();
    const mockResult = makeMockQueryResult({
      json: JSON.stringify({
        nodes: [{ id: "a", n: "funcA", t: "function", p: "src/a.ts", l: 10, r: 1 }],
        edges: [],
        nodeCount: 1,
        edgeCount: 0,
        truncated: false,
      }),
    });
    vi.spyOn(QueryEngine.prototype, "query").mockResolvedValue(mockResult);

    const result = await executeQueryNaturalLanguage({
      question: "test",
      outputFormat: "toon",
    });

    expect(result.toon).toContain("edges()");
  });

  // -----------------------------------------------------------------------
  // 5. outputFormat 'json' → returns nodes/edges arrays (JSON-serializable)
  //    Unaffected by the toon-encoding fix.
  // -----------------------------------------------------------------------

  it("returns nodes and edges arrays when outputFormat is json", async () => {
    setupWorkerState();
    const mockResult = makeMockQueryResult();
    vi.spyOn(QueryEngine.prototype, "query").mockResolvedValue(mockResult);

    const result = await executeQueryNaturalLanguage({
      question: "test",
      outputFormat: "json",
    });

    expect(Array.isArray(result.nodes)).toBe(true);
    expect(Array.isArray(result.edges)).toBe(true);
    expect(result.nodes).toEqual(mockResult.nodes);
    expect(result.edges).toEqual(mockResult.edges);
    expect(result.toon).toBeUndefined();

    // Ensure JSON-serializable
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // 6. tokenBudget out of bounds → Zod validation error
  // -----------------------------------------------------------------------

  it("validates tokenBudget bounds via schema", () => {
    const tooLow = QueryNaturalLanguageSchema.safeParse({
      question: "valid question",
      tokenBudget: 499,
    });
    expect(tooLow.success).toBe(false);

    const tooHigh = QueryNaturalLanguageSchema.safeParse({
      question: "valid question",
      tokenBudget: 16001,
    });
    expect(tooHigh.success).toBe(false);

    const valid = QueryNaturalLanguageSchema.safeParse({
      question: "valid question",
      tokenBudget: 4000,
    });
    expect(valid.success).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 7. Throws when indexer is not initialized
  // -----------------------------------------------------------------------

  it("throws when callGraphIndexer is not available", async () => {
    // Set config so getConfig() works, but leave indexer null
    workerState.config = {
      rootDir: WORKSPACE,
      excludeNodeModules: true,
      maxDepth: 10,
    };
    workerState.callGraphIndexer = null;
    workerState.callGraphIndexedRoot = null;
    workerState.isReady = true;

    await expect(
      executeQueryNaturalLanguage({ question: "test" }),
    ).rejects.toThrow(/Call graph indexer not initialized/);
  });

  // -----------------------------------------------------------------------
  // 8a. Small payload already under budget (no analyzer truncation involved).
  //    This ONLY proves that a payload comfortably below tokenBudget stays
  //    below tokenBudget after MCP-side TOON re-encoding. It does NOT
  //    exercise the analyzer truncation path (QueryEngine.query is fully
  //    mocked here, so no real or simulated truncation ever runs) and does
  //    NOT prove end-to-end budget respect when truncation happens — see
  //    test 8b below for that.
  // -----------------------------------------------------------------------

  it("stays within tokenBudget for a minimal 1-node/1-edge payload already under budget (no truncation involved)", async () => {
    setupWorkerState();
    const compactPayload = {
      nodes: [{ id: "a", n: "funcA", t: "function", p: "src/a.ts", l: 10, r: 1 }],
      edges: [{ src: "a", tgt: "b", rel: "CALLS" }],
      nodeCount: 1,
      edgeCount: 1,
      truncated: false,
    };
    const compactJsonStr = JSON.stringify(compactPayload);
    const jsonTokens = estimateTokens(compactJsonStr);
    // Comfortable margin — this case never approaches the budget boundary.
    const tokenBudget = jsonTokens + 40;

    const mockResult = makeMockQueryResult({
      json: compactJsonStr,
      nodeCount: 1,
      edgeCount: 1,
    });
    vi.spyOn(QueryEngine.prototype, "query").mockResolvedValue(mockResult);

    const result = await executeQueryNaturalLanguage({
      question: "test",
      tokenBudget,
      outputFormat: "toon",
    });

    expect(result.toon).toBeDefined();
    const actualTokens = estimateTokens(result.toon as string);
    expect(actualTokens).toBeLessThanOrEqual(tokenBudget);
    expect(result.meta.tokenEstimate).toBe(actualTokens);
  });

  // -----------------------------------------------------------------------
  // 8b. Real end-to-end budget respect at the analyzer's worst-case boundary.
  //
  //    QueryEngine.toCompactJson() (analyzer, fixed by Lucas) guarantees
  //    estimateTokens(compactJson) <= tokenBudget via binary search on the
  //    real tokenizer — but that guarantee is checked on the compact JSON
  //    string, NOT on the TOON string the MCP tool actually hands back to
  //    the client (encodeCompositeAsToon() re-encodes result.json into a
  //    different, more verbose textual format). The residual risk this
  //    test targets: does the MCP-side TOON re-encoding blow past the
  //    budget that was only guaranteed on the JSON representation?
  //
  //    To exercise that boundary without depending on QueryEngine's real
  //    truncation loop (mocked here like every other test in this file),
  //    we build a multi-node payload marked `truncated: true` (as the
  //    analyzer would emit post-truncation) and set tokenBudget to EXACTLY
  //    jsonTokens — the tightest possible margin the analyzer's guarantee
  //    allows (tokenEstimate <= tokenBudget, so equality is the worst case).
  //    If TOON re-encoding ever added net overhead over compact JSON for a
  //    truncated payload, this is where it would surface.
  // -----------------------------------------------------------------------

  it("keeps the final re-encoded TOON output within tokenBudget at the analyzer's exact truncation boundary (multi-node truncated payload)", async () => {
    setupWorkerState();

    const nodeCount = 10;
    const compactNodes = Array.from({ length: nodeCount }, (_, i) => ({
      id: `src/file${i}.ts::func${i}`,
      n: `func${i}`,
      t: "Function",
      p: `src/file${i}.ts`,
      l: 10 + i,
      r: 0.9,
    }));
    const compactEdges = Array.from({ length: nodeCount - 1 }, (_, i) => ({
      src: compactNodes[i].id,
      tgt: compactNodes[i + 1].id,
      rel: "CALLS",
    }));
    const compactPayload = {
      nodes: compactNodes,
      edges: compactEdges,
      nodeCount,
      edgeCount: compactEdges.length,
      truncated: true,
    };
    const compactJsonStr = JSON.stringify(compactPayload);
    const jsonTokens = estimateTokens(compactJsonStr);
    // Zero margin: the analyzer's binary-search guarantee is <=, not <, so
    // the worst case it can hand off is tokenEstimate === tokenBudget.
    const tokenBudget = jsonTokens;

    const mockResult = makeMockQueryResult({
      json: compactJsonStr,
      nodeCount,
      edgeCount: compactEdges.length,
      meta: {
        llmProvider: "none",
        keywordExtractionMs: 1,
        bfsMs: 2,
        totalMs: 3,
        tokenEstimate: jsonTokens,
        truncated: true,
      },
    });
    vi.spyOn(QueryEngine.prototype, "query").mockResolvedValue(mockResult);

    const result = await executeQueryNaturalLanguage({
      question: "test",
      tokenBudget,
      outputFormat: "toon",
    });

    expect(result.toon).toBeDefined();
    // The real assertion: the actual TOON string returned to the client
    // (via encodeCompositeAsToon(), not a re-implementation of it here)
    // must respect the SAME tokenBudget the client asked for — even though
    // that budget was computed against a differently-shaped JSON string.
    const actualTokens = estimateTokens(result.toon as string);
    expect(actualTokens).toBeLessThanOrEqual(tokenBudget);
    expect(result.meta.tokenEstimate).toBe(actualTokens);
  });
});

// ---------------------------------------------------------------------------
// 9. Zod description non-regression (documentation keywords)
// ---------------------------------------------------------------------------

describe("QueryNaturalLanguageSchema outputFormat description", () => {
  it("documents TOON vs JSON tradeoffs for LLM client indexing", () => {
    const shape = QueryNaturalLanguageSchema.shape.outputFormat;
    const description = shape.description ?? "";

    expect(description).toContain("TOON");
    expect(description).toContain("fewer tokens");
    expect(description).toContain("JSON.parse()");
  });
});
