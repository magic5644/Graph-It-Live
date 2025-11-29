/**
 * MCP Worker Thread
 *
 * Runs in a separate thread to handle CPU-intensive dependency analysis
 * without blocking the VS Code extension host or MCP server.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import { parentPort } from 'node:worker_threads';
import * as fs from 'node:fs/promises';
import { Spider } from '../analyzer/Spider';
import { Parser } from '../analyzer/Parser';
import { PathResolver } from '../analyzer/PathResolver';
import type {
  McpWorkerMessage,
  McpWorkerResponse,
  McpWorkerConfig,
  McpToolName,
  AnalyzeDependenciesParams,
  CrawlDependencyGraphParams,
  FindReferencingFilesParams,
  ExpandNodeParams,
  ParseImportsParams,
  ResolveModulePathParams,
  InvalidateFilesParams,
  AnalyzeDependenciesResult,
  CrawlDependencyGraphResult,
  FindReferencingFilesResult,
  ExpandNodeResult,
  ParseImportsResult,
  ResolveModulePathResult,
  GetIndexStatusResult,
  InvalidateFilesResult,
  RebuildIndexResult,
  NodeInfo,
  EdgeInfo,
} from './types';
import { enrichDependency, getRelativePath } from './types';

// ============================================================================
// Worker State
// ============================================================================

let spider: Spider | null = null;
let parser: Parser | null = null;
let resolver: PathResolver | null = null;
let config: McpWorkerConfig | null = null;
let isReady = false;
let warmupInfo: { completed: boolean; durationMs?: number; filesIndexed?: number } = {
  completed: false,
};

// ============================================================================
// Message Handling
// ============================================================================

parentPort?.on('message', async (msg: McpWorkerMessage) => {
  try {
    switch (msg.type) {
      case 'init':
        await handleInit(msg.config);
        break;
      case 'invoke':
        await handleInvoke(msg.requestId, msg.tool, msg.params);
        break;
      case 'shutdown':
        handleShutdown();
        break;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[McpWorker] Error handling message:', errorMessage);
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
  config = cfg;

  console.error('[McpWorker] Initializing with config:', {
    rootDir: cfg.rootDir,
    excludeNodeModules: cfg.excludeNodeModules,
    maxDepth: cfg.maxDepth,
  });

  // Initialize components
  parser = new Parser();
  resolver = new PathResolver(cfg.tsConfigPath, cfg.excludeNodeModules);
  spider = new Spider({
    rootDir: cfg.rootDir,
    tsConfigPath: cfg.tsConfigPath,
    maxDepth: cfg.maxDepth,
    excludeNodeModules: cfg.excludeNodeModules,
    enableReverseIndex: true, // Always enable for MCP server
  });

  // Subscribe to indexing progress for warmup updates
  spider.subscribeToIndexStatus((snapshot) => {
    if (snapshot.state === 'indexing') {
      postMessage({
        type: 'warmup-progress',
        processed: snapshot.processed,
        total: snapshot.total,
        currentFile: snapshot.currentFile,
      });
    }
  });

  // Perform warmup: build full index of the workspace
  console.error('[McpWorker] Starting warmup indexing...');
  
  try {
    const result = await spider.buildFullIndex();
    
    warmupInfo = {
      completed: true,
      durationMs: result.duration,
      filesIndexed: result.indexedFiles,
    };

    isReady = true;
    const totalDuration = Date.now() - startTime;

    console.error(`[McpWorker] Warmup complete: ${result.indexedFiles} files indexed in ${result.duration}ms`);

    postMessage({
      type: 'ready',
      warmupDuration: totalDuration,
      indexedFiles: result.indexedFiles,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[McpWorker] Warmup failed:', errorMessage);
    
    // Still mark as ready, but warmup failed
    warmupInfo = { completed: false };
    isReady = true;

    postMessage({
      type: 'ready',
      warmupDuration: Date.now() - startTime,
      indexedFiles: 0,
    });
  }
}

/**
 * Handle shutdown message
 */
function handleShutdown(): void {
  console.error('[McpWorker] Shutting down...');
  spider?.cancelIndexing();
  process.exit(0);
}

// ============================================================================
// Tool Invocation
// ============================================================================

/**
 * Handle tool invocation request
 */
async function handleInvoke(
  requestId: string,
  tool: McpToolName,
  params: unknown
): Promise<void> {
  if (!isReady || !spider || !parser || !resolver || !config) {
    postMessage({
      type: 'error',
      requestId,
      error: 'Worker not initialized',
      code: 'NOT_INITIALIZED',
    });
    return;
  }

  const startTime = Date.now();

  try {
    let result: unknown;

    switch (tool) {
      case 'analyze_dependencies':
        result = await executeAnalyzeDependencies(params as AnalyzeDependenciesParams);
        break;
      case 'crawl_dependency_graph':
        result = await executeCrawlDependencyGraph(params as CrawlDependencyGraphParams);
        break;
      case 'find_referencing_files':
        result = await executeFindReferencingFiles(params as FindReferencingFilesParams);
        break;
      case 'expand_node':
        result = await executeExpandNode(params as ExpandNodeParams);
        break;
      case 'parse_imports':
        result = await executeParseImports(params as ParseImportsParams);
        break;
      case 'resolve_module_path':
        result = await executeResolveModulePath(params as ResolveModulePathParams);
        break;
      case 'get_index_status':
        result = executeGetIndexStatus();
        break;
      case 'invalidate_files':
        result = executeInvalidateFiles(params as InvalidateFilesParams);
        break;
      case 'rebuild_index':
        result = await executeRebuildIndex();
        break;
      default:
        throw new Error(`Unknown tool: ${tool}`);
    }

    const executionTimeMs = Date.now() - startTime;

    postMessage({
      type: 'result',
      requestId,
      data: result,
      executionTimeMs,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    postMessage({
      type: 'error',
      requestId,
      error: errorMessage,
      code: 'EXECUTION_ERROR',
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
  params: AnalyzeDependenciesParams
): Promise<AnalyzeDependenciesResult> {
  const { filePath } = params;

  // Validate file exists
  await validateFileExists(filePath);

  const dependencies = await spider!.analyze(filePath);

  return {
    filePath,
    dependencyCount: dependencies.length,
    dependencies: dependencies.map((dep) => enrichDependency(dep, config!.rootDir)),
  };
}

/**
 * Crawl the full dependency graph from an entry file
 */
async function executeCrawlDependencyGraph(
  params: CrawlDependencyGraphParams
): Promise<CrawlDependencyGraphResult> {
  const { entryFile, maxDepth, limit, offset } = params;

  // Validate file exists
  await validateFileExists(entryFile);

  // Temporarily update max depth if specified
  const originalMaxDepth = spider!['config'].maxDepth;
  if (maxDepth !== undefined) {
    spider!.updateConfig({ maxDepth });
  }

  try {
    const graph = await spider!.crawl(entryFile);

    // Restore original max depth
    if (maxDepth !== undefined) {
      spider!.updateConfig({ maxDepth: originalMaxDepth });
    }

    // Build node info with dependency/dependent counts
    const dependencyCount = new Map<string, number>();
    const dependentCount = new Map<string, number>();

    for (const edge of graph.edges) {
      dependencyCount.set(edge.source, (dependencyCount.get(edge.source) ?? 0) + 1);
      dependentCount.set(edge.target, (dependentCount.get(edge.target) ?? 0) + 1);
    }

    // Detect circular dependencies
    const circularDependencies = detectCircularDependencies(graph.edges);

    // Build node info
    let nodes: NodeInfo[] = graph.nodes.map((nodePath) => ({
      path: nodePath,
      relativePath: getRelativePath(nodePath, config!.rootDir),
      extension: nodePath.split('.').pop() ?? '',
      dependencyCount: dependencyCount.get(nodePath) ?? 0,
      dependentCount: dependentCount.get(nodePath) ?? 0,
    }));

    // Build edge info
    let edges: EdgeInfo[] = graph.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      sourceRelative: getRelativePath(edge.source, config!.rootDir),
      targetRelative: getRelativePath(edge.target, config!.rootDir),
    }));

    // Apply pagination if requested
    const totalNodes = nodes.length;
    const totalEdges = edges.length;

    if (limit !== undefined || offset !== undefined) {
      const start = offset ?? 0;
      const end = limit === undefined ? undefined : start + limit;
      nodes = nodes.slice(start, end);
      // For edges, we filter to only include edges where both source and target are in the paginated nodes
      const nodeSet = new Set(nodes.map((n) => n.path));
      edges = edges.filter((e) => nodeSet.has(e.source) && nodeSet.has(e.target));
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
      spider!.updateConfig({ maxDepth: originalMaxDepth });
    }
    throw error;
  }
}

/**
 * Find all files that reference/import a target file
 */
async function executeFindReferencingFiles(
  params: FindReferencingFilesParams
): Promise<FindReferencingFilesResult> {
  const { targetPath } = params;

  // Validate file exists
  await validateFileExists(targetPath);

  const references = await spider!.findReferencingFiles(targetPath);

  return {
    targetPath,
    referencingFileCount: references.length,
    referencingFiles: references.map((ref) => ({
      path: ref.path,
      relativePath: getRelativePath(ref.path, config!.rootDir),
      type: ref.type,
      line: ref.line,
      module: ref.module,
    })),
  };
}

/**
 * Expand a node to discover new dependencies not in the known set
 */
async function executeExpandNode(params: ExpandNodeParams): Promise<ExpandNodeResult> {
  const { filePath, knownPaths, extraDepth } = params;

  // Validate file exists
  await validateFileExists(filePath);

  const existingNodes = new Set<string>(knownPaths);
  const result = await spider!.crawlFrom(filePath, existingNodes, extraDepth ?? 10);

  return {
    expandedNode: filePath,
    newNodeCount: result.nodes.length,
    newEdgeCount: result.edges.length,
    newNodes: result.nodes,
    newEdges: result.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      sourceRelative: getRelativePath(edge.source, config!.rootDir),
      targetRelative: getRelativePath(edge.target, config!.rootDir),
    })),
  };
}

/**
 * Parse imports from a file without resolving paths
 */
async function executeParseImports(
  params: ParseImportsParams
): Promise<ParseImportsResult> {
  const { filePath } = params;

  // Validate file exists
  await validateFileExists(filePath);

  const content = await fs.readFile(filePath, 'utf-8');
  const imports = parser!.parse(content, filePath);

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
 * Resolve a module specifier to an absolute path
 */
async function executeResolveModulePath(
  params: ResolveModulePathParams
): Promise<ResolveModulePathResult> {
  const { fromFile, moduleSpecifier } = params;

  // Validate source file exists
  await validateFileExists(fromFile);

  try {
    const resolvedPath = await resolver!.resolve(fromFile, moduleSpecifier);

    if (resolvedPath) {
      return {
        fromFile,
        moduleSpecifier,
        resolved: true,
        resolvedPath,
        resolvedRelativePath: getRelativePath(resolvedPath, config!.rootDir),
      };
    } else {
      return {
        fromFile,
        moduleSpecifier,
        resolved: false,
        resolvedPath: null,
        resolvedRelativePath: null,
        failureReason: 'Module could not be resolved (may be a node_module or non-existent file)',
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
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
 * Get current index status and statistics
 */
function executeGetIndexStatus(): GetIndexStatusResult {
  const indexStatus = spider!.getIndexStatus();
  const cacheStats = spider!.getCacheStats();

  // Map 'validating' state to 'indexing' for MCP response
  const state = indexStatus.state === 'validating' ? 'indexing' : indexStatus.state;

  return {
    state,
    isReady,
    reverseIndexEnabled: spider!.hasReverseIndex(),
    cacheSize: cacheStats.size,
    reverseIndexStats: cacheStats.reverseIndexStats,
    progress:
      indexStatus.state === 'indexing'
        ? {
            processed: indexStatus.processed,
            total: indexStatus.total,
            percentage: indexStatus.percentage,
            currentFile: indexStatus.currentFile,
          }
        : undefined,
    warmup: warmupInfo,
  };
}

/**
 * Invalidate specific files from the cache
 */
function executeInvalidateFiles(params: InvalidateFilesParams): InvalidateFilesResult {
  const { filePaths } = params;
  const invalidatedFiles: string[] = [];
  const notFoundFiles: string[] = [];

  for (const filePath of filePaths) {
    const wasInvalidated = spider!.invalidateFile(filePath);
    if (wasInvalidated) {
      invalidatedFiles.push(filePath);
    } else {
      notFoundFiles.push(filePath);
    }
  }

  return {
    invalidatedCount: invalidatedFiles.length,
    invalidatedFiles,
    notFoundFiles,
    reverseIndexUpdated: spider!.hasReverseIndex(),
  };
}

/**
 * Rebuild the entire index from scratch
 */
async function executeRebuildIndex(): Promise<RebuildIndexResult> {
  const startTime = Date.now();

  // Clear all cached data
  spider!.clearCache();

  // Re-index by warming up the spider again
  // This will scan the workspace and rebuild the reverse index
  await spider!.warmup((processed, total, currentFile) => {
    postMessage({
      type: 'warmup-progress',
      processed,
      total,
      currentFile,
    });
  });

  const rebuildTimeMs = Date.now() - startTime;
  const cacheStats = spider!.getCacheStats();

  return {
    reindexedCount: cacheStats.size,
    rebuildTimeMs,
    newCacheSize: cacheStats.size,
    reverseIndexStats: cacheStats.reverseIndexStats ?? {
      indexedFiles: 0,
      targetFiles: 0,
      totalReferences: 0,
    },
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validate that a file exists
 */
async function validateFileExists(filePath: string): Promise<void> {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${filePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`File not found: ${filePath}`);
    }
    throw error;
  }
}

/**
 * Detect circular dependencies in the graph
 */
function detectCircularDependencies(
  edges: { source: string; target: string }[]
): string[][] {
  const graph = new Map<string, Set<string>>();

  // Build adjacency list
  for (const edge of edges) {
    if (!graph.has(edge.source)) {
      graph.set(edge.source, new Set());
    }
    graph.get(edge.source)!.add(edge.target);
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): void {
    visited.add(node);
    recursionStack.add(node);
    path.push(node);

    const neighbors = graph.get(node);
    if (neighbors) {
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          dfs(neighbor);
        } else if (recursionStack.has(neighbor)) {
          // Found a cycle
          const cycleStart = path.indexOf(neighbor);
          const cycle = path.slice(cycleStart);
          cycle.push(neighbor); // Complete the cycle
          cycles.push(cycle);
        }
      }
    }

    path.pop();
    recursionStack.delete(node);
  }

  // Run DFS from each unvisited node
  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      dfs(node);
    }
  }

  return cycles;
}

// Re-export types for testing
export type { McpWorkerMessage, McpWorkerResponse, McpWorkerConfig } from './types';
