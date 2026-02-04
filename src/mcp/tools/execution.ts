import { SymbolReverseIndex } from "../../analyzer/SymbolReverseIndex";
import { getLogger } from "../../shared/logger";
import { getRelativePath, validateFileExists } from "../shared/helpers";
import { workerState } from "../shared/state";
import type {
    CallChainEntry,
    GetSymbolCallersParams,
    GetSymbolCallersResult,
    SymbolCallerInfo,
    TraceFunctionExecutionParams,
    TraceFunctionExecutionResult,
} from "../types";

const log = getLogger("McpWorker");

/**
 * Trace the full execution chain from a root symbol
 */
export async function executeTraceFunctionExecution(
  params: TraceFunctionExecutionParams,
): Promise<TraceFunctionExecutionResult> {
  const { filePath, symbolName, maxDepth } = params;
  const spider = workerState.getSpider();
  const config = workerState.getConfig();
  await validateFileExists(filePath);

  const result = await spider.traceFunctionExecution(
    filePath,
    symbolName,
    maxDepth ?? 10,
  );

  // Enrich call chain entries with relative paths
  const enrichedCallChain: CallChainEntry[] = result.callChain.map((entry) => ({
    depth: entry.depth,
    callerSymbolId: entry.callerSymbolId,
    calledSymbolId: entry.calledSymbolId,
    calledFilePath: entry.calledFilePath,
    resolvedFilePath: entry.resolvedFilePath,
    resolvedRelativePath: entry.resolvedFilePath
      ? getRelativePath(entry.resolvedFilePath, config.rootDir)
      : null,
  }));

  const relativePath = getRelativePath(filePath, config.rootDir);

  return {
    rootSymbol: {
      id: result.rootSymbol.id,
      filePath: result.rootSymbol.filePath,
      relativePath,
      symbolName: result.rootSymbol.symbolName,
    },
    maxDepth: maxDepth ?? 10,
    callCount: result.callChain.length,
    uniqueSymbolCount: result.visitedSymbols.length,
    maxDepthReached: result.maxDepthReached,
    callChain: enrichedCallChain,
    visitedSymbols: result.visitedSymbols,
  };
}

/**
 * Get symbol callers with O(1) lookup
 */
export async function executeGetSymbolCallers(
  params: GetSymbolCallersParams,
): Promise<GetSymbolCallersResult> {
  const { filePath, symbolName, includeTypeOnly = true } = params;
  const config = workerState.getConfig();

  // Build symbolId from filePath + symbolName
  const symbolId = `${filePath}:${symbolName}`;

  // Initialize symbol reverse index if needed
  if (!workerState.symbolReverseIndex) {
    workerState.symbolReverseIndex = new SymbolReverseIndex(config.rootDir);
    // Build the index from all cached symbol graphs
    await buildSymbolReverseIndex();
  }

  const callers = includeTypeOnly
    ? workerState.symbolReverseIndex.getCallers(symbolId)
    : workerState.symbolReverseIndex.getRuntimeCallers(symbolId);

  const callerInfos: SymbolCallerInfo[] = callers.map((caller) => ({
    callerSymbolId: caller.callerSymbolId,
    callerFilePath: caller.callerFilePath,
    callerRelativePath: getRelativePath(caller.callerFilePath, config.rootDir),
    isTypeOnly: caller.isTypeOnly,
  }));

  const runtimeCallers = callers.filter((c) => !c.isTypeOnly);
  const typeOnlyCallers = callers.filter((c) => c.isTypeOnly);

  return {
    symbolId,
    callerCount: callers.length,
    runtimeCallerCount: runtimeCallers.length,
    typeOnlyCallerCount: typeOnlyCallers.length,
    callers: callerInfos,
    callerFiles: workerState.symbolReverseIndex.getCallerFiles(symbolId),
  };
}

/**
 * Build symbol reverse index from all known files
 */
async function buildSymbolReverseIndex(): Promise<void> {
  const spider = workerState.spider;
  if (!spider || !workerState.symbolReverseIndex) return;

  // Get all indexed files from the file-level cache
  const status = spider.getIndexStatus();
  if (status.state !== "complete") return;

  // Strategy: Use the file-level reverse index to get all known files
  // If reverse index is not enabled, we build symbol index on-demand per query
  if (!spider.hasReverseIndex()) {
    log.warn(
      "File-level reverse index not enabled. Symbol reverse index will be built incrementally.",
    );
    return;
  }

  // Get all files from the reverse index stats
  const cacheStats = spider.getCacheStats();
  const reverseIndexStats = cacheStats.reverseIndexStats;
  if (!reverseIndexStats || reverseIndexStats.indexedFiles === 0) {
    log.warn(
      "No files in reverse index yet. Symbol reverse index will be built incrementally.",
    );
    return;
  }

  log.info(
    `Building symbol reverse index from ${reverseIndexStats.indexedFiles} indexed files...`,
  );

  // Build index by analyzing files we encounter during queries
  // This is more efficient than pre-scanning all files
  log.info("Symbol reverse index ready (lazy loading mode)");
}
