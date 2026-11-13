import type { Spider } from "../Spider";
import { getRelativePath } from "../../shared/path";
import { validateWorkspacePath } from "../../shared/pathSecurity";
import { countByConfidence, meetsConfidence, type DeadCodeConfidence, type ExcludedExport, type UnreferencedFile, type UnusedSymbol } from "./deadCodeConfidence";

export interface DeadCodeScanOptions {
  scopePath?: string;
  maxFiles?: number;
  /** Lowest confidence listed (default `high`); the others are only counted in `byConfidence`. */
  minConfidence?: DeadCodeConfidence;
  /** Also return `excluded`: the unused exports left out, and why */
  verbose?: boolean;
  /** Called after each scanned file with the files done and the total. */
  onProgress?: (done: number, total: number) => void;
}

export interface DeadCodeScanEntry {
  filePath: string;
  relativePath: string;
  unusedCount: number;
  unusedSymbols: UnusedSymbol[];
}

export interface DeadCodeScanResult {
  rootDir: string;
  scopePath: string;
  scannedFiles: number;
  /** Files listed: with at least one unused export at minConfidence or above */
  filesWithDeadCode: number;
  /** Unused exports listed */
  totalUnusedSymbols: number;
  minConfidence: DeadCodeConfidence;
  /** Every unused export found, listed or not, per confidence */
  byConfidence: Record<DeadCodeConfidence, number>;
  /** How to list the items below minConfidence, when there are some */
  hint?: string;
  entries: DeadCodeScanEntry[];
  /** verbose only: unused exports left out, and why */
  excluded?: Array<Omit<ExcludedExport, "filePath"> & { relativePath: string }>;
  skippedFiles: number;
  /** True when maxFiles stopped the scan: unscanned files may hold dead code too. */
  truncated: boolean;
  /** Analysable files left out by maxFiles */
  filesBeyondLimit: number;
  analysisTimeMs: number;
}

/** The items at `minConfidence` or above, and every item counted per confidence. */
export function filterByConfidence(
  items: readonly UnusedSymbol[],
  minConfidence: DeadCodeConfidence,
): { listed: UnusedSymbol[]; byConfidence: Record<DeadCodeConfidence, number> } {
  return { listed: items.filter((item) => meetsConfidence(item.confidence, minConfidence)), byConfidence: countByConfidence(items) };
}

/** A pointer to the unlisted items, or undefined when every item is listed. */
export function confidenceHint(byConfidence: Record<DeadCodeConfidence, number>, minConfidence: DeadCodeConfidence): string | undefined {
  const hidden = (["medium", "low"] as const).filter((level) => !meetsConfidence(level, minConfidence) && byConfidence[level] > 0);
  if (hidden.length === 0) return undefined;
  const counts = hidden.map((level) => `${byConfidence[level]} ${level}`).join(", ");
  return `${counts}-confidence item(s) not listed: pass minConfidence ${hidden.at(-1)} to list them.`;
}

export async function scanDeadCode(
  spider: Spider,
  rootDir: string,
  options: DeadCodeScanOptions,
  signal?: AbortSignal,
): Promise<DeadCodeScanResult> {
  const scopePath = validateWorkspacePath(options.scopePath ?? rootDir, rootDir);
  const minConfidence = options.minConfidence ?? "high";
  const startTime = Date.now();
  const rawResult = await spider.scanDeadCode(scopePath, { maxFiles: options.maxFiles, signal, onProgress: options.onProgress });
  const byConfidence = countByConfidence(rawResult.entries.flatMap((entry) => entry.unusedSymbols));
  const entries = rawResult.entries.flatMap((entry) => {
    const { listed } = filterByConfidence(entry.unusedSymbols, minConfidence);
    if (listed.length === 0) return [];
    return [{
      filePath: entry.filePath,
      relativePath: getRelativePath(entry.filePath, rootDir),
      unusedCount: listed.length,
      unusedSymbols: listed,
    }];
  });
  const hint = confidenceHint(byConfidence, minConfidence);

  return {
    rootDir,
    scopePath,
    scannedFiles: rawResult.scannedFiles,
    filesWithDeadCode: entries.length,
    totalUnusedSymbols: entries.reduce((sum, entry) => sum + entry.unusedCount, 0),
    minConfidence,
    byConfidence,
    ...(hint ? { hint } : {}),
    entries,
    ...(options.verbose ? { excluded: excludedItems(rawResult.excluded, rootDir) } : {}),
    skippedFiles: rawResult.skippedFiles,
    truncated: rawResult.filesBeyondLimit > 0,
    filesBeyondLimit: rawResult.filesBeyondLimit,
    analysisTimeMs: Date.now() - startTime,
  };
}

/** Workspace-relative, sorted by file then line. */
function excludedItems(excluded: readonly ExcludedExport[], rootDir: string): NonNullable<DeadCodeScanResult["excluded"]> {
  return excluded
    .map(({ filePath, ...item }) => ({ relativePath: getRelativePath(filePath, rootDir), ...item }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.line - b.line);
}

export interface UnreferencedFilesScanResult {
  rootDir: string;
  scopePath: string;
  scannedFiles: number;
  /** Files listed: at minConfidence or above */
  totalUnreferencedFiles: number;
  /** Default `low`: every file found is listed */
  minConfidence: DeadCodeConfidence;
  /** Every file found, listed or not, per confidence: `low` nothing imports it, `medium` only tests do */
  byConfidence: Record<DeadCodeConfidence, number>;
  hint?: string;
  /** Sorted by path */
  unreferencedFiles: Array<UnreferencedFile & { relativePath: string }>;
  /** verbose only: unreferenced files left out, and why (test file, manifest entry point, framework default export) */
  excluded?: Array<{ relativePath: string; reason: string }>;
  skippedFiles: number;
  /** True when maxFiles stopped the scan: unscanned files may be unreferenced too. */
  truncated: boolean;
  filesBeyondLimit: number;
  analysisTimeMs: number;
}

/** The files of the scope no production file imports (#711): the export scan's `unreferencedFiles` option. */
export async function scanUnreferencedFiles(
  spider: Spider,
  rootDir: string,
  options: DeadCodeScanOptions,
  signal?: AbortSignal,
): Promise<UnreferencedFilesScanResult> {
  const scopePath = validateWorkspacePath(options.scopePath ?? rootDir, rootDir);
  const minConfidence = options.minConfidence ?? "low";
  const startTime = Date.now();
  const raw = await spider.scanUnreferencedFiles(scopePath, { maxFiles: options.maxFiles, signal, onProgress: options.onProgress });
  const byConfidence = countByConfidence(raw.files);
  const unreferencedFiles = raw.files
    .filter((file) => meetsConfidence(file.confidence, minConfidence))
    .map((file) => ({ ...file, relativePath: getRelativePath(file.filePath, rootDir) }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const hint = confidenceHint(byConfidence, minConfidence);
  return {
    rootDir,
    scopePath,
    scannedFiles: raw.scannedFiles,
    totalUnreferencedFiles: unreferencedFiles.length,
    minConfidence,
    byConfidence,
    ...(hint ? { hint } : {}),
    unreferencedFiles,
    ...(options.verbose
      ? { excluded: raw.excluded.map(({ filePath, reason }) => ({ relativePath: getRelativePath(filePath, rootDir), reason })).sort((a, b) => a.relativePath.localeCompare(b.relativePath)) }
      : {}),
    skippedFiles: raw.skippedFiles,
    truncated: raw.filesBeyondLimit > 0,
    filesBeyondLimit: raw.filesBeyondLimit,
    analysisTimeMs: Date.now() - startTime,
  };
}
