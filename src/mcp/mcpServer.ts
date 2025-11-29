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

import * as fs from 'node:fs';
import * as os from 'node:os';

// ============================================================================
// File Logger for Debugging (writes to ~/mcp-debug.log)
// ============================================================================
const DEBUG_LOG_PATH = `${os.homedir()}/mcp-debug.log`;

/**
 * Write a debug message to both stderr and a file for easier debugging
 */
function debugLog(...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const message = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  const line = `[${timestamp}] ${message}\n`;
  
  // Write to stderr for MCP protocol
  console.error(message);
  
  // Also write to file for debugging VS Code/Antigravity issues
  try {
    fs.appendFileSync(DEBUG_LOG_PATH, line);
  } catch {
    // Ignore write errors
  }
}

// EARLY DEBUG: Log immediately to confirm process starts
debugLog('[McpServer] ===== PROCESS STARTING =====');
debugLog('[McpServer] Node version:', process.version);
debugLog('[McpServer] PID:', process.pid);
debugLog('[McpServer] argv:', JSON.stringify(process.argv));
debugLog('[McpServer] Environment vars:');
debugLog('  WORKSPACE_ROOT:', process.env.WORKSPACE_ROOT ?? '(not set)');
debugLog('  TSCONFIG_PATH:', process.env.TSCONFIG_PATH ?? '(not set)');
debugLog('  EXCLUDE_NODE_MODULES:', process.env.EXCLUDE_NODE_MODULES ?? '(not set)');
debugLog('  MAX_DEPTH:', process.env.MAX_DEPTH ?? '(not set)');

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as path from 'node:path';
import * as z from 'zod/v4';
import { McpWorkerHost } from './McpWorkerHost';
import {
  createSuccessResponse,
  createErrorResponse,
  MCP_TOOL_VERSION,
  type McpToolResponse,
  type AnalyzeDependenciesResult,
  type CrawlDependencyGraphResult,
  type FindReferencingFilesResult,
  type ExpandNodeResult,
  type ParseImportsResult,
  type ResolveModulePathResult,
  type GetIndexStatusResult,
  type InvalidateFilesResult,
  type RebuildIndexResult,
  type PaginationInfo,
} from './types';

// ============================================================================
// Environment Configuration
// ============================================================================

const WORKSPACE_ROOT_ENV = process.env.WORKSPACE_ROOT;
const TSCONFIG_PATH = process.env.TSCONFIG_PATH;
const EXCLUDE_NODE_MODULES = process.env.EXCLUDE_NODE_MODULES !== 'false';
const MAX_DEPTH = Number.parseInt(process.env.MAX_DEPTH ?? '50', 10);

if (!WORKSPACE_ROOT_ENV) {
  debugLog('[McpServer] WORKSPACE_ROOT environment variable is required');
  process.exit(1);
}

// After validation, we know this is defined
const WORKSPACE_ROOT: string = WORKSPACE_ROOT_ENV;

// ============================================================================
// Server Setup
// ============================================================================

const server = new McpServer({
  name: 'graph-it-live',
  version: MCP_TOOL_VERSION,
});

let workerHost: McpWorkerHost | null = null;
let isInitialized = false;
let initializationPromise: Promise<void> | null = null;
let initializationError: Error | null = null;

/**
 * Initialize the worker host with warmup
 * Uses a singleton pattern to avoid multiple initializations
 */
async function initializeWorker(): Promise<void> {
  // Already initialized successfully
  if (isInitialized) {
    return;
  }

  // Previous initialization failed
  if (initializationError) {
    throw initializationError;
  }

  // Initialization already in progress, wait for it
  if (initializationPromise) {
    debugLog('[McpServer] Waiting for existing initialization...');
    return initializationPromise;
  }

  // Start new initialization
  initializationPromise = doInitializeWorker();
  
  try {
    await initializationPromise;
  } catch (error) {
    initializationError = error instanceof Error ? error : new Error(String(error));
    throw initializationError;
  }
}

/**
 * Actual worker initialization logic
 */
async function doInitializeWorker(): Promise<void> {
  const workerPath = path.join(__dirname, 'mcpWorker.js');
  
  // Debug: Log worker path resolution
  debugLog(`[McpServer] __dirname: ${__dirname}`);
  debugLog(`[McpServer] Worker path: ${workerPath}`);
  
  // Check if worker file exists
  try {
    const fs = await import('node:fs/promises');
    await fs.access(workerPath);
    debugLog('[McpServer] Worker file exists: true');
  } catch {
    debugLog('[McpServer] Worker file exists: false - THIS IS THE PROBLEM!');
    throw new Error(`Worker file not found at ${workerPath}`);
  }

  workerHost = new McpWorkerHost({
    workerPath,
    warmupTimeout: 120000, // 2 minutes for large workspaces
    invokeTimeout: 60000, // 1 minute per tool call
  });

  debugLog('[McpServer] Starting worker with warmup...');

  try {
    const result = await workerHost.start(
      {
        rootDir: WORKSPACE_ROOT,
        tsConfigPath: TSCONFIG_PATH,
        excludeNodeModules: EXCLUDE_NODE_MODULES,
        maxDepth: MAX_DEPTH,
      },
      (processed, total, currentFile) => {
        debugLog(`[McpServer] Warmup progress: ${processed}/${total} - ${currentFile ?? ''}`);
      }
    );

    debugLog(
      `[McpServer] Worker ready: ${result.filesIndexed} files indexed in ${result.durationMs}ms`
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
  params: unknown
): Promise<McpToolResponse<T>> {
  if (!workerHost?.ready()) {
    return createErrorResponse<T>('Worker not ready', 0, WORKSPACE_ROOT);
  }

  const startTime = Date.now();

  try {
    const result = await workerHost.invoke<T>(toolName as Parameters<typeof workerHost.invoke>[0], params);
    const executionTimeMs = Date.now() - startTime;
    return createSuccessResponse(result, executionTimeMs, WORKSPACE_ROOT);
  } catch (error) {
    const executionTimeMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse<T>(errorMessage, executionTimeMs, WORKSPACE_ROOT);
  }
}

/**
 * Helper to ensure worker is initialized, returns error response if not
 */
async function ensureWorkerReady(): Promise<{ error: true; response: { content: { type: 'text'; text: string }[]; isError: true } } | { error: false }> {
  try {
    await initializeWorker();
    return { error: false };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Worker initialization failed';
    debugLog(`[McpServer] Tool call failed - worker init error: ${errorMessage}`);
    return {
      error: true,
      response: {
        content: [{ type: 'text' as const, text: `Error: ${errorMessage}` }],
        isError: true,
      },
    };
  }
}

// ============================================================================
// Tool Definitions - Using registerTool (recommended over deprecated tool())
// ============================================================================

// Tool: graphItLive_analyzeDependencies
server.registerTool(
  'graphItLive_analyzeDependencies',
  {
    title: 'Analyze File Dependencies',
    description: `USE THIS TOOL WHEN the user asks about a file's imports, dependencies, or what modules a specific file uses. Examples: "What does this file import?", "Show me the dependencies of src/utils.ts", "What modules does this component rely on?"

WHY: As an AI, you cannot see import statements or module relationships without parsing the actual source code. This tool provides the ground truth by analyzing real import/export statements on disk. Without it, you would have to guess dependencies and risk hallucinating non-existent relationships.

RETURNS: A structured JSON with all import/export statements including: resolved absolute paths, relative paths from workspace root, import types (static import, dynamic import, require, re-export), line numbers, and file extensions. Supports TypeScript, JavaScript, Vue, Svelte, and GraphQL files.`,
    inputSchema: {
      filePath: z.string().describe('The absolute path to the file to analyze. Typically the file currently open in the editor, or a path mentioned by the user in their question.'),
    },
  },
  async ({ filePath }) => {
    const workerCheck = await ensureWorkerReady();
    if (workerCheck.error) return workerCheck.response;

    const response = await invokeToolWithResponse<AnalyzeDependenciesResult>(
      'analyze_dependencies',
      { filePath }
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }
);

// Tool: graphItLive_crawlDependencyGraph
server.registerTool(
  'graphItLive_crawlDependencyGraph',
  {
    title: 'Crawl Full Dependency Graph',
    description: `CRITICAL: USE THIS TOOL WHENEVER the user asks about project architecture, module relationships, the full dependency tree, or needs to understand how files are connected. Examples: "Show me the architecture of this module", "What's the dependency tree from main.ts?", "Map out all the files connected to this entry point", "How is this project structured?"

WHY: You cannot "see" or infer the complete project structure or transitive dependencies. This tool crawls the actual codebase starting from an entry point and builds the real dependency graph. It detects circular dependencies and counts how many files depend on each node. Without this tool, any attempt to describe project architecture would be pure speculation.

RETURNS: A complete graph with nodes (files with metadata: path, extension, dependency count, dependent count, circular dependency flag) and edges (import relationships between files). Supports pagination for large codebases. Works with TypeScript, JavaScript, Vue, Svelte, and GraphQL.`,
    inputSchema: {
      entryFile: z.string().describe('The absolute path to the entry file to start crawling from. Usually the main entry point like index.ts, main.ts, App.vue, or a file the user specifically mentions.'),
      maxDepth: z.number().optional().describe('Maximum depth to crawl. Default is 50. Use smaller values (3-10) for quick exploration, larger for complete analysis.'),
      limit: z.number().optional().describe('Maximum number of nodes to return per request. Use for pagination when dealing with large graphs.'),
      offset: z.number().optional().describe('Number of nodes to skip. Use with limit for pagination through large result sets.'),
    },
  },
  async ({ entryFile, maxDepth, limit, offset }) => {
    const workerCheck = await ensureWorkerReady();
    if (workerCheck.error) return workerCheck.response;

    const params = { entryFile, maxDepth, limit, offset };
    const result = await workerHost!.invoke<CrawlDependencyGraphResult>(
      'crawl_dependency_graph',
      params
    );

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
      WORKSPACE_ROOT,
      pagination
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }
);

// Tool: graphItLive_findReferencingFiles
server.registerTool(
  'graphItLive_findReferencingFiles',
  {
    title: 'Find Files That Import This File',
    description: `CRITICAL: USE THIS TOOL WHENEVER the user asks about impact analysis, refactoring safety, "who uses this file?", "what will break if I change this?", or reverse dependencies. Examples: "What files import utils.ts?", "What's the impact of modifying this component?", "Who depends on this service?", "Is it safe to refactor this file?", "Show me all usages of this module"

WHY: This is the MOST IMPORTANT tool for impact analysis. You cannot know which files import a given file without this reverse lookup. If a user asks about the consequences of changing a file and you don't use this tool, you will miss critical dependencies and give dangerous advice. The tool uses a pre-built index for instant O(1) lookups across the entire codebase.

RETURNS: A list of all files that directly import/require/reference the target file, with their absolute paths and relative paths from workspace root. This tells you exactly what will be affected by changes to the target file.`,
    inputSchema: {
      targetPath: z.string().describe('The absolute path to the file you want to find importers for. This is the file the user is considering modifying or wants to understand the usage of.'),
    },
  },
  async ({ targetPath }) => {
    const workerCheck = await ensureWorkerReady();
    if (workerCheck.error) return workerCheck.response;

    const response = await invokeToolWithResponse<FindReferencingFilesResult>(
      'find_referencing_files',
      { targetPath }
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }
);

// Tool: graphItLive_expandNode
server.registerTool(
  'graphItLive_expandNode',
  {
    title: 'Expand Node Dependencies',
    description: `USE THIS TOOL WHEN you need to incrementally explore the dependency graph from a specific node, discovering new files not already in your known set. Examples: "Show me more dependencies from this file", "Expand the graph from this node", "What other files does this connect to that I haven't seen yet?"

WHY: When building a dependency graph incrementally or exploring a large codebase, you may already know about some files and want to discover NEW dependencies without re-analyzing everything. This tool efficiently finds only the files you don't already know about, making it perfect for lazy loading or step-by-step exploration.

RETURNS: A list of newly discovered nodes (files) and edges (import relationships) that were not in the known set. Includes the same metadata as the crawl tool: paths, extensions, dependency counts.`,
    inputSchema: {
      filePath: z.string().describe('The absolute path to the node to expand from. This is the file whose additional dependencies you want to discover.'),
      knownPaths: z.array(z.string()).describe('Array of absolute file paths you already know about. The tool will exclude these and only return NEW discoveries.'),
      extraDepth: z.number().optional().describe('How many levels deep to scan from this node. Default is 10. Use smaller values for quick peeks, larger for thorough exploration.'),
    },
  },
  async ({ filePath, knownPaths, extraDepth }) => {
    const workerCheck = await ensureWorkerReady();
    if (workerCheck.error) return workerCheck.response;

    const response = await invokeToolWithResponse<ExpandNodeResult>('expand_node', {
      filePath,
      knownPaths,
      extraDepth,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }
);

// Tool: graphItLive_parseImports
server.registerTool(
  'graphItLive_parseImports',
  {
    title: 'Parse Raw Import Statements',
    description: `USE THIS TOOL WHEN you need to see the exact import statements as written in the source code, without path resolution. Examples: "What import syntax does this file use?", "Show me the raw import statements", "What module specifiers are in this file?"

WHY: Sometimes you need to see exactly how imports are written (relative paths, aliases, bare specifiers) before resolution. This is useful for understanding coding patterns, checking import styles, or debugging path resolution issues. The tool uses fast regex-based parsing and handles Vue/Svelte script extraction automatically.

RETURNS: An array of raw import/require/export statements as they appear in the source code, with the module specifier (e.g., "./utils", "@/components/Button", "lodash"), import type, and line number. Does NOT resolve paths - use graphItLive_analyzeDependencies for resolved paths.`,
    inputSchema: {
      filePath: z.string().describe('The absolute path to the file to parse. Works with TypeScript, JavaScript, Vue, Svelte, and GraphQL files.'),
    },
  },
  async ({ filePath }) => {
    const workerCheck = await ensureWorkerReady();
    if (workerCheck.error) return workerCheck.response;

    const response = await invokeToolWithResponse<ParseImportsResult>('parse_imports', { filePath });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }
);

// Tool: graphItLive_resolveModulePath
server.registerTool(
  'graphItLive_resolveModulePath',
  {
    title: 'Resolve Module Specifier to File Path',
    description: `USE THIS TOOL WHEN you need to convert a module specifier (import path) to an actual file path on disk. Examples: "Where does '@/components/Button' point to?", "Resolve this import path", "What file does './utils' refer to from main.ts?"

WHY: Module specifiers in code (like "./utils", "@/components/Button", "../shared/types") don't directly tell you the actual file path. This tool handles all the complexity: tsconfig.json path aliases, implicit file extensions (.ts, .tsx, .js, .jsx, .vue, .svelte, .gql), index file resolution, and relative path calculation. Without it, you would guess incorrectly about where imports actually point.

RETURNS: The resolved absolute file path if the module exists, or null if it cannot be resolved (e.g., external npm package or non-existent file). Also indicates whether the path is inside or outside the workspace.`,
    inputSchema: {
      fromFile: z.string().describe('The absolute path of the file containing the import statement. Resolution is relative to this file\'s location.'),
      moduleSpecifier: z.string().describe('The module specifier exactly as written in the import statement. Examples: "./utils", "@/components/Button", "../shared/types", "lodash"'),
    },
  },
  async ({ fromFile, moduleSpecifier }) => {
    const workerCheck = await ensureWorkerReady();
    if (workerCheck.error) return workerCheck.response;

    const response = await invokeToolWithResponse<ResolveModulePathResult>(
      'resolve_module_path',
      { fromFile, moduleSpecifier }
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }
);

// Tool: graphItLive_getIndexStatus
server.registerTool(
  'graphItLive_getIndexStatus',
  {
    title: 'Get Dependency Index Status',
    description: `USE THIS TOOL WHEN you need to verify the dependency analyzer is ready, check how many files are indexed, or diagnose performance issues. Examples: "Is the dependency index ready?", "How many files are indexed?", "What's the cache hit rate?", "Is the analyzer warmed up?"

WHY: Before running expensive dependency analysis, you may want to verify the system is ready and understand its current state. This tool gives you insight into the indexing status, cache efficiency, and overall health of the dependency analyzer.

RETURNS: Index state (ready/initializing), number of files indexed, reverse index statistics (for finding references), cache size and hit rates, warmup completion status and duration. Useful for debugging and understanding analyzer performance.`,
    inputSchema: {},
  },
  async () => {
    const workerCheck = await ensureWorkerReady();
    if (workerCheck.error) return workerCheck.response;

    const response = await invokeToolWithResponse<GetIndexStatusResult>('get_index_status', {});

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }
);

// Tool: graphItLive_invalidateFiles
server.registerTool(
  'graphItLive_invalidateFiles',
  {
    title: 'Invalidate File Cache',
    description: `USE THIS TOOL WHEN you have modified files and need to refresh the dependency analysis. Examples: "I just changed utils.ts, refresh the cache", "Invalidate these files I modified", "Clear cache for files I edited", "Refresh dependency data after my changes"

WHY: The dependency analyzer caches file analysis for performance. When you modify a file's imports or exports, the cache becomes stale. This tool clears the cache for specific files, forcing re-analysis on the next query. Use this after file modifications to ensure accurate dependency data.

RETURNS: The number of files invalidated, which files were cleared from cache, and which files were not found in cache (already invalidated or never analyzed). The reverse index is also updated to remove stale references.`,
    inputSchema: {
      filePaths: z.array(z.string()).describe('Array of absolute file paths to invalidate. These should be files you have modified and want to refresh in the dependency cache.'),
    },
  },
  async ({ filePaths }) => {
    const workerCheck = await ensureWorkerReady();
    if (workerCheck.error) return workerCheck.response;

    const response = await invokeToolWithResponse<InvalidateFilesResult>('invalidate_files', {
      filePaths,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }
);

// Tool: graphItLive_rebuildIndex
server.registerTool(
  'graphItLive_rebuildIndex',
  {
    title: 'Rebuild Full Dependency Index',
    description: `USE THIS TOOL WHEN you need to completely rebuild the dependency index from scratch. Examples: "Rebuild the entire index", "Start fresh with dependency analysis", "Clear all cached data and re-index", "The index seems corrupted, rebuild it"

WHY: In rare cases, the dependency index may become out of sync with the actual codebase (e.g., after major refactoring, branch switches, or git operations that changed many files). This tool clears ALL cached data and re-indexes the entire workspace, ensuring the dependency graph is accurate.

RETURNS: The number of files re-indexed, time taken to rebuild, new cache size, and updated reverse index statistics. Note: This operation can take several seconds for large workspaces.`,
    inputSchema: {},
  },
  async () => {
    const workerCheck = await ensureWorkerReady();
    if (workerCheck.error) return workerCheck.response;

    const response = await invokeToolWithResponse<RebuildIndexResult>('rebuild_index', {});

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }
);

// ============================================================================
// Server Startup
// ============================================================================

async function main(): Promise<void> {
  debugLog('[McpServer] Graph-It-Live MCP Server starting...');
  debugLog(`[McpServer] Workspace: ${WORKSPACE_ROOT}`);
  debugLog(`[McpServer] TSConfig: ${TSCONFIG_PATH ?? 'auto-detect'}`);
  debugLog(`[McpServer] Exclude node_modules: ${EXCLUDE_NODE_MODULES}`);
  debugLog(`[McpServer] Max depth: ${MAX_DEPTH}`);

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  debugLog('[McpServer] MCP Server connected via stdio');

  // Start warmup immediately in background
  initializeWorker().catch((error) => {
    debugLog(`[McpServer] Background warmup failed: ${error}`);
  });

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    debugLog('[McpServer] Received SIGINT, shutting down...');
    workerHost?.dispose();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    debugLog('[McpServer] Received SIGTERM, shutting down...');
    workerHost?.dispose();
    process.exit(0);
  });
}

// Run main - IIFE pattern for entry point (NOSONAR: top-level await not supported by tsconfig)
main().catch((error: unknown) => { // NOSONAR
  debugLog(`[McpServer] Fatal error: ${error}`);
  process.exit(1);
});
