import type { Spider } from "../Spider";
import type { SymbolInfo } from "../types";
import { getRelativePath } from "../../shared/path";
import { validateWorkspacePath } from "../../shared/pathSecurity";

export interface DeadCodeScanOptions {
  scopePath?: string;
  maxFiles?: number;
}

export interface DeadCodeScanEntry {
  filePath: string;
  relativePath: string;
  unusedCount: number;
  unusedSymbols: SymbolInfo[];
}

export interface DeadCodeScanResult {
  rootDir: string;
  scopePath: string;
  scannedFiles: number;
  filesWithDeadCode: number;
  totalUnusedSymbols: number;
  entries: DeadCodeScanEntry[];
  skippedFiles: number;
  analysisTimeMs: number;
}

function categorizeSymbolKind(
  kind: string,
): "function" | "class" | "variable" | "interface" | "type" | "other" {
  if (kind.includes("Function")) return "function";
  if (kind.includes("Class")) return "class";
  if (kind.includes("Variable") || kind.includes("Const") || kind.includes("Let")) {
    return "variable";
  }
  if (kind.includes("Interface")) return "interface";
  if (kind.includes("Type")) return "type";
  return "other";
}

export async function scanDeadCode(
  spider: Spider,
  rootDir: string,
  options: DeadCodeScanOptions,
): Promise<DeadCodeScanResult> {
  const scopePath = options.scopePath ?? rootDir;
  validateWorkspacePath(scopePath, rootDir);
  const startTime = Date.now();
  const rawResult = await spider.scanDeadCode(scopePath, { maxFiles: options.maxFiles });
  const entries = rawResult.entries.map((entry) => {
    const unusedSymbols = entry.unusedSymbols.map((symbol) => ({
      ...symbol,
      category: categorizeSymbolKind(symbol.kind),
    }));
    return {
      filePath: entry.filePath,
      relativePath: getRelativePath(entry.filePath, rootDir),
      unusedCount: unusedSymbols.length,
      unusedSymbols,
    };
  });

  return {
    rootDir,
    scopePath,
    scannedFiles: rawResult.scannedFiles,
    filesWithDeadCode: entries.length,
    totalUnusedSymbols: entries.reduce((sum, entry) => sum + entry.unusedCount, 0),
    entries,
    skippedFiles: rawResult.skippedFiles,
    analysisTimeMs: Date.now() - startTime,
  };
}
