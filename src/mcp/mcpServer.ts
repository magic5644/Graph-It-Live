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
import { McpServer, type ToolAnnotations } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as path from "node:path";
import * as z from "zod/v4";
import { McpWorkerHost } from "./McpWorkerHost";
import { formatToolResponse, type ResponseFormat } from "./responseFormatter";
import { nextWorkspaceConfig } from "./shared/helpers";
import { mcpToolDescription, RESPONSE_FORMAT_DESCRIPTION, RESPONSE_FORMATS } from "./toolDescriptions";
import { schemaParameters, toolInputSchema } from "./paramIssues";
import {
  AnalyzeBreakingChangesParamsSchema,
  AnalyzeDependenciesParamsSchema,
  CheckArchitectureParamsSchema,
  CrawlDependencyGraphParamsSchema,
  type CrawlDependencyGraphResult,
  createErrorResponse,
  createSuccessResponse,
  ExploreArchitectureParamsSchema,
  ExportArchitectureDiagramParamsSchema,
  FindReferencingFilesParamsSchema,
  FindUnusedSymbolsParamsSchema,
  GenerateCodemapParamsSchema,
  GenerateWikiParamsSchema,
  GetImpactAnalysisParamsSchema,
  GetIndexStatusParamsSchema,
  type GetIndexStatusResult,
  GetSymbolGraphParamsSchema,
  GraphContextParamsObject,
  InvalidateFilesParamsSchema,
  MCP_SERVER_VERSION,
  MCP_TOOL_VERSION,
  type McpToolName,
  type McpToolResponse,
  QueryCallGraphParamsSchema,
  QueryNaturalLanguageParamsSchema,
  RebuildIndexParamsSchema,
  ResolveModulePathParamsSchema,
  ReviewPrParamsSchema,
  ScanDeadCodeParamsSchema,
  SetWorkspaceParamsSchema,
  type SetWorkspaceResult,
  TraceFunctionExecutionParamsSchema,
  validateFilePath,
  VerifyDependencyUsageParamsSchema,
} from "./types";
import type { GraphContextDetail } from "../shared/graph-context-types";
import { executeGetSessionStats, GetSessionStatsSchema, type GetSessionStatsResult } from "./tools/stats.js";
import { startPeriodicFlush } from "../analyzer/stats/statsPersistence";
import { findProjectRoot } from "../analyzer/utils/workspaceBoundary";
import { sessionStats } from "../shared/sessionStats";

// Session stats: this process is the MCP entry point.
sessionStats.setSource("mcp");

// Rewrites the session file shortly after activity; dispose() flushes on shutdown.
// flushSession is synchronous — safe inside signal/exit handlers.
const statsFlush = startPeriodicFlush(sessionStats, {
  onError: (error) =>
    debugLog(`[McpServer] Stats flush failed: ${error instanceof Error ? error.message : String(error)}`),
});

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

// Fallback logic for WORKSPACE_ROOT (only if set via env)
if (!currentConfig.workspaceRoot) {
  // Same rule as the CLI without --workspace: the nearest project root. Outside
  // any project (a home directory, /) no default is set, so nothing is indexed.
  const projectRoot = findProjectRoot(process.cwd());
  if (projectRoot) {
    currentConfig.workspaceRoot = projectRoot;
    debugLog(
      "[McpServer] WORKSPACE_ROOT not set, using the project root of the current working directory:",
      projectRoot,
    );
  } else {
    debugLog(
      "[McpServer] No workspace configured and no project marker at or above the working directory - use graphitlive_set_workspace tool to set workspace",
    );
  }
}

// Helper to get current workspace (may be empty if not configured)
function getWorkspaceRoot(): string {
  return currentConfig.workspaceRoot;
}

const ResponseFormatSchema = z
  .enum(RESPONSE_FORMATS)
  .default("toon")
  .describe(RESPONSE_FORMAT_DESCRIPTION);

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITES: ToolAnnotations = { ...READ_ONLY, readOnlyHint: false };
const DESTRUCTIVE: ToolAnnotations = { ...WRITES, destructiveHint: true };

// ============================================================================
// Server Setup
// ============================================================================

const server = new McpServer({
  name: "graph-it-live",
  version: MCP_SERVER_VERSION,
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
  if (!getWorkspaceRoot()) {
    throw new Error(
      "No workspace configured: the server was started outside a project. " +
        "Call graphitlive_set_workspace with the project directory, or set WORKSPACE_ROOT.",
    );
  }
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
    // Both grow with file count and have no file cap (dead-code scan: 12,000 files measured at 87 s).
    toolTimeouts: { scan_dead_code: 600_000, review_pr: 600_000 },
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
      // The root still in use: the refused path is shown relative to it.
      workspaceRoot: previousWorkspace,
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
const SetWorkspaceInputSchema = SetWorkspaceParamsSchema.safeExtend({ response_format: ResponseFormatSchema });
// This tool is special - it doesn't require the worker to be ready first
server.registerTool(
  "graphitlive_set_workspace",
  {
    title: "Set Workspace Directory",
    description: mcpToolDescription("set_workspace", schemaParameters(SetWorkspaceInputSchema)),
    inputSchema: toolInputSchema(SetWorkspaceInputSchema),
    annotations: WRITES,
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

    Object.assign(currentConfig, nextWorkspaceConfig(currentConfig, {
      workspaceRoot: workspacePath,
      tsConfigPath: resolvedTsConfigPath,
      excludeNodeModules,
      maxDepth,
    }));

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
        // cacheSize counts the in-memory analysis cache: empty after a cache
        // restore and capped on large workspaces.
        filesIndexed = statusResult.warmup.filesIndexed ?? statusResult.reverseIndexStats?.indexedFiles ?? 0;
      }

      const response: McpToolResponse<SetWorkspaceResult> = {
        success: true,
        data: {
          success: true,
          workspacePath,
          workspaceName: path.basename(workspacePath),
          filesIndexed,
          indexingTimeMs: executionTimeMs,
          previousWorkspace: previousWorkspace || undefined,
          // The basename, not the path: response redaction only rewrites whole path strings.
          message: `Workspace set to ${path.basename(workspacePath)}. Indexed ${filesIndexed} files in ${executionTimeMs}ms.`,
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

// Tool: graphitlive_crawl_dependency_graph
const CrawlInputSchema = CrawlDependencyGraphParamsSchema.safeExtend({ response_format: ResponseFormatSchema });
server.registerTool(
  "graphitlive_crawl_dependency_graph",
  {
    title: "Crawl Full Dependency Graph",
    description: mcpToolDescription("crawl_dependency_graph", schemaParameters(CrawlInputSchema)),
    inputSchema: toolInputSchema(CrawlInputSchema),
    annotations: READ_ONLY,
  },
  async ({ response_format, ...params }) => {
    const workerCheck = await ensureWorkerReady();
    if (workerCheck.error)
      return formatToolResponse(workerCheck.response, response_format, "graphitlive_crawl_dependency_graph");

    const response = await invokeToolWithResponse<CrawlDependencyGraphResult>("crawl_dependency_graph", params);
    const result = response.data;
    // Pagination info when limit/offset were used
    if (result && (params.limit !== undefined || params.offset !== undefined)) {
      const offset = params.offset ?? 0;
      response.pagination = {
        total: result.nodeCount,
        limit: params.limit ?? result.nodeCount,
        offset,
        hasMore: offset + result.nodes.length < result.nodeCount,
      };
    }
    return formatToolResponse(response, response_format, "graphitlive_crawl_dependency_graph");
  },
);

/** Tools whose handler only forwards its parameters to the worker. */
const WORKER_TOOLS: ReadonlyArray<{
  tool: McpToolName;
  title: string;
  schema: z.ZodObject;
  annotations: ToolAnnotations;
  /** Worker parameters derived from the validated ones, when the tool needs the response format. */
  toWorker?: (params: Record<string, unknown>, format: ResponseFormat) => Record<string, unknown>;
}> = [
  { tool: "analyze_dependencies", title: "Analyze File Dependencies", schema: AnalyzeDependenciesParamsSchema, annotations: READ_ONLY },
  { tool: "find_referencing_files", title: "Find Files That Import This File", schema: FindReferencingFilesParamsSchema, annotations: READ_ONLY },
  { tool: "verify_dependency_usage", title: "Verify Dependency Usage", schema: VerifyDependencyUsageParamsSchema, annotations: READ_ONLY },
  { tool: "resolve_module_path", title: "Resolve Module Specifier to File Path", schema: ResolveModulePathParamsSchema, annotations: READ_ONLY },
  { tool: "get_index_status", title: "Get Dependency Index Status", schema: GetIndexStatusParamsSchema, annotations: READ_ONLY },
  { tool: "invalidate_files", title: "Invalidate File Cache", schema: InvalidateFilesParamsSchema, annotations: DESTRUCTIVE },
  { tool: "rebuild_index", title: "Rebuild Full Dependency Index", schema: RebuildIndexParamsSchema, annotations: DESTRUCTIVE },
  { tool: "get_symbol_graph", title: "Get Symbol-Level Dependency Graph", schema: GetSymbolGraphParamsSchema, annotations: READ_ONLY },
  { tool: "find_unused_symbols", title: "Find Dead Code (Unused Exports)", schema: FindUnusedSymbolsParamsSchema, annotations: READ_ONLY },
  { tool: "trace_function_execution", title: "Trace Function Execution Chain", schema: TraceFunctionExecutionParamsSchema, annotations: READ_ONLY },
  { tool: "analyze_breaking_changes", title: "Analyze Breaking Changes in Signature", schema: AnalyzeBreakingChangesParamsSchema, annotations: READ_ONLY },
  { tool: "review_pr", title: "Review Pull Request Diff", schema: ReviewPrParamsSchema, annotations: READ_ONLY },
  { tool: "get_impact_analysis", title: "Get Comprehensive Impact Analysis", schema: GetImpactAnalysisParamsSchema, annotations: READ_ONLY },
  { tool: "generate_codemap", title: "Generate File Codemap", schema: GenerateCodemapParamsSchema, annotations: READ_ONLY },
  { tool: "query_call_graph", title: "Query Cross-File Call Graph", schema: QueryCallGraphParamsSchema, annotations: READ_ONLY },
  { tool: "scan_dead_code", title: "Scan Workspace for Dead Code", schema: ScanDeadCodeParamsSchema, annotations: READ_ONLY },
  { tool: "graph_context", title: "Retrieve Unified Graph Context", schema: GraphContextParamsObject, annotations: READ_ONLY },
  { tool: "explore_architecture", title: "Explore Grouped Architecture", schema: ExploreArchitectureParamsSchema, annotations: READ_ONLY },
  { tool: "check_architecture", title: "Check Architecture Rules", schema: CheckArchitectureParamsSchema, annotations: READ_ONLY },
  // Overwrites output, or architecture.<format> for a diagram over the inline cap.
  { tool: "export_architecture_diagram", title: "Export Architecture Diagram", schema: ExportArchitectureDiagramParamsSchema, annotations: DESTRUCTIVE },
  {
    tool: "query_natural_language",
    title: "Query Codebase with Natural Language",
    schema: QueryNaturalLanguageParamsSchema,
    annotations: READ_ONLY,
    // response_format is the only format knob: TOON gets the compact subgraph, json and markdown the full one.
    toWorker: (params, format) => ({ ...params, outputFormat: format === "toon" ? "toon" : "json" }),
  },
  { tool: "generate_wiki", title: "Generate Markdown Wiki from Call Graph", schema: GenerateWikiParamsSchema, annotations: WRITES },
];

for (const { tool, title, schema, annotations, toWorker } of WORKER_TOOLS) {
  const name = `graphitlive_${tool}`;
  const inputSchema = schema.safeExtend({ response_format: ResponseFormatSchema });
  server.registerTool(
    name,
    {
      title,
      description: mcpToolDescription(tool, schemaParameters(inputSchema)),
      inputSchema: toolInputSchema(inputSchema),
      annotations,
    },
    async (args) => {
      // The table loses each schema's own type: the validated arguments keep response_format.
      const { response_format, ...params } = args as { response_format: ResponseFormat } & Record<string, unknown>;
      const rateLimitError = checkRateLimit(tool);
      if (rateLimitError) {
        return formatToolResponse(createErrorResponse(rateLimitError, 0, getWorkspaceRoot()), response_format, name);
      }
      const workerCheck = await ensureWorkerReady();
      if (workerCheck.error) return formatToolResponse(workerCheck.response, response_format, name);

      const response = await invokeToolWithResponse(tool, toWorker ? toWorker(params, response_format) : params);
      return formatToolResponse(response, response_format, name, (params as { detail?: GraphContextDetail }).detail);
    },
  );
}

// Tool: graphitlive_get_session_stats
// Runs in the server process (no worker needed): the sessionStats singleton
// is populated by responseFormatter in this same process.
server.registerTool(
  "graphitlive_get_session_stats",
  {
    title: "Get Session Token Stats",
    description: mcpToolDescription("get_session_stats", ["response_format"]),
    inputSchema: toolInputSchema(GetSessionStatsSchema.safeExtend({ response_format: ResponseFormatSchema })),
    annotations: READ_ONLY,
  },
  ({ response_format }) => {
    const startTime = Date.now();
    const result = executeGetSessionStats();
    const response = createSuccessResponse<GetSessionStatsResult>(
      result,
      Date.now() - startTime,
      getWorkspaceRoot(),
    );
    return formatToolResponse(response, response_format, "graphitlive_get_session_stats");
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
    statsFlush.dispose();
    void workerHost?.dispose().then(() => process.exit(0)).catch(() => process.exit(0));
    if (!workerHost) process.exit(0);
  };
  process.on("SIGINT", () => shutdown("Received SIGINT"));
  process.on("SIGTERM", () => shutdown("Received SIGTERM"));
  // MCP stdio shutdown starts with the client closing stdin. Exiting here also
  // ends `graph-it serve`, whose parent may not forward signals (Windows).
  process.stdin.on("end", () => shutdown("stdin closed"));

  // Covers stdio transport close / normal exit paths (dispose is idempotent).
  process.on("exit", () => {
    statsFlush.dispose();
  });
}

// Run main - IIFE pattern for entry point (NOSONAR: top-level await not supported by tsconfig)
main().catch((error: unknown) => {// NOSONAR
  debugLog(`[McpServer] Fatal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
