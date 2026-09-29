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
import { executeQueryCallGraph } from "./callgraph";

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
 * Get the call sites of a symbol from the SQLite call graph (one hop).
 * CALLS edges are runtime callers; USES edges (type references) are added only on request.
 */
export async function executeGetSymbolCallers(
  params: GetSymbolCallersParams,
): Promise<GetSymbolCallersResult> {
  const { filePath, symbolName, includeTypeOnly = false } = params;
  const config = workerState.getConfig();
  const symbolId = `${filePath}:${symbolName}`;

  const { callers: edges } = await executeQueryCallGraph({
    filePath,
    symbolName,
    direction: "callers",
    depth: 1,
    relationTypes: includeTypeOnly ? ["CALLS", "USES"] : ["CALLS"],
  });

  // One entry per caller symbol: its first call site, runtime if any edge is a CALLS.
  const byCaller = new Map<string, SymbolCallerInfo>();
  for (const edge of edges) {
    const callerSymbolId = `${edge.sourceFile}:${edge.sourceName}`;
    const isTypeOnly = edge.relation === "USES";
    const existing = byCaller.get(callerSymbolId);
    if (!existing) {
      byCaller.set(callerSymbolId, {
        callerSymbolId,
        callerFilePath: edge.sourceFile,
        callerRelativePath: getRelativePath(edge.sourceFile, config.rootDir),
        line: edge.sourceLine,
        isTypeOnly,
      });
    } else if (existing.isTypeOnly && !isTypeOnly) {
      byCaller.set(callerSymbolId, { ...existing, line: edge.sourceLine, isTypeOnly: false });
    }
  }

  const callers = [...byCaller.values()];
  const typeOnlyCallerCount = callers.filter((c) => c.isTypeOnly).length;

  return {
    symbolId,
    callerCount: callers.length,
    runtimeCallerCount: callers.length - typeOnlyCallerCount,
    typeOnlyCallerCount,
    callers,
    callerFiles: [...new Set(callers.map((c) => c.callerFilePath))],
  };
}
