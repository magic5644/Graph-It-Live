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

import { setLoggerBackend, StderrLogger } from '../shared/logger';

// Configure all loggers in this process to use StderrLogger
// This ensures stdout is kept clean for JSON-RPC
setLoggerBackend({
  createLogger(prefix: string, level) {
    return new StderrLogger(prefix, level);
  }
});

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
debugLog('[McpServer] cwd:', process.cwd());
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
  type GetSymbolGraphResult,
  type FindUnusedSymbolsResult,
  type GetSymbolDependentsResult,
  type TraceFunctionExecutionResult,
  type GetSymbolCallersResult,
  type AnalyzeBreakingChangesResult,
  type GetImpactAnalysisResult,
  type SetWorkspaceResult,
  type PaginationInfo,
  SetWorkspaceParamsSchema,
} from './types';

// ============================================================================
// Environment Configuration
// ============================================================================

// Mutable configuration - can be changed via setWorkspace tool
const currentConfig = {
  workspaceRoot: process.env.WORKSPACE_ROOT ?? '',
  tsConfigPath: process.env.TSCONFIG_PATH,
  excludeNodeModules: process.env.EXCLUDE_NODE_MODULES !== 'false',
  maxDepth: Number.parseInt(process.env.MAX_DEPTH ?? '50', 10),
};

// Check for unresolved variables (common misconfiguration)
if (currentConfig.workspaceRoot && (currentConfig.workspaceRoot.includes('${') || currentConfig.workspaceRoot.includes('$('))) {
  debugLog('[McpServer] WARNING: WORKSPACE_ROOT contains unresolved variable:', currentConfig.workspaceRoot);
  debugLog('[McpServer] Workspace not set - use graphitlive_set_workspace tool to configure');
  currentConfig.workspaceRoot = '';
}

// Fallback logic for WORKSPACE_ROOT (only if set via env)
if (!currentConfig.workspaceRoot) {
  const cwd = process.cwd();
  
  // If cwd is root or empty, don't set a default - require explicit configuration
  if (cwd === '/' || cwd === '') {
    debugLog('[McpServer] No workspace configured - use graphitlive_set_workspace tool to set workspace');
  } else {
    currentConfig.workspaceRoot = cwd;
    debugLog('[McpServer] WORKSPACE_ROOT not set, using current working directory:', currentConfig.workspaceRoot);
  }
}

// Validate workspace if set
if (currentConfig.workspaceRoot && !fs.existsSync(currentConfig.workspaceRoot)) {
  debugLog('[McpServer] WARNING: WORKSPACE_ROOT path does not exist:', currentConfig.workspaceRoot);
  debugLog('[McpServer] Use graphitlive_set_workspace tool to configure a valid workspace');
  currentConfig.workspaceRoot = '';
}

// Helper to get current workspace (may be empty if not configured)
function getWorkspaceRoot(): string {
  return currentConfig.workspaceRoot;
}

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
        rootDir: getWorkspaceRoot(),
        tsConfigPath: currentConfig.tsConfigPath,
        excludeNodeModules: currentConfig.excludeNodeModules,
        maxDepth: currentConfig.maxDepth,
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
    return createErrorResponse<T>('Worker not ready', 0, getWorkspaceRoot());
  }

  const startTime = Date.now();

  try {
    const result = await workerHost.invoke<T>(toolName as Parameters<typeof workerHost.invoke>[0], params);
    const executionTimeMs = Date.now() - startTime;
    return createSuccessResponse(result, executionTimeMs, getWorkspaceRoot());
  } catch (error) {
    const executionTimeMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return createErrorResponse<T>(errorMessage, executionTimeMs, getWorkspaceRoot());
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

// Tool: graphitlive_set_workspace
// This tool is special - it doesn't require the worker to be ready first
server.registerTool(
  'graphitlive_set_workspace',
  {
    title: 'Set Workspace Directory',
    description: `USE THIS TOOL FIRST when working with a new project or when the workspace hasn't been configured yet. This tool MUST be called before any other graphitlive tools if no workspace is set.

WHY: Graph-It-Live needs to know which project directory to analyze. Without a workspace configured, all other tools will fail. This tool sets the project root and initializes the dependency index for fast queries.

RETURNS: Confirmation of the new workspace path and the number of files indexed. After calling this, all other graphItLive tools will work on the specified project.

EXAMPLE: If analyzing a project at "/Users/me/my-app", call this tool with workspacePath="/Users/me/my-app"`,
    inputSchema: SetWorkspaceParamsSchema,
  },
  async ({ workspacePath, tsConfigPath, excludeNodeModules, maxDepth }) => {
    const startTime = Date.now();
    const previousWorkspace = getWorkspaceRoot();
    
    debugLog(`[McpServer] setWorkspace called with: ${workspacePath}`);
    
    // Validate the path exists
    if (!fs.existsSync(workspacePath)) {
      const response: McpToolResponse<SetWorkspaceResult> = {
        success: false,
        data: {
          success: false,
          workspacePath,
          filesIndexed: 0,
          indexingTimeMs: 0,
          previousWorkspace: previousWorkspace || undefined,
          message: `Path does not exist: ${workspacePath}`,
        },
        error: `Path does not exist: ${workspacePath}`,
        metadata: {
          executionTimeMs: Date.now() - startTime,
          toolVersion: MCP_TOOL_VERSION,
          timestamp: new Date().toISOString(),
          workspaceRoot: workspacePath,
        },
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
        isError: true,
      };
    }
    
    // Check if it's a directory
    const stats = fs.statSync(workspacePath);
    if (!stats.isDirectory()) {
      const response: McpToolResponse<SetWorkspaceResult> = {
        success: false,
        data: {
          success: false,
          workspacePath,
          filesIndexed: 0,
          indexingTimeMs: 0,
          previousWorkspace: previousWorkspace || undefined,
          message: `Path is not a directory: ${workspacePath}`,
        },
        error: `Path is not a directory: ${workspacePath}`,
        metadata: {
          executionTimeMs: Date.now() - startTime,
          toolVersion: MCP_TOOL_VERSION,
          timestamp: new Date().toISOString(),
          workspaceRoot: workspacePath,
        },
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
        isError: true,
      };
    }
    
    // Update configuration
    currentConfig.workspaceRoot = workspacePath;
    if (tsConfigPath !== undefined) currentConfig.tsConfigPath = tsConfigPath;
    if (excludeNodeModules !== undefined) currentConfig.excludeNodeModules = excludeNodeModules;
    if (maxDepth !== undefined) currentConfig.maxDepth = maxDepth;
    
    debugLog(`[McpServer] Workspace updated to: ${workspacePath}`);
    
    // Dispose existing worker if any
    if (workerHost) {
      debugLog('[McpServer] Disposing previous worker...');
      workerHost.dispose();
      workerHost = null;
    }
    
    // Reset initialization state
    isInitialized = false;
    initializationPromise = null;
    initializationError = null;
    
    // Initialize with new workspace
    try {
      await initializeWorker();
      
      const executionTimeMs = Date.now() - startTime;
      let filesIndexed = 0;
      
      // Get index status to report number of files indexed
      // workerHost is reassigned in initializeWorker() - use type assertion since TS can't track this
      const currentWorker = workerHost as McpWorkerHost | null;
      if (currentWorker?.ready()) {
        const statusResult = await currentWorker.invoke<GetIndexStatusResult>('get_index_status', {});
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
      
      debugLog(`[McpServer] Workspace configured successfully: ${filesIndexed} files indexed`);
      
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error during initialization';
      debugLog(`[McpServer] setWorkspace failed: ${errorMessage}`);
      
      const response: McpToolResponse<SetWorkspaceResult> = {
        success: false,
        data: {
          success: false,
          workspacePath,
          filesIndexed: 0,
          indexingTimeMs: Date.now() - startTime,
          previousWorkspace: previousWorkspace || undefined,
          message: `Failed to initialize workspace: ${errorMessage}`,
        },
        error: errorMessage,
        metadata: {
          executionTimeMs: Date.now() - startTime,
          toolVersion: MCP_TOOL_VERSION,
          timestamp: new Date().toISOString(),
          workspaceRoot: workspacePath,
        },
      };
      
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
        isError: true,
      };
    }
  }
);

// Tool: graphitlive_analyze_dependencies
server.registerTool(
  'graphitlive_analyze_dependencies',
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

// Tool: graphitlive_crawl_dependency_graph
server.registerTool(
  'graphitlive_crawl_dependency_graph',
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
      getWorkspaceRoot(),
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

// Tool: graphitlive_find_referencing_files
server.registerTool(
  'graphitlive_find_referencing_files',
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

// Tool: graphitlive_expand_node
server.registerTool(
  'graphitlive_expand_node',
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

// Tool: graphitlive_parse_imports
server.registerTool(
  'graphitlive_parse_imports',
  {
    title: 'Parse Raw Import Statements',
    description: `USE THIS TOOL WHEN you need to see the exact import statements as written in the source code, without path resolution. Examples: "What import syntax does this file use?", "Show me the raw import statements", "What module specifiers are in this file?"

WHY: Sometimes you need to see exactly how imports are written (relative paths, aliases, bare specifiers) before resolution. This is useful for understanding coding patterns, checking import styles, or debugging path resolution issues. The tool uses fast regex-based parsing and handles Vue/Svelte script extraction automatically.

RETURNS: An array of raw import/require/export statements as they appear in the source code, with the module specifier (e.g., "./utils", "@/components/Button", "lodash"), import type, and line number. Does NOT resolve paths - use graphitlive_analyze_dependencies for resolved paths.`,
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

// Tool: graphitlive_resolve_module_path
server.registerTool(
  'graphitlive_resolve_module_path',
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

// Tool: graphitlive_get_index_status
server.registerTool(
  'graphitlive_get_index_status',
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

// Tool: graphitlive_invalidate_files
server.registerTool(
  'graphitlive_invalidate_files',
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

// Tool: graphitlive_rebuild_index
server.registerTool(
  'graphitlive_rebuild_index',
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

// Tool: graphitlive_get_symbol_graph
server.registerTool(
  'graphitlive_get_symbol_graph',
  {
    title: 'Get Symbol-Level Dependency Graph',
    description: `CRITICAL: USE THIS TOOL WHEN the user wants to drill down from file-level dependencies to symbol-level (functions, classes, methods) dependencies. This enables **surgical refactoring** by showing exactly which symbols within a file depend on which external symbols.

WHEN TO USE:
- User asks "Which functions in this file use X?"
- User wants to understand the internal structure of a file's dependencies
- User needs to refactor a specific class/function without breaking others in the same file
- User asks about symbol-level architecture or method-level coupling

WHY YOU NEED THIS:
Without this tool, you only see file-to-file relationships. This tool uses AST parsing (ts-morph) to extract:
1. All exported symbols (functions, classes, variables) with their types and line numbers
2. Precise symbol-to-symbol dependencies (e.g., "function A calls function B from module X")
3. Import alias resolution (tracks original names even when aliased)
4. Filters out type-only imports (interfaces/types vs runtime code)

RETURNS:
- List of exported symbols with: name, kind (FunctionDeclaration, ClassDeclaration, etc.), line number, category (function/class/variable/interface/type)
- Symbol dependency edges with source/target symbol IDs and file paths
- Categorized by runtime vs type-only for filtering

This enables the **"Drill Down" UX pattern** where users double-click a file node to see its internal symbol graph.`,
    inputSchema: {
      filePath: z.string().describe('The absolute path to the file to analyze at the symbol level. This should be a TypeScript, JavaScript, Vue, or Svelte file.'),
    },
  },
  async ({ filePath }) => {
    const workerCheck = await ensureWorkerReady();
    if (workerCheck.error) return workerCheck.response;

    const response = await invokeToolWithResponse<GetSymbolGraphResult>('get_symbol_graph', { filePath });

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

// Tool: graphitlive_find_unused_symbols
server.registerTool(
  'graphitlive_find_unused_symbols',
  {
    title: 'Find Dead Code (Unused Exports)',
    description: `CRITICAL: USE THIS TOOL WHEN the user wants to identify potential dead code or refactor opportunities by finding exported symbols that are never imported/used anywhere in the project.

WHEN TO USE:
- User asks "What exports are unused in this file?"
- User wants to clean up dead code or remove unnecessary exports
- User needs to understand which parts of an API are actually consumed
- Code review to identify bloat or over-exported symbols

WHY YOU NEED THIS:
You cannot determine if an export is used without scanning the entire codebase. This tool:
1. Extracts all exported symbols from the target file
2. Cross-references them with the reverse dependency index
3. Identifies symbols that are exported but never imported elsewhere
4. Calculates the "unused percentage" to prioritize cleanup

RETURNS:
- List of unused exported symbols with their metadata (name, kind, line number, category)
- Total count of unused vs total exported symbols
- Percentage of exports that are dead code
- Each unused symbol includes its line number for quick navigation

NOTE: Currently returns all exports as potentially unused until full cross-file symbol resolution is implemented. This will be enhanced to accurately track symbol-level imports across the project.`,
    inputSchema: {
      filePath: z.string().describe('The absolute path to the file to check for unused exports. Typically a library file, utility module, or component that may have over-exported.'),
    },
  },
  async ({ filePath }) => {
    const workerCheck = await ensureWorkerReady();
    if (workerCheck.error) return workerCheck.response;

    const response = await invokeToolWithResponse<FindUnusedSymbolsResult>('find_unused_symbols', { filePath });

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

// Tool: graphitlive_get_symbol_dependents
server.registerTool(
  'graphitlive_get_symbol_dependents',
  {
    title: 'Find All Callers of a Symbol (Impact Analysis)',
    description: `CRITICAL: USE THIS TOOL WHEN the user wants to know every file and specific method/function that calls or uses a given symbol. This is essential for surgical refactoring and precise impact analysis.

WHEN TO USE:
- User asks "What uses this function?" or "Who calls this method?"
- User wants to refactor a function and needs to know all callers
- User needs to change a function signature and must update all call sites
- Impact analysis before modifying an API, class method, or utility function
- User asks about the "blast radius" of a change to a specific symbol

WHY YOU NEED THIS:
Unlike file-level dependencies, this tool provides SYMBOL-LEVEL precision:
- Knows exactly which FUNCTIONS/METHODS call the target symbol
- Works across the entire codebase, not just one file
- Essential for safe refactoring without breaking dependent code
- Answers the question: "If I change this signature, what breaks?"

RETURNS:
- List of all symbol dependencies that use the target symbol
- Each entry includes: caller symbol ID, file path, and relative path
- Total count of dependents for quick impact assessment

EXAMPLE USE CASE:
User: "I want to add a parameter to formatDate(). What will break?"
→ Use this tool with symbolName="formatDate" to get all callers, then the user knows exactly which functions need updating.`,
    inputSchema: {
      filePath: z.string().describe('The absolute path to the file containing the symbol to analyze.'),
      symbolName: z.string().describe('The name of the function, class, or method to find dependents for (e.g., "formatDate", "UserService", "handleRequest").'),
    },
  },
  async ({ filePath, symbolName }) => {
    const workerCheck = await ensureWorkerReady();
    if (workerCheck.error) return workerCheck.response;

    const response = await invokeToolWithResponse<GetSymbolDependentsResult>('get_symbol_dependents', { 
      filePath, 
      symbolName,
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

// Tool: graphitlive_trace_function_execution
server.registerTool(
  'graphitlive_trace_function_execution',
  {
    title: 'Trace Function Execution Chain',
    description: `CRITICAL: USE THIS TOOL WHEN the user wants to trace the full, deep call chain from a root symbol (function, method, or class). This is essential for understanding the execution flow through services, repositories, and utilities.

WHEN TO USE:
- User asks "What does this function call?"
- User wants to trace an API call through the entire stack
- User needs to understand the full execution path of a feature
- User asks about the call hierarchy or call graph
- Impact analysis for deep refactoring

WHY YOU NEED THIS:
This tool provides a complete picture of what a function calls, recursively following the call chain until:
1. It reaches external modules (node_modules)
2. It hits the max depth limit
3. It encounters a cycle (already visited symbol)

Unlike graphitlive_get_symbol_graph which shows only direct dependencies, this tool follows the entire execution chain through multiple files.

RETURNS:
- Root symbol information (ID, file path, symbol name)
- Complete call chain with depth, caller, and called symbols
- Resolved file paths for each called symbol
- List of all visited symbols (for detecting coverage)
- Whether the max depth was reached (may need deeper trace)

Use cases:
- Trace \`handleRequest\` from controller → service → repository → database
- Understand which utilities a feature depends on
- Map out the blast radius of a function change`,
    inputSchema: {
      filePath: z.string().describe('The absolute path to the file containing the root symbol to trace from.'),
      symbolName: z.string().describe('The name of the function, method, or class to start tracing from.'),
      maxDepth: z.number().optional().describe('Maximum depth to trace. Default is 10. Use higher values (20-50) for deep call stacks.'),
    },
  },
  async ({ filePath, symbolName, maxDepth }) => {
    const workerCheck = await ensureWorkerReady();
    if (workerCheck.error) return workerCheck.response;

    const response = await invokeToolWithResponse<TraceFunctionExecutionResult>('trace_function_execution', { 
      filePath, 
      symbolName,
      maxDepth,
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

// Tool: graphitlive_get_symbol_callers
server.registerTool(
  'graphitlive_get_symbol_callers',
  {
    title: 'Get Symbol Callers (Reverse Dependencies)',
    description: `CRITICAL: USE THIS TOOL WHEN the user wants to find all callers of a specific symbol (function, method, class, or variable).

WHEN TO USE:
- User asks "Who calls this function?"
- User asks "Where is this method used?"
- User wants to understand symbol usage across the codebase
- User needs reverse symbol-level dependencies
- Pre-refactoring analysis to understand blast radius

WHY YOU NEED THIS:
Unlike file-level reverse dependencies (graphitlive_find_referencing_files), this tool provides **symbol-level granularity**.
It answers "Which specific functions call my function?" rather than "Which files import my file?".

RETURNS:
- List of callers with their file path, symbol name, line number
- Usage type: 'runtime' (actual code execution) vs 'type-only' (interface/type usage)
- Sorted by depth (direct callers first)

Use cases:
- Find all call sites before renaming a function
- Identify dead code (symbols with no callers)
- Understand symbol coupling across modules`,
    inputSchema: {
      filePath: z.string().describe('The absolute path to the file containing the target symbol.'),
      symbolName: z.string().describe('The name of the symbol (function, class, method, variable) to find callers for.'),
      includeTypeOnly: z.boolean().optional().describe('Include type-only usages (interfaces, type aliases). Default is true.'),
    },
  },
  async ({ filePath, symbolName, includeTypeOnly }) => {
    const workerCheck = await ensureWorkerReady();
    if (workerCheck.error) return workerCheck.response;

    const response = await invokeToolWithResponse<GetSymbolCallersResult>('get_symbol_callers', { 
      filePath, 
      symbolName,
      includeTypeOnly,
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

// Tool: graphitlive_analyze_breaking_changes
server.registerTool(
  'graphitlive_analyze_breaking_changes',
  {
    title: 'Analyze Breaking Changes in Signature',
    description: `CRITICAL: USE THIS TOOL WHEN the user wants to detect breaking changes after modifying a function, method, or class signature.

WHEN TO USE:
- User asks "Will this change break anything?"
- User is about to modify function parameters
- User changed return type and wants to validate
- User renamed or removed parameters
- Pre-PR validation for API changes

WHY YOU NEED THIS:
This tool compares the BEFORE and AFTER versions of a function/method signature and detects:
- Added required parameters (BREAKING)
- Removed parameters (BREAKING)
- Changed parameter types (BREAKING)
- Changed return type (BREAKING)
- Added optional parameters (usually safe)
- Parameter order changes

RETURNS:
- List of breaking changes with type and description
- Severity level (high/medium/low)
- Suggested migration steps
- List of affected callers that need to be updated

Use cases:
- Validate refactoring before committing
- Generate migration notes for API changes
- Identify which call sites need updates`,
    inputSchema: {
      filePath: z.string().describe('The absolute path to the file containing the modified symbol.'),
      symbolName: z.string().optional().describe('Optional: filter to analyze only changes to this specific symbol.'),
      oldContent: z.string().describe('The original file content before the change (for comparison).'),
      newContent: z.string().optional().describe('The new file content after the change. If not provided, reads current file.'),
    },
  },
  async ({ filePath, symbolName, oldContent, newContent }) => {
    const workerCheck = await ensureWorkerReady();
    if (workerCheck.error) return workerCheck.response;

    const response = await invokeToolWithResponse<AnalyzeBreakingChangesResult>('analyze_breaking_changes', { 
      filePath, 
      symbolName,
      oldContent,
      newContent,
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

// Tool: graphitlive_get_impact_analysis
server.registerTool(
  'graphitlive_get_impact_analysis',
  {
    title: 'Get Comprehensive Impact Analysis',
    description: `CRITICAL: USE THIS TOOL WHEN the user needs a full impact assessment before modifying a symbol.

WHEN TO USE:
- User asks "What's the blast radius of this change?"
- User wants to understand full impact of modifying a function/class
- User needs to identify all affected code paths
- Pre-refactoring risk assessment
- Understanding module coupling

WHY YOU NEED THIS:
This is the MOST COMPREHENSIVE impact analysis tool. It combines:
1. Symbol-level reverse dependencies (who calls this symbol?)
2. Transitive impact (who calls the callers? And so on...)
3. Type vs runtime usage distinction
4. File-level aggregation
5. Human-readable risk assessment

RETURNS:
- Impact level: 'high', 'medium', or 'low'
- Total impact count (direct + transitive)
- Breakdown: runtime vs type-only impacts
- List of impacted symbols with:
  - Symbol ID and file path
  - Depth (1 = direct, 2+ = transitive)
  - Usage type (runtime/type-only)
- Affected files list
- Human-readable summary with recommendations

Use cases:
- Full risk assessment before major refactoring
- Identify critical vs low-impact changes
- Generate change impact reports
- Prioritize which call sites to update first`,
    inputSchema: {
      filePath: z.string().describe('The absolute path to the file containing the target symbol.'),
      symbolName: z.string().describe('The name of the symbol to analyze impact for.'),
      includeTransitive: z.boolean().optional().describe('Include transitive (indirect) impacts. Default is true.'),
      maxDepth: z.number().optional().describe('Maximum transitive depth. Default is 5. Higher = more complete but slower.'),
    },
  },
  async ({ filePath, symbolName, includeTransitive, maxDepth }) => {
    const workerCheck = await ensureWorkerReady();
    if (workerCheck.error) return workerCheck.response;

    const response = await invokeToolWithResponse<GetImpactAnalysisResult>('get_impact_analysis', { 
      filePath, 
      symbolName,
      includeTransitive,
      maxDepth,
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

// ============================================================================
// Server Startup
// ============================================================================

async function main(): Promise<void> {
  debugLog('[McpServer] Graph-It-Live MCP Server starting...');
  debugLog(`[McpServer] Workspace: ${getWorkspaceRoot() || '(not configured - use graphitlive_set_workspace)'}`);
  debugLog(`[McpServer] TSConfig: ${currentConfig.tsConfigPath ?? 'auto-detect'}`);
  debugLog(`[McpServer] Exclude node_modules: ${currentConfig.excludeNodeModules}`);
  debugLog(`[McpServer] Max depth: ${currentConfig.maxDepth}`);

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
