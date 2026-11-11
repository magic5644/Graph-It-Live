import { getRelativePath } from "../shared/helpers";
import { confidenceHint, filterByConfidence } from "../../analyzer/deadcode/DeadCodeScanner";
import { validateFileExists } from "../../shared/pathSecurity";
import { workerState } from "../shared/state";
import type {
    FindUnusedSymbolsParams,
    FindUnusedSymbolsResult,
    GetSymbolGraphParams,
    GetSymbolGraphResult,
    SymbolDependencyEdge,
} from "../types";

/**
 * Get symbol graph for a file
 */
export async function executeGetSymbolGraph(
  params: GetSymbolGraphParams,
): Promise<GetSymbolGraphResult> {
  const { filePath } = params;
  const spider = workerState.getSpider();
  const config = workerState.getConfig();
  await validateFileExists(filePath);

  const { symbols, dependencies } = await spider.getSymbolGraph(filePath);

  // Enrich dependencies with relative paths
  const enrichedDependencies: SymbolDependencyEdge[] = dependencies.map(
    (dep) => ({
      sourceSymbolId: dep.sourceSymbolId,
      targetSymbolId: dep.targetSymbolId,
      targetFilePath: dep.targetFilePath,
      targetRelativePath: getRelativePath(dep.targetFilePath, config.rootDir),
      ...(dep.line !== undefined && { line: dep.line }),
      ...(dep.relation && { relation: dep.relation }),
    }),
  );

  const relativePath = getRelativePath(filePath, config.rootDir);

  return {
    filePath,
    relativePath,
    symbolCount: symbols.length,
    dependencyCount: dependencies.length,
    symbols,
    dependencies: enrichedDependencies,
    isSymbolView: true,
  };
}

/**
 * Find unused exported symbols in a file
 */
export async function executeFindUnusedSymbols(
  params: FindUnusedSymbolsParams,
): Promise<FindUnusedSymbolsResult> {
  const { filePath } = params;
  const spider = workerState.getSpider();
  const config = workerState.getConfig();
  await validateFileExists(filePath);

  const minConfidence = params.minConfidence ?? "high";
  const { listed: unusedSymbols, byConfidence } = filterByConfidence(await spider.findUnusedSymbols(filePath), minConfidence);
  const hint = confidenceHint(byConfidence, minConfidence);

  // Get all exported symbols to calculate percentage
  const { symbols } = await spider.getSymbolGraph(filePath);
  const exportedSymbols = symbols.filter((s) => s.isExported);

  const unusedCount = unusedSymbols.length;
  const totalExportedSymbols = exportedSymbols.length;
  // Share of every unused export found, listed or not.
  const found = byConfidence.high + byConfidence.medium + byConfidence.low;
  const unusedPercentage =
    totalExportedSymbols > 0
      ? Math.round((found / totalExportedSymbols) * 100)
      : 0;

  const relativePath = getRelativePath(filePath, config.rootDir);

  return {
    filePath,
    relativePath,
    unusedCount,
    unusedSymbols,
    minConfidence,
    byConfidence,
    ...(hint ? { hint } : {}),
    totalExportedSymbols,
    unusedPercentage,
  };
}

