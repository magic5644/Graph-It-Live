import { scanDeadCode, scanUnreferencedFiles, type UnreferencedFilesScanResult } from "../../analyzer/deadcode/DeadCodeScanner";
import { validateScopePath } from "../shared/helpers";
import { workerState } from "../shared/state";
import type {
    ScanDeadCodeParams,
    ScanDeadCodeResult,
} from "../types";

/**
 * Scan the workspace (or a scoped directory) for unused exported symbols, or with
 * `unreferencedFiles` for the whole files no production file imports.
 *
 * Security: scopePath is validated against the workspace root to prevent
 * path traversal.
 * Guard: requires the reverse index to be ready — never silent O(n²) fallback.
 */
export function executeScanDeadCode(params: ScanDeadCodeParams & { unreferencedFiles?: false }, signal?: AbortSignal): Promise<ScanDeadCodeResult>;
export function executeScanDeadCode(params: ScanDeadCodeParams, signal?: AbortSignal): Promise<ScanDeadCodeResult | UnreferencedFilesScanResult>;
export async function executeScanDeadCode(
  params: ScanDeadCodeParams,
  signal?: AbortSignal,
): Promise<ScanDeadCodeResult | UnreferencedFilesScanResult> {
  const spider = workerState.getSpider();
  const config = workerState.getConfig();
  validateScopePath(params.scopePath ?? config.rootDir, config.rootDir);
  const scan = params.unreferencedFiles ? scanUnreferencedFiles : scanDeadCode;
  return scan(spider, config.rootDir, params, signal);
}
