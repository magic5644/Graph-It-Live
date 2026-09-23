import { watch } from "chokidar";
import * as fs from "node:fs";
import * as path from "node:path";
import {
    IGNORED_DIRECTORIES,
    SUPPORTED_FILE_EXTENSIONS,
} from "../../shared/constants";
import { getLogger } from "../../shared/logger";
import { normalizePath } from "../../shared/path";
import { workerState } from "../shared/state";
import type { McpWorkerResponse } from "../types";

/**
 * Resolve a directory path to its real long-name form.
 *
 * On Windows, os.tmpdir() (and paths derived from it) may contain 8.3 short
 * path components (e.g. RUNNER~1). If chokidar registers a watcher with the
 * short-name path while the OS fires ReadDirectoryChangesW events using the
 * long-name path, libuv asserts `!_wcsnicmp(filename, dir, dirlen)` and calls
 * abort(), crashing the process. Resolving the real path before handing it to
 * chokidar keeps both names consistent.
 *
 * Uses fs.realpathSync.native which calls GetFinalPathNameByHandle on Windows,
 * fully resolving short names and symlinks without the forward-slash
 * normalization done by fs.realpathSync.
 */
function resolveRealPath(dirPath: string): string {
  try {
    return fs.realpathSync.native(dirPath);
  } catch {
    // Directory may not exist yet or access is denied — fall back to the
    // original path so startup is not blocked.
    return dirPath;
  }
}

const log = getLogger("McpWorker");

/** Debounce delay for file change events (ms) */
const FILE_CHANGE_DEBOUNCE_MS = 300;

/** Extensions to watch for changes */
const WATCHED_EXTENSIONS = SUPPORTED_FILE_EXTENSIONS;

/**
 * Setup chokidar file watcher for automatic cache invalidation
 * Watches the workspace for file changes and invalidates the cache accordingly
 */
export function setupFileWatcher(
  postMessage: (msg: McpWorkerResponse) => void,
): void {
  if (!workerState.config?.rootDir) {
    log.warn("Cannot setup file watcher: no rootDir configured");
    return;
  }

  // Resolve to real long-name path to avoid Windows 8.3 short-name mismatch
  // that causes libuv to abort() when ReadDirectoryChangesW fires events.
  const watchRoot = resolveRealPath(workerState.config.rootDir);

  log.debug("Setting up file watcher for:", watchRoot);
  if (watchRoot !== workerState.config.rootDir) {
    log.debug("Resolved rootDir short path:", workerState.config.rootDir, "→", watchRoot);
  }

  try {
    let initialScanComplete = false;
    // Chokidar 4+ treats globs as literal paths. Watch the directory and filter
    // files without excluding directories needed for recursive traversal.
    workerState.fileWatcher = watch(watchRoot, {
      ignored: (filePath, stats) =>
        path.relative(watchRoot, filePath).split(path.sep).some(part => IGNORED_DIRECTORIES.includes(part)) ||
      (stats?.isFile() === true && !WATCHED_EXTENSIONS.some(ext => filePath.endsWith(ext))),
      persistent: true,
      // Keep initial events so files created together with a new directory are
      // not mistaken for the directory's initial scan. They are filtered until
      // the ready event below.
      ignoreInitial: false,
      // ReadDirectoryChangesW can miss a file created immediately after a new
      // directory on Windows. Poll there for correctness; native events remain
      // the lower-overhead default on macOS and Linux.
      usePolling: process.platform === "win32" || process.env.CI === "true",
      interval: 300,
      awaitWriteFinish: {
        stabilityThreshold: 100, // Wait 100ms after last write
        pollInterval: 50,
      },
    });

    workerState.fileWatcher.on("change", (filePath: string) => {
      if (!initialScanComplete) return;
      handleFileChange(postMessage, "change", filePath, watchRoot);
    });

    workerState.fileWatcher.on("add", (filePath: string) => {
      if (!initialScanComplete) return;
      handleFileChange(postMessage, "add", filePath, watchRoot);
    });

    workerState.fileWatcher.on("unlink", (filePath: string) => {
      if (!initialScanComplete) return;
      handleFileChange(postMessage, "unlink", filePath, watchRoot);
    });

    workerState.fileWatcher.on("addDir", (directory: string) => {
      if (!initialScanComplete) return;
      void reportNewDirectoryFiles(postMessage, directory, watchRoot);
    });

    workerState.fileWatcher.on("error", (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log.error("File watcher error:", message);
    });

    workerState.fileWatcher.on("ready", () => {
      initialScanComplete = true;
      log.debug("File watcher ready");
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    log.error("Failed to setup file watcher:", errorMessage);
  }
}

/**
 * Chokidar can classify files created with a new directory as that directory's
 * initial scan. Reconcile only that directory so nested source files are not
 * lost without turning the watcher into a workspace-wide polling scan.
 */
async function reportNewDirectoryFiles(
  postMessage: (msg: McpWorkerResponse) => void,
  directory: string,
  watchRoot: string,
): Promise<void> {
  try {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      const relative = path.relative(watchRoot, filePath);
      if (relative.split(path.sep).some(part => IGNORED_DIRECTORIES.includes(part))) continue;
      if (entry.isDirectory()) {
        await reportNewDirectoryFiles(postMessage, filePath, watchRoot);
      } else if (entry.isFile() && WATCHED_EXTENSIONS.some(ext => entry.name.endsWith(ext))) {
        handleFileChange(postMessage, "add", filePath, watchRoot);
      }
    }
  } catch (error) {
    log.debug("Could not reconcile new directory:", error instanceof Error ? error.message : String(error));
  }
}

/**
 * Stop the file watcher and cleanup
 */
export async function stopFileWatcher(): Promise<void> {
  if (workerState.fileWatcher) {
    log.debug("Stopping file watcher...");
    await workerState.fileWatcher.close().catch((error: Error) => {
      log.error("Error closing file watcher:", error.message);
    });
    workerState.fileWatcher = null;
  }

  // Clear any pending debounced invalidations
  for (const timeout of workerState.pendingInvalidations.values()) {
    clearTimeout(timeout);
  }
  workerState.pendingInvalidations.clear();
}

/**
 * Handle a file change event with debouncing
 * Debounces rapid changes to the same file to avoid excessive cache invalidations
 */
function handleFileChange(
  postMessage: (msg: McpWorkerResponse) => void,
  event: "change" | "add" | "unlink",
  filePath: string,
  watchRoot: string,
): void {
  filePath = restoreConfiguredPath(filePath, watchRoot);
  filePath = normalizePath(filePath);
  // Clear any pending invalidation for this file
  const existingTimeout = workerState.pendingInvalidations.get(filePath);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
  }

  // Schedule a debounced invalidation
  const timeout = setTimeout(() => {
    workerState.pendingInvalidations.delete(filePath);
    performFileInvalidation(postMessage, event, filePath);
  }, FILE_CHANGE_DEBOUNCE_MS);

  workerState.pendingInvalidations.set(filePath, timeout);
}

/**
 * Chokidar reports paths using the real path passed to it. On Windows that can
 * differ from the configured 8.3 workspace path, so map events back to the
 * same path namespace used by the index and MCP responses.
 */
function restoreConfiguredPath(filePath: string, watchRoot: string): string {
  const configuredRoot = workerState.config?.rootDir;
  if (!configuredRoot || configuredRoot === watchRoot) return filePath;

  const relativePath = path.relative(watchRoot, filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return filePath;
  return path.join(configuredRoot, relativePath);
}

/**
 * Actually perform the file invalidation after debounce
 */
function performFileInvalidation(
  postMessage: (msg: McpWorkerResponse) => void,
  event: "change" | "add" | "unlink",
  filePath: string,
): void {
  if (!workerState.spider) {
    return;
  }

  log.debug("File", event + ":", path.basename(filePath));

  // The call graph has its own database; Spider invalidation does not refresh it.
  // Reuse lazy workspace indexing on the next graph query after a change.
  workerState.callGraphIndexedRoot = null;
  if (event === "unlink") {
    workerState.callGraphIndexer?.invalidateFile(filePath);
  }

  switch (event) {
    case "change":
    case "add":
      // Invalidate and optionally re-analyze
      // Using invalidateFile instead of reanalyzeFile for performance
      // The file will be re-analyzed on next query
      workerState.spider.invalidateFile(filePath);

      // Also invalidate symbol reverse index to prevent stale cache
      if (workerState.symbolReverseIndex) {
        workerState.symbolReverseIndex.removeDependenciesFromSource(filePath);
      }
      break;

    case "unlink":
      // File was deleted
      workerState.spider.handleFileDeleted(filePath);

      // Remove file from symbol reverse index
      if (workerState.symbolReverseIndex) {
        workerState.symbolReverseIndex.removeDependenciesFromSource(filePath);
      }
      break;
  }

  // Notify parent about cache invalidation (optional, for debugging)
  postMessage({
    type: "file-invalidated" as const,
    filePath,
    event,
  } as McpWorkerResponse);
}
