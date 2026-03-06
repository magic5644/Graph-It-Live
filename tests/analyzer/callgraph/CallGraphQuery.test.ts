/**
 * Unit tests for CallGraphQuery (queryNeighbourhood).
 *
 * Uses CallGraphIndexer with the real sql.js WASM to create a properly-seeded
 * in-memory SQLite database, then exercises the BFS traversal logic.
 *
 * SPEC: specs/001-live-call-graph/spec.md — FR-001, FR-003, FR-004, FR-007
 */

import {
    CallGraphIndexer,
    type CallGraphEdge,
    type CallGraphNode,
} from "@/analyzer/callgraph/CallGraphIndexer";
import {
    queryNeighbourhood,
    type NeighbourhoodResult,
} from "@/analyzer/callgraph/CallGraphQuery";
import type { SupportedLang } from "@/shared/callgraph-types";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Real sql.js WASM path
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
const FILE_C = "/workspace/utils/c.ts";

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
    endLine: line + 2,
    startCol: 0,
    isExported: true,
    ...overrides,
  };
}

function edge(
  sourceNode: CallGraphNode,
  targetNode: CallGraphNode,
): CallGraphEdge {
  return {
    sourceId: sourceNode.id,
    targetId: targetNode.id,
    typeRelation: "CALLS",
    sourceLine: sourceNode.startLine,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("queryNeighbourhood", () => {
  let indexer: CallGraphIndexer;

  beforeEach(async () => {
    indexer = new CallGraphIndexer(SQL_WASM_PATH);
    await indexer.init();
  });

  afterEach(() => {
    indexer.dispose();
  });

  // -------------------------------------------------------------------------
  // Empty / root not found
  // -------------------------------------------------------------------------

  it("returns empty result when root ID does not exist in DB", () => {
    const result: NeighbourhoodResult = queryNeighbourhood(
      indexer.getDb(),
      "nonexistent:root:1",
      2,
    );

    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
    expect(result.compounds).toHaveLength(0);
    expect(result.rootSymbolId).toBe("nonexistent:root:1");
  });

  // -------------------------------------------------------------------------
  // Depth 1 — direct neighbours only
  // -------------------------------------------------------------------------

  it("depth=1 returns root and its direct callees", () => {
    const root = node(FILE_A, "main", 1);
    const callee1 = node(FILE_A, "helper", 10);
    const callee2 = node(FILE_B, "util", 5);
    const distant = node(FILE_C, "distant", 20); // reachable only at depth 2

    indexer.indexFile([root, callee1], [edge(root, callee1)], FILE_A, "typescript", 100);
    indexer.indexFile([callee2], [], FILE_B, "typescript", 100);
    indexer.indexFile([distant], [edge(callee1, distant)], FILE_C, "typescript", 100);

    const result = queryNeighbourhood(indexer.getDb(), root.id, 1);

    const resultIds = result.nodes.map((n) => n.id);
    expect(resultIds).toContain(root.id);
    expect(resultIds).toContain(callee1.id);
    expect(resultIds).not.toContain(distant.id); // too deep
  });

  // -------------------------------------------------------------------------
  // Depth 2 — neighbours of neighbours
  // -------------------------------------------------------------------------

  it("depth=2 traverses two hops", () => {
    const root = node(FILE_A, "root", 1);
    const mid = node(FILE_A, "mid", 10);
    const deep = node(FILE_B, "deep", 5);

    indexer.indexFile([root, mid], [edge(root, mid)], FILE_A, "typescript", 100);
    indexer.indexFile([deep], [edge(mid, deep)], FILE_B, "typescript", 100);

    const result = queryNeighbourhood(indexer.getDb(), root.id, 2);

    const resultIds = result.nodes.map((n) => n.id);
    expect(resultIds).toContain(root.id);
    expect(resultIds).toContain(mid.id);
    expect(resultIds).toContain(deep.id);
  });

  // -------------------------------------------------------------------------
  // Root node flag
  // -------------------------------------------------------------------------

  it("marks the queried root node with isRoot = true", () => {
    const root = node(FILE_A, "mainFn", 1);
    const callee = node(FILE_A, "helperFn", 10);

    indexer.indexFile([root, callee], [edge(root, callee)], FILE_A, "typescript", 100);

    const result = queryNeighbourhood(indexer.getDb(), root.id, 1);

    const rootNode = result.nodes.find((n) => n.id === root.id);
    const calleeNode = result.nodes.find((n) => n.id === callee.id);

    expect(rootNode?.isRoot).toBe(true);
    expect(calleeNode?.isRoot).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Compound nodes (grouped by folder)
  // -------------------------------------------------------------------------

  it("creates compound nodes grouping siblings from the same folder", () => {
    const nodeInA1 = node(FILE_A, "fnA1", 1);
    const nodeInA2 = node(FILE_A, "fnA2", 10);
    const nodeInB = node(FILE_B, "fnB", 1);

    indexer.indexFile(
      [nodeInA1, nodeInA2],
      [edge(nodeInA1, nodeInA2)],
      FILE_A,
      "typescript",
      100,
    );
    indexer.indexFile([nodeInB], [], FILE_B, "typescript", 100);

    const result = queryNeighbourhood(indexer.getDb(), nodeInA1.id, 2);

    // Compound for FILE_A folder should exist since it has 2 nodes
    const srcFolder = path.dirname(FILE_A);
    const compound = result.compounds.find((c) => c.id.includes(srcFolder) || c.label.includes("src"));
    expect(compound).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Cycle detection
  // -------------------------------------------------------------------------

  it("marks edges in a cycle with isCyclic = true", () => {
    const fnA = node(FILE_A, "cycleA", 1);
    const fnB = node(FILE_A, "cycleB", 10);

    const edgeAB = edge(fnA, fnB);
    const edgeBA: CallGraphEdge = {
      sourceId: fnB.id,
      targetId: fnA.id,
      typeRelation: "CALLS",
      sourceLine: 11,
    };

    indexer.indexFile([fnA, fnB], [edgeAB, edgeBA], FILE_A, "typescript", 100);
    indexer.markCycles([
      { sourceId: fnA.id, targetId: fnB.id },
      { sourceId: fnB.id, targetId: fnA.id },
    ]);

    const result = queryNeighbourhood(indexer.getDb(), fnA.id, 1);

    const cyclicEdges = result.edges.filter((e) => e.isCyclic);
    expect(cyclicEdges.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Bidirectional BFS — callers also included
  // -------------------------------------------------------------------------

  it("bidirectional BFS includes callers (reverse edges)", () => {
    const caller = node(FILE_C, "caller", 1);
    const root = node(FILE_A, "target", 5);

    // Index root (target) first so FK on edge is satisfied
    indexer.indexFile([root], [], FILE_A, "typescript", 100);
    indexer.indexFile([caller], [edge(caller, root)], FILE_C, "typescript", 100);

    const result = queryNeighbourhood(indexer.getDb(), root.id, 1);

    const resultIds = result.nodes.map((n) => n.id);
    expect(resultIds).toContain(caller.id); // caller is included via reverse BFS
    expect(resultIds).toContain(root.id);
  });

  // -------------------------------------------------------------------------
  // Result structure
  // -------------------------------------------------------------------------

  it("result contains timestamp and correct depth", () => {
    const root = node(FILE_A, "ts_fn", 1);
    indexer.indexFile([root], [], FILE_A, "typescript", Date.now());

    const before = Date.now();
    const result = queryNeighbourhood(indexer.getDb(), root.id, 3);
    const after = Date.now();

    expect(result.depth).toBe(3);
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(after);
  });

  it("edges reference valid node IDs that appear in nodes array", () => {
    const root = node(FILE_A, "edgeChk", 1);
    const callee = node(FILE_B, "callee", 5);

    // Index callee (edge target) first to satisfy FK constraint
    indexer.indexFile([callee], [], FILE_B, "typescript", 100);
    indexer.indexFile([root], [edge(root, callee)], FILE_A, "typescript", 100);

    const result = queryNeighbourhood(indexer.getDb(), root.id, 1);

    const nodeIds = new Set(result.nodes.map((n) => n.id));
    for (const e of result.edges) {
      expect(nodeIds.has(e.sourceId) || nodeIds.has(e.targetId)).toBe(true);
    }
  });
});
