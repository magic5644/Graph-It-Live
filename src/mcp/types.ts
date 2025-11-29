/**
 * MCP (Model Context Protocol) Types
 *
 * Defines the message protocol between MCP server, worker host, and worker thread.
 * Also includes response types with enriched metadata for LLM consumption.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import * as z from 'zod/v4';
import type { Dependency } from '../analyzer/types';

// ============================================================================
// Tool Version (for metadata)
// ============================================================================

export const MCP_TOOL_VERSION = '1.0.0';

// ============================================================================
// Worker Message Protocol
// ============================================================================

/**
 * Message sent from McpWorkerHost to McpWorker
 */
export type McpWorkerMessage =
  | { type: 'init'; config: McpWorkerConfig }
  | { type: 'invoke'; requestId: string; tool: McpToolName; params: unknown }
  | { type: 'shutdown' };

/**
 * Configuration for the MCP Worker
 */
export interface McpWorkerConfig {
  rootDir: string;
  tsConfigPath?: string;
  excludeNodeModules: boolean;
  maxDepth: number;
}

/**
 * Response sent from McpWorker to McpWorkerHost
 */
export type McpWorkerResponse =
  | { type: 'ready'; warmupDuration: number; indexedFiles: number }
  | { type: 'result'; requestId: string; data: unknown; executionTimeMs: number }
  | { type: 'error'; requestId: string; error: string; code?: string }
  | { type: 'warmup-progress'; processed: number; total: number; currentFile?: string };

// ============================================================================
// Tool Names
// ============================================================================

export type McpToolName =
  | 'analyze_dependencies'
  | 'crawl_dependency_graph'
  | 'find_referencing_files'
  | 'expand_node'
  | 'parse_imports'
  | 'resolve_module_path'
  | 'get_index_status'
  | 'invalidate_files'
  | 'rebuild_index';

// ============================================================================
// Zod Schemas for Tool Parameters
// ============================================================================

export const AnalyzeDependenciesParamsSchema = z.object({
  filePath: z.string().describe('Absolute path to the file to analyze'),
});
export type AnalyzeDependenciesParams = z.infer<typeof AnalyzeDependenciesParamsSchema>;

export const CrawlDependencyGraphParamsSchema = z.object({
  entryFile: z.string().describe('Absolute path to the entry file'),
  maxDepth: z.number().optional().describe('Maximum depth to crawl (default: from config)'),
  limit: z.number().optional().describe('Maximum number of nodes to return (for pagination)'),
  offset: z.number().optional().describe('Number of nodes to skip (for pagination)'),
});
export type CrawlDependencyGraphParams = z.infer<typeof CrawlDependencyGraphParamsSchema>;

export const FindReferencingFilesParamsSchema = z.object({
  targetPath: z.string().describe('Absolute path to the file to find references for'),
});
export type FindReferencingFilesParams = z.infer<typeof FindReferencingFilesParamsSchema>;

export const ExpandNodeParamsSchema = z.object({
  filePath: z.string().describe('Absolute path to the node to expand'),
  knownPaths: z.array(z.string()).describe('Array of already known file paths to exclude'),
  extraDepth: z.number().optional().describe('Additional depth to scan from this node (default: 10)'),
});
export type ExpandNodeParams = z.infer<typeof ExpandNodeParamsSchema>;

export const ParseImportsParamsSchema = z.object({
  filePath: z.string().describe('Absolute path to the file to parse'),
});
export type ParseImportsParams = z.infer<typeof ParseImportsParamsSchema>;

export const ResolveModulePathParamsSchema = z.object({
  fromFile: z.string().describe('Absolute path of the file containing the import'),
  moduleSpecifier: z.string().describe('The module specifier to resolve (e.g., "./utils", "@/components/Button")'),
});
export type ResolveModulePathParams = z.infer<typeof ResolveModulePathParamsSchema>;

export const GetIndexStatusParamsSchema = z.object({});
export type GetIndexStatusParams = z.infer<typeof GetIndexStatusParamsSchema>;

export const InvalidateFilesParamsSchema = z.object({
  filePaths: z
    .array(z.string())
    .describe(
      'Array of absolute file paths to invalidate from the cache. Use this after modifying files to ensure fresh analysis.',
    ),
});
export type InvalidateFilesParams = z.infer<typeof InvalidateFilesParamsSchema>;

export const RebuildIndexParamsSchema = z.object({});
export type RebuildIndexParams = z.infer<typeof RebuildIndexParamsSchema>;

// ============================================================================
// Tool Response Types with Enriched Metadata
// ============================================================================

/**
 * Metadata included in every tool response for LLM context
 */
export interface McpResponseMetadata {
  /** Time taken to execute the tool in milliseconds */
  executionTimeMs: number;
  /** Version of the MCP tools */
  toolVersion: string;
  /** ISO timestamp of when the response was generated */
  timestamp: string;
  /** Workspace root directory */
  workspaceRoot: string;
}

/**
 * Pagination info for large result sets
 */
export interface PaginationInfo {
  /** Total number of items available */
  total: number;
  /** Maximum items per page */
  limit: number;
  /** Number of items skipped */
  offset: number;
  /** Whether there are more items available */
  hasMore: boolean;
}

/**
 * Generic wrapper for all MCP tool responses
 */
export interface McpToolResponse<T> {
  /** Whether the operation succeeded */
  success: boolean;
  /** The actual data returned by the tool */
  data: T;
  /** Metadata about the execution */
  metadata: McpResponseMetadata;
  /** Pagination info (only present for paginated responses) */
  pagination?: PaginationInfo;
  /** Error message (only present when success is false) */
  error?: string;
}

// ============================================================================
// Tool-Specific Response Data Types
// ============================================================================

/**
 * Type of import statement
 */
export type ImportType = 'import' | 'require' | 'export' | 'dynamic';

/**
 * Result of analyze_dependencies tool
 */
export interface AnalyzeDependenciesResult {
  /** The analyzed file path */
  filePath: string;
  /** Number of dependencies found */
  dependencyCount: number;
  /** List of dependencies with full details */
  dependencies: DependencyInfo[];
}

/**
 * Dependency information enriched for LLM consumption
 */
export interface DependencyInfo {
  /** Absolute path to the dependency */
  path: string;
  /** Relative path from workspace root (easier for humans/LLMs to read) */
  relativePath: string;
  /** Type of import statement */
  type: ImportType;
  /** Line number where the import appears */
  line: number;
  /** Original module specifier as written in code */
  module: string;
  /** File extension of the dependency */
  extension: string;
}

/**
 * Result of crawl_dependency_graph tool
 */
export interface CrawlDependencyGraphResult {
  /** Entry file used for crawling */
  entryFile: string;
  /** Maximum depth used for crawling */
  maxDepth: number;
  /** Total number of unique files in the graph */
  nodeCount: number;
  /** Total number of edges (import relationships) */
  edgeCount: number;
  /** List of all file paths in the graph */
  nodes: NodeInfo[];
  /** List of all edges (import relationships) */
  edges: EdgeInfo[];
  /** Circular dependencies detected (if any) */
  circularDependencies: string[][];
}

/**
 * Node information in the dependency graph
 */
export interface NodeInfo {
  /** Absolute path */
  path: string;
  /** Relative path from workspace root */
  relativePath: string;
  /** File extension */
  extension: string;
  /** Number of outgoing edges (dependencies) */
  dependencyCount: number;
  /** Number of incoming edges (dependents) */
  dependentCount: number;
}

/**
 * Edge information in the dependency graph
 */
export interface EdgeInfo {
  /** Source file (the one with the import statement) */
  source: string;
  /** Target file (the one being imported) */
  target: string;
  /** Relative paths for readability */
  sourceRelative: string;
  targetRelative: string;
}

/**
 * Result of find_referencing_files tool
 */
export interface FindReferencingFilesResult {
  /** The target file being referenced */
  targetPath: string;
  /** Number of files that reference the target */
  referencingFileCount: number;
  /** List of files that import/require the target */
  referencingFiles: ReferencingFileInfo[];
}

/**
 * Information about a file that references the target
 */
export interface ReferencingFileInfo {
  /** Absolute path of the referencing file */
  path: string;
  /** Relative path from workspace root */
  relativePath: string;
  /** Type of import used */
  type: ImportType;
  /** Line number of the import statement */
  line: number;
  /** Original module specifier */
  module: string;
}

/**
 * Result of expand_node tool
 */
export interface ExpandNodeResult {
  /** The node that was expanded */
  expandedNode: string;
  /** Number of new nodes discovered */
  newNodeCount: number;
  /** Number of new edges discovered */
  newEdgeCount: number;
  /** Newly discovered nodes */
  newNodes: string[];
  /** Newly discovered edges */
  newEdges: EdgeInfo[];
}

/**
 * Result of parse_imports tool
 */
export interface ParseImportsResult {
  /** The parsed file path */
  filePath: string;
  /** Number of imports found */
  importCount: number;
  /** Raw imports without path resolution */
  imports: ParsedImportInfo[];
}

/**
 * Parsed import information (before resolution)
 */
export interface ParsedImportInfo {
  /** Module specifier as written in code */
  module: string;
  /** Type of import */
  type: ImportType;
  /** Line number */
  line: number;
}

/**
 * Result of resolve_module_path tool
 */
export interface ResolveModulePathResult {
  /** The source file */
  fromFile: string;
  /** The original module specifier */
  moduleSpecifier: string;
  /** Whether resolution was successful */
  resolved: boolean;
  /** Resolved absolute path (null if not resolved) */
  resolvedPath: string | null;
  /** Resolved relative path from workspace root */
  resolvedRelativePath: string | null;
  /** Reason for resolution failure (if not resolved) */
  failureReason?: string;
}

/**
 * Result of get_index_status tool
 */
export interface GetIndexStatusResult {
  /** Current indexing state */
  state: 'idle' | 'counting' | 'indexing' | 'complete' | 'error';
  /** Whether the index is ready for queries */
  isReady: boolean;
  /** Whether reverse index is enabled */
  reverseIndexEnabled: boolean;
  /** Number of files in the cache */
  cacheSize: number;
  /** Reverse index statistics (if available) */
  reverseIndexStats?: {
    /** Number of indexed source files */
    indexedFiles: number;
    /** Number of unique target files referenced */
    targetFiles: number;
    /** Total number of reference entries */
    totalReferences: number;
  };
  /** Indexing progress (if currently indexing) */
  progress?: {
    processed: number;
    total: number;
    percentage: number;
    currentFile?: string;
  };
  /** Warmup information */
  warmup: {
    /** Whether warmup has completed */
    completed: boolean;
    /** Time taken for warmup in ms (if completed) */
    durationMs?: number;
    /** Number of files indexed during warmup */
    filesIndexed?: number;
  };
}

/**
 * Result of invalidate_files tool
 */
export interface InvalidateFilesResult {
  /** Number of files invalidated from cache */
  invalidatedCount: number;
  /** List of file paths that were invalidated */
  invalidatedFiles: string[];
  /** List of file paths that were not in cache */
  notFoundFiles: string[];
  /** Whether the reverse index was also updated */
  reverseIndexUpdated: boolean;
}

/**
 * Result of rebuild_index tool
 */
export interface RebuildIndexResult {
  /** Number of files re-indexed */
  reindexedCount: number;
  /** Time taken to rebuild in milliseconds */
  rebuildTimeMs: number;
  /** New cache size after rebuild */
  newCacheSize: number;
  /** New reverse index statistics */
  reverseIndexStats: {
    indexedFiles: number;
    targetFiles: number;
    totalReferences: number;
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a successful MCP tool response with metadata
 */
export function createSuccessResponse<T>(
  data: T,
  executionTimeMs: number,
  workspaceRoot: string,
  pagination?: PaginationInfo
): McpToolResponse<T> {
  return {
    success: true,
    data,
    metadata: {
      executionTimeMs,
      toolVersion: MCP_TOOL_VERSION,
      timestamp: new Date().toISOString(),
      workspaceRoot,
    },
    ...(pagination && { pagination }),
  };
}

/**
 * Create an error MCP tool response
 */
export function createErrorResponse<T>(
  error: string,
  executionTimeMs: number,
  workspaceRoot: string
): McpToolResponse<T> {
  return {
    success: false,
    data: null as T,
    error,
    metadata: {
      executionTimeMs,
      toolVersion: MCP_TOOL_VERSION,
      timestamp: new Date().toISOString(),
      workspaceRoot,
    },
  };
}

/**
 * Convert a Dependency to DependencyInfo with enriched data
 */
export function enrichDependency(dep: Dependency, workspaceRoot: string): DependencyInfo {
  const relativePath = dep.path.startsWith(workspaceRoot)
    ? dep.path.slice(workspaceRoot.length + 1)
    : dep.path;
  
  const extension = dep.path.split('.').pop() ?? '';

  return {
    path: dep.path,
    relativePath,
    type: dep.type,
    line: dep.line,
    module: dep.module,
    extension,
  };
}

/**
 * Get relative path from workspace root
 */
export function getRelativePath(absolutePath: string, workspaceRoot: string): string {
  return absolutePath.startsWith(workspaceRoot)
    ? absolutePath.slice(workspaceRoot.length + 1)
    : absolutePath;
}
