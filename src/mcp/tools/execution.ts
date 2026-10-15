import { getRelativePath, validateFileExists } from "../shared/helpers";
import { workerState } from "../shared/state";
import type {
    CallChainEntry,
    TraceFunctionExecutionParams,
    TraceFunctionExecutionResult,
} from "../types";

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

