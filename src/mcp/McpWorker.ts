/**
 * MCP Worker Thread
 *
 * Runs in a separate thread to handle CPU-intensive dependency analysis
 * without blocking the VS Code extension host or MCP server.
 *
 * ## WASM Parser Usage in Worker Threads
 *
 * This worker uses WASM-based parsers (PythonParser, RustParser) for dependency analysis.
 * The parsers require the `extensionPath` to locate WASM files in the dist/ directory.
 *
 * **Current Implementation:**
 * - Worker receives `extensionPath` via `McpWorkerConfig`
 * - Passes `extensionPath` to `SpiderBuilder` via `withExtensionPath()`
 * - Spider creates parsers with `extensionPath` through `LanguageService`
 * - Parsers initialize WASM from extension's dist/ directory
 * - WASM files: tree-sitter.wasm, tree-sitter-python.wasm, tree-sitter-rust.wasm
 *
 * **Known Limitations:**
 * - web-tree-sitter has known compatibility issues in Node.js Worker Thread contexts
 * - WASM initialization may fail with LinkError in some environments
 * - If WASM fails, parsing errors will be caught and tools will return errors
 *
 * **Alternative Approach (if WASM issues persist):**
 * If WASM parsing proves unreliable in worker threads, consider delegating parsing
 * to the extension host via message passing:
 * 1. Worker sends file path to extension host
 * 2. Extension host performs parsing (WASM works reliably in Electron)
 * 3. Extension host sends parsed dependencies back to worker
 * 4. Worker continues with analysis
 *
 * This would add message passing overhead but ensure reliable parsing.
 *
 * @see Requirements 5.3 - Support Electron Environment (workers delegate to extension host)
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import { parentPort } from "node:worker_threads";
import { AstWorkerHost } from "../analyzer/ast/AstWorkerHost";
import { Parser } from "../analyzer/Parser";
import { SpiderBuilder } from "../analyzer/SpiderBuilder";
import { PathResolver } from "../analyzer/utils/PathResolver";
import {
  getLogger,
  getLogLevelFromEnv,
  loggerFactory,
  setLoggerBackend,
  StderrLogger,
} from "../shared/logger";
import { workerState } from "./shared/state";
import type {
  McpToolName,
  McpWorkerConfig,
  McpWorkerMessage,
  McpWorkerResponse,
} from "./types";
import { setupFileWatcher, stopFileWatcher } from "./worker/fileWatcher";
import { invokeTool } from "./worker/invokeTool";

// Configure all loggers in this thread to use StderrLogger
setLoggerBackend({
  createLogger(prefix: string, level) {
    return new StderrLogger(prefix, level);
  },
});

// Configure log level from environment variable
loggerFactory.setDefaultLevel(getLogLevelFromEnv("LOG_LEVEL"));

/** Logger instance for McpWorker */
const log = getLogger("McpWorker");

// ============================================================================
// Message Handling
// ============================================================================

parentPort?.on("message", async (msg: McpWorkerMessage) => {
  try {
    switch (msg.type) {
      case "init":
        await handleInit(msg.config);
        break;
      case "invoke":
        await handleInvoke(msg.requestId, msg.tool, msg.params);
        break;
      case "shutdown":
        handleShutdown();
        break;
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    log.error("Error handling message:", errorMessage);
  }
});

/**
 * Send a message to the parent thread
 */
function postMessage(msg: McpWorkerResponse): void {
  parentPort?.postMessage(msg);
}

// ============================================================================
// Initialization & Warmup
// ============================================================================

/**
 * Initialize the worker with configuration and perform warmup
 */
async function handleInit(cfg: McpWorkerConfig): Promise<void> {
  const startTime = Date.now();

  log.info("Initializing with config:", {
    rootDir: cfg.rootDir,
    excludeNodeModules: cfg.excludeNodeModules,
    maxDepth: cfg.maxDepth,
  });

  // Store configuration
  workerState.config = cfg;

  // Initialize components
  workerState.parser = new Parser();
  workerState.resolver = new PathResolver(
    cfg.tsConfigPath,
    cfg.excludeNodeModules,
    cfg.rootDir, // workspaceRoot for package.json discovery
  );

  // Initialize AstWorkerHost
  workerState.astWorkerHost = new AstWorkerHost(undefined, cfg.extensionPath);
  await workerState.astWorkerHost.start();
  log.info("AstWorkerHost started");

  const builder = new SpiderBuilder()
    .withRootDir(cfg.rootDir)
    .withMaxDepth(cfg.maxDepth)
    .withExcludeNodeModules(cfg.excludeNodeModules)
    .withReverseIndex(true); // Always enable for MCP server

  if (cfg.tsConfigPath) {
    builder.withTsConfigPath(cfg.tsConfigPath);
  }

  // Pass extensionPath to enable WASM parser initialization
  // The extensionPath is required for Python and Rust parsers to locate WASM files
  // in the extension's dist/ directory (tree-sitter-python.wasm, tree-sitter-rust.wasm)
  // If extensionPath is not provided, WASM initialization will fail and parsing
  // for Python/Rust files will throw errors (caught in tool invocation handlers)
  if (cfg.extensionPath) {
    builder.withExtensionPath(cfg.extensionPath);
  }

  workerState.spider = builder.build();

  const spider = workerState.spider;
  if (!spider) {
    throw new Error("Spider not initialized");
  }

  // Subscribe to indexing progress for warmup updates
  spider.subscribeToIndexStatus((snapshot) => {
    if (snapshot.state === "indexing") {
      postMessage({
        type: "warmup-progress",
        processed: snapshot.processed,
        total: snapshot.total,
        currentFile: snapshot.currentFile,
      });
    }
  });

  // Perform warmup: build full index of the workspace
  log.info("Starting warmup indexing...");

  try {
    const result = await spider.buildFullIndex();

    workerState.warmupInfo = {
      completed: true,
      durationMs: result.duration,
      filesIndexed: result.indexedFiles,
    };

    workerState.isReady = true;
    const totalDuration = Date.now() - startTime;

    log.info(
      "Warmup complete:",
      result.indexedFiles,
      "files indexed in",
      result.duration,
      "ms",
    );

    // Start file watcher after warmup
    setupFileWatcher(postMessage);

    postMessage({
      type: "ready",
      warmupDuration: totalDuration,
      indexedFiles: result.indexedFiles,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    log.error("Warmup failed:", errorMessage);

    // Still mark as ready, but warmup failed
    workerState.warmupInfo = { completed: false };
    workerState.isReady = true;

    postMessage({
      type: "ready",
      warmupDuration: Date.now() - startTime,
      indexedFiles: 0,
    });
  }
}

/**
 * Handle shutdown message
 */
async function handleShutdown(): Promise<void> {
  log.info("Shutting down...");

  // Stop file watcher
  stopFileWatcher();

  // Cancel any pending operations
  workerState.spider?.cancelIndexing();

  // Stop AstWorkerHost
  if (workerState.astWorkerHost) {
    await workerState.astWorkerHost.stop();
    log.info("AstWorkerHost stopped");
  }

  // Dispose Spider
  if (workerState.spider) {
    await workerState.spider.dispose();
    log.info("Spider disposed");
  }

  process.exit(0);
}

// ============================================================================
// Tool Invocation
// ============================================================================

/**
 * Handle tool invocation request with Zod validation
 */
async function handleInvoke(
  requestId: string,
  tool: McpToolName,
  params: unknown,
): Promise<void> {
  await invokeTool(requestId, tool, params, postMessage);
}

// Re-export types for testing
export type {
  McpWorkerConfig,
  McpWorkerMessage,
  McpWorkerResponse
} from "./types";
