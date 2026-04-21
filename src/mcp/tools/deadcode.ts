import { getRelativePath, validateScopePath } from "../shared/helpers";
import { workerState } from "../shared/state";
import type {
    DeadCodeFileEntry,
    ScanDeadCodeParams,
    ScanDeadCodeResult,
    SymbolInfo,
} from "../types";

/**
 * Categorize a symbol by its kind (mirrors symbol.ts helper)
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
 * Scan the workspace (or a scoped directory) for unused exported symbols.
 *
 * Security: scopePath is validated against the workspace root to prevent
 * path traversal.
 * Guard: requires the reverse index to be ready — never silent O(n²) fallback.
 */
export async function executeScanDeadCode(
  params: ScanDeadCodeParams,
): Promise<ScanDeadCodeResult> {
  const spider = workerState.getSpider();
  const config = workerState.getConfig();
  const { scopePath, maxFiles } = params;

  const resolvedScopePath = scopePath ?? config.rootDir;

  // Path traversal prevention
  validateScopePath(resolvedScopePath, config.rootDir);

  const startTime = Date.now();

  const rawResult = await spider.scanDeadCode(resolvedScopePath, { maxFiles });

  const analysisTimeMs = Date.now() - startTime;

  // Enrich entries
  const entries: DeadCodeFileEntry[] = rawResult.entries.map((entry) => {
    const categorizedSymbols: SymbolInfo[] = entry.unusedSymbols.map((s) => ({
      ...s,
      category: categorizeSymbolKind(s.kind),
    }));
    return {
      filePath: entry.filePath,
      relativePath: getRelativePath(entry.filePath, config.rootDir),
      unusedCount: categorizedSymbols.length,
      unusedSymbols: categorizedSymbols,
    };
  });

  return {
    rootDir: config.rootDir,
    scopePath: resolvedScopePath,
    scannedFiles: rawResult.scannedFiles,
    filesWithDeadCode: entries.length,
    totalUnusedSymbols: entries.reduce((sum, e) => sum + e.unusedCount, 0),
    entries,
    skippedFiles: rawResult.skippedFiles,
    analysisTimeMs,
  };
}
