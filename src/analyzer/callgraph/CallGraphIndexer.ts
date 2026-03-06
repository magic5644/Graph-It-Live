/**
 * CallGraphIndexer — sql.js (SQLite WASM) in-memory database manager.
 *
 * Responsibilities:
 * - Initialize the in-memory SQLite database with the schema from db-schema.sql
 * - Upsert nodes and edges for a given source file (atomic transaction)
 * - Invalidate (delete + re-index) all data for a given file path
 * - Mark edges as cyclic (is_cyclic = 1) after cycle detection
 *
 * NO vscode imports — this module is VS Code-agnostic.
 *
 * SPEC: specs/001-live-call-graph/data-model.md
 * SCHEMA: specs/001-live-call-graph/contracts/db-schema.sql
 */

import type { RelationType, SupportedLang, SymbolType } from "@/shared/callgraph-types";
import fs from "node:fs/promises";
import path from "node:path";
import type { Database, SqlJsStatic } from "sql.js";

// ---------------------------------------------------------------------------
// Input types (used by GraphExtractor / callers)
// ---------------------------------------------------------------------------

export interface CallGraphNode {
  /** Stable ID: normalizedFilePath:symbolName:startLine */
  id: string;
  name: string;
  type: SymbolType;
  lang: SupportedLang;
  /** Normalized absolute path */
  path: string;
  /** Workspace-relative folder (for compound nodes) */
  folder: string;
  startLine: number;
  endLine: number;
  startCol: number;
  isExported: boolean;
}

export interface CallGraphEdge {
  sourceId: string;
  targetId: string;
  typeRelation: RelationType;
  sourceLine: number;
}

// ---------------------------------------------------------------------------
// SQLite schema (inlined — matches contracts/db-schema.sql)
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
PRAGMA journal_mode = MEMORY;
PRAGMA synchronous = OFF;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS file_index (
    path          TEXT     NOT NULL,
    lang          TEXT     NOT NULL,
    last_modified INTEGER  NOT NULL,
    indexed_at    INTEGER  NOT NULL,
    PRIMARY KEY (path)
);

CREATE TABLE IF NOT EXISTS nodes (
    id          TEXT     NOT NULL,
    name        TEXT     NOT NULL,
    type        TEXT     NOT NULL
                         CHECK (type IN ('function','class','method','interface','type','variable')),
    lang        TEXT     NOT NULL,
    path        TEXT     NOT NULL,
    folder      TEXT     NOT NULL,
    start_line  INTEGER  NOT NULL,
    end_line    INTEGER  NOT NULL,
    start_col   INTEGER  NOT NULL,
    is_exported INTEGER  NOT NULL DEFAULT 0,
    indexed_at  INTEGER  NOT NULL,
    PRIMARY KEY (id),
    FOREIGN KEY (path) REFERENCES file_index(path) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_nodes_path   ON nodes(path);
CREATE INDEX IF NOT EXISTS idx_nodes_folder ON nodes(folder);
CREATE INDEX IF NOT EXISTS idx_nodes_type   ON nodes(type);

CREATE TABLE IF NOT EXISTS edges (
    source_id     TEXT     NOT NULL,
    target_id     TEXT     NOT NULL,
    type_relation TEXT     NOT NULL
                           CHECK (type_relation IN ('CALLS','INHERITS','IMPLEMENTS','USES')),
    is_cyclic     INTEGER  NOT NULL DEFAULT 0,
    source_line   INTEGER  NOT NULL,
    indexed_at    INTEGER  NOT NULL,
    PRIMARY KEY (source_id, target_id, type_relation)
    -- FK constraints removed intentionally: @@external: stubs are stored here temporarily
    -- and resolved to real node IDs by resolveExternalEdges() after workspace indexing.
    -- Cascade cleanup is handled manually in indexFile() instead.
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_cyclic ON edges(is_cyclic) WHERE is_cyclic = 1;
`;

// ---------------------------------------------------------------------------
// CallGraphIndexer
// ---------------------------------------------------------------------------

/**
 * Singleton-per-instance in-memory SQLite graph store.
 * Designed to be created once during extension activation and reused.
 */
export class CallGraphIndexer {
  private db: Database | null = null;
  private SQL: SqlJsStatic | null = null;
  private initPromise: Promise<void> | null = null;
  private readonly wasmPath: string;

  constructor(wasmPath: string) {
    this.wasmPath = wasmPath;
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  /**
   * Initialize the sql.js database with the WASM binary and apply the schema.
   * Safe to call multiple times — subsequent calls wait for the first.
   */
  async init(): Promise<void> {
    if (this.db !== null) return;
    if (this.initPromise !== null) return this.initPromise;

    this.initPromise = (async () => {
      const wasmBinary = await fs.readFile(this.wasmPath);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const initSqlJs = require("sql.js") as (config: { wasmBinary: Uint8Array }) => Promise<SqlJsStatic>;
      this.SQL = await initSqlJs({ wasmBinary });
      this.db = new this.SQL.Database();
      this.db.run(SCHEMA_SQL);
    })();

    return this.initPromise;
  }

  /**
   * Returns the underlying sql.js Database object.
   * Throws if `init()` has not been called.
   */
  getDb(): Database {
    if (!this.db) {
      throw new Error("CallGraphIndexer not initialized — call init() first");
    }
    return this.db;
  }

  // ---------------------------------------------------------------------------
  // Indexation
  // ---------------------------------------------------------------------------

  /**
   * Atomically index all nodes and edges for a given source file.
   * Existing data for this file is deleted first (DELETE + INSERT in transaction).
   * After insertion the caller should call `markCycles()` with the cyclic edge IDs.
   *
   * @param nodes - Extracted nodes for the file
   * @param edges - Extracted edges for the file
   * @param filePath - Normalized absolute file path
   * @param lang - Language key
   * @param mtime - File mtime at extraction time (Unix ms)
   */
  indexFile(
    nodes: CallGraphNode[],
    edges: CallGraphEdge[],
    filePath: string,
    lang: SupportedLang,
    mtime: number,
  ): void {
    const db = this.getDb();
    const now = Date.now();

    db.run("BEGIN TRANSACTION");
    try {
      // Upsert file_index record
      db.run(
        `INSERT OR REPLACE INTO file_index (path, lang, last_modified, indexed_at)
         VALUES (?, ?, ?, ?)`,
        [filePath, lang, mtime, now],
      );

      // Manually delete edges touching nodes in this file BEFORE removing the nodes.
      // (FK CASCADE is not used on the edges table so that @@external: stubs can be stored.)
      db.run(
        `DELETE FROM edges
         WHERE source_id IN (SELECT id FROM nodes WHERE path = ?)
            OR target_id IN (SELECT id FROM nodes WHERE path = ?)`,
        [filePath, filePath],
      );

      // Delete existing nodes
      db.run("DELETE FROM nodes WHERE path = ?", [filePath]);

      // Insert all nodes
      const nodeStmt = db.prepare(
        `INSERT OR REPLACE INTO nodes
           (id, name, type, lang, path, folder, start_line, end_line, start_col, is_exported, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const n of nodes) {
        nodeStmt.run([
          n.id,
          n.name,
          n.type,
          n.lang,
          n.path,
          n.folder,
          n.startLine,
          n.endLine,
          n.startCol,
          n.isExported ? 1 : 0,
          now,
        ]);
      }
      nodeStmt.free();

      // Insert ALL edges, including @@external: stubs for cross-file calls.
      // @@external: targets are resolved to real node IDs later by resolveExternalEdges().
      const edgeStmt = db.prepare(
        `INSERT OR REPLACE INTO edges
           (source_id, target_id, type_relation, is_cyclic, source_line, indexed_at)
         VALUES (?, ?, ?, 0, ?, ?)`,
      );
      for (const e of edges) {
        // Skip edges from an external stub source (should not occur, but defensive)
        if (e.sourceId.startsWith("@@external:")) continue;
        edgeStmt.run([e.sourceId, e.targetId, e.typeRelation, e.sourceLine, now]);
      }
      edgeStmt.free();

      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
  }

  /**
   * Remove all nodes and edges associated with the given file path.
   * Also removes the file's record from `file_index`.
   * FK CASCADE is not used on edges, so we clean them up manually first.
   *
   * @param filePath - Normalized absolute file path
   */
  invalidateFile(filePath: string): void {
    const db = this.getDb();
    // Manually remove edges before nodes (no FK CASCADE on edges table)
    db.run(
      `DELETE FROM edges
       WHERE source_id IN (SELECT id FROM nodes WHERE path = ?)
          OR target_id IN (SELECT id FROM nodes WHERE path = ?)`,
      [filePath, filePath],
    );
    db.run("DELETE FROM file_index WHERE path = ?", [filePath]);
  }

  /**
   * Mark a set of edges as cyclic (is_cyclic = 1).
   * Edges are identified by (source_id, target_id) pairs.
   *
   * @param edgePairs - Array of { sourceId, targetId } pairs to mark
   */
  markCycles(edgePairs: Array<{ sourceId: string; targetId: string }>): void {
    if (edgePairs.length === 0) return;
    const db = this.getDb();

    // First reset all is_cyclic flags for these source nodes
    const sourceIds = [...new Set(edgePairs.map((e) => e.sourceId))];
    const placeholders = sourceIds.map(() => "?").join(",");
    db.run(
      `UPDATE edges SET is_cyclic = 0 WHERE source_id IN (${placeholders})`,
      sourceIds,
    );

    // Mark cyclic edges
    const stmt = db.prepare(
      `UPDATE edges SET is_cyclic = 1
       WHERE source_id = ? AND target_id = ?`,
    );
    for (const { sourceId, targetId } of edgePairs) {
      stmt.run([sourceId, targetId]);
    }
    stmt.free();
  }

  /**
   * Resolve `@@external:<name>` stub targets to real indexed node IDs.
   *
   * After workspace-wide indexing, call this once to replace cross-file stubs
   * with the IDs of the matching nodes in the workspace.  Ambiguous names
   * (same symbol name in multiple files) prefer exported symbols, then most
   * recently indexed.  Stubs that cannot be resolved are deleted.
   *
   * Must be called AFTER all files have been indexed for the result to be correct.
   *
   * Resolution strategy: for each @@external:name stub, find all nodes in the DB
   * that have the same symbol name, then pick the one whose file path shares the
   * most leading path segments with the source file.  Ties are broken by
   * preferring exported symbols and then most-recently indexed files.  This
   * correctly resolves same-named symbols from different projects (e.g. two
   * fixtures each exporting `formatDate`) to the version nearest the caller.
   */
  resolveExternalEdges(): { before: number; resolved: number; deleted: number } {
    const db = this.getDb();

    // Count stubs before resolution.
    const beforeRows = db.exec("SELECT COUNT(*) FROM edges WHERE target_id LIKE '@@external:%'");
    const before = (beforeRows[0]?.values[0][0] as number | null) ?? 0;

    if (before === 0) {
      return { before: 0, resolved: 0, deleted: 0 };
    }

    // Fetch all external stub edges together with the source node's file path.
    // Joining nodes gives us the source file path without having to parse the
    // composite source_id string.
    const stubRows = db.exec(`
      SELECT e.rowid, s.path AS source_path, SUBSTR(e.target_id, 12) AS sym_name
      FROM edges e
      JOIN nodes s ON s.id = e.source_id
      WHERE e.target_id LIKE '@@external:%'
    `);

    // Fetch all candidate target nodes that could satisfy any stub.
    const candidateRows = db.exec(`
      SELECT name, id, path, is_exported, indexed_at
      FROM nodes
      WHERE name IN (
        SELECT DISTINCT SUBSTR(target_id, 12) FROM edges WHERE target_id LIKE '@@external:%'
      )
    `);

    // Build name → candidates map.
    const candidateMap = new Map<string, Array<{ id: string; path: string; isExported: number; indexedAt: number }>>();
    if (candidateRows[0]) {
      for (const row of candidateRows[0].values as [string, string, string, number, number][]) {
        const [name, id, nodePath, isExported, indexedAt] = row;
        const existing = candidateMap.get(name);
        if (existing) {
          existing.push({ id, path: nodePath, isExported, indexedAt });
        } else {
          candidateMap.set(name, [{ id, path: nodePath, isExported, indexedAt }]);
        }
      }
    }

    // Apply best-match updates: for each stub, pick the candidate whose file
    // shares the most leading path segments with the caller's file.
    const updateStmt = db.prepare("UPDATE OR IGNORE edges SET target_id = ? WHERE rowid = ?");
    let resolved = 0;
    if (stubRows[0]) {
      for (const row of stubRows[0].values as [number, string, string][]) {
        const [rowid, sourcePath, symName] = row;
        const candidates = candidateMap.get(symName);
        if (!candidates || candidates.length === 0) { continue; }
        const best = pickBestCandidate(sourcePath, candidates);
        updateStmt.run([best.id, rowid]);
        resolved++;
      }
    }
    updateStmt.free();

    // Remove remaining unresolved stubs (library calls, builtins, etc.)
    db.run("DELETE FROM edges WHERE target_id LIKE '@@external:%'");
    // Defensive: remove any orphaned external sources.
    db.run("DELETE FROM edges WHERE source_id LIKE '@@external:%'");

    const deleted = before - resolved;
    return { before, resolved, deleted };
  }

  /**
   * Retrieve file_index record if it exists.
   * Used to check whether a file is already indexed and if mtime is fresh.
   */
  getFileRecord(filePath: string): { lang: string; lastModified: number; indexedAt: number } | null {
    const db = this.getDb();
    const stmt = db.prepare(
      "SELECT lang, last_modified, indexed_at FROM file_index WHERE path = ?",
    );
    stmt.bind([filePath]);
    let result: { lang: string; lastModified: number; indexedAt: number } | null = null;
    if (stmt.step()) {
      const row = stmt.getAsObject() as { lang: string; last_modified: number; indexed_at: number };
      result = {
        lang: row.lang,
        lastModified: row.last_modified,
        indexedAt: row.indexed_at,
      };
    }
    stmt.free();
    return result;
  }

  /**
   * Close the database and release resources.
   */
  dispose(): void {
    this.db?.close();
    this.db = null;
    this.SQL = null;
    this.initPromise = null;
  }
}

// ---------------------------------------------------------------------------
// Utility: resolve sql.js WASM path from extension path
// ---------------------------------------------------------------------------

/**
 * Returns the canonical path to sqljs.wasm given the VS Code extension path.
 * Uses path.join for cross-platform safety.
 */
export function getSqlJsWasmPath(extensionPath: string): string {
  return path.join(extensionPath, "dist", "wasm", "sqljs.wasm");
}

// ---------------------------------------------------------------------------
// Module-level helpers for resolveExternalEdges
// ---------------------------------------------------------------------------

type NodeCandidate = { id: string; path: string; isExported: number; indexedAt: number };

/**
 * Count the number of leading directory segments two file paths share.
 * Directories are compared case-sensitively (paths are already normalised).
 * Example: sharedPathSegments('/a/b/c.ts', '/a/b/d.ts') → 2
 */
function sharedPathSegments(pathA: string, pathB: string): number {
  const dirA = pathA.split("/").slice(0, -1);
  const dirB = pathB.split("/").slice(0, -1);
  const len = Math.min(dirA.length, dirB.length);
  let count = 0;
  for (let i = 0; i < len; i++) {
    if (dirA[i] === dirB[i]) { count++; } else { break; }
  }
  return count;
}

/**
 * From a list of candidate nodes, return the one whose path best matches
 * the caller's source path.  Tie-breaking: exported > recently indexed.
 */
function pickBestCandidate(sourcePath: string, candidates: NodeCandidate[]): NodeCandidate {
  let best = candidates[0];
  let bestSim = sharedPathSegments(sourcePath, best.path);
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    const sim = sharedPathSegments(sourcePath, c.path);
    const betterSim = sim > bestSim;
    const sameSim = sim === bestSim;
    const betterExport = sameSim && c.isExported > best.isExported;
    const betterRecent = sameSim && c.isExported === best.isExported && c.indexedAt > best.indexedAt;
    if (betterSim || betterExport || betterRecent) {
      best = c;
      bestSim = sim;
    }
  }
  return best;
}
