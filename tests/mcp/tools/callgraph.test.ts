/**
 * Unit tests for the MCP call graph tool (executeQueryCallGraph).
 *
 * Seeds a real sql.js CallGraphIndexer with test data, injects it into
 * workerState, then exercises the BFS query logic.
 */

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    CallGraphIndexer,
    type CallGraphEdge,
    type CallGraphNode,
} from "../../../src/analyzer/callgraph/CallGraphIndexer";
import { workerState } from "../../../src/mcp/shared/state";
import { executeQueryCallGraph } from "../../../src/mcp/tools/callgraph";
import type { SupportedLang } from "../../../src/shared/callgraph-types";

// ---------------------------------------------------------------------------
// sql.js WASM path (real WASM from node_modules)
// ---------------------------------------------------------------------------

const SQL_WASM_PATH = path.join(
  process.cwd(),
  "node_modules",
  "sql.js",
  "dist",
  "sql-wasm.wasm",
);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const FILE_A = "/workspace/src/a.ts";
const FILE_B = "/workspace/src/b.ts";

function node(
  filePath: string,
  name: string,
  line: number,
  overrides: Partial<CallGraphNode> = {},
): CallGraphNode {
  return {
    id: `${filePath}:${name}:${line}`,
    name,
    type: "function",
    lang: "typescript" as SupportedLang,
    path: filePath,
    folder: path.dirname(filePath),
    startLine: line,
    endLine: line + 5,
    startCol: 0,
    isExported: true,
    ...overrides,
  };
}

function edge(
  source: CallGraphNode,
  target: CallGraphNode,
  relation: string = "CALLS",
): CallGraphEdge {
  return {
    sourceId: source.id,
    targetId: target.id,
    typeRelation: relation,
    sourceLine: source.startLine,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeQueryCallGraph", () => {
  let indexer: CallGraphIndexer;

  // Shared test symbols
  const fnMain = node(FILE_A, "main", 1);
  const fnHelper = node(FILE_A, "helper", 10);
  const fnProcess = node(FILE_B, "process", 1);
  const fnFormat = node(FILE_B, "format", 20);

  beforeEach(async () => {
    indexer = new CallGraphIndexer(SQL_WASM_PATH);
    await indexer.init();

    // Seed: main → helper, main → process, process → format
    const nodesA = [fnMain, fnHelper];
    const edgesA: CallGraphEdge[] = [
      edge(fnMain, fnHelper),
      edge(fnMain, fnProcess),
    ];
    indexer.indexFile(nodesA, edgesA, FILE_A, "typescript", Date.now());

    const nodesB = [fnProcess, fnFormat];
    const edgesB: CallGraphEdge[] = [edge(fnProcess, fnFormat)];
    indexer.indexFile(nodesB, edgesB, FILE_B, "typescript", Date.now());

    // Inject into workerState
    workerState.callGraphIndexer = indexer;
    workerState.callGraphIndexedRoot = "/workspace";
    workerState.config = {
      rootDir: "/workspace",
      excludeNodeModules: true,
      maxDepth: 10,
    };
    workerState.isReady = true;
  });

  afterEach(() => {
    workerState.reset();
  });

  // -------------------------------------------------------------------------
  // Symbol lookup
  // -------------------------------------------------------------------------

  it("returns null symbol when not found", async () => {
    const result = await executeQueryCallGraph({
      filePath: FILE_A,
      symbolName: "nonExistent",
    });

    expect(result.symbol).toBeNull();
    expect(result.callers).toHaveLength(0);
    expect(result.callees).toHaveLength(0);
    expect(result.indexedFiles).toBeGreaterThanOrEqual(0);
  });

  it("finds a symbol by filePath + symbolName", async () => {
    const result = await executeQueryCallGraph({
      filePath: FILE_A,
      symbolName: "main",
    });

    expect(result.symbol).not.toBeNull();
    expect(result.symbol?.name).toBe("main");
    expect(result.symbol?.filePath).toBe(FILE_A);
  });

  // -------------------------------------------------------------------------
  // Direction: callees
  // -------------------------------------------------------------------------

  it("returns callees at depth 1", async () => {
    const result = await executeQueryCallGraph({
      filePath: FILE_A,
      symbolName: "main",
      direction: "callees",
      depth: 1,
    });

    expect(result.callees.length).toBeGreaterThanOrEqual(1);
    const targetNames = result.callees.map((c) => c.targetName);
    expect(targetNames).toContain("helper");
    expect(result.callers).toHaveLength(0); // only callees requested
  });

  it("returns deeper callees at depth 2", async () => {
    const result = await executeQueryCallGraph({
      filePath: FILE_A,
      symbolName: "main",
      direction: "callees",
      depth: 2,
    });

    const targetNames = result.callees.map((c) => c.targetName);
    // depth 2: main → helper + process (depth 1) → format (depth 2)
    expect(targetNames).toContain("format");
  });

  // -------------------------------------------------------------------------
  // Direction: callers
  // -------------------------------------------------------------------------

  it("returns callers of helper", async () => {
    const result = await executeQueryCallGraph({
      filePath: FILE_A,
      symbolName: "helper",
      direction: "callers",
      depth: 1,
    });

    expect(result.callers.length).toBeGreaterThanOrEqual(1);
    const sourceNames = result.callers.map((c) => c.sourceName);
    expect(sourceNames).toContain("main");
    expect(result.callees).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Direction: both
  // -------------------------------------------------------------------------

  it("returns both callers and callees", async () => {
    const result = await executeQueryCallGraph({
      filePath: FILE_B,
      symbolName: "process",
      direction: "both",
      depth: 1,
    });

    // process is called by main, and calls format
    const callerNames = result.callers.map((c) => c.sourceName);
    const calleeNames = result.callees.map((c) => c.targetName);
    expect(callerNames).toContain("main");
    expect(calleeNames).toContain("format");
  });

  // -------------------------------------------------------------------------
  // Defaults
  // -------------------------------------------------------------------------

  it("defaults to direction='both' and depth=2", async () => {
    const result = await executeQueryCallGraph({
      filePath: FILE_A,
      symbolName: "main",
    });

    expect(result.direction).toBe("both");
    expect(result.depth).toBe(2);
    // Should have callees (helper, process, format at depth 2)
    expect(result.callees.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Relation type filter
  // -------------------------------------------------------------------------

  it("filters by relation type", async () => {
    // Add an INHERITS edge: fnFormat INHERITS fnHelper
    const db = indexer.getDb();
    db.run(
      "INSERT INTO edges (source_id, target_id, type_relation, source_line, is_cyclic, indexed_at) VALUES (?, ?, ?, ?, 0, ?)",
      [fnFormat.id, fnHelper.id, "INHERITS", 20, Date.now()],
    );

    // Query only INHERITS
    const result = await executeQueryCallGraph({
      filePath: FILE_B,
      symbolName: "format",
      direction: "callees",
      depth: 1,
      relationTypes: ["INHERITS"],
    });

    expect(result.callees.length).toBeGreaterThanOrEqual(1);
    for (const edge of result.callees) {
      expect(edge.relation).toBe("INHERITS");
    }
  });

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  it("returns indexedFiles and indexTimeMs", async () => {
    const result = await executeQueryCallGraph({
      filePath: FILE_A,
      symbolName: "main",
    });

    expect(result.indexedFiles).toBeGreaterThanOrEqual(2);
    expect(result.indexTimeMs).toBeDefined();
    expect(typeof result.indexTimeMs).toBe("number");
  });

  it("returns totalCallers and totalCallees counts matching arrays", async () => {
    const result = await executeQueryCallGraph({
      filePath: FILE_B,
      symbolName: "process",
      direction: "both",
      depth: 1,
    });

    expect(result.totalCallers).toBe(result.callers.length);
    expect(result.totalCallees).toBe(result.callees.length);
  });
});
