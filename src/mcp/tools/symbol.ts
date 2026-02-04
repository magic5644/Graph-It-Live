import { getRelativePath, validateFileExists } from "../shared/helpers";
import { workerState } from "../shared/state";
import type {
    FindUnusedSymbolsParams,
    FindUnusedSymbolsResult,
    GetSymbolDependentsParams,
    GetSymbolDependentsResult,
    GetSymbolGraphParams,
    GetSymbolGraphResult,
    SymbolDependencyEdge,
    SymbolInfo,
} from "../types";

/**
 * Categorize a symbol by its kind
 */
function categorizeSymbolKind(
  kind: string,
): "function" | "class" | "variable" | "interface" | "type" | "other" {
  if (kind.includes("Function")) return "function";
  if (kind.includes("Class")) return "class";
  if (
    kind.includes("Variable") ||
    kind.includes("Const") ||
    kind.includes("Let")
  )
    return "variable";
  if (kind.includes("Interface")) return "interface";
  if (kind.includes("Type")) return "type";
  return "other";
}

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
    }),
  );

  // Categorize symbols
  const categorizedSymbols: SymbolInfo[] = symbols.map((symbol) => ({
    ...symbol,
    category: categorizeSymbolKind(symbol.kind),
  }));

  const relativePath = getRelativePath(filePath, config.rootDir);

  return {
    filePath,
    relativePath,
    symbolCount: symbols.length,
    dependencyCount: dependencies.length,
    symbols: categorizedSymbols,
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

  const unusedSymbols = await spider.findUnusedSymbols(filePath);

  // Get all exported symbols to calculate percentage
  const { symbols } = await spider.getSymbolGraph(filePath);
  const exportedSymbols = symbols.filter((s) => s.isExported);

  // Categorize unused symbols
  const categorizedUnusedSymbols: SymbolInfo[] = unusedSymbols.map(
    (symbol) => ({
      ...symbol,
      category: categorizeSymbolKind(symbol.kind),
    }),
  );

  const unusedCount = unusedSymbols.length;
  const totalExportedSymbols = exportedSymbols.length;
  const unusedPercentage =
    totalExportedSymbols > 0
      ? Math.round((unusedCount / totalExportedSymbols) * 100)
      : 0;

  const relativePath = getRelativePath(filePath, config.rootDir);

  return {
    filePath,
    relativePath,
    unusedCount,
    unusedSymbols: categorizedUnusedSymbols,
    totalExportedSymbols,
    unusedPercentage,
  };
}

/**
 * Get dependents of a specific symbol
 */
export async function executeGetSymbolDependents(
  params: GetSymbolDependentsParams,
): Promise<GetSymbolDependentsResult> {
  const { filePath, symbolName } = params;
  const spider = workerState.getSpider();
  const config = workerState.getConfig();
  await validateFileExists(filePath);

  const dependents = await spider.getSymbolDependents(filePath, symbolName);

  // Enrich dependents with relative paths
  const enrichedDependents: SymbolDependencyEdge[] = dependents.map((dep) => ({
    sourceSymbolId: dep.sourceSymbolId,
    targetSymbolId: dep.targetSymbolId,
    targetFilePath: dep.targetFilePath,
    targetRelativePath: getRelativePath(dep.targetFilePath, config.rootDir),
  }));

  return {
    filePath,
    symbolName,
    dependentCount: dependents.length,
    dependents: enrichedDependents,
  };
}
