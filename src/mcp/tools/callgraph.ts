/**
 * MCP Call Graph Tool — Cross-file call graph queries via SQLite.
 *
 * Lazy-initializes a CallGraphIndexer + GraphExtractor on first invocation,
 * indexes the entire workspace, then answers callers/callees/neighbourhood
 * queries against the in-memory sql.js database.
 *
 * NO vscode imports — this module is VS Code agnostic.
 */

import type { IndexCache } from "@/analyzer/cache/IndexCache";
import { CallGraphIndexer } from "@/analyzer/callgraph/CallGraphIndexer";
import type { ExtractorConfig } from "@/analyzer/callgraph/GraphExtractor";
import {
  collectChangedFiles,
  fileExtToLang,
  getQueryFreshnessCutoffs,
  GraphExtractor,
} from "@/analyzer/callgraph/GraphExtractor";
import { SourceFileCollector } from "@/analyzer/SourceFileCollector";
import type { RelationType, SupportedLang } from "@/shared/callgraph-types";
import { getLogger } from "@/shared/logger";
import { normalizePath } from "@/shared/path";
import fs from "node:fs/promises";
import path from "node:path";
import { fitToTokenBudget } from "../shared/helpers";
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
  /** Offset of the next page when relations remain; pass it back as offset */
  nextOffset?: number;
  /** Set when a tokenBudget was applied: true if callers or callees were cut */
  truncated?: boolean;
  /** Callers and callees cut by the tokenBudget; totals keep the full counts */
  omitted?: { callers: number; callees: number };
}

// ---------------------------------------------------------------------------
// Lazy initialization
// ---------------------------------------------------------------------------

let indexPromise: Promise<void> | null = null;

export async function ensureCallGraphReady(): Promise<void> {
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

  indexPromise = doInitAndIndex(config.extensionPath, workspaceRoot, workerState.indexCache);
  try {
    await indexPromise;
  } finally {
    indexPromise = null;
  }
}

/**
 * Above this share of files needing re-extraction, a clean rebuild beats an
 * incremental pass — and it periodically heals the drift documented below.
 */
const REBUILD_THRESHOLD = 0.2;

/** One file to extract, with its resolved language. */
interface CallGraphJob {
  filePath: string;
  lang: SupportedLang;
}

/**
 * Decide what to re-extract on top of a restored DB.
 *
 * Returns every file when the workspace churned past REBUILD_THRESHOLD, after
 * wiping the DB clean — the caller then indexes from scratch.
 *
 * ponytail: resolveExternalEdges() permanently deletes unresolved `@@external:`
 * stubs, so an edge whose TARGET gained a symbol is not restored by re-extracting
 * the target alone. Importers of changed files are re-extracted to cover the
 * import-based cases; non-import resolution (dynamic dispatch, Go/Java
 * package-level) stays uncovered until the next full rebuild.
 */
async function selectStaleJobs(
  indexer: CallGraphIndexer,
  callgraphFiles: string[],
  extensionPath: string,
  pendingFiles: readonly string[],
): Promise<CallGraphJob[]> {
  const onDisk = new Set(callgraphFiles);
  invalidateMissingFiles(indexer, onDisk);

  const cutoffs = await getQueryFreshnessCutoffs(extensionPath);
  const { jobs } = await collectChangedFiles(
    callgraphFiles,
    (f) => indexer.getFileRecord(f),
    cutoffs,
  );

  // Re-extract importers of changed files so cross-file edges get re-resolved.
  // The Spider reverse index is already warm in this process, so this is free.
  const selected = selectChangedJobs(jobs);
  // Explicitly invalidated files are re-extracted even when their mtime did not move.
  for (const filePath of pendingFiles) addIndexableJob(selected, filePath, onDisk);
  await addReferencingJobs(selected, [...selected.values()], onDisk);

  if (shouldRebuild(callgraphFiles.length, selected.size)) {
    return rebuildCallGraph(indexer, callgraphFiles);
  }

  return [...selected.values()];
}

function invalidateMissingFiles(
  indexer: CallGraphIndexer,
  onDisk: Set<string>,
): void {
  for (const indexed of indexer.getIndexSnapshot().files) {
    if (!onDisk.has(indexed.path)) {
      indexer.invalidateFile(indexed.path);
    }
  }
}

function selectChangedJobs(jobs: CallGraphJob[]): Map<string, CallGraphJob> {
  return new Map(jobs.map((job) => [job.filePath, job]));
}

async function addReferencingJobs(
  selected: Map<string, CallGraphJob>,
  jobs: CallGraphJob[],
  onDisk: Set<string>,
): Promise<void> {
  const spider = workerState.spider;
  if (!spider) return;

  for (const job of jobs) {
    const referencingFiles = await spider.findReferencingFiles(job.filePath);
    for (const referencing of referencingFiles) {
      addIndexableJob(selected, normalizePath(referencing.path), onDisk);
    }
  }
}

function addIndexableJob(
  selected: Map<string, CallGraphJob>,
  importer: string,
  onDisk: Set<string>,
): void {
  const lang = fileExtToLang(importer);
  if (lang && onDisk.has(importer) && !selected.has(importer)) {
    selected.set(importer, { filePath: importer, lang });
  }
}

function shouldRebuild(fileCount: number, selectedCount: number): boolean {
  return fileCount > 0 && selectedCount / fileCount > REBUILD_THRESHOLD;
}

async function rebuildCallGraph(
  indexer: CallGraphIndexer,
  callgraphFiles: string[],
): Promise<CallGraphJob[]> {
  log.info("Call graph cache too stale, rebuilding from scratch");
  indexer.dispose();
  await indexer.init();
  return callgraphFiles.map((filePath) => ({
    filePath,
    lang: fileExtToLang(filePath) as SupportedLang,
  }));
}

async function doInitAndIndex(
  extensionPath: string | undefined,
  workspaceRoot: string,
  cache: IndexCache | null,
): Promise<void> {
  if (!extensionPath) {
    throw new Error("extensionPath required for call graph WASM parsers");
  }

  // Held from restore to save: a second process waits, then restores this result.
  const release = cache ? await cache.lock() : null;
  try {
    await indexCallGraph(extensionPath, workspaceRoot, cache);
  } finally {
    release?.();
  }
}

async function indexCallGraph(
  extensionPath: string,
  workspaceRoot: string,
  cache: IndexCache | null,
): Promise<void> {
  const startTime = Date.now();
  // Snapshot what was explicitly invalidated: marks made while indexing stay pending.
  const pendingFiles = [...workerState.callGraphPendingFiles];
  const fullRebuild = workerState.callGraphFullRebuild;
  const { indexer, restored } = await initializeCallGraphIndexer(
    extensionPath,
    fullRebuild ? null : cache,
  );

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

  const jobs = await selectCallGraphJobs(
    restored,
    indexer,
    callgraphFiles,
    extensionPath,
    pendingFiles,
  );

  log.info(
    `Indexing ${jobs.length}/${callgraphFiles.length} files for call graph` +
      (restored ? " (incremental)" : ""),
  );

  // Extract + index the selected files in batches
  await indexCallGraphJobs(indexer, extractor, jobs);

  // Resolve cross-file edges, then flag cycles on the resolved graph
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
  workerState.clearCallGraphPending(pendingFiles, fullRebuild);

  cache?.save({ callGraph: indexer.exportDb() });

  const duration = Date.now() - startTime;
  log.info(`Call graph indexed ${callgraphFiles.length} files in ${duration}ms`);
}

async function initializeCallGraphIndexer(
  extensionPath: string,
  cache: IndexCache | null,
): Promise<{ indexer: CallGraphIndexer; restored: boolean }> {
  const wasmPath = path.join(extensionPath, "dist", "wasm", "sqljs.wasm");
  await fs.access(wasmPath);
  const indexer = new CallGraphIndexer(wasmPath);
  const restored = cache?.isValid() ? await indexer.loadFromFile(cache.callGraphPath) : false;
  if (!restored) await indexer.init();
  return { indexer, restored };
}

async function selectCallGraphJobs(
  restored: boolean,
  indexer: CallGraphIndexer,
  callgraphFiles: string[],
  extensionPath: string,
  pendingFiles: readonly string[],
): Promise<CallGraphJob[]> {
  if (restored) {
    return selectStaleJobs(indexer, callgraphFiles, extensionPath, pendingFiles);
  }
  return callgraphFiles.map((filePath) => ({
    filePath,
    lang: fileExtToLang(filePath)!,
  }));
}

async function indexCallGraphJobs(
  indexer: CallGraphIndexer,
  extractor: GraphExtractor,
  jobs: CallGraphJob[],
): Promise<void> {
  indexer.beginBatch();
  try {
    for (const job of jobs) {
      await indexCallGraphJob(indexer, extractor, job);
    }
    indexer.commitBatch();
  } catch (err) {
    indexer.rollbackBatch();
    throw err;
  }
}

async function indexCallGraphJob(
  indexer: CallGraphIndexer,
  extractor: GraphExtractor,
  job: CallGraphJob,
): Promise<void> {
  try {
    const stat = await fs.stat(job.filePath);
    const result = await extractor.extractFile(job.filePath, job.lang, stat.mtimeMs);
    indexer.indexFile(result.nodes, result.edges, job.filePath, job.lang, stat.mtimeMs);
  } catch {
    // Skip files that fail to parse (binary files, encoding issues, etc.)
  }
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
  // USES edges are type-only references, not calls: they come back only on request.
  const relationFilter: RelationType[] | null =
    params.relationTypes ?? (params.includeTypeOnly ? null : ["CALLS", "INHERITS", "IMPLEMENTS"]);

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

  const result: QueryCallGraphResult = {
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
  // BFS order puts the nearest hops first. Callers and callees are interleaved
  // so one direction never crowds the other out of a page; offset and
  // nextOffset index that interleaved sequence.
  const sequence: Array<{ direction: "callers" | "callees"; relation: CallGraphRelation }> = [];
  for (let index = 0; index < Math.max(callers.length, callees.length); index++) {
    if (index < callers.length) sequence.push({ direction: "callers", relation: callers[index] });
    if (index < callees.length) sequence.push({ direction: "callees", relation: callees[index] });
  }
  const offset = params.offset ?? 0;
  const pageSize = Math.max(0, sequence.length - offset);
  const page = (count: number): QueryCallGraphResult => {
    const end = offset + count;
    const slice = sequence.slice(offset, end);
    return {
      ...result,
      callers: slice.filter((item) => item.direction === "callers").map((item) => item.relation),
      callees: slice.filter((item) => item.direction === "callees").map((item) => item.relation),
      ...(end < sequence.length ? { nextOffset: end } : {}),
    };
  };
  if (!params.tokenBudget) return page(pageSize);

  const fullPage = page(pageSize);
  return fitToTokenBudget(pageSize, params.tokenBudget, (count) => {
    const budgeted = page(count);
    return {
      ...budgeted,
      truncated: count < pageSize,
      omitted: {
        callers: fullPage.callers.length - budgeted.callers.length,
        callees: fullPage.callees.length - budgeted.callees.length,
      },
    };
  }).result;
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
  // Stable order so offset pages line up between calls.
  sql += " ORDER BY e.source_id, e.target_id, e.source_line";

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
