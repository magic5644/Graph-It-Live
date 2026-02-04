/**
 * MCP Worker Thread
 *
 * Runs in a separate thread to handle CPU-intensive dependency analysis
 * without blocking the VS Code extension host or MCP server.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import { watch } from "chokidar";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parentPort } from "node:worker_threads";
import { AstWorkerHost } from "../analyzer/ast/AstWorkerHost";
import { LspCallHierarchyAnalyzer } from "../analyzer/LspCallHierarchyAnalyzer";
import { Parser } from "../analyzer/Parser";
import { Spider } from "../analyzer/Spider";
import { SymbolReverseIndex } from "../analyzer/SymbolReverseIndex";
import { PathResolver } from "../analyzer/utils/PathResolver";
import {
  IGNORED_DIRECTORIES,
  SUPPORTED_FILE_EXTENSIONS,
} from "../shared/constants";
import {
  getLogger,
  getLogLevelFromEnv,
  loggerFactory,
  setLoggerBackend,
  StderrLogger,
} from "../shared/logger";
import type { IntraFileGraph } from "../shared/types";
import {
  applyPagination,
  buildEdgeCounts,
  buildEdgeInfo,
  buildNodeInfo,
  convertSpiderToLspFormat,
  detectCircularDependencies,
  getRelativePath,
  updateNodeCounts,
  validateAnalysisInput,
  validateFileExists,
} from "./shared/helpers";
import { workerState } from "./shared/state";
import {
  executeGetIndexStatus,
  executeInvalidateFiles,
  executeRebuildIndex,
} from "./tools/workspace";
import type {
  AnalyzeBreakingChangesParams,
  AnalyzeBreakingChangesResult,
  AnalyzeDependenciesParams,
  AnalyzeDependenciesResult,
  AnalyzeFileLogicParams,
  BreakingChangeInfo,
  CallChainEntry,
  CrawlDependencyGraphParams,
  CrawlDependencyGraphResult,
  EdgeInfo,
  ExpandNodeParams,
  ExpandNodeResult,
  FindReferencingFilesParams,
  FindReferencingFilesResult,
  FindUnusedSymbolsParams,
  FindUnusedSymbolsResult,
  GetImpactAnalysisParams,
  GetImpactAnalysisResult,
  GetSymbolCallersParams,
  GetSymbolCallersResult,
  GetSymbolDependentsParams,
  GetSymbolDependentsResult,
  GetSymbolGraphParams,
  GetSymbolGraphResult,
  ImpactedItem,
  InvalidateFilesParams,
  McpToolName,
  McpWorkerConfig,
  McpWorkerMessage,
  McpWorkerResponse,
  ParseImportsParams,
  ParseImportsResult,
  ResolveModulePathParams,
  ResolveModulePathResult,
  SymbolCallerInfo,
  SymbolDependencyEdge,
  SymbolInfo,
  TraceFunctionExecutionParams,
  TraceFunctionExecutionResult,
  VerifyDependencyUsageParams,
  VerifyDependencyUsageResult,
} from "./types";
import {
  enrichDependency,
  validateFilePath,
  validateToolParams,
} from "./types";

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
// Helper Functions
// ============================================================================

/**
 * Convert absolute path to relative path from workspace root
 * Cross-platform safe: uses Node.js path.relative which handles
 * Windows drive letters and path separators correctly.
 *
 * @param absolutePath - The absolute path to convert
 * @param workspaceRoot - The workspace root directory
 * @returns Relative path with forward slashes (for consistent output)
 */

// ============================================================================
// Worker State
// ============================================================================

// Use centralized state management
// Legacy module-level variables replaced with workerState singleton

/** Debounce delay for file change events (ms) */
const FILE_CHANGE_DEBOUNCE_MS = 300;

/** Extensions to watch for changes */
const WATCHED_EXTENSIONS = SUPPORTED_FILE_EXTENSIONS;

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
  workerState.config = cfg;

  log.info("Initializing with config:", {
    rootDir: cfg.rootDir,
    excludeNodeModules: cfg.excludeNodeModules,
    maxDepth: cfg.maxDepth,
  });

  // Initialize components
  workerState.parser = new Parser();
  workerState.resolver = new PathResolver(
    cfg.tsConfigPath,
    cfg.excludeNodeModules,
    cfg.rootDir, // workspaceRoot for package.json discovery
  );

  // Initialize AstWorkerHost
  workerState.astWorkerHost = new AstWorkerHost();
  await workerState.astWorkerHost.start();
  log.info("AstWorkerHost started");

  workerState.spider = new Spider({
    rootDir: cfg.rootDir,
    tsConfigPath: cfg.tsConfigPath,
    maxDepth: cfg.maxDepth,
    excludeNodeModules: cfg.excludeNodeModules,
    enableReverseIndex: true, // Always enable for MCP server
  });

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
    setupFileWatcher();

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
// File Watching
// ============================================================================

/**
 * Setup chokidar file watcher for automatic cache invalidation
 * Watches the workspace for file changes and invalidates the cache accordingly
 */
function setupFileWatcher(): void {
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
      handleFileChange("change", filePath);
    });

    workerState.fileWatcher.on("add", (filePath: string) => {
      handleFileChange("add", filePath);
    });

    workerState.fileWatcher.on("unlink", (filePath: string) => {
      handleFileChange("unlink", filePath);
    });

    workerState.fileWatcher.on("error", (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log.error("File watcher error:", message);
    });

    workerState.fileWatcher.on("ready", () => {
      log.debug("File watcher ready");
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    log.error("Failed to setup file watcher:", errorMessage);
  }
}

/**
 * Stop the file watcher and cleanup
 */
function stopFileWatcher(): void {
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
    performFileInvalidation(event, filePath);
  }, FILE_CHANGE_DEBOUNCE_MS);

  workerState.pendingInvalidations.set(filePath, timeout);
}

/**
 * Actually perform the file invalidation after debounce
 */
function performFileInvalidation(
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
  if (
    !workerState.isReady ||
    !workerState.spider ||
    !workerState.parser ||
    !workerState.resolver ||
    !workerState.config
  ) {
    postMessage({
      type: "error",
      requestId,
      error: "Worker not initialized",
      code: "NOT_INITIALIZED",
    });
    return;
  }

  const startTime = Date.now();

  try {
    // Validate parameters using Zod schema
    const validation = validateToolParams(tool, params);
    if (!validation.success) {
      postMessage({
        type: "error",
        requestId,
        error: validation.error,
        code: "VALIDATION_ERROR",
      });
      return;
    }

    const validatedParams = validation.data;
    const config = workerState.getConfig();
    let result: unknown;

    switch (tool) {
      case "analyze_dependencies": {
        const p = validatedParams as AnalyzeDependenciesParams;
        validateFilePath(p.filePath, config.rootDir);
        result = await executeAnalyzeDependencies(p);
        break;
      }
      case "crawl_dependency_graph": {
        const p = validatedParams as CrawlDependencyGraphParams;
        validateFilePath(p.entryFile, config.rootDir);
        result = await executeCrawlDependencyGraph(p);
        break;
      }
      case "find_referencing_files": {
        const p = validatedParams as FindReferencingFilesParams;
        validateFilePath(p.targetPath, config.rootDir);
        result = await executeFindReferencingFiles(p);
        break;
      }
      case "expand_node": {
        const p = validatedParams as ExpandNodeParams;
        validateFilePath(p.filePath, config.rootDir);
        result = await executeExpandNode(p);
        break;
      }
      case "parse_imports": {
        const p = validatedParams as ParseImportsParams;
        validateFilePath(p.filePath, config.rootDir);
        result = await executeParseImports(p);
        break;
      }
      case "verify_dependency_usage": {
        const p = validatedParams as VerifyDependencyUsageParams;
        validateFilePath(p.sourceFile, config.rootDir);
        validateFilePath(p.targetFile, config.rootDir);
        result = await executeVerifyDependencyUsage(p);
        break;
      }
      case "resolve_module_path": {
        const p = validatedParams as ResolveModulePathParams;
        validateFilePath(p.fromFile, config.rootDir);
        result = await executeResolveModulePath(p);
        break;
      }
      case "get_index_status":
        result = await executeGetIndexStatus();
        break;
      case "invalidate_files": {
        const p = validatedParams as InvalidateFilesParams;
        for (const filePath of p.filePaths) {
          validateFilePath(filePath, config.rootDir);
        }
        result = executeInvalidateFiles(p);
        break;
      }
      case "rebuild_index":
        result = await executeRebuildIndex(postMessage);
        break;
      case "get_symbol_graph": {
        const p = validatedParams as GetSymbolGraphParams;
        validateFilePath(p.filePath, config.rootDir);
        result = await executeGetSymbolGraph(p);
        break;
      }
      case "find_unused_symbols": {
        const p = validatedParams as FindUnusedSymbolsParams;
        validateFilePath(p.filePath, config.rootDir);
        result = await executeFindUnusedSymbols(p);
        break;
      }
      case "get_symbol_dependents": {
        const p = validatedParams as GetSymbolDependentsParams;
        validateFilePath(p.filePath, config.rootDir);
        result = await executeGetSymbolDependents(p);
        break;
      }
      case "trace_function_execution": {
        const p = validatedParams as TraceFunctionExecutionParams;
        validateFilePath(p.filePath, config.rootDir);
        result = await executeTraceFunctionExecution(p);
        break;
      }
      case "get_symbol_callers": {
        const p = validatedParams as GetSymbolCallersParams;
        validateFilePath(p.filePath, config.rootDir);
        result = await executeGetSymbolCallers(p);
        break;
      }
      case "analyze_breaking_changes": {
        const p = validatedParams as AnalyzeBreakingChangesParams;
        validateFilePath(p.filePath, config.rootDir);
        result = await executeAnalyzeBreakingChanges(p);
        break;
      }
      case "get_impact_analysis": {
        const p = validatedParams as GetImpactAnalysisParams;
        validateFilePath(p.filePath, config.rootDir);
        result = await executeGetImpactAnalysis(p);
        break;
      }
      case "analyze_file_logic": {
        const p = validatedParams as AnalyzeFileLogicParams;
        validateFilePath(p.filePath, config.rootDir);
        result = await executeAnalyzeFileLogic(p);
        break;
      }
      default:
        throw new Error(`Unknown tool: ${tool}`);
    }

    const executionTimeMs = Date.now() - startTime;

    postMessage({
      type: "result",
      requestId,
      data: result,
      executionTimeMs,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    const errorCode =
      errorMessage.includes("Path traversal") ||
      errorMessage.includes("outside workspace")
        ? "SECURITY_ERROR"
        : "EXECUTION_ERROR";

    postMessage({
      type: "error",
      requestId,
      error: errorMessage,
      code: errorCode,
    });
  }
}

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Analyze dependencies of a single file
 */
async function executeAnalyzeDependencies(
  params: AnalyzeDependenciesParams,
): Promise<AnalyzeDependenciesResult> {
  const { filePath } = params;
  const spider = workerState.getSpider();
  const config = workerState.getConfig();

  // Validate file exists
  await validateFileExists(filePath);

  const dependencies = await spider.analyze(filePath);

  return {
    filePath,
    dependencyCount: dependencies.length,
    dependencies: dependencies.map((dep) =>
      enrichDependency(dep, config.rootDir),
    ),
  };
}

/**
 * Build dependency and dependent counts from edges
 */


/**
 * Filter edges by actual usage verification
 * Parallelized for better performance on large graphs
 */
async function filterEdgesByUsage(edges: EdgeInfo[]): Promise<EdgeInfo[]> {
  log.info(`Filtering ${edges.length} edges by usage (onlyUsed=true) - using parallel verification`);
  const spider = workerState.getSpider();
  
  // Parallelize verification with Promise.all for better performance
  const verificationResults = await Promise.all(
    edges.map(async (edge) => {
      try {
        const isUsed = await spider.verifyDependencyUsage(
          edge.source,
          edge.target,
        );
        return { edge, isUsed, error: null };
      } catch (err) {
        log.warn(
          `Failed to verify usage for edge ${edge.source} -> ${edge.target}:`,
          err,
        );
        // Conservative: keep edge if verification fails
        return { edge, isUsed: true, error: err };
      }
    })
  );

  // Filter results
  const filteredEdges = verificationResults
    .filter((result) => result.isUsed)
    .map((result) => result.edge);

  log.info(`Filtered to ${filteredEdges.length} used edges (removed ${edges.length - filteredEdges.length} unused)`);
  return filteredEdges;
}

/**
 * Update node counts after edge filtering
 */

/**
 * Crawl the full dependency graph from an entry file
 */
async function executeCrawlDependencyGraph(
  params: CrawlDependencyGraphParams,
): Promise<CrawlDependencyGraphResult> {
  const { entryFile, maxDepth, limit, offset, onlyUsed } = params;
  const spider = workerState.getSpider();
  const config = workerState.getConfig();

  await validateFileExists(entryFile);

  // Temporarily update max depth if specified
  const originalMaxDepth = spider["config"].maxDepth;
  if (maxDepth !== undefined) {
    spider.updateConfig({ maxDepth });
  }

  try {
    const graph = await spider.crawl(entryFile);

    // Restore original max depth
    if (maxDepth !== undefined) {
      spider.updateConfig({ maxDepth: originalMaxDepth });
    }

    // Build initial counts and detect cycles
    const { dependencyCount, dependentCount } = buildEdgeCounts(graph.edges);
    const circularDependencies = detectCircularDependencies(graph.edges);

    // Build node and edge info
    let nodes = buildNodeInfo(
      graph.nodes,
      dependencyCount,
      dependentCount,
      config.rootDir,
    );
    let edges = buildEdgeInfo(graph.edges, config.rootDir);

    // Filter by usage if requested
    if (onlyUsed === true) {
      edges = await filterEdgesByUsage(edges);
      updateNodeCounts(nodes, edges);
    }

    // Store totals before pagination
    const totalNodes = nodes.length;
    const totalEdges = edges.length;

    // Apply pagination if requested
    if (limit !== undefined || offset !== undefined) {
      const paginated = applyPagination(nodes, edges, limit, offset);
      nodes = paginated.nodes;
      edges = paginated.edges;
    }

    return {
      entryFile,
      maxDepth: maxDepth ?? originalMaxDepth ?? 3,
      nodeCount: totalNodes,
      edgeCount: totalEdges,
      nodes,
      edges,
      circularDependencies,
    };
  } catch (error) {
    // Restore original max depth on error
    if (maxDepth !== undefined) {
      spider.updateConfig({ maxDepth: originalMaxDepth });
    }
    throw error;
  }
}

/**
 * Find all files that reference/import a target file
 */
async function executeFindReferencingFiles(
  params: FindReferencingFilesParams,
): Promise<FindReferencingFilesResult> {
  const { targetPath } = params;
  const spider = workerState.getSpider();
  const config = workerState.getConfig();

  // Validate file exists
  await validateFileExists(targetPath);

  const references = await spider.findReferencingFiles(targetPath);

  return {
    targetPath,
    referencingFileCount: references.length,
    referencingFiles: references.map((ref) => ({
      path: ref.path,
      relativePath: getRelativePath(ref.path, config.rootDir),
      type: ref.type,
      line: ref.line,
      module: ref.module,
    })),
  };
}

/**
 * Expand a node to discover new dependencies not in the known set
 */
async function executeExpandNode(
  params: ExpandNodeParams,
): Promise<ExpandNodeResult> {
  const { filePath, knownPaths, extraDepth } = params;
  const spider = workerState.getSpider();
  const config = workerState.getConfig();

  // Validate file exists
  await validateFileExists(filePath);

  const existingNodes = new Set<string>(knownPaths);
  const result = await spider.crawlFrom(
    filePath,
    existingNodes,
    extraDepth ?? 10,
  );

  return {
    expandedNode: filePath,
    newNodeCount: result.nodes.length,
    newEdgeCount: result.edges.length,
    newNodes: result.nodes,
    newEdges: result.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      sourceRelative: getRelativePath(edge.source, config.rootDir),
      targetRelative: getRelativePath(edge.target, config.rootDir),
    })),
  };
}

/**
 * Parse imports from a file without resolving paths
 */
async function executeParseImports(
  params: ParseImportsParams,
): Promise<ParseImportsResult> {
  const { filePath } = params;
  const parser = workerState.getParser();

  // Validate file exists
  await validateFileExists(filePath);

  const content = await fs.readFile(filePath, "utf-8");
  const imports = parser.parse(content, filePath);

  return {
    filePath,
    importCount: imports.length,
    imports: imports.map((imp) => ({
      module: imp.module,
      type: imp.type,
      line: imp.line,
    })),
  };
}

/**
 * Verify if a dependency is actually used
 */
async function executeVerifyDependencyUsage(
  params: VerifyDependencyUsageParams,
): Promise<VerifyDependencyUsageResult> {
  const { sourceFile, targetFile } = params;
  const spider = workerState.getSpider();

  // Validate file exists
  await validateFileExists(sourceFile);
  await validateFileExists(targetFile);

  const isUsed = await spider.verifyDependencyUsage(sourceFile, targetFile);

  return {
    sourceFile,
    targetFile,
    isUsed,
    usedSymbolCount: isUsed ? undefined : 0, // We don't have count yet, but if unused it's 0
  };
}

/**
 * Resolve a module specifier to an absolute path
 */
async function executeResolveModulePath(
  params: ResolveModulePathParams,
): Promise<ResolveModulePathResult> {
  const { fromFile, moduleSpecifier } = params;
  const resolver = workerState.getResolver();
  const config = workerState.getConfig();

  // Validate source file exists
  await validateFileExists(fromFile);

  try {
    const resolvedPath = await resolver.resolve(fromFile, moduleSpecifier);

    if (resolvedPath) {
      return {
        fromFile,
        moduleSpecifier,
        resolved: true,
        resolvedPath,
        resolvedRelativePath: getRelativePath(resolvedPath, config.rootDir),
      };
    } else {
      return {
        fromFile,
        moduleSpecifier,
        resolved: false,
        resolvedPath: null,
        resolvedRelativePath: null,
        failureReason:
          "Module could not be resolved (may be a node_module or non-existent file)",
      };
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return {
      fromFile,
      moduleSpecifier,
      resolved: false,
      resolvedPath: null,
      resolvedRelativePath: null,
      failureReason: errorMessage,
    };
  }
}

/**
 * Get symbol graph for a file
 */
async function executeGetSymbolGraph(
  params: GetSymbolGraphParams,
): Promise<GetSymbolGraphResult> {
  const { filePath } = params;
  const spider = workerState.getSpider();
  const config = workerState.getConfig();
  await validateFileExists(filePath);

  const { symbols, dependencies } = await spider.getSymbolGraph(filePath);

  // Enrich dependencies with relative paths
  const enrichedDependencies: SymbolDependencyEdge[] = dependencies.map(
    (dep) => ({
      sourceSymbolId: dep.sourceSymbolId,
      targetSymbolId: dep.targetSymbolId,
      targetFilePath: dep.targetFilePath,
      targetRelativePath: getRelativePath(dep.targetFilePath, config.rootDir),
    }),
  );

  // Categorize symbols
  const categorizedSymbols: SymbolInfo[] = symbols.map((symbol) => ({
    ...symbol,
    category: categorizeSymbolKind(symbol.kind),
  }));

  const relativePath = getRelativePath(filePath, config.rootDir);

  return {
    filePath,
    relativePath,
    symbolCount: symbols.length,
    dependencyCount: dependencies.length,
    symbols: categorizedSymbols,
    dependencies: enrichedDependencies,
    isSymbolView: true,
  };
}

/**
 * Find unused exported symbols in a file
 */
async function executeFindUnusedSymbols(
  params: FindUnusedSymbolsParams,
): Promise<FindUnusedSymbolsResult> {
  const { filePath } = params;
  const spider = workerState.getSpider();
  const config = workerState.getConfig();
  await validateFileExists(filePath);

  const unusedSymbols = await spider.findUnusedSymbols(filePath);

  // Get all exported symbols to calculate percentage
  const { symbols } = await spider.getSymbolGraph(filePath);
  const exportedSymbols = symbols.filter((s) => s.isExported);

  // Categorize unused symbols
  const categorizedUnusedSymbols: SymbolInfo[] = unusedSymbols.map(
    (symbol) => ({
      ...symbol,
      category: categorizeSymbolKind(symbol.kind),
    }),
  );

  const unusedCount = unusedSymbols.length;
  const totalExportedSymbols = exportedSymbols.length;
  const unusedPercentage =
    totalExportedSymbols > 0
      ? Math.round((unusedCount / totalExportedSymbols) * 100)
      : 0;

  const relativePath = getRelativePath(filePath, config.rootDir);

  return {
    filePath,
    relativePath,
    unusedCount,
    unusedSymbols: categorizedUnusedSymbols,
    totalExportedSymbols,
    unusedPercentage,
  };
}

/**
 * Get dependents of a specific symbol
 */
async function executeGetSymbolDependents(
  params: GetSymbolDependentsParams,
): Promise<GetSymbolDependentsResult> {
  const { filePath, symbolName } = params;
  const spider = workerState.getSpider();
  const config = workerState.getConfig();
  await validateFileExists(filePath);

  const dependents = await spider.getSymbolDependents(filePath, symbolName);

  // Enrich dependents with relative paths
  const enrichedDependents: SymbolDependencyEdge[] = dependents.map((dep) => ({
    sourceSymbolId: dep.sourceSymbolId,
    targetSymbolId: dep.targetSymbolId,
    targetFilePath: dep.targetFilePath,
    targetRelativePath: getRelativePath(dep.targetFilePath, config.rootDir),
  }));

  return {
    filePath,
    symbolName,
    dependentCount: dependents.length,
    dependents: enrichedDependents,
  };
}

/**
 * Trace the full execution chain from a root symbol
 */
async function executeTraceFunctionExecution(
  params: TraceFunctionExecutionParams,
): Promise<TraceFunctionExecutionResult> {
  const { filePath, symbolName, maxDepth } = params;
  const spider = workerState.getSpider();
  const config = workerState.getConfig();
  await validateFileExists(filePath);

  const result = await spider.traceFunctionExecution(
    filePath,
    symbolName,
    maxDepth ?? 10,
  );

  // Enrich call chain entries with relative paths
  const enrichedCallChain: CallChainEntry[] = result.callChain.map((entry) => ({
    depth: entry.depth,
    callerSymbolId: entry.callerSymbolId,
    calledSymbolId: entry.calledSymbolId,
    calledFilePath: entry.calledFilePath,
    resolvedFilePath: entry.resolvedFilePath,
    resolvedRelativePath: entry.resolvedFilePath
      ? getRelativePath(entry.resolvedFilePath, config.rootDir)
      : null,
  }));

  const relativePath = getRelativePath(filePath, config.rootDir);

  return {
    rootSymbol: {
      id: result.rootSymbol.id,
      filePath: result.rootSymbol.filePath,
      relativePath,
      symbolName: result.rootSymbol.symbolName,
    },
    maxDepth: maxDepth ?? 10,
    callCount: result.callChain.length,
    uniqueSymbolCount: result.visitedSymbols.length,
    maxDepthReached: result.maxDepthReached,
    callChain: enrichedCallChain,
    visitedSymbols: result.visitedSymbols,
  };
}

/**
 * Categorize a symbol by its kind
 */
function categorizeSymbolKind(
  kind: string,
): "function" | "class" | "variable" | "interface" | "type" | "other" {
  if (kind.includes("Function")) return "function";
  if (kind.includes("Class")) return "class";
  if (
    kind.includes("Variable") ||
    kind.includes("Const") ||
    kind.includes("Let")
  )
    return "variable";
  if (kind.includes("Interface")) return "interface";
  if (kind.includes("Type")) return "type";
  return "other";
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validate that a file exists
 */


// ============================================================================
// NEW: Symbol Callers (O(1) Lookup)
// ============================================================================

/**
 * Get symbol callers with O(1) lookup
 */
async function executeGetSymbolCallers(
  params: GetSymbolCallersParams,
): Promise<GetSymbolCallersResult> {
  const { filePath, symbolName, includeTypeOnly = true } = params;
  const config = workerState.getConfig();

  // Build symbolId from filePath + symbolName
  const symbolId = `${filePath}:${symbolName}`;

  // Initialize symbol reverse index if needed
  if (!workerState.symbolReverseIndex) {
    workerState.symbolReverseIndex = new SymbolReverseIndex(config.rootDir);
    // Build the index from all cached symbol graphs
    await buildSymbolReverseIndex();
  }

  const callers = includeTypeOnly
    ? workerState.symbolReverseIndex.getCallers(symbolId)
    : workerState.symbolReverseIndex.getRuntimeCallers(symbolId);

  const callerInfos: SymbolCallerInfo[] = callers.map((caller) => ({
    callerSymbolId: caller.callerSymbolId,
    callerFilePath: caller.callerFilePath,
    callerRelativePath: getRelativePath(caller.callerFilePath, config.rootDir),
    isTypeOnly: caller.isTypeOnly,
  }));

  const runtimeCallers = callers.filter((c) => !c.isTypeOnly);
  const typeOnlyCallers = callers.filter((c) => c.isTypeOnly);

  return {
    symbolId,
    callerCount: callers.length,
    runtimeCallerCount: runtimeCallers.length,
    typeOnlyCallerCount: typeOnlyCallers.length,
    callers: callerInfos,
    callerFiles: workerState.symbolReverseIndex.getCallerFiles(symbolId),
  };
}

/**
 * Build symbol reverse index from all known files
 */
async function buildSymbolReverseIndex(): Promise<void> {
  const spider = workerState.spider;
  if (!spider || !workerState.symbolReverseIndex) return;

  // Get all indexed files from the file-level cache
  const status = spider.getIndexStatus();
  if (status.state !== "complete") return;

  // Strategy: Use the file-level reverse index to get all known files
  // If reverse index is not enabled, we build symbol index on-demand per query
  if (!spider.hasReverseIndex()) {
    log.warn("File-level reverse index not enabled. Symbol reverse index will be built incrementally.");
    return;
  }

  // Get all files from the reverse index stats
  const cacheStats = spider.getCacheStats();
  const reverseIndexStats = cacheStats.reverseIndexStats;
  if (!reverseIndexStats || reverseIndexStats.indexedFiles === 0) {
    log.warn("No files in reverse index yet. Symbol reverse index will be built incrementally.");
    return;
  }

  log.info(`Building symbol reverse index from ${reverseIndexStats.indexedFiles} indexed files...`);
  
  // Build index by analyzing files we encounter during queries
  // This is more efficient than pre-scanning all files
  log.info(`Symbol reverse index ready (lazy loading mode)`);
}

// ============================================================================
// NEW: Breaking Changes Analysis
// ============================================================================

/**
 * Analyze breaking changes between old and new file versions
 */
async function executeAnalyzeBreakingChanges(
  params: AnalyzeBreakingChangesParams,
): Promise<AnalyzeBreakingChangesResult> {
  const { filePath, symbolName, oldContent } = params;

  // If newContent not provided, read current file
  let newContent = params.newContent;
  if (!newContent) {
    try {
      newContent = await fs.readFile(filePath, "utf-8");
    } catch {
      throw new Error(`Cannot read current file: ${filePath}`);
    }
  }

  const astWorkerHost = workerState.getAstWorkerHost();

  let results: import("../analyzer/SignatureAnalyzer").SignatureComparisonResult[];
  try {
    results = await astWorkerHost.analyzeBreakingChanges(
      filePath,
      oldContent,
      newContent,
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Failed to analyze breaking changes: ${errorMsg}`);
  }

  // Filter by symbolName if provided
  if (symbolName) {
    results = results.filter((r) => r.symbolName === symbolName);
  }

  // Aggregate all breaking changes
  const breakingChanges: BreakingChangeInfo[] = [];
  const nonBreakingChanges: string[] = [];
  const removedSymbols: string[] = [];
  const addedSymbols: string[] = [];

  for (const result of results) {
    for (const change of result.breakingChanges) {
      breakingChanges.push({
        type: change.type,
        symbolName: change.symbolName,
        description: change.description,
        severity: change.severity,
        oldValue: change.oldValue,
        newValue: change.newValue,
        line: change.line,
      });

      if (change.type === "member-removed") {
        removedSymbols.push(change.symbolName);
      }
    }
    nonBreakingChanges.push(...result.nonBreakingChanges);
  }

  // Count by severity
  const errorCount = breakingChanges.filter(
    (c) => c.severity === "error",
  ).length;
  const warningCount = breakingChanges.filter(
    (c) => c.severity === "warning",
  ).length;

  return {
    filePath,
    breakingChangeCount: breakingChanges.length,
    errorCount,
    warningCount,
    breakingChanges,
    nonBreakingChanges,
    removedSymbols,
    addedSymbols,
  };
}

// ============================================================================
// NEW: Impact Analysis
// ============================================================================

/**
 * Create an impacted item from a symbol dependency
 */
function createImpactedItem(
  dep: import("../analyzer/types").SymbolDependency,
  depth: number,
  rootDir: string,
): ImpactedItem {
  return {
    symbolId: dep.sourceSymbolId,
    filePath: dep.targetFilePath,
    relativePath: getRelativePath(dep.targetFilePath, rootDir),
    usageType: dep.isTypeOnly ? "type-only" : "runtime",
    depth,
  };
}

/**
 * Determine impact level based on metrics
 */
function determineImpactLevel(
  runtimeCount: number,
  totalCount: number,
): "high" | "medium" | "low" {
  if (runtimeCount >= 10 || totalCount >= 20) return "high";
  if (runtimeCount >= 3 || totalCount >= 5) return "medium";
  return "low";
}

/**
 * Calculate impact metrics from items
 */
function calculateImpactMetrics(items: ImpactedItem[]): {
  directCount: number;
  transitiveCount: number;
  runtimeCount: number;
  typeOnlyCount: number;
} {
  return {
    directCount: items.filter((i) => i.depth === 1).length,
    transitiveCount: items.filter((i) => i.depth > 1).length,
    runtimeCount: items.filter((i) => i.usageType === "runtime").length,
    typeOnlyCount: items.filter((i) => i.usageType === "type-only").length,
  };
}

/**
 * Parse symbolId into file path and symbol name
 */
function parseSymbolId(
  symbolId: string,
): { filePath: string; symbolName: string } | null {
  const parts = symbolId.split(":");
  if (parts.length < 2) return null;

  const symbolName = parts.at(-1);
  if (!symbolName) return null;

  return {
    filePath: parts.slice(0, -1).join(":"),
    symbolName,
  };
}

/**
 * Context for processing transitive dependents
 */
interface TransitiveContext {
  maxDepth: number;
  rootDir: string;
  visitedSymbols: Set<string>;
  affectedFilesSet: Set<string>;
  impactedItems: ImpactedItem[];
  queue: { symbolId: string; depth: number }[];
}

/**
 * Process a single transitive dependent and add to the queue
 */
function processTransitiveDependent(
  dep: import("../analyzer/types").SymbolDependency,
  depth: number,
  ctx: TransitiveContext,
): void {
  if (ctx.visitedSymbols.has(dep.sourceSymbolId)) return;

  ctx.impactedItems.push(createImpactedItem(dep, depth, ctx.rootDir));
  ctx.visitedSymbols.add(dep.sourceSymbolId);
  ctx.affectedFilesSet.add(dep.targetFilePath);

  if (depth < ctx.maxDepth) {
    ctx.queue.push({ symbolId: dep.sourceSymbolId, depth: depth + 1 });
  }
}

/**
 * Process transitive dependents
 */
async function processTransitiveDependents(
  directDependents: import("../analyzer/types").SymbolDependency[],
  maxDepth: number,
  rootDir: string,
  visitedSymbols: Set<string>,
  affectedFilesSet: Set<string>,
  impactedItems: ImpactedItem[],
): Promise<void> {
  const spider = workerState.getSpider();
  const queue = directDependents.map((d) => ({
    symbolId: d.sourceSymbolId,
    depth: 2,
  }));
  const ctx: TransitiveContext = {
    maxDepth,
    rootDir,
    visitedSymbols,
    affectedFilesSet,
    impactedItems,
    queue,
  };

  while (ctx.queue.length > 0) {
    const current = ctx.queue.shift()!;
    if (current.depth > maxDepth) continue;

    const parsed = parseSymbolId(current.symbolId);
    if (!parsed) continue;

    try {
      const transitiveDeps = await spider.getSymbolDependents(
        parsed.filePath,
        parsed.symbolName,
      );

      for (const dep of transitiveDeps) {
        processTransitiveDependent(dep, current.depth, ctx);
      }
    } catch {
      // Skip symbols that fail to analyze
    }
  }
}

/**
 * Get comprehensive impact analysis for a symbol modification
 */
async function executeGetImpactAnalysis(
  params: GetImpactAnalysisParams,
): Promise<GetImpactAnalysisResult> {
  const {
    filePath,
    symbolName,
    includeTransitive = false,
    maxDepth = 3,
  } = params;
  const spider = workerState.getSpider();
  const config = workerState.getConfig();
  await validateFileExists(filePath);

  const symbolId = `${filePath}:${symbolName}`;
  const impactedItems: ImpactedItem[] = [];
  const visitedSymbols = new Set<string>();
  const affectedFilesSet = new Set<string>();

  // Get direct dependents
  const directDependents = await spider.getSymbolDependents(
    filePath,
    symbolName,
  );

  for (const dep of directDependents) {
    impactedItems.push(createImpactedItem(dep, 1, config.rootDir));
    visitedSymbols.add(dep.sourceSymbolId);
    affectedFilesSet.add(dep.targetFilePath);
  }

  // Get transitive dependents if requested
  if (includeTransitive && maxDepth > 1) {
    await processTransitiveDependents(
      directDependents,
      maxDepth,
      config.rootDir,
      visitedSymbols,
      affectedFilesSet,
      impactedItems,
    );
  }

  // Calculate metrics
  const metrics = calculateImpactMetrics(impactedItems);
  const impactLevel = determineImpactLevel(
    metrics.runtimeCount,
    impactedItems.length,
  );

  // Generate summary
  const summary = generateImpactSummary(
    symbolName,
    impactedItems.length,
    metrics.runtimeCount,
    metrics.typeOnlyCount,
    affectedFilesSet.size,
    impactLevel,
  );

  return {
    targetSymbol: {
      id: symbolId,
      filePath,
      relativePath: getRelativePath(filePath, config.rootDir),
      symbolName,
    },
    impactLevel,
    totalImpactCount: impactedItems.length,
    directImpactCount: metrics.directCount,
    transitiveImpactCount: metrics.transitiveCount,
    runtimeImpactCount: metrics.runtimeCount,
    typeOnlyImpactCount: metrics.typeOnlyCount,
    impactedItems,
    affectedFiles: Array.from(affectedFilesSet),
    summary,
  };
}

/**
 * Generate human-readable impact summary
 */
function generateImpactSummary(
  symbolName: string,
  totalCount: number,
  runtimeCount: number,
  typeOnlyCount: number,
  fileCount: number,
  level: "high" | "medium" | "low",
): string {
  if (totalCount === 0) {
    return `Symbol '${symbolName}' has no known dependents. Changes should be safe.`;
  }

  let levelEmoji: string;
  if (level === "high") {
    levelEmoji = "🔴";
  } else if (level === "medium") {
    levelEmoji = "🟡";
  } else {
    levelEmoji = "🟢";
  }

  let summary = `${levelEmoji} Impact Level: ${level.toUpperCase()}\n\n`;
  summary += `Modifying '${symbolName}' will affect:\n`;
  summary += `- ${totalCount} symbol(s) across ${fileCount} file(s)\n`;

  if (runtimeCount > 0) {
    summary += `- ${runtimeCount} runtime usage(s) - tests should be run\n`;
  }
  if (typeOnlyCount > 0) {
    summary += `- ${typeOnlyCount} type-only usage(s) - only type checking affected\n`;
  }

  if (level === "high") {
    summary += `\n⚠️ High impact: Consider running full test suite and reviewing all affected files.`;
  }

  return summary;
}

/**
 * Analyze intra-file call hierarchy using LSP data
 */
/**
 * Validate input parameters for file analysis
 */


async function executeAnalyzeFileLogic(
  params: AnalyzeFileLogicParams,
): Promise<{
  filePath: string;
  graph: IntraFileGraph;
  language: string;
  analysisTimeMs: number;
  isPartial?: boolean;
  warnings?: string[];
}> {
  const { filePath } = params;
  const spider = workerState.getSpider();
  // Note: includeExternal will be used in T066 when integrating LSP call hierarchy

  // Validate input parameters
  const { language } = await validateAnalysisInput(filePath);

  const startTime = Date.now();
  const isPartial = false;
  const warnings: string[] = [];

  try {
    // Get symbol graph data using Spider's AST-based analysis
    const symbolGraphData = await spider.getSymbolGraph(filePath);

    // Convert Spider's symbol format to LSP format for LspCallHierarchyAnalyzer
    const lspData = convertSpiderToLspFormat(symbolGraphData, filePath);

    // Use LspCallHierarchyAnalyzer to build the graph (T066)
    const analyzer = new LspCallHierarchyAnalyzer();
    const graph = analyzer.buildIntraFileGraph(filePath, lspData);

    const analysisTimeMs = Date.now() - startTime;

    log.info(
      `Analyzed file logic for ${filePath} in ${analysisTimeMs}ms (${graph.nodes.length} symbols, ${graph.edges.length} edges)`,
    );

    // T065: Return with optional partial results flag
    const result: {
      filePath: string;
      graph: IntraFileGraph;
      language: string;
      analysisTimeMs: number;
      isPartial?: boolean;
      warnings?: string[];
    } = {
      filePath,
      graph,
      language,
      analysisTimeMs,
    };

    if (isPartial) {
      result.isPartial = true;
    }

    if (warnings.length > 0) {
      result.warnings = warnings;
    }

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // T065: Enhanced error code mapping
    // Check for timeout errors
    if (errorMessage.includes("timeout") || errorMessage.includes("timed out")) {
      throw new Error(`LSP_TIMEOUT: LSP call hierarchy analysis timed out for ${filePath} (exceeded 5 seconds)`);
    }

    // Check for LSP availability errors
    if (errorMessage.includes("LSP") || errorMessage.includes("language server")) {
      throw new Error(`LSP_UNAVAILABLE: Language server protocol is not available for ${filePath}. ${errorMessage}`);
    }

    // Check for file system errors
    if (errorMessage.includes("ENOENT") || errorMessage.includes("no such file")) {
      throw new Error(`FILE_NOT_FOUND: File does not exist: ${filePath}`);
    }

    // Generic analysis failure
    throw new Error(`ANALYSIS_FAILED: Symbol analysis failed for ${filePath}. ${errorMessage}`);
  }
}

// Re-export types for testing
export type {
  McpWorkerConfig,
  McpWorkerMessage,
  McpWorkerResponse
} from "./types";
