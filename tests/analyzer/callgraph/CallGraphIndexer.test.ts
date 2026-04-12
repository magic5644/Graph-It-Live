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

  // -------------------------------------------------------------------------
  // Incoming edge preservation (cross-file relationships)
  // -------------------------------------------------------------------------

  const FILE_B = "/workspace/src/main.ts";

  it("indexFile() preserves incoming edges from other files when re-indexing target file", () => {
    // Setup: file A has helper(), file B has main() which calls helper()
    const helperNode = makeNode({ id: `${FILE_A}:helper:5`, name: "helper", startLine: 5 });
    const mainNode = makeNode({
      id: `${FILE_B}:main:1`, name: "main", startLine: 1,
      path: FILE_B, folder: "/workspace/src",
    });

    // Index file A (defines helper)
    indexer.indexFile([helperNode], [], FILE_A, "typescript", Date.now());
    // Index file B (defines main, calls helper) — cross-file edge
    const crossEdge = makeEdge({ sourceId: mainNode.id, targetId: helperNode.id, sourceLine: 3 });
    indexer.indexFile([mainNode], [crossEdge], FILE_B, "typescript", Date.now());

    // Verify the cross-file edge exists
    const db = indexer.getDb();
    let edgeRows = db.exec(
      "SELECT source_id, target_id FROM edges WHERE source_id = ? AND target_id = ?",
      [mainNode.id, helperNode.id],
    );
    expect(edgeRows[0]?.values.length).toBe(1);

    // ACT: Re-index file A (simulate saving file A — body change, same symbols)
    const helperNodeV2 = makeNode({ id: `${FILE_A}:helper:5`, name: "helper", startLine: 5 });
    indexer.indexFile([helperNodeV2], [], FILE_A, "typescript", Date.now());

    // ASSERT: The incoming edge from B→A must still exist
    edgeRows = db.exec(
      "SELECT source_id, target_id FROM edges WHERE source_id = ? AND target_id = ?",
      [mainNode.id, helperNode.id],
    );
    expect(edgeRows[0]?.values.length).toBe(1);
  });

  it("indexFile() cleans up incoming edges when target node is removed/renamed", () => {
    // Setup: file A has oldFunc(), file B calls oldFunc()
    const oldFunc = makeNode({ id: `${FILE_A}:oldFunc:5`, name: "oldFunc", startLine: 5 });
    const caller = makeNode({
      id: `${FILE_B}:caller:1`, name: "caller", startLine: 1,
      path: FILE_B, folder: "/workspace/src",
    });
    const crossEdge = makeEdge({ sourceId: caller.id, targetId: oldFunc.id, sourceLine: 3 });

    indexer.indexFile([oldFunc], [], FILE_A, "typescript", Date.now());
    indexer.indexFile([caller], [crossEdge], FILE_B, "typescript", Date.now());

    // ACT: Re-index file A with renamed function (different node ID)
    const newFunc = makeNode({ id: `${FILE_A}:newFunc:5`, name: "newFunc", startLine: 5 });
    indexer.indexFile([newFunc], [], FILE_A, "typescript", Date.now());

    // ASSERT: Dangling incoming edge targeting oldFunc should be cleaned up
    const db = indexer.getDb();
    const danglingEdges = db.exec(
      "SELECT * FROM edges WHERE target_id = ?",
      [oldFunc.id],
    );
    expect(danglingEdges.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // resolveExternalEdges — cross-language isolation
  // -------------------------------------------------------------------------

  it("resolveExternalEdges() does not resolve @@external stub to a same-named node in a different language", () => {
    // Java file defines a `User` class; Go file also exports a `User` symbol.
    // A Java caller that references @@external:User must NOT be linked to the Go node.
    const JAVA_FILE = "/workspace/src/Main.java";
    const GO_FILE = "/workspace/go-project/models/user.go";

    const javaCallerNode = makeNode({
      id: `${JAVA_FILE}:main:1`, name: "main", type: "method",
      lang: "java" as SupportedLang, path: JAVA_FILE, folder: "/workspace/src",
      startLine: 1, endLine: 10, startCol: 0, isExported: true,
    });
    const javaUserNode = makeNode({
      id: `${JAVA_FILE}:User:20`, name: "User", type: "class",
      lang: "java" as SupportedLang, path: JAVA_FILE, folder: "/workspace/src",
      startLine: 20, endLine: 30, startCol: 0, isExported: true,
    });
    const goUserNode = makeNode({
      id: `${GO_FILE}:User:5`, name: "User", type: "class",
      lang: "go" as SupportedLang, path: GO_FILE, folder: "/workspace/go-project/models",
      startLine: 5, endLine: 15, startCol: 0, isExported: true,
    });

    // Java stub edge: main → @@external:User (unresolved cross-file ref)
    const stubEdge = makeEdge({
      sourceId: javaCallerNode.id,
      targetId: "@@external:User",
      typeRelation: "CALLS",
      sourceLine: 5,
    });

    indexer.indexFile([javaCallerNode, javaUserNode], [stubEdge], JAVA_FILE, "java", Date.now());
    indexer.indexFile([goUserNode], [], GO_FILE, "go", Date.now());

    const result = indexer.resolveExternalEdges();

    const db = indexer.getDb();

    // The stub should be resolved to the Java User node, NOT the Go User node.
    const edgeToJava = db.exec(
      "SELECT source_id, target_id FROM edges WHERE source_id = ? AND target_id = ?",
      [javaCallerNode.id, javaUserNode.id],
    );
    expect(edgeToJava[0]?.values.length).toBe(1);

    // No edge should exist from the Java caller to the Go User node.
    const edgeToGo = db.exec(
      "SELECT source_id, target_id FROM edges WHERE source_id = ? AND target_id = ?",
      [javaCallerNode.id, goUserNode.id],
    );
    expect(edgeToGo.length).toBe(0);

    expect(result.resolved).toBe(1);
  });

  it("indexFile() preserves outgoing edges from the re-indexed file", () => {
    // Setup: file A has helper(), file A's main() calls helper()
    const mainNode = makeNode({ id: `${FILE_A}:main:1`, name: "main", startLine: 1 });
    const helperNode = makeNode({ id: `${FILE_A}:helper:10`, name: "helper", startLine: 10 });
    const internalEdge = makeEdge({ sourceId: mainNode.id, targetId: helperNode.id });

    indexer.indexFile([mainNode, helperNode], [internalEdge], FILE_A, "typescript", Date.now());

    // ACT: Re-index file A with different outgoing edge
    const newEdge = makeEdge({ sourceId: mainNode.id, targetId: helperNode.id, sourceLine: 99 });
    indexer.indexFile([mainNode, helperNode], [newEdge], FILE_A, "typescript", Date.now());

    // ASSERT: The old outgoing edge is replaced by the new one
    const db = indexer.getDb();
    const edgeRows = db.exec(
      "SELECT source_line FROM edges WHERE source_id = ? AND target_id = ?",
      [mainNode.id, helperNode.id],
    );
    expect(edgeRows[0]?.values.length).toBe(1);
    expect(edgeRows[0]?.values[0][0]).toBe(99);
  });
});
