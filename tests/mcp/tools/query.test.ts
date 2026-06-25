/**
 * Unit tests for the MCP natural language query tool (executeQueryNaturalLanguage).
 *
 * Uses a mock CallGraphIndexer (no sql.js WASM dependency) and mocks
 * QueryEngine.query to isolate the tool logic.
 *
 * Test cases:
 *  1. Valid params → QueryResult returned
 *  2. Question too long (>1024 chars) → Zod validation error
 *  3. depth out of bounds → Zod validation error
 *  4. outputFormat 'toon' → returns TOON string
 *  5. outputFormat 'json' → returns nodes/edges arrays (JSON-serializable)
 *  6. tokenBudget out of bounds → Zod validation error
 *  7. Throws when indexer not initialized
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallGraphIndexer } from "../../../src/analyzer/callgraph/CallGraphIndexer";
import { QueryEngine } from "../../../src/analyzer/QueryEngine";
import { workerState } from "../../../src/mcp/shared/state";
import {
  executeQueryNaturalLanguage,
  QueryNaturalLanguageSchema,
} from "../../../src/mcp/tools/query";
import { validateToolParams } from "../../../src/mcp/types";
import type { QueryResult } from "../../../src/shared/query-types";

// ---------------------------------------------------------------------------
// Minimal mock database (sql.js-compatible shape)
// ---------------------------------------------------------------------------

type MockDb = { exec: ReturnType<typeof vi.fn> };

function makeMockDb(): MockDb {
  return { exec: vi.fn().mockReturnValue([]) };
}

// ---------------------------------------------------------------------------
// Mock QueryResult
// ---------------------------------------------------------------------------

const WORKSPACE = "/workspace";
const FILE_A = `${WORKSPACE}/src/a.ts`;

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
    toon: '{"nodes":[{"id":"main","name":"main"}],"edges":[],"nodeCount":1,"edgeCount":0}',
    meta: {
      llmProvider: "none",
      keywordExtractionMs: 1,
      bfsMs: 2,
      totalMs: 3,
      tokenEstimate: 50,
      truncated: false,
    },
    ...overrides,
  };
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
  // 4. outputFormat 'toon' → returns TOON string
  // -----------------------------------------------------------------------

  it("returns toon string when outputFormat is toon", async () => {
    setupWorkerState();
    const toonString = '{"nodes":[],"edges":[],"nodeCount":0,"edgeCount":0}';
    const mockResult = makeMockQueryResult({
      toon: toonString,
      nodeCount: 0,
      edgeCount: 0,
      nodes: [],
    });
    vi.spyOn(QueryEngine.prototype, "query").mockResolvedValue(mockResult);

    const result = await executeQueryNaturalLanguage({
      question: "test",
      outputFormat: "toon",
    });

    expect(result.toon).toBe(toonString);
    expect(result.nodes).toBeUndefined();
    expect(result.edges).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // 5. outputFormat 'json' → returns nodes/edges arrays (JSON-serializable)
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
});
