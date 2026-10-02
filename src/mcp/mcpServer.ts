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
import { mcpToolDescription } from "./toolDescriptions";
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
  FindReferencingFilesParamsSchema,
  type FindReferencingFilesResult,
  FindUnusedSymbolsParamsSchema,
  type FindUnusedSymbolsResult,
  GetImpactAnalysisParamsSchema,
  type GetImpactAnalysisResult,
  GraphContextParamsSchema,
  type GetIndexStatusResult,
  GetSymbolGraphParamsSchema,
  type GetSymbolGraphResult,
  InvalidateFilesParamsSchema,
  type InvalidateFilesResult,
  MCP_TOOL_VERSION,
  type McpToolResponse,
  type PaginationInfo,
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
  extensionPath: process.env.EXTENSION_PATH ?? path.resolve(__dirname, ".."),
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
        shareIndexCache: true,
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
// Rate limiting for expensive/destructive tools (in-memory sliding window)
// Bounds repeated full re-index / cache-invalidation calls that would
// otherwise saturate CPU/IO in this single stdio process (M2/M5 security audit).
// ============================================================================
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX_CALLS: Record<string, number> = {
  set_workspace: 5,
  rebuild_index: 5,
  invalidate_files: 20,
};
const rateLimitCallTimestamps = new Map<string, number[]>();

function checkRateLimit(tool: string): string | null {
  const max = RATE_LIMIT_MAX_CALLS[tool];
  if (max === undefined) return null;

  const now = Date.now();
  const recentCalls = (rateLimitCallTimestamps.get(tool) ?? []).filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
  );

  if (recentCalls.length >= max) {
    return `Rate limit exceeded: max ${max} calls per ${RATE_LIMIT_WINDOW_MS / 1000}s for ${tool}. Wait before retrying.`;
  }

  recentCalls.push(now);
  rateLimitCallTimestamps.set(tool, recentCalls);
  return null;
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
    description: mcpToolDescription("set_workspace"),
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

    const rateLimitError = checkRateLimit("set_workspace");
    if (rateLimitError) {
      return formatToolResponse(
        createSetWorkspaceErrorResponse(
          workspacePath,
          previousWorkspace,
          rateLimitError,
          startTime,
        ),
        responseFormat,
        "graphitlive_set_workspace",
      );
    }

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
    description: mcpToolDescription("analyze_dependencies"),
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
    description: mcpToolDescription("crawl_dependency_graph"),
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
  async ({ entryFile, maxDepth, limit, offset, onlyUsed, tokenBudget, response_format }) => {
    const workerCheck = await ensureWorkerReady();
    const responseFormat = response_format;
    if (workerCheck.error)
      return formatToolResponse(workerCheck.response, responseFormat, "graphitlive_crawl_dependency_graph");

    const params = { entryFile, maxDepth, limit, offset, onlyUsed, tokenBudget };
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
    description: mcpToolDescription("find_referencing_files"),
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

// Tool: graphitlive_verify_dependency_usage
server.registerTool(
  "graphitlive_verify_dependency_usage",
  {
    title: "Verify Dependency Usage",
    description: mcpToolDescription("verify_dependency_usage"),
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
    description: mcpToolDescription("resolve_module_path"),
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
    description: mcpToolDescription("get_index_status"),
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
    description: mcpToolDescription("invalidate_files"),
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
    const responseFormat = response_format;
    const rateLimitError = checkRateLimit("invalidate_files");
    if (rateLimitError) {
      return formatToolResponse(
        createErrorResponse<InvalidateFilesResult>(rateLimitError, 0, getWorkspaceRoot()),
        responseFormat,
        "graphitlive_invalidate_files",
      );
    }

    const workerCheck = await ensureWorkerReady();
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
    description: mcpToolDescription("rebuild_index"),
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
    const responseFormat = response_format;
    const rateLimitError = checkRateLimit("rebuild_index");
    if (rateLimitError) {
      return formatToolResponse(
        createErrorResponse<RebuildIndexResult>(rateLimitError, 0, getWorkspaceRoot()),
        responseFormat,
        "graphitlive_rebuild_index",
      );
    }

    const workerCheck = await ensureWorkerReady();
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
    description: mcpToolDescription("get_symbol_graph"),
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
    description: mcpToolDescription("find_unused_symbols"),
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

// Tool: graphitlive_trace_function_execution
server.registerTool(
  "graphitlive_trace_function_execution",
  {
    title: "Trace Function Execution Chain",
    description: mcpToolDescription("trace_function_execution"),
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

// Tool: graphitlive_analyze_breaking_changes
server.registerTool(
  "graphitlive_analyze_breaking_changes",
  {
    title: "Analyze Breaking Changes in Signature",
    description: mcpToolDescription("analyze_breaking_changes"),
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
    description: mcpToolDescription("review_pr"),
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
    description: mcpToolDescription("get_impact_analysis"),
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

// Tool: graphitlive_generate_codemap
server.registerTool(
  "graphitlive_generate_codemap",
  {
    title: "Generate File Codemap",
    description: mcpToolDescription("generate_codemap"),
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
    description: mcpToolDescription("query_call_graph"),
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
  async ({ filePath, symbolName, direction, depth, relationTypes, includeTypeOnly, offset, tokenBudget, response_format }) => {
    const workerCheck = await ensureWorkerReady();
    const responseFormat = response_format;
    if (workerCheck.error)
      return formatToolResponse(workerCheck.response, responseFormat, "graphitlive_query_call_graph");

    const response = await invokeToolWithResponse(
      "query_call_graph",
      { filePath, symbolName, direction, depth, relationTypes, includeTypeOnly, offset, tokenBudget },
    );

    return formatToolResponse(response, responseFormat, "graphitlive_query_call_graph");
  },
);

// Tool: graphitlive_scan_dead_code
server.registerTool(
  "graphitlive_scan_dead_code",
  {
    title: "Scan Workspace for Dead Code",
    description: mcpToolDescription("scan_dead_code"),
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
    description: mcpToolDescription("graph_context"),
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
    description: mcpToolDescription("query_natural_language"),
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
    description: mcpToolDescription("generate_wiki"),
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
  async ({ outputDir, topHubsLimit, scope, exclude, response_format }) => {
    const workerCheck = await ensureWorkerReady();
    const responseFormat = response_format;
    if (workerCheck.error)
      return formatToolResponse(workerCheck.response, responseFormat, "graphitlive_generate_wiki");

    const response = await invokeToolWithResponse(
      "generate_wiki",
      { outputDir, topHubsLimit, scope, exclude },
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
    description: mcpToolDescription("get_session_stats"),
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
  const shutdown = (reason: string): void => {
    debugLog(`[McpServer] ${reason}, shutting down...`);
    flushStatsOnce();
    void workerHost?.dispose().then(() => process.exit(0)).catch(() => process.exit(0));
    if (!workerHost) process.exit(0);
  };
  process.on("SIGINT", () => shutdown("Received SIGINT"));
  process.on("SIGTERM", () => shutdown("Received SIGTERM"));
  // MCP stdio shutdown starts with the client closing stdin. Exiting here also
  // ends `graph-it serve`, whose parent may not forward signals (Windows).
  process.stdin.on("end", () => shutdown("stdin closed"));

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
