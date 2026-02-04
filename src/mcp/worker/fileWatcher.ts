import { watch } from "chokidar";
import * as path from "node:path";
import {
    IGNORED_DIRECTORIES,
    SUPPORTED_FILE_EXTENSIONS,
} from "../../shared/constants";
import { getLogger } from "../../shared/logger";
import { workerState } from "../shared/state";
import type { McpWorkerResponse } from "../types";

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

  // Build glob pattern for watched extensions
  const globPattern = `${workerState.config.rootDir}/**/*{${WATCHED_EXTENSIONS.join(",")}}`;

  log.debug("Setting up file watcher for:", globPattern);

  try {
    workerState.fileWatcher = watch(globPattern, {
      ignored: IGNORED_DIRECTORIES.map((dir) => `**/${dir}/**`),
      persistent: true,
      ignoreInitial: true, // Don't fire events for existing files
      awaitWriteFinish: {
        stabilityThreshold: 100, // Wait 100ms after last write
        pollInterval: 50,
      },
    });

    workerState.fileWatcher.on("change", (filePath: string) => {
      handleFileChange(postMessage, "change", filePath);
    });

    workerState.fileWatcher.on("add", (filePath: string) => {
      handleFileChange(postMessage, "add", filePath);
    });

    workerState.fileWatcher.on("unlink", (filePath: string) => {
      handleFileChange(postMessage, "unlink", filePath);
    });

    workerState.fileWatcher.on("error", (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log.error("File watcher error:", message);
    });

    workerState.fileWatcher.on("ready", () => {
      log.debug("File watcher ready");
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    log.error("Failed to setup file watcher:", errorMessage);
  }
}

/**
 * Stop the file watcher and cleanup
 */
export function stopFileWatcher(): void {
  if (workerState.fileWatcher) {
    log.debug("Stopping file watcher...");
    workerState.fileWatcher.close().catch((error: Error) => {
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
): void {
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
