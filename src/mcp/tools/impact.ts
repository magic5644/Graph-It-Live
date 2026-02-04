import * as fs from "node:fs/promises";
import type { SymbolDependency } from "../../analyzer/types";
import { getRelativePath, validateFileExists } from "../shared/helpers";
import { workerState } from "../shared/state";
import type {
    AnalyzeBreakingChangesParams,
    AnalyzeBreakingChangesResult,
    BreakingChangeInfo,
    GetImpactAnalysisParams,
    GetImpactAnalysisResult,
    ImpactedItem,
} from "../types";

/**
 * Analyze breaking changes between old and new file versions
 */
export async function executeAnalyzeBreakingChanges(
  params: AnalyzeBreakingChangesParams,
): Promise<AnalyzeBreakingChangesResult> {
  const { filePath, symbolName, oldContent } = params;

  // If newContent not provided, read current file
  let newContent = params.newContent;
  if (!newContent) {
    try {
      newContent = await fs.readFile(filePath, "utf-8");
    } catch {
      throw new Error(`Cannot read current file: ${filePath}`);
    }
  }

  const astWorkerHost = workerState.getAstWorkerHost();

  let results: import("../../analyzer/SignatureAnalyzer").SignatureComparisonResult[];
  try {
    results = await astWorkerHost.analyzeBreakingChanges(
      filePath,
      oldContent,
      newContent,
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Failed to analyze breaking changes: ${errorMsg}`);
  }

  // Filter by symbolName if provided
  if (symbolName) {
    results = results.filter((r) => r.symbolName === symbolName);
  }

  // Aggregate all breaking changes
  const breakingChanges: BreakingChangeInfo[] = [];
  const nonBreakingChanges: string[] = [];
  const removedSymbols: string[] = [];
  const addedSymbols: string[] = [];

  for (const result of results) {
    for (const change of result.breakingChanges) {
      breakingChanges.push({
        type: change.type,
        symbolName: change.symbolName,
        description: change.description,
        severity: change.severity,
        oldValue: change.oldValue,
        newValue: change.newValue,
        line: change.line,
      });

      if (change.type === "member-removed") {
        removedSymbols.push(change.symbolName);
      }
    }
    nonBreakingChanges.push(...result.nonBreakingChanges);
  }

  // Count by severity
  const errorCount = breakingChanges.filter(
    (c) => c.severity === "error",
  ).length;
  const warningCount = breakingChanges.filter(
    (c) => c.severity === "warning",
  ).length;

  return {
    filePath,
    breakingChangeCount: breakingChanges.length,
    errorCount,
    warningCount,
    breakingChanges,
    nonBreakingChanges,
    removedSymbols,
    addedSymbols,
  };
}

/**
 * Create an impacted item from a symbol dependency
 */
function createImpactedItem(
  dep: SymbolDependency,
  depth: number,
  rootDir: string,
): ImpactedItem {
  return {
    symbolId: dep.sourceSymbolId,
    filePath: dep.targetFilePath,
    relativePath: getRelativePath(dep.targetFilePath, rootDir),
    usageType: dep.isTypeOnly ? "type-only" : "runtime",
    depth,
  };
}

/**
 * Determine impact level based on metrics
 */
function determineImpactLevel(
  runtimeCount: number,
  totalCount: number,
): "high" | "medium" | "low" {
  if (runtimeCount >= 10 || totalCount >= 20) return "high";
  if (runtimeCount >= 3 || totalCount >= 5) return "medium";
  return "low";
}

/**
 * Calculate impact metrics from items
 */
function calculateImpactMetrics(items: ImpactedItem[]): {
  directCount: number;
  transitiveCount: number;
  runtimeCount: number;
  typeOnlyCount: number;
} {
  return {
    directCount: items.filter((i) => i.depth === 1).length,
    transitiveCount: items.filter((i) => i.depth > 1).length,
    runtimeCount: items.filter((i) => i.usageType === "runtime").length,
    typeOnlyCount: items.filter((i) => i.usageType === "type-only").length,
  };
}

/**
 * Parse symbolId into file path and symbol name
 */
function parseSymbolId(
  symbolId: string,
): { filePath: string; symbolName: string } | null {
  const parts = symbolId.split(":");
  if (parts.length < 2) return null;

  const symbolName = parts.at(-1);
  if (!symbolName) return null;

  return {
    filePath: parts.slice(0, -1).join(":"),
    symbolName,
  };
}

/**
 * Context for processing transitive dependents
 */
interface TransitiveContext {
  maxDepth: number;
  rootDir: string;
  visitedSymbols: Set<string>;
  affectedFilesSet: Set<string>;
  impactedItems: ImpactedItem[];
  queue: { symbolId: string; depth: number }[];
}

/**
 * Process a single transitive dependent and add to the queue
 */
function processTransitiveDependent(
  dep: SymbolDependency,
  depth: number,
  ctx: TransitiveContext,
): void {
  if (ctx.visitedSymbols.has(dep.sourceSymbolId)) return;

  ctx.impactedItems.push(createImpactedItem(dep, depth, ctx.rootDir));
  ctx.visitedSymbols.add(dep.sourceSymbolId);
  ctx.affectedFilesSet.add(dep.targetFilePath);

  if (depth < ctx.maxDepth) {
    ctx.queue.push({ symbolId: dep.sourceSymbolId, depth: depth + 1 });
  }
}

/**
 * Process transitive dependents
 */
async function processTransitiveDependents(
  directDependents: SymbolDependency[],
  maxDepth: number,
  rootDir: string,
  visitedSymbols: Set<string>,
  affectedFilesSet: Set<string>,
  impactedItems: ImpactedItem[],
): Promise<void> {
  const spider = workerState.getSpider();
  const queue = directDependents.map((d) => ({
    symbolId: d.sourceSymbolId,
    depth: 2,
  }));
  const ctx: TransitiveContext = {
    maxDepth,
    rootDir,
    visitedSymbols,
    affectedFilesSet,
    impactedItems,
    queue,
  };

  while (ctx.queue.length > 0) {
    const current = ctx.queue.shift()!;
    if (current.depth > maxDepth) continue;

    const parsed = parseSymbolId(current.symbolId);
    if (!parsed) continue;

    try {
      const transitiveDeps = await spider.getSymbolDependents(
        parsed.filePath,
        parsed.symbolName,
      );

      for (const dep of transitiveDeps) {
        processTransitiveDependent(dep, current.depth, ctx);
      }
    } catch {
      // Skip symbols that fail to analyze
    }
  }
}

/**
 * Generate human-readable impact summary
 */
function generateImpactSummary(
  symbolName: string,
  totalCount: number,
  runtimeCount: number,
  typeOnlyCount: number,
  fileCount: number,
  level: "high" | "medium" | "low",
): string {
  if (totalCount === 0) {
    return `Symbol '${symbolName}' has no known dependents. Changes should be safe.`;
  }

  let levelEmoji: string;
  if (level === "high") {
    levelEmoji = "🔴";
  } else if (level === "medium") {
    levelEmoji = "🟡";
  } else {
    levelEmoji = "🟢";
  }

  let summary = `${levelEmoji} Impact Level: ${level.toUpperCase()}\n\n`;
  summary += `Modifying '${symbolName}' will affect:\n`;
  summary += `- ${totalCount} symbol(s) across ${fileCount} file(s)\n`;

  if (runtimeCount > 0) {
    summary += `- ${runtimeCount} runtime usage(s) - tests should be run\n`;
  }
  if (typeOnlyCount > 0) {
    summary += `- ${typeOnlyCount} type-only usage(s) - only type checking affected\n`;
  }

  if (level === "high") {
    summary += `\n⚠️ High impact: Consider running full test suite and reviewing all affected files.`;
  }

  return summary;
}

/**
 * Get comprehensive impact analysis for a symbol modification
 */
export async function executeGetImpactAnalysis(
  params: GetImpactAnalysisParams,
): Promise<GetImpactAnalysisResult> {
  const {
    filePath,
    symbolName,
    includeTransitive = false,
    maxDepth = 3,
  } = params;
  const spider = workerState.getSpider();
  const config = workerState.getConfig();
  await validateFileExists(filePath);

  const symbolId = `${filePath}:${symbolName}`;
  const impactedItems: ImpactedItem[] = [];
  const visitedSymbols = new Set<string>();
  const affectedFilesSet = new Set<string>();

  // Get direct dependents
  const directDependents = await spider.getSymbolDependents(
    filePath,
    symbolName,
  );

  for (const dep of directDependents) {
    impactedItems.push(createImpactedItem(dep, 1, config.rootDir));
    visitedSymbols.add(dep.sourceSymbolId);
    affectedFilesSet.add(dep.targetFilePath);
  }

  // Get transitive dependents if requested
  if (includeTransitive && maxDepth > 1) {
    await processTransitiveDependents(
      directDependents,
      maxDepth,
      config.rootDir,
      visitedSymbols,
      affectedFilesSet,
      impactedItems,
    );
  }

  // Calculate metrics
  const metrics = calculateImpactMetrics(impactedItems);
  const impactLevel = determineImpactLevel(
    metrics.runtimeCount,
    impactedItems.length,
  );

  // Generate summary
  const summary = generateImpactSummary(
    symbolName,
    impactedItems.length,
    metrics.runtimeCount,
    metrics.typeOnlyCount,
    affectedFilesSet.size,
    impactLevel,
  );

  return {
    targetSymbol: {
      id: symbolId,
      filePath,
      relativePath: getRelativePath(filePath, config.rootDir),
      symbolName,
    },
    impactLevel,
    totalImpactCount: impactedItems.length,
    directImpactCount: metrics.directCount,
    transitiveImpactCount: metrics.transitiveCount,
    runtimeImpactCount: metrics.runtimeCount,
    typeOnlyImpactCount: metrics.typeOnlyCount,
    impactedItems,
    affectedFiles: Array.from(affectedFilesSet),
    summary,
  };
}
