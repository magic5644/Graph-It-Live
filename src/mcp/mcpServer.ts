#!/usr/bin/env node
/**
 * MCP Server Entry Point
 *
 * Standalone Node.js process that implements the MCP protocol via stdio.
 * Delegates heavy analysis work to McpWorkerHost running in a Worker Thread.
 *
 * This is spawned by McpServerProvider when the user enables the MCP server.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import { setLoggerBackend, StderrLogger } from "../shared/logger";

// Configure all loggers in this process to use StderrLogger
// This ensures stdout is kept clean for JSON-RPC
setLoggerBackend({
  createLogger(prefix: string, level) {
    return new StderrLogger(prefix, level);
  },
});

import * as fs from "node:fs";
import * as os from "node:os";

// ============================================================================
// Secure File Logger with Rotation (opt-in via DEBUG_MCP=true)
// ============================================================================
const DEBUG_MCP_ENABLED = process.env.DEBUG_MCP === "true";
const DEBUG_LOG_PATH = `${os.homedir()}/mcp-debug.log`;
const DEBUG_LOG_MAX_SIZE = 5 * 1024 * 1024; // 5MB per file
const DEBUG_LOG_BACKUP = `${DEBUG_LOG_PATH}.1`;

/**
 * Check log file size and rotate if necessary
 * Keeps last 2 files: mcp-debug.log (current) and mcp-debug.log.1 (previous)
 */
function rotateLogIfNeeded(): void {
  if (!DEBUG_MCP_ENABLED) return;

  try {
    const stats = fs.statSync(DEBUG_LOG_PATH);
    if (stats.size >= DEBUG_LOG_MAX_SIZE) {
      // Delete old backup if exists
      if (fs.existsSync(DEBUG_LOG_BACKUP)) {
        fs.unlinkSync(DEBUG_LOG_BACKUP);
      }
      // Rotate: current → backup
      fs.renameSync(DEBUG_LOG_PATH, DEBUG_LOG_BACKUP);
    }
  } catch {
    // File doesn't exist yet or other error - ignore
  }
}

/**
 * Write a debug message to both stderr and optionally to file (if DEBUG_MCP=true)
 * Privacy: Only logs when explicitly enabled to avoid exposing project paths
 */
function debugLog(...args: unknown[]): void {
  const message = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");

  // Always write to stderr for MCP protocol
  process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);

  // Only write to file if DEBUG logging is explicitly enabled
  if (!DEBUG_MCP_ENABLED) return;

  try {
    rotateLogIfNeeded();
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(DEBUG_LOG_PATH, line);
  } catch {
    // Ignore write errors to avoid crashing on permission issues
  }
}

// EARLY DEBUG: Log immediately to confirm process starts (only if opted-in)
if (DEBUG_MCP_ENABLED) {
  debugLog("[McpServer] ===== PROCESS STARTING (DEBUG MODE) =====");
  debugLog("[McpServer] Node version:", process.version);
  debugLog("[McpServer] PID:", process.pid);
  debugLog("[McpServer] cwd:", process.cwd());
  debugLog("[McpServer] argv:", JSON.stringify(process.argv));
  debugLog("[McpServer] Environment vars:");
  debugLog("  WORKSPACE_ROOT:", process.env.WORKSPACE_ROOT ?? "(not set)");
  debugLog("  TSCONFIG_PATH:", process.env.TSCONFIG_PATH ?? "(not set)");
  debugLog(
    "  EXCLUDE_NODE_MODULES:",
    process.env.EXCLUDE_NODE_MODULES ?? "(not set)",
  );
  debugLog("  MAX_DEPTH:", process.env.MAX_DEPTH ?? "(not set)");
} else {
  process.stderr.write(
    "[McpServer] Starting (debug logging disabled - set DEBUG_MCP=true to enable)\n",
  );
}
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as path from "node:path";
import * as z from "zod/v4";
import { McpWorkerHost } from "./McpWorkerHost";
import { formatToolResponse } from "./responseFormatter";
import {
  AnalyzeBreakingChangesParamsSchema,
  type AnalyzeBreakingChangesResult,
  ReviewPrParamsSchema,
  type ReviewPrResult,
  AnalyzeDependenciesParamsSchema,
  type AnalyzeDependenciesResult,
  CrawlDependencyGraphParamsSchema,
  type CrawlDependencyGraphResult,
  createErrorResponse,
  createSuccessResponse,
  ExpandNodeParamsSchema,
  type ExpandNodeResult,
  FindReferencingFilesParamsSchema,
  type FindReferencingFilesResult,
  FindUnusedSymbolsParamsSchema,
  type FindUnusedSymbolsResult,
  GetImpactAnalysisParamsSchema,
  type GetImpactAnalysisResult,
  GraphContextParamsSchema,
  type GetIndexStatusResult,
  GetSymbolCallersParamsSchema,
  type GetSymbolCallersResult,
  GetSymbolDependentsParamsSchema,
  type GetSymbolDependentsResult,
  GetSymbolGraphParamsSchema,
  type GetSymbolGraphResult,
  InvalidateFilesParamsSchema,
  type InvalidateFilesResult,
  MCP_TOOL_VERSION,
  type McpToolResponse,
  type PaginationInfo,
  ParseImportsParamsSchema,
  type ParseImportsResult,
  QueryCallGraphParamsSchema,
  type RebuildIndexResult,
  ResolveModulePathParamsSchema,
  type ResolveModulePathResult,
  ScanDeadCodeParamsSchema,
  QueryNaturalLanguageParamsSchema,
  // Import all parameter schemas with payload limits
  SetWorkspaceParamsSchema,
  type SetWorkspaceResult,
  TraceFunctionExecutionParamsSchema,
  type TraceFunctionExecutionResult,
  validateFilePath,
  VerifyDependencyUsageParamsSchema,
} from "./types";
import type { GraphContextResponse } from "../shared/graph-context-types";
import { GenerateWikiSchema } from "./tools/wiki.js";
import { executeGetSessionStats, GetSessionStatsSchema, type GetSessionStatsResult } from "./tools/stats.js";
import { flushSession } from "../analyzer/stats/statsPersistence";
import { sessionStats } from "../shared/sessionStats";

// Session stats: this process is the MCP entry point.
sessionStats.setSource("mcp");

// Idempotent stats flush — signal handlers and exit path may all fire.
let statsFlushed = false;
function flushStatsOnce(): void {
  if (statsFlushed) {
    return;
  }
  statsFlushed = true;
  try {
    // flushSession is synchronous — safe inside signal/exit handlers.
    flushSession(sessionStats.snapshot());
  } catch (error) {
    debugLog(`[McpServer] Stats flush failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ============================================================================
// Environment Configuration
// ============================================================================

// Mutable configuration - can be changed via setWorkspace tool
const currentConfig = {
  workspaceRoot: process.env.WORKSPACE_ROOT ?? "",
  extensionPath: process.env.EXTENSION_PATH,
  tsConfigPath: process.env.TSCONFIG_PATH,
  excludeNodeModules: process.env.EXCLUDE_NODE_MODULES !== "false",
  maxDepth: Number.parseInt(process.env.MAX_DEPTH ?? "50", 10),
};

// Check for unresolved variables (common misconfiguration)
if (
  currentConfig.workspaceRoot &&
  (currentConfig.workspaceRoot.includes("${") ||
    currentConfig.workspaceRoot.includes("$("))
) {
  debugLog(
    "[McpServer] WARNING: WORKSPACE_ROOT contains unresolved variable:",
    currentConfig.workspaceRoot,
  );
  debugLog(
    "[McpServer] Workspace not set - use graphitlive_set_workspace tool to configure",
  );
  currentConfig.workspaceRoot = "";
}

// Fallback logic for WORKSPACE_ROOT (only if set via env)
if (!currentConfig.workspaceRoot) {
  const cwd = process.cwd();

  // If cwd is root or empty, don't set a default - require explicit configuration
  if (cwd === "/" || cwd === "") {
    debugLog(
      "[McpServer] No workspace configured - use graphitlive_set_workspace tool to set workspace",
    );
  } else {
    currentConfig.workspaceRoot = cwd;
    debugLog(
      "[McpServer] WORKSPACE_ROOT not set, using current working directory:",
      currentConfig.workspaceRoot,
    );
  }
}

// Validate workspace if set
if (
  currentConfig.workspaceRoot &&
  !fs.existsSync(currentConfig.workspaceRoot)
) {
  debugLog(
    "[McpServer] WARNING: WORKSPACE_ROOT path does not exist:",
    currentConfig.workspaceRoot,
  );
  debugLog(
    "[McpServer] Use graphitlive_set_workspace tool to configure a valid workspace",
  );
  currentConfig.workspaceRoot = "";
}

// Helper to get current workspace (may be empty if not configured)
function getWorkspaceRoot(): string {
  return currentConfig.workspaceRoot;
}

const ResponseFormatSchema = z
  .enum(["json", "markdown", "toon"])
  .default("toon");
const PaginationInfoSchema = z.object({
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
});
const McpResponseMetadataSchema = z.object({
  executionTimeMs: z.number(),
  toolVersion: z.string(),
  timestamp: z.string(),
  workspaceRoot: z.string(),
  indexedAt: z.string().nullable().optional(),
  stale: z.boolean().optional(),
});
const McpToolResponseSchema = z.object({
  success: z.boolean(),
  data: z.any(),
  metadata: McpResponseMetadataSchema,
  pagination: PaginationInfoSchema.optional(),
  error: z.string().optional(),
});

// ============================================================================
// Server Setup
// ============================================================================

const server = new McpServer({
  name: "graph-it-live",
  version: MCP_TOOL_VERSION,
});

let workerHost: McpWorkerHost | null = null;
let isInitialized = false;
let initializationPromise: Promise<void> | null = null;
let initializationError: Error | null = null;

/**
 * Reset initialization state so the next call to initializeWorker()
 * creates a fresh worker. Used for auto-recovery after a worker crash.
 */
function resetInitializationState(): void {
  isInitialized = false;
  initializationPromise = null;
  initializationError = null;
}

/**
 * Initialize the worker host with warmup
 * Uses a singleton pattern to avoid multiple initializations.
 * Automatically recovers from dead workers and transient init failures.
 */
async function initializeWorker(): Promise<void> {
  // If we previously succeeded but the worker has since died, reset and re-init
  if (isInitialized && !workerHost?.ready()) {
    debugLog(
      "[McpServer] Worker was initialized but is no longer ready — auto-recovering",
    );
    if (workerHost) {
      await workerHost.dispose();
      workerHost = null;
    }
    resetInitializationState();
  }

  // Already initialized and worker is alive
  if (isInitialized) {
    return;
  }

  // Previous initialization failed — allow a single retry so callers
  // don't stay permanently stuck (set_workspace still does a full reset)
  if (initializationError) {
    debugLog(
      "[McpServer] Previous init failed, allowing retry",
    );
    resetInitializationState();
  }

  // Initialization already in progress, wait for it
  if (initializationPromise !== null) {
    debugLog("[McpServer] Waiting for existing initialization...");
    return initializationPromise;
  }

  // Start new initialization
  initializationPromise = doInitializeWorker();

  try {
    await initializationPromise;
  } catch (error) {
    initializationError =
      error instanceof Error ? error : new Error(String(error));
    initializationPromise = null;
    throw initializationError;
  }
}

/**
 * Actual worker initialization logic
 */
async function doInitializeWorker(): Promise<void> {
  const workerPath = path.join(__dirname, "mcpWorker.js");

  // Debug: Log worker path resolution
  debugLog(`[McpServer] __dirname: ${__dirname}`);
  debugLog(`[McpServer] Worker path: ${workerPath}`);

  // Check if worker file exists
  try {
    const fs = await import("node:fs/promises");
    await fs.access(workerPath);
    debugLog("[McpServer] Worker file exists: true");
  } catch {
    debugLog("[McpServer] Worker file exists: false - THIS IS THE PROBLEM!");
    throw new Error(`Worker file not found at ${workerPath}`);
  }

  workerHost = new McpWorkerHost({
    workerPath,
    warmupTimeout: 120000, // 2 minutes for large workspaces
    invokeTimeout: 60000, // 1 minute per tool call
  });

  debugLog("[McpServer] Starting worker with warmup...");

  try {
    const result = await workerHost.start(
      {
        rootDir: getWorkspaceRoot(),
        tsConfigPath: currentConfig.tsConfigPath,
        extensionPath: currentConfig.extensionPath,
        excludeNodeModules: currentConfig.excludeNodeModules,
        maxDepth: currentConfig.maxDepth,
      },
      (processed, total, currentFile) => {
        debugLog(
          `[McpServer] Warmup progress: ${processed}/${total} - ${currentFile ?? ""}`,
        );
      },
    );

    debugLog(
      `[McpServer] Worker ready: ${result.filesIndexed} files indexed in ${result.durationMs}ms`,
    );
    isInitialized = true;
  } catch (error) {
    debugLog(`[McpServer] Worker initialization failed: ${error}`);
    throw error;
  }
}

/**
 * Helper to invoke a tool and wrap result in McpToolResponse
 */
async function invokeToolWithResponse<T>(
  toolName: string,
  params: unknown,
): Promise<McpToolResponse<T>> {
  if (!workerHost?.ready()) {
    return createErrorResponse<T>("Worker not ready", 0, getWorkspaceRoot());
  }

  const startTime = Date.now();

  try {
    const result = await workerHost.invoke<T>(
      toolName as Parameters<typeof workerHost.invoke>[0],
      params,
    );
    const executionTimeMs = Date.now() - startTime;
    return createSuccessResponse(
      result,
      executionTimeMs,
      getWorkspaceRoot(),
      undefined,
      workerHost.freshness(),
    );
  } catch (error) {
    const executionTimeMs = Date.now() - startTime;
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return createErrorResponse<T>(
      errorMessage,
      executionTimeMs,
      getWorkspaceRoot(),
    );
  }
}

/**
 * Helper to ensure worker is initialized, returns error response if not
 */
async function ensureWorkerReady(): Promise<
  { error: true; response: McpToolResponse<unknown> } | { error: false }
> {
  try {
    await initializeWorker();
    return { error: false };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Worker initialization failed";
    debugLog(
      `[McpServer] Tool call failed - worker init error: ${errorMessage}`,
    );
    return {
      error: true,
      response: createErrorResponse<unknown>(
        errorMessage,
        0,
        getWorkspaceRoot(),
      ),
    };
  }
}

// ============================================================================
// Helper functions for setWorkspace tool
// ============================================================================

/**
 * Creates an error response for the setWorkspace tool
 */
function createSetWorkspaceErrorResponse(
  workspacePath: string,
  previousWorkspace: string,
  errorMessage: string,
  startTime: number,
): McpToolResponse<SetWorkspaceResult> {
  return {
    success: false,
    data: {
      success: false,
      workspacePath,
      filesIndexed: 0,
      indexingTimeMs: Date.now() - startTime,
      previousWorkspace: previousWorkspace || undefined,
      message: errorMessage,
    },
    error: errorMessage,
    metadata: {
      executionTimeMs: Date.now() - startTime,
      toolVersion: MCP_TOOL_VERSION,
      timestamp: new Date().toISOString(),
      workspaceRoot: workspacePath,
    },
  };
}

/**
 * Validates that the workspace path exists and is a directory
 */
function validateWorkspacePath(workspacePath: string): string | null {
  if (!fs.existsSync(workspacePath)) {
    return `Path does not exist: ${workspacePath}`;
  }

  const stats = fs.statSync(workspacePath);
  if (!stats.isDirectory()) {
    return `Path is not a directory: ${workspacePath}`;
  }

  return null;
}

/**
 * Validates and resolves the tsConfigPath if provided
 */
function validateTsConfigPath(
  tsConfigPath: string | undefined,
  workspacePath: string,
): { resolvedPath: string | undefined; error: string | null } {
  if (!tsConfigPath) {
    return { resolvedPath: undefined, error: null };
  }

  const resolvedPath = path.isAbsolute(tsConfigPath)
    ? tsConfigPath
    : path.join(workspacePath, tsConfigPath);

  if (!fs.existsSync(resolvedPath)) {
    return {
      resolvedPath: undefined,
      error: `tsConfigPath does not exist: ${resolvedPath}`,
    };
  }

  const stats = fs.statSync(resolvedPath);
  if (!stats.isFile()) {
    return {
      resolvedPath: undefined,
      error: `tsConfigPath is not a file: ${resolvedPath}`,
    };
  }

  try {
    validateFilePath(resolvedPath, workspacePath);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid tsConfigPath";
    return { resolvedPath: undefined, error: message };
  }

  return { resolvedPath, error: null };
}

// ============================================================================
// Tool Definitions - Using registerTool (recommended over deprecated tool())
// ============================================================================

// Tool: graphitlive_set_workspace
// This tool is special - it doesn't require the worker to be ready first
server.registerTool(
  "graphitlive_set_workspace",
  {
    title: "Set Workspace Directory",
    description: `Sets the project root for this server session and builds its dependency index.

WHEN: only when no workspace is configured yet, or to switch to a different project. It is server setup, not analysis: it answers no question about code, so never pick it for a question about architecture, callers, dependencies, dead code or documentation - those tools fail with a clear error if the workspace is missing, and the fix is to call this once, then retry them.
RETURNS: resolved workspace path, number of files indexed, indexing duration.`,
    inputSchema: SetWorkspaceParamsSchema.extend({
      response_format: ResponseFormatSchema.describe(
        "Output format: 'json', 'markdown', or 'toon' (Token-Oriented Object Notation for reduced token usage) (default: toon - RECOMMENDED for 30-60% token savings)",
      ),
    }),
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({
    workspacePath,
    tsConfigPath,
    excludeNodeModules,
    maxDepth,
    response_format,
  }) => {
    const startTime = Date.now();
    const previousWorkspace = getWorkspaceRoot();
    const responseFormat = response_format;

    debugLog(`[McpServer] setWorkspace called with: ${workspacePath}`);

    // Validate workspace path
    const workspaceError = validateWorkspacePath(workspacePath);
    if (workspaceError) {
      return formatToolResponse(
        createSetWorkspaceErrorResponse(
          workspacePath,
          previousWorkspace,
          workspaceError,
          startTime,
        ),
        responseFormat,
      "graphitlive_set_workspace",
      );
    }

    // Validate tsConfigPath if provided
    const { resolvedPath: resolvedTsConfigPath, error: tsConfigError } =
      validateTsConfigPath(tsConfigPath, workspacePath);
    if (tsConfigError) {
      return formatToolResponse(
        createSetWorkspaceErrorResponse(
          workspacePath,
          previousWorkspace,
          tsConfigError,
          startTime,
        ),
        responseFormat,
      "graphitlive_set_workspace",
      );
    }

    // Update configuration
    currentConfig.workspaceRoot = workspacePath;
    if (resolvedTsConfigPath !== undefined)
      currentConfig.tsConfigPath = resolvedTsConfigPath;
    if (excludeNodeModules !== undefined)
      currentConfig.excludeNodeModules = excludeNodeModules;
    if (maxDepth !== undefined) currentConfig.maxDepth = maxDepth;

    debugLog(`[McpServer] Workspace updated to: ${workspacePath}`);

    // Dispose existing worker if any
    if (workerHost) {
      debugLog("[McpServer] Disposing previous worker...");
      await workerHost.dispose();
      workerHost = null;
    }

    // Reset initialization state
    resetInitializationState();

    // Initialize with new workspace
    try {
      await initializeWorker();

      const executionTimeMs = Date.now() - startTime;
      let filesIndexed = 0;

      // Get index status to report number of files indexed
      // workerHost is reassigned inside initializeWorker() — re-read the module-level variable.
      // Type assertion required: TS control-flow narrows workerHost to `null` (set above)
      // but initializeWorker() reassigns it — TS cannot track cross-function mutations.
      const activeWorker = workerHost as McpWorkerHost | null; // NOSONAR
      if (activeWorker?.ready()) {
        const statusResult = await activeWorker.invoke<GetIndexStatusResult>(
          "get_index_status",
          {},
        );
        filesIndexed = statusResult.cacheSize;
      }

      const response: McpToolResponse<SetWorkspaceResult> = {
        success: true,
        data: {
          success: true,
          workspacePath,
          filesIndexed,
          indexingTimeMs: executionTimeMs,
          previousWorkspace: previousWorkspace || undefined,
          message: `Workspace set to ${workspacePath}. Indexed ${filesIndexed} files in ${executionTimeMs}ms.`,
        },
        metadata: {
          executionTimeMs,
          toolVersion: MCP_TOOL_VERSION,
          timestamp: new Date().toISOString(),
          workspaceRoot: workspacePath,
        },
      };

      debugLog(
        `[McpServer] Workspace configured successfully: ${filesIndexed} files indexed`,
      );

      return formatToolResponse(response, responseFormat, "graphitlive_set_workspace");
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown error during initialization";
      debugLog(`[McpServer] setWorkspace failed: ${errorMessage}`);

      return formatToolResponse(
        createSetWorkspaceErrorResponse(
          workspacePath,
          previousWorkspace,
          `Failed to initialize workspace: ${errorMessage}`,
          startTime,
        ),
        responseFormat,
      "graphitlive_set_workspace",
      );
    }
  },
);

// Tool: graphitlive_analyze_dependencies
server.registerTool(
  "graphitlive_analyze_dependencies",
  {
    title: "Analyze File Dependencies",
    description: `Lists the import/export statements of one file, with each specifier resolved to a path on disk.

WHEN: "what does this file import", "what are this file's dependencies".
WHY: read from the parsed source, so tsconfig path aliases, implicit extensions and index files are already resolved.
RETURNS: per statement - module specifier, resolved absolute path, workspace-relative path, import type (static, dynamic, require, re-export), line number.
SUPPORTS: TypeScript, JavaScript, Vue, Svelte, GraphQL.`,
    inputSchema: AnalyzeDependenciesParamsSchema.extend({
      response_format: ResponseFormatSchema.describe(
        "Output format: 'json', 'markdown', or 'toon' (Token-Oriented Object Notation for reduced token usage) (default: toon - RECOMMENDED for 30-60% token savings)",
      ),
    }),
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ filePath, response_format }) => {
    const workerCheck = await ensureWorkerReady();
    if (workerCheck.error)
      return formatToolResponse(
        workerCheck.response,
        response_format,
      "graphitlive_analyze_dependencies",
      );

    const response = await invokeToolWithResponse<AnalyzeDependenciesResult>(
      "analyze_dependencies",
      { filePath },
    );

    return formatToolResponse(response, response_format, "graphitlive_analyze_dependencies");
  },
);

// Tool: graphitlive_crawl_dependency_graph
server.registerTool(
  "graphitlive_crawl_dependency_graph",
  {
    title: "Crawl Full Dependency Graph",
    description: `Builds the transitive file dependency graph reachable from one entry file.

WHEN: project architecture, full dependency tree from an entry point, circular-import detection.
WHY: crawls real import edges across the workspace rather than inferring structure from file names.
RETURNS: nodes (path, extension, dependency count, dependent count, circular flag) and edges (import relations); paginated via offset/limit.
For an open-ended question, start with graphitlive_graph_context and come here when you need this specific cut.`,
    inputSchema: CrawlDependencyGraphParamsSchema.extend({
      response_format: ResponseFormatSchema.describe(
        "Output format: 'json', 'markdown', or 'toon' (Token-Oriented Object Notation for reduced token usage) (default: toon - RECOMMENDED for 30-60% token savings)",
      ),
    }),
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ entryFile, maxDepth, limit, offset, onlyUsed, response_format }) => {
    const workerCheck = await ensureWorkerReady();
    const responseFormat = response_format;
    if (workerCheck.error)
      return formatToolResponse(workerCheck.response, responseFormat, "graphitlive_crawl_dependency_graph");

    const params = { entryFile, maxDepth, limit, offset, onlyUsed };
    const result = await workerHost?.invoke<CrawlDependencyGraphResult>(
      "crawl_dependency_graph",
      params,
    );
    if (!result) {
      return formatToolResponse(
        createErrorResponse<CrawlDependencyGraphResult>("Worker not available", 0, getWorkspaceRoot()),
        responseFormat,
      "graphitlive_crawl_dependency_graph",
      );
    }

    // Build pagination info if limit/offset were used
    let pagination: PaginationInfo | undefined;
    if (limit !== undefined || offset !== undefined) {
      const actualOffset = offset ?? 0;
      const actualLimit = limit ?? result.nodeCount;
      pagination = {
        total: result.nodeCount,
        limit: actualLimit,
        offset: actualOffset,
        hasMore: actualOffset + result.nodes.length < result.nodeCount,
      };
    }

    const response = createSuccessResponse(
      result,
      0, // We don't track time here, worker already includes it
      getWorkspaceRoot(),
      pagination,
    );

    return formatToolResponse(response, responseFormat, "graphitlive_crawl_dependency_graph");
  },
);

// Tool: graphitlive_find_referencing_files
server.registerTool(
  "graphitlive_find_referencing_files",
  {
    title: "Find Files That Import This File",
    description: `Lists every file that imports or references a given file (reverse dependency lookup).

WHEN: impact analysis, "who uses this file", refactoring-safety checks before changing or deleting a file.
WHY: served from a prebuilt reverse index, so it covers the whole workspace rather than the files already in context.
RETURNS: absolute and workspace-relative path of each referencing file.
For an open-ended question, start with graphitlive_graph_context and come here when you need this specific cut.`,
    inputSchema: FindReferencingFilesParamsSchema.extend({
      response_format: ResponseFormatSchema.describe(
        "Output format: 'json', 'markdown', or 'toon' (Token-Oriented Object Notation for reduced token usage) (default: toon - RECOMMENDED for 30-60% token savings)",
      ),
    }),
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ targetPath, response_format }) => {
    const workerCheck = await ensureWorkerReady();
    const responseFormat = response_format;
    if (workerCheck.error)
      return formatToolResponse(workerCheck.response, responseFormat, "graphitlive_find_referencing_files");

    const response = await invokeToolWithResponse<FindReferencingFilesResult>(
      "find_referencing_files",
      { targetPath },
    );

    return formatToolResponse(response, responseFormat, "graphitlive_find_referencing_files");
  },
);

// Tool: graphitlive_expand_node
server.registerTool(
  "graphitlive_expand_node",
  {
    title: "Expand Node Dependencies",
    description: `Returns the dependencies of one file that are not already in a set of paths you provide.

WHEN: exploring a large graph incrementally, or lazily loading one node at a time.
WHY: skips re-analysing what you already hold, so only newly discovered files come back.
RETURNS: the new nodes and edges only, with the same fields as crawl_dependency_graph.`,
    inputSchema: ExpandNodeParamsSchema.extend({
      response_format: ResponseFormatSchema.describe(
        "Output format: 'json', 'markdown', or 'toon' (Token-Oriented Object Notation for reduced token usage) (default: toon - RECOMMENDED for 30-60% token savings)",
      ),
    }),
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ filePath, knownPaths, extraDepth, response_format }) => {
    const workerCheck = await ensureWorkerReady();
    const responseFormat = response_format;
    if (workerCheck.error)
      return formatToolResponse(workerCheck.response, responseFormat, "graphitlive_expand_node");

    const response = await invokeToolWithResponse<ExpandNodeResult>(
      "expand_node",
      {
        filePath,
        knownPaths,
        extraDepth,
      },
    );

    return formatToolResponse(response, responseFormat, "graphitlive_expand_node");
  },
);

// Tool: graphitlive_parse_imports
server.registerTool(
  "graphitlive_parse_imports",
  {
    title: "Parse Raw Import Statements",
    description: `Returns the import statements of one file exactly as written, without resolving them to paths.

WHEN: inspecting import style or alias usage, or debugging why a specifier fails to resolve.
WHY: regex-based, and extracts the script block from Vue/Svelte files first.
RETURNS: module specifier as written, import type, line number.
LIMITS: does not resolve paths - use graphitlive_analyze_dependencies for resolved targets.`,
    inputSchema: ParseImportsParamsSchema.extend({
      response_format: ResponseFormatSchema.describe(
        "Output format: 'json', 'markdown', or 'toon' (Token-Oriented Object Notation for reduced token usage) (default: toon - RECOMMENDED for 30-60% token savings)",
      ),
    }),
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ filePath, response_format }) => {
    const workerCheck = await ensureWorkerReady();
    const responseFormat = response_format;
    if (workerCheck.error)
      return formatToolResponse(workerCheck.response, responseFormat, "graphitlive_parse_imports");

    const response = await invokeToolWithResponse<ParseImportsResult>(
      "parse_imports",
      { filePath },
    );

    return formatToolResponse(response, responseFormat, "graphitlive_parse_imports");
  },
);

// Tool: graphitlive_verify_dependency_usage
server.registerTool(
  "graphitlive_verify_dependency_usage",
  {
    title: "Verify Dependency Usage",
    description: `Reports whether a source file actually uses any symbol from a target file it imports.

WHEN: identifying unused imports, or confirming a dependency edge is real before acting on it.
WHY: AST analysis of actual references, so an import that is never used is distinguished from one that is.
RETURNS: boolean.`,
    inputSchema: VerifyDependencyUsageParamsSchema.extend({
      response_format: ResponseFormatSchema.describe(
        "Output format: 'json', 'markdown', or 'toon' (Token-Oriented Object Notation for reduced token usage) (default: toon - RECOMMENDED for 30-60% token savings)",
      ),
    }),
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ sourceFile, targetFile, response_format }) => {
    const workerCheck = await ensureWorkerReady();
    const responseFormat = response_format;
    if (workerCheck.error)
      return formatToolResponse(workerCheck.response, responseFormat, "graphitlive_verify_dependency_usage");

    const response = await invokeToolWithResponse<unknown>(
      "verify_dependency_usage",
      {
        sourceFile,
        targetFile,
      },
    );

    return formatToolResponse(response, responseFormat, "graphitlive_verify_dependency_usage");
  },
);

// Tool: graphitlive_resolve_module_path
server.registerTool(
  "graphitlive_resolve_module_path",
  {
    title: "Resolve Module Specifier to File Path",
    description: `Resolves one module specifier, as seen from a given file, to a path on disk.

WHEN: "where does this import point", or debugging alias and extension resolution.
WHY: applies tsconfig path aliases, implicit extensions (.ts, .tsx, .js, .jsx, .vue, .svelte, .gql) and index-file resolution.
RETURNS: resolved absolute path and whether it lies inside the workspace, or null for an unresolvable or external module.`,
    inputSchema: ResolveModulePathParamsSchema.extend({
      response_format: ResponseFormatSchema.describe(
        "Output format: 'json', 'markdown', or 'toon' (Token-Oriented Object Notation for reduced token usage) (default: toon - RECOMMENDED for 30-60% token savings)",
      ),
    }),
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ fromFile, moduleSpecifier, response_format }) => {
    const workerCheck = await ensureWorkerReady();
    const responseFormat = response_format;
    if (workerCheck.error)
      return formatToolResponse(workerCheck.response, responseFormat, "graphitlive_resolve_module_path");

    const response = await invokeToolWithResponse<ResolveModulePathResult>(
      "resolve_module_path",
      { fromFile, moduleSpecifier },
    );

    return formatToolResponse(response, responseFormat, "graphitlive_resolve_module_path");
  },
);

// Tool: graphitlive_get_index_status
server.registerTool(
  "graphitlive_get_index_status",
  {
    title: "Get Dependency Index Status",
    description: `Reports the state of the dependency index backing the other tools.

WHEN: checking readiness before a large analysis, or explaining unexpectedly empty results.
WHY: distinguishes "no results" from "index not built yet".
RETURNS: index state, files indexed, reverse-index statistics, cache size and hit rate, warmup completion and duration.`,
    inputSchema: z.object({
      response_format: ResponseFormatSchema.describe(
        "Output format: 'json', 'markdown', or 'toon' (Token-Oriented Object Notation for reduced token usage) (default: toon - RECOMMENDED for 30-60% token savings)",
      ),
    }),
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ response_format }) => {
    const workerCheck = await ensureWorkerReady();
    const responseFormat = response_format;
    if (workerCheck.error)
      return formatToolResponse(workerCheck.response, responseFormat, "graphitlive_get_index_status");

    const response = await invokeToolWithResponse<GetIndexStatusResult>(
      "get_index_status",
      {},
    );

    return formatToolResponse(response, responseFormat, "graphitlive_get_index_status");
  },
);

// Tool: graphitlive_invalidate_files
server.registerTool(
  "graphitlive_invalidate_files",
  {
    title: "Invalidate File Cache",
    description: `Drops the cached analysis for specific files so the next query re-reads them.

WHEN: after editing files outside the watched workspace, when results look stale.
WHY: analysis is cached per file; the cache is otherwise refreshed by the file watcher.
RETURNS: how many files were invalidated, which were cleared, and which held no cache entry.`,
    inputSchema: InvalidateFilesParamsSchema.extend({
      response_format: ResponseFormatSchema.describe(
        "Output format: 'json', 'markdown', or 'toon' (Token-Oriented Object Notation for reduced token usage) (default: toon - RECOMMENDED for 30-60% token savings)",
      ),
    }),
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ filePaths, response_format }) => {
    const workerCheck = await ensureWorkerReady();
    const responseFormat = response_format;
    if (workerCheck.error)
      return formatToolResponse(workerCheck.response, responseFormat, "graphitlive_invalidate_files");

    const response = await invokeToolWithResponse<InvalidateFilesResult>(
      "invalidate_files",
      {
        filePaths,
      },
    );

    return formatToolResponse(response, responseFormat, "graphitlive_invalidate_files");
  },
);

// Tool: graphitlive_rebuild_index
server.registerTool(
  "graphitlive_rebuild_index",
  {
    title: "Rebuild Full Dependency Index",
    description: `Clears all cached analysis and re-indexes the whole workspace.

WHEN: after a branch switch or large refactor when the index no longer matches the tree; invalidate_files is enough for a few files.
WHY: restores a graph that is consistent with what is on disk.
RETURNS: files re-indexed, duration, new cache size and reverse-index statistics.
LIMITS: takes seconds on a large workspace.`,
    inputSchema: z.object({
      response_format: ResponseFormatSchema.describe(
        "Output format: 'json', 'markdown', or 'toon' (Token-Oriented Object Notation for reduced token usage) (default: toon - RECOMMENDED for 30-60% token savings)",
      ),
    }),
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ response_format }) => {
    const workerCheck = await ensureWorkerReady();
    const responseFormat = response_format;
    if (workerCheck.error)
      return formatToolResponse(workerCheck.response, responseFormat, "graphitlive_rebuild_index");

    const response = await invokeToolWithResponse<RebuildIndexResult>(
      "rebuild_index",
      {},
    );

    return formatToolResponse(response, responseFormat, "graphitlive_rebuild_index");
  },
);

// Tool: graphitlive_get_symbol_graph
server.registerTool(
  "graphitlive_get_symbol_graph",
  {
    title: "Get Symbol-Level Dependency Graph",
    description: `Lists the symbols a file exports and the symbols OUTSIDE the file that each of them depends on.

WHEN: "which function in this file calls the database / uses X", scoping a refactor to one symbol rather than the whole file.
WHY: ts-morph AST parsing, so import aliases are tracked back to their original names and type-only imports are separated from runtime ones.
RETURNS: exported symbols (name, kind, line, category) and symbol-to-symbol edges tagged runtime or type-only.
NOT THIS TOOL: for calls between symbols defined in the same file, use graphitlive_analyze_file_logic. This tool crosses the file boundary outward; that one stays inside it.
For an open-ended question, start with graphitlive_graph_context and come here when you need this specific cut.`,
    inputSchema: GetSymbolGraphParamsSchema.extend({
      response_format: ResponseFormatSchema.describe(
        "Output format: 'json', 'markdown', or 'toon' (Token-Oriented Object Notation for reduced token usage) (default: toon - RECOMMENDED for 30-60% token savings)",
      ),
    }),
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ filePath, response_format }) => {
    const workerCheck = await ensureWorkerReady();
    const responseFormat = response_format;
    if (workerCheck.error)
      return formatToolResponse(workerCheck.response, responseFormat, "graphitlive_get_symbol_graph");

    const response = await invokeToolWithResponse<GetSymbolGraphResult>(
      "get_symbol_graph",
      { filePath },
    );

    return formatToolResponse(response, responseFormat, "graphitlive_get_symbol_graph");
  },
);

// Tool: graphitlive_find_unused_symbols
server.registerTool(
  "graphitlive_find_unused_symbols",
  {
    title: "Find Dead Code (Unused Exports)",
    description: `Lists the symbols a file exports that nothing else in the workspace imports.

WHEN: dead-code cleanup in one file, or checking which parts of an API are consumed.
WHY: cross-references the file's exports against the reverse index, then widens the used set through the file's internal call graph so a symbol reached only indirectly is not reported.
RETURNS: unused exported symbols (name, kind, line, category), unused and total counts, unused percentage.
LIMITS: an export reached only through a dynamic or string-keyed lookup can still be reported as unused; confirm before deleting.`,
    inputSchema: FindUnusedSymbolsParamsSchema.extend({
      response_format: ResponseFormatSchema.describe(
        "Output format: 'json', 'markdown', or 'toon' (Token-Oriented Object Notation for reduced token usage) (default: toon - RECOMMENDED for 30-60% token savings)",
      ),
    }),
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ filePath, response_format }) => {
    const workerCheck = await ensureWorkerReady();
    const responseFormat = response_format;
    if (workerCheck.error)
      return formatToolResponse(workerCheck.response, responseFormat, "graphitlive_find_unused_symbols");

    const response = await invokeToolWithResponse<FindUnusedSymbolsResult>(
      "find_unused_symbols",
      { filePath },
    );

    return formatToolResponse(response, responseFormat, "graphitlive_find_unused_symbols");
  },
);

// Tool: graphitlive_get_symbol_dependents
server.registerTool(
  "graphitlive_get_symbol_dependents",
  {
    title: "Find All Callers of a Symbol (Impact Analysis)",
    description: `Lists the symbols that use one given symbol - one hop, computed from source at call time.

WHEN: changing a signature and needing every call site, or assessing the blast radius of a symbol-level change.
WHY: re-reads the referencing files instead of a cached index, so it reflects edits the index has not absorbed yet.
RETURNS: caller symbol id, file path and workspace-relative path per dependent, plus a total count.
PICKING BETWEEN THE THREE: this one for fresh single-hop edges; graphitlive_get_symbol_callers for the fast indexed lookup with a runtime versus type-only split; graphitlive_query_call_graph for multi-hop traversal, callees, or relation types.`,
    inputSchema: GetSymbolDependentsParamsSchema.extend({
      response_format: ResponseFormatSchema.describe(
        "Output format: 'json', 'markdown', or 'toon' (Token-Oriented Object Notation for reduced token usage) (default: toon - RECOMMENDED for 30-60% token savings)",
      ),
    }),
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ filePath, symbolName, response_format }) => {
    const workerCheck = await ensureWorkerReady();
    const responseFormat = response_format;
    if (workerCheck.error)
      return formatToolResponse(workerCheck.response, responseFormat, "graphitlive_get_symbol_dependents");

    const response = await invokeToolWithResponse<GetSymbolDependentsResult>(
      "get_symbol_dependents",
      {
        filePath,
        symbolName,
      },
    );

    return formatToolResponse(response, responseFormat, "graphitlive_get_symbol_dependents");
  },
);

// Tool: graphitlive_trace_function_execution
server.registerTool(
  "graphitlive_trace_function_execution",
  {
    title: "Trace Function Execution Chain",
    description: `Follows the call chain outward from one symbol, recursively, across files.

WHEN: tracing a request through controller, service and repository, or mapping what a feature actually reaches.
WHY: follows calls through multiple files instead of stopping at direct dependencies; stops at external modules, at maxDepth, or on a cycle.
RETURNS: root symbol, call chain entries (depth, caller, callee, resolved path), visited symbols, and whether maxDepth was hit.
For an open-ended question, start with graphitlive_graph_context and come here when you need this specific cut.`,
    inputSchema: TraceFunctionExecutionParamsSchema.extend({
      response_format: ResponseFormatSchema.describe(
        "Output format: 'json', 'markdown', or 'toon' (Token-Oriented Object Notation for reduced token usage) (default: toon - RECOMMENDED for 30-60% token savings)",
      ),
    }),
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ filePath, symbolName, maxDepth, response_format }) => {
    const workerCheck = await ensureWorkerReady();
    const responseFormat = response_format;
    if (workerCheck.error)
      return formatToolResponse(workerCheck.response, responseFormat, "graphitlive_trace_function_execution");

    const response = await invokeToolWithResponse<TraceFunctionExecutionResult>(
      "trace_function_execution",
      {
        filePath,
        symbolName,
        maxDepth,
      },
    );

    return formatToolResponse(response, responseFormat, "graphitlive_trace_function_execution");
  },
);

// Tool: graphitlive_get_symbol_callers
server.registerTool(
  "graphitlive_get_symbol_callers",
  {
    title: "Get Symbol Callers (Reverse Dependencies)",
    description: `Lists the symbols that call one given symbol - one hop, from a prebuilt reverse index.

WHEN: the plain question "who calls X" or "where is X used"; finding call sites before a rename; spotting a symbol with no callers.
WHY: O(1) lookup in the symbol reverse index, and the only tool of the three that separates runtime calls from type-only references.
RETURNS: caller file path, symbol name, line, and usage type (runtime or type-only), nearest first.
PICKING BETWEEN THE THREE: this one for a single hop with the runtime/type-only split; graphitlive_get_symbol_dependents for a single hop computed fresh from source as dependency edges; graphitlive_query_call_graph when you need more than one hop, callees as well as callers, or relation types such as INHERITS and IMPLEMENTS.`,
    inputSchema: GetSymbolCallersParamsSchema.extend({
      response_format: ResponseFormatSchema.describe(
        "Output format: 'json', 'markdown', or 'toon' (Token-Oriented Object Notation for reduced token usage) (default: toon - RECOMMENDED for 30-60% token savings)",
      ),
    }),
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ filePath, symbolName, includeTypeOnly, response_format }) => {
    const workerCheck = await ensureWorkerReady();
    const responseFormat = response_format;
    if (workerCheck.error)
      return formatToolResponse(workerCheck.response, responseFormat, "graphitlive_get_symbol_callers");

    const response = await invokeToolWithResponse<GetSymbolCallersResult>(
      "get_symbol_callers",
      {
        filePath,
        symbolName,
        includeTypeOnly,
      },
    );

    return formatToolResponse(response, responseFormat, "graphitlive_get_symbol_callers");
  },
);

// Tool: graphitlive_analyze_breaking_changes
server.registerTool(
  "graphitlive_analyze_breaking_changes",
  {
    title: "Analyze Breaking Changes in Signature",
    description: `Compares two versions of a file and reports which signature changes break callers.

WHEN: validating an edit before committing, or writing migration notes for an API change.
WHY: diffs the parsed signatures rather than the text, so added optional parameters are separated from breaking ones.
RETURNS: breaking changes with kind and description, severity, suggested migration steps, and the callers that need updating.
DETECTS: added required parameter, removed parameter, changed parameter type, changed return type, parameter reordering.`,
    inputSchema: AnalyzeBreakingChangesParamsSchema.extend({
      response_format: ResponseFormatSchema.describe(
        "Output format: 'json', 'markdown', or 'toon' (Token-Oriented Object Notation for reduced token usage) (default: toon - RECOMMENDED for 30-60% token savings)",
      ),
    }),
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ filePath, symbolName, oldContent, newContent, response_format }) => {
    const workerCheck = await ensureWorkerReady();
    const responseFormat = response_format;
    if (workerCheck.error)
      return formatToolResponse(workerCheck.response, responseFormat, "graphitlive_analyze_breaking_changes");

    const response = await invokeToolWithResponse<AnalyzeBreakingChangesResult>(
      "analyze_breaking_changes",
      {
        filePath,
        symbolName,
        oldContent,
        newContent,
      },
    );

    return formatToolResponse(response, responseFormat, "graphitlive_analyze_breaking_changes");
  },
);

// Tool: graphitlive_review_pr
server.registerTool(
  "graphitlive_review_pr",
  {
    title: "Review Pull Request Diff",
    description: `Reviews a local Git diff and reports the risk it carries, with per-symbol evidence.

WHEN: before opening a pull request, or as a CI gate.
WHY: combines the parsed signatures of both revisions with the workspace index, so signature changes are scored against their real callers.
RETURNS: deterministic risk level, per-symbol evidence, impact counts, and an explicit list of what could not be analysed.`,
    inputSchema: ReviewPrParamsSchema.extend({
      response_format: ResponseFormatSchema.describe("Output format: 'json', 'markdown', or 'toon'"),
    }),
    outputSchema: McpToolResponseSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ baseRef, headRef, maxFiles, maxDepth, response_format }) => {
    const workerCheck = await ensureWorkerReady();
    const responseFormat = response_format;
    if (workerCheck.error) {
      return formatToolResponse(workerCheck.response, responseFormat, "graphitlive_review_pr");
    }
    const response = await invokeToolWithResponse<ReviewPrResult>("review_pr", { baseRef, headRef, maxFiles, maxDepth });
    return formatToolResponse(response, responseFormat, "graphitlive_review_pr");
  },
);

// Tool: graphitlive_get_impact_analysis
server.registerTool(
  "graphitlive_get_impact_analysis",
  {
    title: "Get Comprehensive Impact Analysis",
    description: `Reports everything affected by changing one symbol, direct and transitive.

WHEN: assessing a refactor before starting it, or prioritising which call sites to update first.
WHY: walks the symbol reverse index outward, keeping runtime and type-only impact separate and aggregating per file.
RETURNS: impact level (high, medium, low), total impact count, runtime versus type-only breakdown, impacted symbols with depth (1 = direct), affected files, and a written summary.
For an open-ended question, start with graphitlive_graph_context and come here when you need this specific cut.`,
    inputSchema: GetImpactAnalysisParamsSchema.extend({
      response_format: ResponseFormatSchema.describe(
        "Output format: 'json', 'markdown', or 'toon' (Token-Oriented Object Notation for reduced token usage) (default: toon - RECOMMENDED for 30-60% token savings)",
      ),
    }),
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({
    filePath,
    symbolName,
    includeTransitive,
    maxDepth,
    response_format,
  }) => {
    const workerCheck = await ensureWorkerReady();
    const responseFormat = response_format;
    if (workerCheck.error)
      return formatToolResponse(workerCheck.response, responseFormat, "graphitlive_get_impact_analysis");

    const response = await invokeToolWithResponse<GetImpactAnalysisResult>(
      "get_impact_analysis",
      {
        filePath,
        symbolName,
        includeTransitive,
        maxDepth,
      },
    );

    return formatToolResponse(response, responseFormat, "graphitlive_get_impact_analysis");
  },
);

// Tool: graphitlive_analyze_file_logic
server.registerTool(
  "graphitlive_analyze_file_logic",
  {
    title: "Analyze File Logic & Call Hierarchy",
    description: `Returns the call hierarchy among the symbols defined INSIDE one file, ignoring anything it imports.

WHEN: understanding how a file works internally, or spotting recursion before a refactor.
WHY: call hierarchy from the language server, so calls are resolved by the compiler rather than matched by name.
RETURNS: nodes (symbol id, type, export status, line range), call edges with line numbers, and cycle detection with the symbols involved.
NOT THIS TOOL: for what this file's symbols reach in OTHER files, use graphitlive_get_symbol_graph.
SUPPORTS: TypeScript, JavaScript, Python, Rust (needs the language server extension).
For an open-ended question, start with graphitlive_graph_context and come here when you need this specific cut.`,
    inputSchema: z.object({
      filePath: z.string().describe("Absolute path to the file to analyze"),
      includeExternal: z
        .boolean()
        .optional()
        .describe("Include external calls (default: false - intra-file only)"),
      response_format: ResponseFormatSchema.describe(
        "Output format: 'json', 'markdown', or 'toon' (default: toon - RECOMMENDED for 30-60% token savings)",
      ),
    }),
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ filePath, includeExternal, response_format }) => {
    const workerCheck = await ensureWorkerReady();
    const responseFormat = response_format;
    if (workerCheck.error)
      return formatToolResponse(workerCheck.response, responseFormat, "graphitlive_analyze_file_logic");

    const response = await invokeToolWithResponse("analyze_file_logic", {
      filePath,
      includeExternal: includeExternal ?? false,
    });

    return formatToolResponse(response, responseFormat, "graphitlive_analyze_file_logic");
  },
);

// Tool: graphitlive_generate_codemap
server.registerTool(
  "graphitlive_generate_codemap",
  {
    title: "Generate File Codemap",
    description: `Returns one file's exports, internals, dependencies, dependents and internal call flow in a single call.

WHEN: getting oriented in an unfamiliar file, or gathering the full context of a file before refactoring it.
WHY: one call in place of analyze_dependencies, get_symbol_graph, find_referencing_files and analyze_file_logic together.
RETURNS: path, language, line count, exported and internal symbols, dependencies, dependents, intra-file call flow, cycle detection.
SUPPORTS: TypeScript, JavaScript, Python, Rust, Vue, Svelte.`,
    inputSchema: z.object({
      filePath: z.string().describe("Absolute path to the file to generate a codemap for"),
      response_format: ResponseFormatSchema.describe(
        "Output format: 'json', 'markdown', or 'toon' (default: toon - RECOMMENDED for 30-60% token savings)",
      ),
    }),
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ filePath, response_format }) => {
    const workerCheck = await ensureWorkerReady();
    const responseFormat = response_format;
    if (workerCheck.error)
      return formatToolResponse(workerCheck.response, responseFormat, "graphitlive_generate_codemap");

    const response = await invokeToolWithResponse("generate_codemap", {
      filePath,
    });

    return formatToolResponse(response, responseFormat, "graphitlive_generate_codemap");
  },
);

// Tool: graphitlive_query_call_graph
server.registerTool(
  "graphitlive_query_call_graph",
  {
    title: "Query Cross-File Call Graph",
    description: `Traces calls across files for several hops, in either direction, from a SQLite-backed call graph.

WHEN: multi-hop traversal ("three levels deep"), callees as well as callers, relation types beyond plain calls, or cycle detection across modules.
WHY: built from tree-sitter AST analysis, so it holds real call edges (CALLS, INHERITS, IMPLEMENTS, USES) rather than import edges.
RETURNS: the matched symbol, its callers and callees with file and line, relation type, and a cyclic flag per edge.
PICKING BETWEEN THE THREE: this one once you need depth, direction or relation types; graphitlive_get_symbol_callers for a fast single-hop "who calls X"; graphitlive_get_symbol_dependents for a single hop computed fresh from source.
LIMITS: the first call indexes the workspace (3-8s); later queries are fast.`,
    inputSchema: QueryCallGraphParamsSchema.extend({
      response_format: ResponseFormatSchema.describe(
        "Output format: 'json', 'markdown', or 'toon' (default: toon - RECOMMENDED for 30-60% token savings)",
      ),
    }),
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ filePath, symbolName, direction, depth, relationTypes, response_format }) => {
    const workerCheck = await ensureWorkerReady();
    const responseFormat = response_format;
    if (workerCheck.error)
      return formatToolResponse(workerCheck.response, responseFormat, "graphitlive_query_call_graph");

    const response = await invokeToolWithResponse(
      "query_call_graph",
      { filePath, symbolName, direction, depth, relationTypes },
    );

    return formatToolResponse(response, responseFormat, "graphitlive_query_call_graph");
  },
);

// Tool: graphitlive_scan_dead_code
server.registerTool(
  "graphitlive_scan_dead_code",
  {
    title: "Scan Workspace for Dead Code",
    description: `Lists the unused exported symbols across a whole workspace or directory.

WHEN: auditing code quality, or cleaning up before a refactor; use find_unused_symbols for a single file.
WHY: combines the reverse index with per-file symbol analysis, so the scan stays linear instead of comparing every file against every other.
RETURNS: files scanned, files holding dead code, total unused symbols, per-file unused symbol lists, scan duration.
LIMITS: needs background indexing to have finished; an export reached only through a dynamic lookup can still be listed.`,
    inputSchema: ScanDeadCodeParamsSchema.extend({
      response_format: ResponseFormatSchema.describe(
        "Output format: 'json', 'markdown', or 'toon' (default: toon)",
      ),
    }),
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ scopePath, maxFiles, response_format }) => {
    const workerCheck = await ensureWorkerReady();
    const responseFormat = response_format;
    if (workerCheck.error)
      return formatToolResponse(workerCheck.response, responseFormat, "graphitlive_scan_dead_code");

    const response = await invokeToolWithResponse(
      "scan_dead_code",
      { scopePath, maxFiles },
    );

    return formatToolResponse(response, responseFormat, "graphitlive_scan_dead_code");
  },
);

// Tool: graphitlive_graph_context
server.registerTool(
  "graphitlive_graph_context",
  {
    title: "Retrieve Unified Graph Context",
    description: `Returns a token-bounded subgraph answering a question about the codebase - the default entry point for graph questions.

WHEN: any question spanning file dependencies, symbol calls, implementations, tests or impact; reach for a specialised tool only when this cannot express the cut you need.
WHY: one deterministic gateway over the same index the specialised tools use, with an explicit token budget so large graphs come back bounded instead of truncated arbitrarily.
MODES: search, neighbors, path, impact, refactor, overview.
RETURNS: nodes and edges with workspace-relative paths, an index revision and a freshness flag, and a cursor when results are paginated.`,
    inputSchema: GraphContextParamsSchema,
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ response_format, ...params }) => {
    const responseFormat = response_format ?? "toon";
    const workerCheck = await ensureWorkerReady();
    if (workerCheck.error) {
      return formatToolResponse(
        workerCheck.response,
        responseFormat,
        "graphitlive_graph_context",
      );
    }

    const response = await invokeToolWithResponse<GraphContextResponse>(
      "graph_context",
      params,
    );
    return formatToolResponse(response, responseFormat, "graphitlive_graph_context", params.detail);
  },
);

// Tool: graphitlive_query_natural_language
server.registerTool(
  "graphitlive_query_natural_language",
  {
    title: "Query Codebase with Natural Language",
    description: `Returns the subgraph relevant to a plain-language question, for you to turn into an answer.

WHEN: exploring a codebase from a concept rather than a known file or symbol name.
WHY: extracts keywords, scores seed nodes with full-text search over the call graph index, then traverses outward from them.
RETURNS: the question, the extracted keywords, the subgraph, and timing and truncation metadata.
LIMITS: returns graph data, not prose - you write the answer from it. The first call indexes the workspace (3-8s).`,
    inputSchema: QueryNaturalLanguageParamsSchema.extend({
      response_format: ResponseFormatSchema.describe(
        "Output format: 'json', 'markdown', or 'toon' (default: toon - RECOMMENDED for 30-60% token savings)",
      ),
    }),
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ question, depth, tokenBudget, fileFilter, outputFormat, response_format }) => {
    const workerCheck = await ensureWorkerReady();
    const responseFormat = response_format;
    if (workerCheck.error)
      return formatToolResponse(workerCheck.response, responseFormat, "graphitlive_query_natural_language");

    const response = await invokeToolWithResponse(
      "query_natural_language",
      { question, depth, tokenBudget, fileFilter, outputFormat },
    );

    return formatToolResponse(response, responseFormat, "graphitlive_query_natural_language");
  },
);

// Tool: graphitlive_generate_wiki
server.registerTool(
  "graphitlive_generate_wiki",
  {
    title: "Generate Markdown Wiki from Call Graph",
    description: `Writes a navigable markdown wiki of the workspace from the call graph index.

WHEN: producing browsable documentation, or a persistent overview of files and their relationships.
WHY: one article per source file, cross-linked through real caller and callee edges.
RETURNS: number of articles written, index path, articles directory, and the top files by hub score.
LIMITS: writes files to disk. The first call indexes the workspace (3-8s).`,
    inputSchema: GenerateWikiSchema.extend({
      response_format: ResponseFormatSchema.describe(
        "Output format: 'json', 'markdown', or 'toon' (default: json). scope and exclude filtering is applied before generation — limitations are documented in the generated wiki itself.",
      ),
    }),
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ workspaceRoot, outputDir, topHubsLimit, scope, exclude, response_format }) => {
    const workerCheck = await ensureWorkerReady();
    const responseFormat = response_format;
    if (workerCheck.error)
      return formatToolResponse(workerCheck.response, responseFormat, "graphitlive_generate_wiki");

    const response = await invokeToolWithResponse(
      "generate_wiki",
      { workspaceRoot, outputDir, topHubsLimit, scope, exclude },
    );

    return formatToolResponse(response, responseFormat, "graphitlive_generate_wiki");
  },
);

// Tool: graphitlive_get_session_stats
// Runs in the server process (no worker needed): the sessionStats singleton
// is populated by responseFormatter in this same process.
server.registerTool(
  "graphitlive_get_session_stats",
  {
    title: "Get Session Token Stats",
    description: `Reports how large this session's TOON responses were against their JSON equivalent, plus real token usage.

WHEN: asked how much the TOON encoding is saving, or for a summary of tool usage.
WHY: encoding sizes are estimated (characters / 4); provider-reported LLM usage is reported separately and never mixed into that estimate.
RETURNS: per-tool and total encoding sizes for this session, llmUsage as its own section, and per-source history.
LIMITS: compares two encodings of the same data - not a saving attributable to the tools themselves.`,
    inputSchema: GetSessionStatsSchema,
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const startTime = Date.now();
    const result = executeGetSessionStats();
    const response = createSuccessResponse<GetSessionStatsResult>(
      result,
      Date.now() - startTime,
      getWorkspaceRoot(),
    );
    // Always JSON: stats output is small and must stay exact (no TOON re-encoding).
    return formatToolResponse(response, "json", "graphitlive_get_session_stats");
  },
);

// ============================================================================
// Server Startup
// ============================================================================

async function main(): Promise<void> {
  debugLog("[McpServer] Graph-It-Live MCP Server starting...");
  debugLog(
    `[McpServer] Workspace: ${getWorkspaceRoot() || "(not configured - use graphitlive_set_workspace)"}`,
  );
  debugLog(
    `[McpServer] TSConfig: ${currentConfig.tsConfigPath ?? "auto-detect"}`,
  );
  debugLog(
    `[McpServer] Exclude node_modules: ${currentConfig.excludeNodeModules}`,
  );
  debugLog(`[McpServer] Max depth: ${currentConfig.maxDepth}`);

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  debugLog("[McpServer] MCP Server connected via stdio");

  // Start warmup immediately in background
  initializeWorker().catch((error) => {
    debugLog(`[McpServer] Background warmup failed: ${error}`);
  });

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    debugLog("[McpServer] Received SIGINT, shutting down...");
    flushStatsOnce();
    void workerHost?.dispose().then(() => process.exit(0)).catch(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    debugLog("[McpServer] Received SIGTERM, shutting down...");
    flushStatsOnce();
    void workerHost?.dispose().then(() => process.exit(0)).catch(() => process.exit(0));
  });

  // Covers stdio transport close / normal exit paths (flushStatsOnce is idempotent).
  process.on("exit", () => {
    flushStatsOnce();
  });
}

// Run main - IIFE pattern for entry point (NOSONAR: top-level await not supported by tsconfig)
main().catch((error: unknown) => {// NOSONAR
  debugLog(`[McpServer] Fatal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
