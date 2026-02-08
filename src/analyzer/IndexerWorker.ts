/**
 * Worker Thread for background indexing
 *
 * This runs in a separate thread to avoid blocking the VS Code extension host.
 * Node.js Worker Threads allow CPU-intensive work without affecting responsiveness.
 *
 * ## WASM Parser Usage in Worker Threads
 *
 * This worker uses WASM-based parsers (PythonParser, RustParser) for dependency analysis.
 * The parsers require the `extensionPath` to locate WASM files in the dist/ directory.
 *
 * **Current Implementation:**
 * - Worker receives `extensionPath` via `WorkerConfig`
 * - Passes `extensionPath` to `LanguageService` constructor
 * - `LanguageService` creates parsers with `extensionPath`
 * - Parsers initialize WASM from extension's dist/ directory
 *
 * **Known Limitations:**
 * - web-tree-sitter has known compatibility issues in Node.js Worker Thread contexts
 * - WASM initialization may fail with LinkError in some environments
 * - If WASM fails, parsing errors will be caught and files will be skipped
 *
 * **Alternative Approach (if WASM issues persist):**
 * If WASM parsing proves unreliable in worker threads, consider delegating parsing
 * to the extension host via message passing:
 * 1. Worker sends file path to extension host
 * 2. Extension host performs parsing (WASM works reliably in Electron)
 * 3. Extension host sends parsed dependencies back to worker
 * 4. Worker continues with indexing
 *
 * This would add message passing overhead but ensure reliable parsing.
 *
 * @see Requirements 5.3 - Support Electron Environment (workers delegate to extension host)
 */

import { ConsoleLogger } from "@/shared/logger";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { LanguageService } from "./LanguageService";
import {
  isSupportedSourceFile,
  shouldSkipDirectory,
} from "./SourceFileFilters";
import type { Dependency } from "./types";

const log = new ConsoleLogger("IndexerWorker");

interface WorkerConfig {
  rootDir: string;
  maxDepth?: number;
  excludeNodeModules?: boolean;
  tsConfigPath?: string;
  progressInterval?: number;
  /**
   * Path to the VS Code extension directory.
   * Required for WASM parser initialization (locating .wasm files in dist/).
   *
   * **IMPORTANT:** This must be provided by the extension host when creating the worker.
   * Without it, WASM parsers cannot initialize and parsing will fail.
   *
   * Example: context.extensionPath from VS Code extension activation
   */
  extensionPath?: string;
}

interface WorkerMessage {
  type: "start" | "cancel";
}

interface WorkerResponse {
  type: "progress" | "complete" | "error" | "counting";
  data?: {
    processed?: number;
    total?: number;
    currentFile?: string;
    duration?: number;
    indexData?: IndexedFileData[];
  };
  error?: string;
}

interface IndexedFileData {
  filePath: string;
  dependencies: Dependency[];
  mtime: number;
  size: number;
}

let cancelled = false;

/**
 * Post a message to the parent thread
 */
function postMessage(msg: WorkerResponse): void {
  parentPort?.postMessage(msg);
}

/**
 * Collect all supported source files in a directory tree
 */
async function collectAllSourceFiles(
  dir: string,
  excludeNodeModules: boolean,
): Promise<string[]> {
  const files: string[] = [];

  const walkDir = async (currentDir: string): Promise<void> => {
    if (cancelled) return;

    try {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        if (cancelled) return;

        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          if (!shouldSkipDirectory(entry.name, excludeNodeModules)) {
            await walkDir(fullPath);
          }
        } else if (entry.isFile() && isSupportedSourceFile(entry.name)) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      // Silently skip directories that don't exist or can't be read
      // This can happen with symbolic links or permission issues
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        (error as NodeJS.ErrnoException).code !== "EACCES"
      ) {
        log.error(
          "Error reading directory in IndexerWorker",
          currentDir,
          error,
        );
      }
    }
  };

  await walkDir(dir);
  return files;
}

/**
 * Analyze a single file and extract its dependencies
 *
 * Uses LanguageService to get the appropriate analyzer (parser) for the file type.
 * For Python and Rust files, this will use WASM-based parsers.
 *
 * **Error Handling:**
 * If parsing fails (including WASM initialization failures), the function returns null
 * and the file is skipped. This ensures the indexing process continues even if
 * individual files cannot be parsed.
 *
 * **WASM Considerations:**
 * - First call to parseImports() triggers WASM initialization
 * - WASM files must be available in extension's dist/ directory
 * - If WASM fails to load, parsing will throw and file will be skipped
 */
async function analyzeFile(
  filePath: string,
  languageService: LanguageService,
): Promise<IndexedFileData | null> {
  try {
    const stats = await fs.stat(filePath);

    // Use LanguageService to get the appropriate analyzer for this file
    const analyzer = languageService.getAnalyzer(filePath);
    const parsedImports = await analyzer.parseImports(filePath);
    const dependencies: Dependency[] = [];

    for (const imp of parsedImports) {
      const resolvedPath = await analyzer.resolvePath(filePath, imp.module);
      if (resolvedPath) {
        dependencies.push({
          path: resolvedPath,
          type: imp.type,
          line: imp.line,
          module: imp.module,
        });
      }
    }

    return {
      filePath,
      dependencies,
      mtime: stats.mtimeMs,
      size: stats.size,
    };
  } catch {
    return null;
  }
}

/**
 * Main indexing function
 */
async function runIndexing(config: WorkerConfig): Promise<void> {
  const startTime = Date.now();
  const progressInterval = config.progressInterval ?? 100;

  try {
    // Create language service with root directory and tsconfig path
    // The extensionPath is passed to enable WASM parser initialization
    // Parsers (PythonParser, RustParser) need extensionPath to locate WASM files
    // in the extension's dist/ directory (tree-sitter-python.wasm, tree-sitter-rust.wasm)
    const languageService = new LanguageService(
      config.rootDir,
      config.tsConfigPath,
      config.extensionPath,
    );

    // Phase 1: Collect all files
    postMessage({ type: "counting" });
    const files = await collectAllSourceFiles(
      config.rootDir,
      config.excludeNodeModules ?? true,
    );

    if (cancelled) {
      postMessage({
        type: "complete",
        data: { duration: Date.now() - startTime, indexData: [] },
      });
      return;
    }

    const totalFiles = files.length;
    const indexedData: IndexedFileData[] = [];

    // Phase 2: Process files one by one
    // Since we're in a worker thread, we don't need to yield as aggressively
    // but we still send progress updates periodically
    for (let i = 0; i < files.length; i++) {
      if (cancelled) {
        break;
      }

      const result = await analyzeFile(files[i], languageService);
      if (result) {
        indexedData.push(result);
      }

      // Send progress update periodically
      if ((i + 1) % progressInterval === 0 || i === files.length - 1) {
        postMessage({
          type: "progress",
          data: {
            processed: i + 1,
            total: totalFiles,
            currentFile: files[i],
          },
        });
      }
    }

    const duration = Date.now() - startTime;
    postMessage({
      type: "complete",
      data: {
        duration,
        processed: indexedData.length,
        total: totalFiles,
        indexData: indexedData,
      },
    });
  } catch (error) {
    postMessage({
      type: "error",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

// Listen for messages from the parent thread
parentPort?.on("message", (msg: WorkerMessage) => {
  switch (msg.type) {
    case "start":
      cancelled = false;
      runIndexing(workerData as WorkerConfig);
      break;
    case "cancel":
      cancelled = true;
      break;
  }
});

// Export for testing
export type { IndexedFileData, WorkerConfig, WorkerMessage, WorkerResponse };
