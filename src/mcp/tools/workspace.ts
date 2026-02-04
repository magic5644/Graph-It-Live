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
    reverseIndexEnabled: spider.hasReverseIndex(),
    cacheSize: cacheStats.dependencyCache.size,
    reverseIndexStats: cacheStats.reverseIndexStats,
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

  for (const filePath of filePaths) {
    const wasInvalidated = spider.invalidateFile(filePath);
    if (wasInvalidated) {
      invalidatedFiles.push(filePath);
    } else {
      notFoundFiles.push(filePath);
    }
  }

  return {
    invalidatedCount: invalidatedFiles.length,
    invalidatedFiles,
    notFoundFiles,
    reverseIndexUpdated: spider.hasReverseIndex(),
  };
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
  await spider.buildFullIndex((processed, total, currentFile) => {
    postMessage({
      type: "warmup-progress",
      processed,
      total,
      currentFile,
    });
  });

  const rebuildTimeMs = Date.now() - startTime;
  const cacheStats = await spider.getCacheStatsAsync();

  return {
    reindexedCount: cacheStats.dependencyCache.size,
    rebuildTimeMs,
    newCacheSize: cacheStats.dependencyCache.size,
    reverseIndexStats: cacheStats.reverseIndexStats ?? {
      indexedFiles: 0,
      targetFiles: 0,
      totalReferences: 0,
    },
  };
}
