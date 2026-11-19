import * as fs from "node:fs";
import * as path from "node:path";
import { IndexCache } from "../../analyzer/cache/IndexCache";
import { closestPathsHint } from "../../analyzer/utils/SymbolLookup";
import { normalizePath } from "../../shared/path";
import { reportOutOfRootImports } from "../../analyzer/utils/workspaceBoundary";
import { unresolvedImportsField } from "../../analyzer/utils/unresolvedImports";
import { workerState } from "../shared/state";
import type {
    GetIndexStatusResult,
    InvalidateFilesParams,
    InvalidateFilesResult,
    McpWorkerResponse,
    RebuildIndexResult,
} from "../types";

/**
 * Get current index status and statistics
 */
export async function executeGetIndexStatus(): Promise<GetIndexStatusResult> {
  const spider = workerState.getSpider();
  const indexStatus = spider.getIndexStatus();
  const cacheStats = await spider.getCacheStatsAsync();

  // Map 'validating' state to 'indexing' for MCP response
  const state =
    indexStatus.state === "validating" ? "indexing" : indexStatus.state;

  return {
    state,
    isReady: workerState.isReady,
    reverseIndexEnabled: spider.isReverseIndexEnabled(),
    cacheSize: cacheStats.dependencyCache.size,
    reverseIndexStats: cacheStats.reverseIndexStats,
    ...reportOutOfRootImports(spider.getOutOfRootImports(), spider.workspaceRoot),
    ...unresolvedImportsField(await spider.getUnresolvedImports(), spider.workspaceRoot),
    progress:
      indexStatus.state === "indexing"
        ? {
            processed: indexStatus.processed,
            total: indexStatus.total,
            percentage: indexStatus.percentage,
            currentFile: indexStatus.currentFile,
          }
        : undefined,
    warmup: workerState.warmupInfo,
    // Distinct from reverseIndexStats: the call graph only covers languages that
    // have a Tree-sitter query, so its file count is legitimately lower.
    callGraph: workerState.callGraphIndexer
      ? (() => {
          const counts = workerState.callGraphIndexer.getCounts();
          return {
            indexedFiles: counts.files,
            symbols: counts.symbols,
            relations: counts.relations,
          };
        })()
      : undefined,
    cacheFiles: workerState.indexCache ? IndexCache.fileSizes(workerState.indexCache.dir) : undefined,
  };
}

/**
 * Invalidate specific files from the cache
 */
export function executeInvalidateFiles(
  params: InvalidateFilesParams,
): InvalidateFilesResult {
  const spider = workerState.getSpider();
  const { filePaths } = params;
  const invalidatedFiles: string[] = [];
  const notFoundFiles: string[] = [];

  // The call graph has its own database: re-extract these files before the next graph query.
  workerState.markCallGraphStale(filePaths);

  for (const filePath of filePaths) {
    // A file on disk that was not cached yet is still re-read; only a path nothing knows is "not found".
    const wasInvalidated = spider.invalidateFile(filePath);
    if (wasInvalidated || fs.existsSync(filePath)) {
      invalidatedFiles.push(filePath);
    } else {
      notFoundFiles.push(filePath);
    }
  }
  if (invalidatedFiles.length === 0 && notFoundFiles.length > 0) {
    const rootDir = workerState.getConfig().rootDir;
    const [first] = notFoundFiles;
    const label = normalizePath(path.relative(rootDir, first));
    const others = notFoundFiles.length > 1 ? ` (and ${notFoundFiles.length - 1} more)` : "";
    throw new Error(`File not found: ${label}${others}: neither on disk nor in the index.${closestPathsHint(first, rootDir)}`);
  }

  return {
    invalidatedCount: invalidatedFiles.length,
    invalidatedFiles,
    notFoundFiles,
    reverseIndexUpdated: spider.isReverseIndexEnabled(),
  };
}

/**
 * Rebuild the call graph from scratch. A workspace without call graph support
 * (no WASM parsers, no supported file) keeps the dependency rebuild usable:
 * the failure is reported instead of thrown.
 */
async function rebuildCallGraph(): Promise<RebuildIndexResult["callGraph"]> {
  const { ensureCallGraphReady } = await import("./callgraph.js");
  try {
    await ensureCallGraphReady();
  } catch (error) {
    return { rebuilt: false, error: error instanceof Error ? error.message : String(error) };
  }
  const counts = workerState.callGraphIndexer?.getCounts();
  return counts
    ? { rebuilt: true, indexedFiles: counts.files, symbols: counts.symbols, relations: counts.relations }
    : { rebuilt: false, error: "Call graph indexer not initialized" };
}

/**
 * Rebuild the entire index from scratch
 */
export async function executeRebuildIndex(
  postMessage: (msg: McpWorkerResponse) => void,
): Promise<RebuildIndexResult> {
  const spider = workerState.getSpider();
  const startTime = Date.now();

  // Clear all cached data
  spider.clearCache();

  // Re-index by building full index again
  // This will scan the workspace and rebuild the reverse index
  const { indexedFiles } = await spider.buildFullIndex((processed, total, currentFile) => {
    postMessage({
      type: "warmup-progress",
      processed,
      total,
      currentFile,
    });
  });

  // Rebuild the call graph too, ignoring its cache, so graph queries match the new index.
  workerState.markCallGraphStale();
  const callGraph = await rebuildCallGraph();

  const rebuildTimeMs = Date.now() - startTime;
  const cacheStats = await spider.getCacheStatsAsync();

  return {
    callGraph,
    // The analysis cache is capped on large workspaces: count the indexed files.
    reindexedCount: indexedFiles,
    rebuildTimeMs,
    newCacheSize: cacheStats.dependencyCache.size,
    reverseIndexStats: cacheStats.reverseIndexStats ?? {
      indexedFiles: 0,
      targetFiles: 0,
      totalReferences: 0,
    },
  };
}
