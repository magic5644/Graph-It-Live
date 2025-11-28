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

// Tool: analyze_dependencies
server.registerTool(
  'analyze_dependencies',
  {
    title: 'Analyze Dependencies',
    description: '[Built-in tool - no installation needed] Analyze a TypeScript/JavaScript/Vue/Svelte/GraphQL file and return all its import/export dependencies with full path resolution. Uses native regex-based parsing.',
    inputSchema: {
      filePath: z.string().describe('Absolute path to the file to analyze'),
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

// Tool: crawl_dependency_graph
server.registerTool(
  'crawl_dependency_graph',
  {
    title: 'Crawl Dependency Graph',
    description: '[Built-in tool - no installation needed] Build a complete dependency graph starting from an entry file. Returns all nodes (files) and edges (import relationships). Supports pagination for large graphs. Works with TS/JS/Vue/Svelte/GraphQL.',
    inputSchema: {
      entryFile: z.string().describe('Absolute path to the entry file'),
      maxDepth: z.number().optional().describe('Maximum depth to crawl (default: from config)'),
      limit: z.number().optional().describe('Maximum number of nodes to return (for pagination)'),
      offset: z.number().optional().describe('Number of nodes to skip (for pagination)'),
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

// Tool: find_referencing_files
server.registerTool(
  'find_referencing_files',
  {
    title: 'Find Referencing Files',
    description: '[Built-in tool - no installation needed] Find all files that import/reference a given file (reverse dependency lookup). Uses pre-built index for instant O(1) lookups. Useful for understanding the impact of changing a file.',
    inputSchema: {
      targetPath: z.string().describe('Absolute path to the file to find references for'),
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

// Tool: expand_node
server.registerTool(
  'expand_node',
  {
    title: 'Expand Node',
    description: '[Built-in tool - no installation needed] Discover new dependencies from a specific node that are not in the known set. Useful for incremental graph exploration without re-analyzing the entire project.',
    inputSchema: {
      filePath: z.string().describe('Absolute path to the node to expand'),
      knownPaths: z.array(z.string()).describe('Array of already known file paths to exclude'),
      extraDepth: z.number().optional().describe('Additional depth to scan from this node (default: 10)'),
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

// Tool: parse_imports
server.registerTool(
  'parse_imports',
  {
    title: 'Parse Imports',
    description: '[Built-in tool - no installation needed] Extract raw import statements from a TS/JS/Vue/Svelte/GraphQL file without resolving paths. Returns the module specifiers as written in the source code. Uses fast regex-based parsing.',
    inputSchema: {
      filePath: z.string().describe('Absolute path to the file to parse'),
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

// Tool: resolve_module_path
server.registerTool(
  'resolve_module_path',
  {
    title: 'Resolve Module Path',
    description: '[Built-in tool - no installation needed] Resolve a module specifier (like "./utils" or "@/components/Button") to an absolute file path. Automatically handles tsconfig.json path aliases and implicit file extensions (.ts, .tsx, .js, .jsx, .vue, .svelte).',
    inputSchema: {
      fromFile: z.string().describe('Absolute path of the file containing the import'),
      moduleSpecifier: z.string().describe('The module specifier to resolve (e.g., "./utils", "@/components/Button")'),
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

// Tool: get_index_status
server.registerTool(
  'get_index_status',
  {
    title: 'Get Index Status',
    description: '[Built-in tool - no installation needed] Get the current status of the dependency index including number of indexed files, cache statistics, and warmup information. Useful to verify the server is ready.',
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
