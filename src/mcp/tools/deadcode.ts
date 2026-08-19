import { scanDeadCode } from "../../analyzer/deadcode/DeadCodeScanner";
import { validateScopePath } from "../shared/helpers";
import { workerState } from "../shared/state";
import type {
    ScanDeadCodeParams,
    ScanDeadCodeResult,
} from "../types";

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
  validateScopePath(params.scopePath ?? config.rootDir, config.rootDir);
  return scanDeadCode(spider, config.rootDir, params);
}
