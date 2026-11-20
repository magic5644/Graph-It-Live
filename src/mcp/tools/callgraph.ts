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
import { AutoImports, type AutoImportProject } from "@/analyzer/callgraph/autoImports";
import { CallGraphIndexer } from "@/analyzer/callgraph/CallGraphIndexer";
import type { DeclarationReads } from "@/analyzer/utils/declarations";
import type { ExtractorConfig } from "@/analyzer/callgraph/GraphExtractor";
import {
  collectChangedFiles,
  fileExtToLang,
  getQueryFreshnessCutoffs,
  GraphExtractor,
} from "@/analyzer/callgraph/GraphExtractor";
import {
  lookupCallGraphSymbol,
  symbolNamesInFile,
  type CallGraphSymbol,
  type CallGraphSymbolMiss,
} from "@/analyzer/callgraph/CallGraphSymbolLookup";
import { SourceFileCollector } from "@/analyzer/SourceFileCollector";
import { closestNames, symbolNotFoundMessage } from "@/analyzer/utils/SymbolLookup";
import type { RelationType, SupportedLang } from "@/shared/callgraph-types";
import { mapWithConcurrency } from "@/shared/concurrency";
import { getLogger } from "@/shared/logger";
import { assertOffsetInRange } from "@/shared/paging";
import { normalizePath } from "@/shared/path";
import type { Database } from "sql.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fitToTokenBudget } from "../shared/helpers";
import { workerState } from "../shared/state";
import type { CallGraphAutoImports, QueryCallGraphParams } from "../types";

const log = getLogger("McpCallGraph");

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface CallGraphRelation {
  sourceId: string;
  sourceName: string;
  sourceFile: string;
  targetId: string;
  targetName: string;
  targetFile: string;
  relation: string;
  /** 1-based line of the call in the caller's file */
  sourceLine: number;
  isCyclic: boolean;
}

export interface QueryCallGraphResult {
  symbol: CallGraphSymbol | null;
  /** Set when symbol is null: why no single node was selected */
  reason?: CallGraphSymbolMiss;
  /** Same-name nodes to pick from (ambiguous) or that the selector missed (stale_selector) */
  candidates?: CallGraphSymbol[];
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
 * the target alone. Importers of changed files, direct or through re-export
 * barrels, are re-extracted to cover the import-based cases; non-import resolution (dynamic dispatch, Go/Java
 * package-level) stays uncovered until the next full rebuild.
 */
async function selectStaleJobs(
  indexer: CallGraphIndexer,
  callgraphFiles: string[],
  extensionPath: string,
  pendingFiles: readonly string[],
  autoImports: AutoImportProject[],
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
  addAutoImportJobs(selected, indexer, autoImports, onDisk);
  await addReferencingJobs(selected, [...selected.values()], onDisk);

  if (shouldRebuild(callgraphFiles.length, selected.size)) {
    return rebuildCallGraph(indexer, callgraphFiles);
  }

  return [...selected.values()];
}

/** Metadata key of the auto-import declarations the stored call graph was extracted with: project root -> hash. */
const AUTO_IMPORTS_KEY = "auto_imports";

function autoImportHashes(projects: AutoImportProject[]): Record<string, string> {
  return Object.fromEntries(projects.filter(project => project.hash !== "").map(project => [project.root, project.hash]));
}

function storedAutoImportHashes(indexer: CallGraphIndexer): Record<string, string> {
  try {
    return JSON.parse(indexer.getMetadata(AUTO_IMPORTS_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Files whose auto-import bindings may have moved, which no import statement tells: every file of a project whose
 * declarations changed (added, edited, removed), and the callers of a changed file of a project that auto-imports.
 */
function addAutoImportJobs(
  selected: Map<string, CallGraphJob>,
  indexer: CallGraphIndexer,
  projects: AutoImportProject[],
  onDisk: Set<string>,
): void {
  const stored = storedAutoImportHashes(indexer);
  const current = autoImportHashes(projects);
  const changedRoots = [...new Set([...Object.keys(stored), ...Object.keys(current)])].filter(root => stored[root] !== current[root]);
  const autoImporting = projects.filter(project => project.names.size > 0).map(project => `${project.root}/`);
  const changed = [...selected.keys()].filter(file => autoImporting.some(root => file.startsWith(root)));
  for (const file of changed) {
    for (const caller of indexer.getCallerFiles(file)) addIndexableJob(selected, caller, onDisk);
  }
  if (changedRoots.length === 0) return;
  for (const file of onDisk) {
    if (changedRoots.some(root => file.startsWith(`${root}/`))) addIndexableJob(selected, file, onDisk);
  }
}

/** Missing declarations already reported by this process: each is reported once. */
const reportedMissing = new Set<string>();

/** What get_index_status shows of the auto-imports, workspace-relative; undefined when no project has any. */
function describeAutoImports(projects: AutoImportProject[], workspaceRoot: string): CallGraphAutoImports | undefined {
  const relative = (root: string) => normalizePath(path.relative(workspaceRoot, root)) || ".";
  const declaring = projects.filter(project => project.sources.length > 0)
    .map(project => ({ project: relative(project.root), sources: project.sources.map(relative), entries: project.names.size }))
    .sort((a, b) => a.project.localeCompare(b.project));
  const missing = projects.flatMap(project => project.missing.map(entry => ({ project: relative(project.root), ...entry })))
    .sort((a, b) => a.project.localeCompare(b.project));
  return declaring.length > 0 || missing.length > 0 ? { projects: declaring, missing } : undefined;
}

/** One notice for the missing declarations not reported yet by this process, grouped by file and hint. */
function reportMissingAutoImports(summary: CallGraphAutoImports | undefined, workspaceRoot: string): void {
  const fresh = (summary?.missing ?? []).filter(({ project, source }) => {
    const key = `${workspaceRoot}\0${project}\0${source}`;
    if (reportedMissing.has(key)) return false;
    reportedMissing.add(key);
    return true;
  });
  const groups = new Map<string, string[]>();
  for (const { project, source, hint } of fresh) groups.set(`${source}\0${hint}`, [...(groups.get(`${source}\0${hint}`) ?? []), project]);
  const parts = [...groups].map(([key, projects]) => {
    const [source, hint] = key.split("\0");
    const shown = projects.slice(0, 3).join(", ") + (projects.length > 3 ? ` and ${projects.length - 3} more` : "");
    return `${source} is missing in ${shown}: ${hint}`;
  });
  if (parts.length === 0) return;
  const message = `auto-imported names stay unresolved in the call graph; ${parts.join("; ")}.`;
  log.warn(message);
  workerState.callGraphNotice?.(message);
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

  // Through barrels too: an importer of `./ui` links to `ui/Card.tsx`'s nodes, whose ids move with the file (#575).
  const referencingPerJob = await mapWithConcurrency(jobs, 8, (job) => spider.findReferencingFilesThroughBarrels(job.filePath));
  for (const referencingFiles of referencingPerJob) {
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
  const autoImports = new AutoImports(workspaceRoot);
  const autoImportProjects = autoImports.projectsOf(callgraphFiles);

  // Initialize GraphExtractor (tree-sitter WASM)
  const extractorConfig: ExtractorConfig = {
    extensionPath,
    workspaceRoot,
    autoImports,
  };
  const extractor = new GraphExtractor(extractorConfig);

  const jobs = await selectCallGraphJobs(
    restored,
    indexer,
    callgraphFiles,
    extensionPath,
    pendingFiles,
    autoImportProjects,
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
  indexer.setMetadata(AUTO_IMPORTS_KEY, JSON.stringify(autoImportHashes(autoImportProjects)));
  workerState.callGraphAutoImports = describeAutoImports(autoImportProjects, workspaceRoot);
  reportMissingAutoImports(workerState.callGraphAutoImports, workspaceRoot);

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
  autoImports: AutoImportProject[],
): Promise<CallGraphJob[]> {
  if (restored) {
    return selectStaleJobs(indexer, callgraphFiles, extensionPath, pendingFiles, autoImports);
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
    // One pass reads each module and resolves each barrel re-export once, whatever the number of importers.
    await indexCallGraphWindow(indexer, extractor, jobs, 0, new Map());
    indexer.commitBatch();
  } catch (err) {
    indexer.rollbackBatch();
    throw err;
  }
}

/** Jobs extracted together before their DB writes: bounds the extraction results held in memory. */
const CALL_GRAPH_WINDOW = 64;

/** Extracts one window of jobs in parallel, writes them in job order, then moves to the next window. */
async function indexCallGraphWindow(
  indexer: CallGraphIndexer,
  extractor: GraphExtractor,
  jobs: CallGraphJob[],
  start: number,
  reads: DeclarationReads,
): Promise<void> {
  if (start >= jobs.length) return;
  const window = jobs.slice(start, start + CALL_GRAPH_WINDOW);
  const extracted = await mapWithConcurrency(window, 8, (job) => extractCallGraphJob(extractor, job, reads));
  window.forEach((job, index) => indexCallGraphJob(indexer, job, extracted[index]));
  return indexCallGraphWindow(indexer, extractor, jobs, start + CALL_GRAPH_WINDOW, reads);
}

type ExtractedCallGraphJob = Awaited<ReturnType<GraphExtractor["extractFile"]>> & { mtime: number };

async function extractCallGraphJob(
  extractor: GraphExtractor,
  job: CallGraphJob,
  reads: DeclarationReads,
): Promise<ExtractedCallGraphJob | null> {
  try {
    const stat = await fs.stat(job.filePath);
    const result = await extractor.extractFile(job.filePath, job.lang, stat.mtimeMs, reads);
    return { ...result, mtime: stat.mtimeMs };
  } catch {
    // Skip files that fail to parse (binary files, encoding issues, etc.)
    return null;
  }
}

function indexCallGraphJob(
  indexer: CallGraphIndexer,
  job: CallGraphJob,
  extracted: ExtractedCallGraphJob | null,
): void {
  if (!extracted) return;
  try {
    indexer.indexFile(extracted.nodes, extracted.edges, job.filePath, job.lang, extracted.mtime);
  } catch {
    // Skip files that fail to index, as before.
  }
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

/**
 * MCP responses show workspace-relative ids while the index stores absolute ones,
 * so an id copied from a result must be mapped back. Only the prefix of the
 * requested file is rewritten: an id of another file stays foreign and misses.
 */
function toIndexedSymbolId(
  symbolId: string | undefined,
  filePath: string,
  rootDir: string | undefined,
): string | undefined {
  if (!symbolId || !rootDir) return symbolId;
  const stored = shiftIdLine(symbolId, -1);
  const relative = normalizePath(path.relative(rootDir, filePath));
  if (!stored.startsWith(`${relative}:`)) return stored;
  return `${normalizePath(filePath)}${stored.slice(relative.length)}`;
}

/**
 * Node ids end with the stored 0-based declaration row; results show it 1-based, the line of
 * `startLine` (#793), and toIndexedSymbolId shifts it back. Only the trailing `:<row>` changes.
 */
function shiftIdLine(id: string, delta: 1 | -1): string {
  return id.replace(/:(\d+)$/, (_match, row: string) => `:${Number(row) + delta}`);
}

const shownSymbol = (symbol: CallGraphSymbol): CallGraphSymbol => ({ ...symbol, id: shiftIdLine(symbol.id, 1) });
const shownRelation = (relation: CallGraphRelation): CallGraphRelation => ({
  ...relation,
  sourceId: shiftIdLine(relation.sourceId, 1),
  targetId: shiftIdLine(relation.targetId, 1),
});

export async function executeQueryCallGraph(
  params: QueryCallGraphParams,
): Promise<QueryCallGraphResult> {
  const startTime = Date.now();
  await ensureCallGraphReady();

  const indexer = workerState.callGraphIndexer;
  if (!indexer) {
    throw new Error("Call graph indexer not initialized");
  }
  return queryCallGraphInDb(indexer.getDb(), workerState.config?.rootDir ?? "", params, Date.now() - startTime);
}

/** query_call_graph on an open call graph, shared by the MCP tool and its VS Code language model tool. */
export function queryCallGraphInDb(
  db: Database,
  rootDir: string,
  params: QueryCallGraphParams,
  indexTimeMs = 0,
): QueryCallGraphResult {

  const direction = params.direction ?? "both";
  const depth = params.depth ?? 2;
  // USES edges are type-only references, not calls: they come back only on request.
  const relationFilter: RelationType[] | null =
    params.relationTypes ?? (params.includeTypeOnly ? null : ["CALLS", "INHERITS", "IMPLEMENTS", "REFERENCES"]);

  const lookup = lookupCallGraphSymbol(db, {
    ...params,
    symbolId: toIndexedSymbolId(params.symbolId, params.filePath, rootDir),
  });
  if (lookup.symbol === null && lookup.reason === "not_found") {
    // A missing symbol is an error with the closest names, like trace and impact.
    const names = symbolNamesInFile(db, params.filePath);
    const label = normalizePath(path.relative(rootDir, params.filePath));
    throw new Error(symbolNotFoundMessage(params.symbolName, label, closestNames(names, params.symbolName)));
  }
  if (lookup.symbol === null) {
    return {
      symbol: null,
      reason: lookup.reason,
      candidates: lookup.candidates.map(shownSymbol),
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

  const symbol = lookup.symbol;
  const symbolId = symbol.id;

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
    symbol: shownSymbol(symbol),
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
  assertOffsetInRange(offset, sequence.length, "relations");
  const pageSize = Math.max(0, sequence.length - offset);
  const page = (count: number): QueryCallGraphResult => {
    const end = offset + count;
    const slice = sequence.slice(offset, end);
    return {
      ...result,
      callers: slice.filter((item) => item.direction === "callers").map((item) => shownRelation(item.relation)),
      callees: slice.filter((item) => item.direction === "callees").map((item) => shownRelation(item.relation)),
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
    sourceLine: (r[4] as number) + 1,
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
