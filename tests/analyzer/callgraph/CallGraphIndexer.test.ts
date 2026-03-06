/**
 * Unit tests for CallGraphIndexer.
 *
 * Uses the real sql.js WASM from node_modules (WebAssembly works in Node.js).
 * This avoids brittle CJS require() mocking and tests actual SQL execution.
 *
 * SPEC: specs/001-live-call-graph/data-model.md
 */

import type {
    CallGraphEdge,
    CallGraphNode,
} from "@/analyzer/callgraph/CallGraphIndexer";
import type { SupportedLang } from "@/shared/callgraph-types";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Real sql.js WASM path (from node_modules, WebAssembly works in Node.js)
// ---------------------------------------------------------------------------

const SQL_WASM_PATH = path.join(
  process.cwd(),
  "node_modules",
  "sql.js",
  "dist",
  "sql-wasm.wasm",
);

// ---------------------------------------------------------------------------
// Source import
// ---------------------------------------------------------------------------

import {
    CallGraphIndexer,
    getSqlJsWasmPath,
} from "@/analyzer/callgraph/CallGraphIndexer";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const FILE_A = "/workspace/src/utils.ts";

const makeNode = (overrides: Partial<CallGraphNode> = {}): CallGraphNode => ({
  id: `${FILE_A}:myFunc:5`,
  name: "myFunc",
  type: "function",
  lang: "typescript" as SupportedLang,
  path: FILE_A,
  folder: "/workspace/src",
  startLine: 5,
  endLine: 8,
  startCol: 0,
  isExported: true,
  ...overrides,
});

const makeEdge = (overrides: Partial<CallGraphEdge> = {}): CallGraphEdge => ({
  sourceId: `${FILE_A}:myFunc:5`,
  targetId: `${FILE_A}:helper:12`,
  typeRelation: "CALLS",
  sourceLine: 6,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CallGraphIndexer", () => {
  let indexer: CallGraphIndexer;

  beforeEach(async () => {
    indexer = new CallGraphIndexer(SQL_WASM_PATH);
    await indexer.init();
  });

  afterEach(() => {
    indexer.dispose();
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  it("init() resolves without throwing", async () => {
    const fresh = new CallGraphIndexer(SQL_WASM_PATH);
    await expect(fresh.init()).resolves.not.toThrow();
    fresh.dispose();
  });

  it("getDb() throws before init()", () => {
    const fresh = new CallGraphIndexer(SQL_WASM_PATH);
    expect(() => fresh.getDb()).toThrow();
  });

  it("getDb() returns Database instance after init()", () => {
    expect(() => indexer.getDb()).not.toThrow();
    const db = indexer.getDb();
    expect(db).toBeDefined();
    expect(typeof db.run).toBe("function");
  });

  it("init() is idempotent — second call is no-op", async () => {
    await expect(indexer.init()).resolves.not.toThrow();
    expect(() => indexer.getDb()).not.toThrow();
  });

  it("dispose() allows re-init on the same object", async () => {
    indexer.dispose();
    expect(() => indexer.getDb()).toThrow();
    await indexer.init();
    expect(() => indexer.getDb()).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // indexFile
  // -------------------------------------------------------------------------

  it("indexFile() inserts node and file_index records", () => {
    const node = makeNode();
    indexer.indexFile([node], [], FILE_A, "typescript", Date.now());

    const db = indexer.getDb();
    const fileRows = db.exec("SELECT path FROM file_index WHERE path = ?", [FILE_A]);
    expect(fileRows[0]?.values.length).toBe(1);

    const nodeRows = db.exec("SELECT id FROM nodes WHERE id = ?", [node.id]);
    expect(nodeRows[0]?.values.length).toBe(1);
  });

  it("indexFile() inserts edges between nodes in the same file", () => {
    const nodeA = makeNode({ id: `${FILE_A}:myFunc:5`, name: "myFunc", startLine: 5 });
    const nodeB = makeNode({ id: `${FILE_A}:helper:12`, name: "helper", startLine: 12 });
    const edge = makeEdge({ sourceId: nodeA.id, targetId: nodeB.id });

    indexer.indexFile([nodeA, nodeB], [edge], FILE_A, "typescript", Date.now());

    const db = indexer.getDb();
    const rows = db.exec(
      "SELECT source_id, target_id FROM edges WHERE source_id = ?",
      [nodeA.id],
    );
    expect(rows[0]?.values.length).toBe(1);
  });

  it("indexFile() replaces stale data on re-indexation of same file", () => {
    const nodeV1 = makeNode({ id: `${FILE_A}:oldFunc:1`, name: "oldFunc", startLine: 1 });
    indexer.indexFile([nodeV1], [], FILE_A, "typescript", 1000);

    const nodeV2 = makeNode({ id: `${FILE_A}:newFunc:10`, name: "newFunc", startLine: 10 });
    indexer.indexFile([nodeV2], [], FILE_A, "typescript", 2000);

    const db = indexer.getDb();
    const oldRows = db.exec("SELECT id FROM nodes WHERE id = ?", [nodeV1.id]);
    expect(oldRows.length).toBe(0);

    const newRows = db.exec("SELECT id FROM nodes WHERE id = ?", [nodeV2.id]);
    expect(newRows[0]?.values.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // invalidateFile
  // -------------------------------------------------------------------------

  it("invalidateFile() removes file and its nodes", () => {
    indexer.indexFile([makeNode()], [], FILE_A, "typescript", Date.now());
    indexer.invalidateFile(FILE_A);

    const db = indexer.getDb();
    const fileRows = db.exec("SELECT path FROM file_index WHERE path = ?", [FILE_A]);
    expect(fileRows.length).toBe(0);

    const nodeRows = db.exec("SELECT id FROM nodes WHERE path = ?", [FILE_A]);
    expect(nodeRows.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // markCycles
  // -------------------------------------------------------------------------

  it("markCycles() sets is_cyclic = 1 on matching edges", () => {
    const nodeA = makeNode({ id: `${FILE_A}:alpha:1`, name: "alpha", startLine: 1 });
    const nodeB = makeNode({ id: `${FILE_A}:beta:10`, name: "beta", startLine: 10 });
    const edge = makeEdge({ sourceId: nodeA.id, targetId: nodeB.id });

    indexer.indexFile([nodeA, nodeB], [edge], FILE_A, "typescript", Date.now());
    indexer.markCycles([{ sourceId: nodeA.id, targetId: nodeB.id }]);

    const db = indexer.getDb();
    const rows = db.exec(
      "SELECT is_cyclic FROM edges WHERE source_id = ? AND target_id = ?",
      [nodeA.id, nodeB.id],
    );
    expect(rows[0]?.values[0]?.[0]).toBe(1);
  });

  // -------------------------------------------------------------------------
  // getFileRecord
  // -------------------------------------------------------------------------

  it("getFileRecord() returns null for un-indexed file", () => {
    expect(indexer.getFileRecord("/no/such/file.ts")).toBeNull();
  });

  it("getFileRecord() returns lang and mtime for indexed file", () => {
    const mtime = 1_700_000_000_000;
    indexer.indexFile([], [], FILE_A, "typescript", mtime);

    const record = indexer.getFileRecord(FILE_A);
    expect(record).not.toBeNull();
    expect(record?.lang).toBe("typescript");
    expect(record?.lastModified).toBe(mtime);
  });

  // -------------------------------------------------------------------------
  // getSqlJsWasmPath
  // -------------------------------------------------------------------------

  it("getSqlJsWasmPath() builds a path containing 'sqljs.wasm' under 'dist'", () => {
    const result = getSqlJsWasmPath("/my/extension");
    expect(result).toContain("sqljs.wasm");
    expect(result).toContain("dist");
  });
});
