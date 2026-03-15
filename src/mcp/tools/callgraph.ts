/**
 * MCP Call Graph Tool — Cross-file call graph queries via SQLite.
 *
 * Lazy-initializes a CallGraphIndexer + GraphExtractor on first invocation,
 * indexes the entire workspace, then answers callers/callees/neighbourhood
 * queries against the in-memory sql.js database.
 *
 * NO vscode imports — this module is VS Code agnostic.
 */

import type { CallGraphEdge } from "@/analyzer/callgraph/CallGraphIndexer";
import { CallGraphIndexer } from "@/analyzer/callgraph/CallGraphIndexer";
import { detectCycleEdges } from "@/analyzer/callgraph/cycleUtils";
import type { ExtractorConfig } from "@/analyzer/callgraph/GraphExtractor";
import { fileExtToLang, GraphExtractor } from "@/analyzer/callgraph/GraphExtractor";
import { SourceFileCollector } from "@/analyzer/SourceFileCollector";
import type { RelationType } from "@/shared/callgraph-types";
import { getLogger } from "@/shared/logger";
import { normalizePath } from "@/shared/path";
import fs from "node:fs/promises";
import path from "node:path";
import { workerState } from "../shared/state";
import type { QueryCallGraphParams } from "../types";

const log = getLogger("McpCallGraph");

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface CallGraphSymbol {
  id: string;
  name: string;
  type: string;
  lang: string;
  filePath: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
}

interface CallGraphRelation {
  sourceId: string;
  sourceName: string;
  sourceFile: string;
  targetId: string;
  targetName: string;
  targetFile: string;
  relation: string;
  sourceLine: number;
  isCyclic: boolean;
}

export interface QueryCallGraphResult {
  symbol: CallGraphSymbol | null;
  callers: CallGraphRelation[];
  callees: CallGraphRelation[];
  totalCallers: number;
  totalCallees: number;
  depth: number;
  direction: string;
  indexedFiles: number;
  indexTimeMs?: number;
}

// ---------------------------------------------------------------------------
// Lazy initialization
// ---------------------------------------------------------------------------

let indexPromise: Promise<void> | null = null;

async function ensureCallGraphReady(): Promise<void> {
  const config = workerState.getConfig();
  const workspaceRoot = config.rootDir;

  // Already indexed for this workspace
  if (
    workerState.callGraphIndexer &&
    workerState.callGraphIndexedRoot === workspaceRoot
  ) {
    return;
  }

  // Avoid duplicate indexing
  if (indexPromise !== null) return indexPromise;

  indexPromise = doInitAndIndex(config.extensionPath, workspaceRoot);
  try {
    await indexPromise;
  } finally {
    indexPromise = null;
  }
}

async function doInitAndIndex(
  extensionPath: string | undefined,
  workspaceRoot: string,
): Promise<void> {
  if (!extensionPath) {
    throw new Error("extensionPath required for call graph WASM parsers");
  }

  const startTime = Date.now();

  // Initialize CallGraphIndexer (sql.js WASM)
  const wasmPath = path.join(extensionPath, "dist", "wasm", "sqljs.wasm");
  await fs.access(wasmPath); // fail fast if missing
  const indexer = new CallGraphIndexer(wasmPath);
  await indexer.init();

  // Initialize GraphExtractor (tree-sitter WASM)
  const extractorConfig: ExtractorConfig = {
    extensionPath,
    workspaceRoot,
  };
  const extractor = new GraphExtractor(extractorConfig);

  // Collect source files
  const collector = new SourceFileCollector({
    excludeNodeModules: true,
    yieldIntervalMs: 30,
    isCancelled: () => false,
  });
  const allFiles = await collector.collectAllSourceFiles(workspaceRoot);
  const callgraphFiles = allFiles
    .map(normalizePath)
    .filter((f) => fileExtToLang(f) !== null);

  log.info(`Indexing ${callgraphFiles.length} files for call graph…`);

  // Extract + index all files in batches
  const allEdges: CallGraphEdge[] = [];
  indexer.beginBatch();
  try {
    for (const filePath of callgraphFiles) {
      const lang = fileExtToLang(filePath);
      if (!lang) continue;
      try {
        const stat = await fs.stat(filePath);
        const result = await extractor.extractFile(filePath, lang, stat.mtimeMs);
        if (result.nodes.length > 0) {
          indexer.indexFile(result.nodes, result.edges, filePath, lang, stat.mtimeMs);
          allEdges.push(...result.edges);
        }
      } catch {
        // Skip files that fail to parse (binary files, encoding issues, etc.)
      }
    }
    indexer.commitBatch();
  } catch (err) {
    indexer.rollbackBatch();
    throw err;
  }

  // Cycle detection
  const nonUsesEdges = allEdges
    .filter((e) => e.typeRelation !== "USES")
    .map((e) => ({ source: e.sourceId, target: e.targetId }));
  if (nonUsesEdges.length > 0) {
    const cycleEdgeKeys = detectCycleEdges(nonUsesEdges);
    const cyclicPairs = allEdges.filter((e) =>
      cycleEdgeKeys.has(`${e.sourceId}->${e.targetId}`),
    );
    if (cyclicPairs.length > 0) {
      indexer.markCycles(
        cyclicPairs.map((e) => ({ sourceId: e.sourceId, targetId: e.targetId })),
      );
    }
  }

  // Resolve cross-file edges
  const resolveStats = indexer.resolveExternalEdges();
  log.info(
    `Cross-file resolution: resolved=${resolveStats.resolved} unresolved=${resolveStats.deleted}`,
  );

  // Dispose any previous instances
  if (workerState.graphExtractor) workerState.graphExtractor.dispose();
  if (workerState.callGraphIndexer) workerState.callGraphIndexer.dispose();

  // Store in worker state
  workerState.callGraphIndexer = indexer;
  workerState.graphExtractor = extractor;
  workerState.callGraphIndexedRoot = workspaceRoot;

  const duration = Date.now() - startTime;
  log.info(`Call graph indexed ${callgraphFiles.length} files in ${duration}ms`);
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

export async function executeQueryCallGraph(
  params: QueryCallGraphParams,
): Promise<QueryCallGraphResult> {
  const startTime = Date.now();
  await ensureCallGraphReady();

  const indexer = workerState.callGraphIndexer;
  if (!indexer) {
    throw new Error("Call graph indexer not initialized");
  }
  const db = indexer.getDb();
  const indexTimeMs = Date.now() - startTime;

  const normalizedPath = normalizePath(params.filePath);
  const direction = params.direction ?? "both";
  const depth = params.depth ?? 2;
  const relationFilter = params.relationTypes ?? null;

  // Find matching symbol nodes
  const symbolRows = db.exec(
    "SELECT id, name, type, lang, path, start_line, end_line, is_exported FROM nodes WHERE path = ? AND name = ?",
    [normalizedPath, params.symbolName],
  );

  if (!symbolRows[0] || symbolRows[0].values.length === 0) {
    return {
      symbol: null,
      callers: [],
      callees: [],
      totalCallers: 0,
      totalCallees: 0,
      depth,
      direction,
      indexedFiles: countIndexedFiles(db),
      indexTimeMs,
    };
  }

  // Use the first matching symbol (most specific would require line info)
  const row = symbolRows[0].values[0];
  const symbolId = row[0] as string;
  const symbol: CallGraphSymbol = {
    id: symbolId,
    name: row[1] as string,
    type: row[2] as string,
    lang: row[3] as string,
    filePath: row[4] as string,
    startLine: row[5] as number,
    endLine: row[6] as number,
    isExported: (row[7] as number) === 1,
  };

  // BFS callers (who calls this symbol?)
  let callers: CallGraphRelation[] = [];
  if (direction === "callers" || direction === "both") {
    callers = bfsRelations(db, symbolId, "callers", depth, relationFilter);
  }

  // BFS callees (what does this symbol call?)
  let callees: CallGraphRelation[] = [];
  if (direction === "callees" || direction === "both") {
    callees = bfsRelations(db, symbolId, "callees", depth, relationFilter);
  }

  return {
    symbol,
    callers,
    callees,
    totalCallers: callers.length,
    totalCallees: callees.length,
    depth,
    direction,
    indexedFiles: countIndexedFiles(db),
    indexTimeMs,
  };
}

// ---------------------------------------------------------------------------
// BFS traversal helpers
// ---------------------------------------------------------------------------

function bfsRelations(
  db: import("sql.js").Database,
  rootId: string,
  dir: "callers" | "callees",
  maxDepth: number,
  relationFilter: RelationType[] | null,
): CallGraphRelation[] {
  const visited = new Set<string>();
  const results: CallGraphRelation[] = [];
  let frontier = new Set<string>([rootId]);

  for (let d = 0; d < maxDepth && frontier.size > 0; d++) {
    const nextFrontier = new Set<string>();
    for (const nodeId of frontier) {
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      expandNode(db, nodeId, dir, relationFilter, results, visited, nextFrontier);
    }
    frontier = nextFrontier;
  }

  return results;
}

function expandNode(
  db: import("sql.js").Database,
  nodeId: string,
  dir: "callers" | "callees",
  relationFilter: RelationType[] | null,
  results: CallGraphRelation[],
  visited: Set<string>,
  nextFrontier: Set<string>,
): void {
  const edges = queryEdges(db, nodeId, dir, relationFilter);
  for (const edge of edges) {
    results.push(edge);
    const nextId = dir === "callers" ? edge.sourceId : edge.targetId;
    if (!visited.has(nextId)) {
      nextFrontier.add(nextId);
    }
  }
}

function queryEdges(
  db: import("sql.js").Database,
  nodeId: string,
  dir: "callers" | "callees",
  relationFilter: RelationType[] | null,
): CallGraphRelation[] {
  // Build query based on direction
  const isCallers = dir === "callers";
  const joinCol = isCallers ? "e.target_id" : "e.source_id";
  const otherCol = isCallers ? "e.source_id" : "e.target_id";

  let sql = `
    SELECT e.source_id, e.target_id, e.type_relation, e.is_cyclic, e.source_line,
           src.name AS src_name, src.path AS src_path,
           tgt.name AS tgt_name, tgt.path AS tgt_path
    FROM edges e
    JOIN nodes src ON src.id = e.source_id
    JOIN nodes tgt ON tgt.id = e.target_id
    WHERE ${joinCol} = ?`;

  const sqlParams: (string | number)[] = [nodeId];

  if (relationFilter && relationFilter.length > 0) {
    const placeholders = relationFilter.map(() => "?").join(",");
    sql += ` AND e.type_relation IN (${placeholders})`;
    sqlParams.push(...relationFilter);
  }

  // Skip edges pointing at unresolved external stubs
  sql += ` AND ${otherCol} NOT LIKE '@@external:%'`;

  const rows = db.exec(sql, sqlParams);
  if (!rows[0]) return [];

  return rows[0].values.map((r) => ({
    sourceId: r[0] as string,
    targetId: r[1] as string,
    relation: r[2] as string,
    isCyclic: (r[3] as number) === 1,
    sourceLine: r[4] as number,
    sourceName: r[5] as string,
    sourceFile: r[6] as string,
    targetName: r[7] as string,
    targetFile: r[8] as string,
  }));
}

function countIndexedFiles(db: import("sql.js").Database): number {
  const result = db.exec("SELECT COUNT(*) FROM file_index");
  if (!result[0]) return 0;
  return result[0].values[0][0] as number;
}
