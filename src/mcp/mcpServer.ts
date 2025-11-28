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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as path from 'node:path';
import { McpWorkerHost } from './McpWorkerHost';
import {
  AnalyzeDependenciesParamsSchema,
  CrawlDependencyGraphParamsSchema,
  FindReferencingFilesParamsSchema,
  ExpandNodeParamsSchema,
  ParseImportsParamsSchema,
  ResolveModulePathParamsSchema,
  GetIndexStatusParamsSchema,
  createSuccessResponse,
  createErrorResponse,
  MCP_TOOL_VERSION,
  type McpToolResponse,
  type AnalyzeDependenciesResult,
  type AnalyzeDependenciesParams,
  type CrawlDependencyGraphResult,
  type CrawlDependencyGraphParams,
  type FindReferencingFilesResult,
  type FindReferencingFilesParams,
  type ExpandNodeResult,
  type ExpandNodeParams,
  type ParseImportsResult,
  type ParseImportsParams,
  type ResolveModulePathResult,
  type ResolveModulePathParams,
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
  console.error('[McpServer] WORKSPACE_ROOT environment variable is required');
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

/**
 * Initialize the worker host with warmup
 */
async function initializeWorker(): Promise<void> {
  if (isInitialized) {
    return;
  }

  const workerPath = path.join(__dirname, 'mcpWorker.js');
  workerHost = new McpWorkerHost({
    workerPath,
    warmupTimeout: 120000, // 2 minutes for large workspaces
    invokeTimeout: 60000, // 1 minute per tool call
  });

  console.error('[McpServer] Starting worker with warmup...');

  try {
    const result = await workerHost.start(
      {
        rootDir: WORKSPACE_ROOT,
        tsConfigPath: TSCONFIG_PATH,
        excludeNodeModules: EXCLUDE_NODE_MODULES,
        maxDepth: MAX_DEPTH,
      },
      (processed, total, currentFile) => {
        console.error(`[McpServer] Warmup progress: ${processed}/${total} - ${currentFile ?? ''}`);
      }
    );

    console.error(
      `[McpServer] Worker ready: ${result.filesIndexed} files indexed in ${result.durationMs}ms`
    );
    isInitialized = true;
  } catch (error) {
    console.error('[McpServer] Worker initialization failed:', error);
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

// ============================================================================
// Tool Definitions
// ============================================================================

// Tool: analyze_dependencies
server.tool(
  'analyze_dependencies',
  'Analyze a file and return all its import/export dependencies with full path resolution',
  AnalyzeDependenciesParamsSchema.shape,
  async (params: AnalyzeDependenciesParams) => {
    await initializeWorker();

    const response = await invokeToolWithResponse<AnalyzeDependenciesResult>(
      'analyze_dependencies',
      params
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
server.tool(
  'crawl_dependency_graph',
  'Build a complete dependency graph starting from an entry file. Returns all nodes (files) and edges (import relationships). Supports pagination for large graphs.',
  CrawlDependencyGraphParamsSchema.shape,
  async (params: CrawlDependencyGraphParams) => {
    await initializeWorker();

    const result = await workerHost!.invoke<CrawlDependencyGraphResult>(
      'crawl_dependency_graph',
      params
    );

    // Build pagination info if limit/offset were used
    let pagination: PaginationInfo | undefined;
    if (params.limit !== undefined || params.offset !== undefined) {
      const offset = params.offset ?? 0;
      const limit = params.limit ?? result.nodeCount;
      pagination = {
        total: result.nodeCount,
        limit,
        offset,
        hasMore: offset + result.nodes.length < result.nodeCount,
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
server.tool(
  'find_referencing_files',
  'Find all files that import/reference a given file (reverse dependency lookup). Useful for understanding the impact of changing a file.',
  FindReferencingFilesParamsSchema.shape,
  async (params: FindReferencingFilesParams) => {
    await initializeWorker();

    const response = await invokeToolWithResponse<FindReferencingFilesResult>(
      'find_referencing_files',
      params
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
server.tool(
  'expand_node',
  'Discover new dependencies from a specific node that are not in the known set. Useful for incremental graph exploration.',
  ExpandNodeParamsSchema.shape,
  async (params: ExpandNodeParams) => {
    await initializeWorker();

    const response = await invokeToolWithResponse<ExpandNodeResult>('expand_node', params);

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
server.tool(
  'parse_imports',
  'Extract raw import statements from a file without resolving paths. Returns the module specifiers as written in the source code.',
  ParseImportsParamsSchema.shape,
  async (params: ParseImportsParams) => {
    await initializeWorker();

    const response = await invokeToolWithResponse<ParseImportsResult>('parse_imports', params);

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
server.tool(
  'resolve_module_path',
  'Resolve a module specifier (like "./utils" or "@/components/Button") to an absolute file path, taking into account tsconfig path aliases.',
  ResolveModulePathParamsSchema.shape,
  async (params: ResolveModulePathParams) => {
    await initializeWorker();

    const response = await invokeToolWithResponse<ResolveModulePathResult>(
      'resolve_module_path',
      params
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
server.tool(
  'get_index_status',
  'Get the current status of the dependency index including cache statistics, reverse index status, and warmup information.',
  GetIndexStatusParamsSchema.shape,
  async () => {
    await initializeWorker();

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
  console.error('[McpServer] Graph-It-Live MCP Server starting...');
  console.error(`[McpServer] Workspace: ${WORKSPACE_ROOT}`);
  console.error(`[McpServer] TSConfig: ${TSCONFIG_PATH ?? 'auto-detect'}`);
  console.error(`[McpServer] Exclude node_modules: ${EXCLUDE_NODE_MODULES}`);
  console.error(`[McpServer] Max depth: ${MAX_DEPTH}`);

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[McpServer] MCP Server connected via stdio');

  // Start warmup immediately in background
  initializeWorker().catch((error) => {
    console.error('[McpServer] Background warmup failed:', error);
  });

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.error('[McpServer] Received SIGINT, shutting down...');
    workerHost?.dispose();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.error('[McpServer] Received SIGTERM, shutting down...');
    workerHost?.dispose();
    process.exit(0);
  });
}

// Run main with top-level error handling
main().catch((error) => {
  console.error('[McpServer] Fatal error:', error);
  process.exit(1);
});
