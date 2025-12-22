/**
 * MCP (Model Context Protocol) Types
 *
 * Defines the message protocol between MCP server, worker host, and worker thread.
 * Also includes response types with enriched metadata for LLM consumption.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import { z } from "zod/v4";
import * as nodePath from 'node:path';
import { normalizePathForComparison as _normalizePathForComparison, getRelativePath as _getRelativePath } from '../shared/path';
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
  | { type: 'warmup-progress'; processed: number; total: number; currentFile?: string }
  | { type: 'file-invalidated'; filePath: string; event: 'change' | 'add' | 'unlink' };

// ============================================================================
// Tool Names
// ============================================================================

export type McpToolName =
  | 'set_workspace'             // NEW: Set workspace directory dynamically
  | 'analyze_dependencies'
  | 'crawl_dependency_graph'
  | 'find_referencing_files'
  | 'expand_node'
  | 'parse_imports'
  | 'resolve_module_path'
  | 'get_index_status'
  | 'invalidate_files'
  | 'rebuild_index'
  | 'get_symbol_graph'
  | 'find_unused_symbols'
  | 'get_symbol_dependents'
  | 'trace_function_execution'
  | 'get_symbol_callers'        // NEW: O(1) lookup of symbol callers
  | 'analyze_breaking_changes'  // NEW: Detect breaking changes
  | 'get_impact_analysis';      // NEW: Full impact analysis

// ============================================================================
// Zod Schemas for Tool Parameters
// ============================================================================

/**
 * Common format parameter for output formatting
 * - 'json': Standard JSON format (default)
 * - 'toon': Token-Oriented Object Notation (compact format for large datasets)
 */
export const OutputFormatSchema = z.enum(['json', 'toon']).default('json').describe(
  "Output format: 'json' (default) or 'toon' (Token-Oriented Object Notation for reduced token usage)"
);
export type OutputFormat = z.infer<typeof OutputFormatSchema>;

export const SetWorkspaceParamsSchema = z.object({
  workspacePath: z.string().describe('Absolute path to the project/workspace directory to analyze'),
  tsConfigPath: z.string().optional().describe('Optional path to tsconfig.json for path alias resolution'),
  excludeNodeModules: z.boolean().optional().describe('Whether to exclude node_modules (default: true)'),
  maxDepth: z.number().optional().describe('Maximum crawl depth (default: 50)'),
  format: OutputFormatSchema.optional(),
});
export type SetWorkspaceParams = z.infer<typeof SetWorkspaceParamsSchema>;

export const AnalyzeDependenciesParamsSchema = z.object({
  filePath: z.string().describe('Absolute path to the file to analyze'),
  format: OutputFormatSchema.optional(),
});
export type AnalyzeDependenciesParams = z.infer<typeof AnalyzeDependenciesParamsSchema>;

export const CrawlDependencyGraphParamsSchema = z.object({
  entryFile: z.string().describe('Absolute path to the entry file'),
  maxDepth: z.number().optional().describe('Maximum depth to crawl (default: from config)'),
  limit: z.number().optional().describe('Maximum number of nodes to return (for pagination)'),
  offset: z.number().optional().describe('Number of nodes to skip (for pagination)'),
  format: OutputFormatSchema.optional(),
});
export type CrawlDependencyGraphParams = z.infer<typeof CrawlDependencyGraphParamsSchema>;

export const FindReferencingFilesParamsSchema = z.object({
  targetPath: z.string().describe('Absolute path to the file to find references for'),
  format: OutputFormatSchema.optional(),
});
export type FindReferencingFilesParams = z.infer<typeof FindReferencingFilesParamsSchema>;

export const ExpandNodeParamsSchema = z.object({
  filePath: z.string().describe('Absolute path to the node to expand'),
  knownPaths: z.array(z.string()).describe('Array of already known file paths to exclude'),
  extraDepth: z.number().optional().describe('Additional depth to scan from this node (default: 10)'),
  format: OutputFormatSchema.optional(),
});
export type ExpandNodeParams = z.infer<typeof ExpandNodeParamsSchema>;

export const ParseImportsParamsSchema = z.object({
  filePath: z.string().describe('Absolute path to the file to parse'),
  format: OutputFormatSchema.optional(),
});
export type ParseImportsParams = z.infer<typeof ParseImportsParamsSchema>;

export const ResolveModulePathParamsSchema = z.object({
  fromFile: z.string().describe('Absolute path of the file containing the import'),
  moduleSpecifier: z.string().describe('The module specifier to resolve (e.g., "./utils", "@/components/Button")'),
  format: OutputFormatSchema.optional(),
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

export const GetSymbolGraphParamsSchema = z.object({
  filePath: z.string().describe('Absolute path to the file to analyze for symbols'),
  format: OutputFormatSchema.optional(),
});
export type GetSymbolGraphParams = z.infer<typeof GetSymbolGraphParamsSchema>;

export const FindUnusedSymbolsParamsSchema = z.object({
  filePath: z.string().describe('Absolute path to the file to check for unused exported symbols'),
  format: OutputFormatSchema.optional(),
});
export type FindUnusedSymbolsParams = z.infer<typeof FindUnusedSymbolsParamsSchema>;

export const GetSymbolDependentsParamsSchema = z.object({
  filePath: z.string().describe('Absolute path to the file containing the symbol'),
  symbolName: z.string().describe('Name of the symbol to find dependents for'),
  format: OutputFormatSchema.optional(),
});
export type GetSymbolDependentsParams = z.infer<typeof GetSymbolDependentsParamsSchema>;

export const TraceFunctionExecutionParamsSchema = z.object({
  filePath: z.string().describe('Absolute path to the file containing the root symbol'),
  symbolName: z.string().describe('Name of the root symbol to trace from'),
  maxDepth: z.number().optional().describe('Maximum depth to trace the call chain (default: 10)'),
  format: OutputFormatSchema.optional(),
});
export type TraceFunctionExecutionParams = z.infer<typeof TraceFunctionExecutionParamsSchema>;

// NEW: Schema for get_symbol_callers (O(1) lookup)
export const GetSymbolCallersParamsSchema = z.object({
  filePath: z.string().describe('The absolute path to the file containing the target symbol.'),
  symbolName: z.string().describe('The name of the symbol (function, class, method, variable) to find callers for.'),
  includeTypeOnly: z.boolean().optional().describe('Include type-only usages (interfaces, type aliases). Default is true.'),
  format: OutputFormatSchema.optional(),
});
export type GetSymbolCallersParams = z.infer<typeof GetSymbolCallersParamsSchema>;

// NEW: Schema for analyze_breaking_changes
export const AnalyzeBreakingChangesParamsSchema = z.object({
  filePath: z.string().describe('Absolute path to the file to analyze'),
  symbolName: z.string().optional().describe('Optional: Only analyze changes to this specific symbol'),
  oldContent: z.string().describe('The old version of the file content'),
  newContent: z.string().optional().describe('The new version of the file content (if not provided, reads current file)'),
  format: OutputFormatSchema.optional(),
});
export type AnalyzeBreakingChangesParams = z.infer<typeof AnalyzeBreakingChangesParamsSchema>;

// NEW: Schema for get_impact_analysis
export const GetImpactAnalysisParamsSchema = z.object({
  filePath: z.string().describe('Absolute path to the file being modified'),
  symbolName: z.string().describe('Name of the symbol being modified'),
  includeTransitive: z.boolean().optional().describe('Include transitive dependents (default: false)'),
  maxDepth: z.number().optional().describe('Maximum depth for transitive analysis (default: 3)'),
  format: OutputFormatSchema.optional(),
});
export type GetImpactAnalysisParams = z.infer<typeof GetImpactAnalysisParamsSchema>;

// ============================================================================
// Validation Utilities
// ============================================================================

/**
 * Map of tool names to their Zod validation schemas
 */
export const toolSchemas: Record<McpToolName, z.ZodType<unknown>> = {
  set_workspace: SetWorkspaceParamsSchema,
  analyze_dependencies: AnalyzeDependenciesParamsSchema,
  crawl_dependency_graph: CrawlDependencyGraphParamsSchema,
  find_referencing_files: FindReferencingFilesParamsSchema,
  expand_node: ExpandNodeParamsSchema,
  parse_imports: ParseImportsParamsSchema,
  resolve_module_path: ResolveModulePathParamsSchema,
  get_index_status: GetIndexStatusParamsSchema,
  invalidate_files: InvalidateFilesParamsSchema,
  rebuild_index: RebuildIndexParamsSchema,
  get_symbol_graph: GetSymbolGraphParamsSchema,
  find_unused_symbols: FindUnusedSymbolsParamsSchema,
  get_symbol_dependents: GetSymbolDependentsParamsSchema,
  trace_function_execution: TraceFunctionExecutionParamsSchema,
  get_symbol_callers: GetSymbolCallersParamsSchema,
  analyze_breaking_changes: AnalyzeBreakingChangesParamsSchema,
  get_impact_analysis: GetImpactAnalysisParamsSchema,
};

/**
 * Result of parameter validation
 */
export type ValidationResult<T> = 
  | { success: true; data: T }
  | { success: false; error: string; issues: z.core.$ZodIssue[] };

/**
 * Validate tool parameters against their Zod schema
 * 
 * @param tool - The tool name
 * @param params - The raw parameters to validate
 * @returns Validation result with parsed data or error details
 */
export function validateToolParams<T>(
  tool: McpToolName,
  params: unknown
): ValidationResult<T> {
  const schema = toolSchemas[tool];
  
  if (!schema) {
    return {
      success: false,
      error: `No schema defined for tool: ${tool}`,
      issues: [],
    };
  }

  const result = schema.safeParse(params);
  
  if (result.success) {
    return {
      success: true,
      data: result.data as T,
    };
  }

  // Format Zod errors for better readability
  const issues = result.error.issues;
  const errorMessages = issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    return `${path}${issue.message}`;
  });

  return {
    success: false,
    error: `Invalid parameters: ${errorMessages.join('; ')}`,
    issues,
  };
}

/**
 * Normalize a path for cross-platform comparison.
 * - Converts backslashes to forward slashes
 * - Lowercases drive letters on Windows for consistent comparison
 * - Removes trailing slashes
 * 
 * @param filePath - The path to normalize
 * @returns Normalized path
 */
export const normalizePathForComparison = _normalizePathForComparison;

/**
 * Check if a path is within a root directory (cross-platform safe).
 * Uses path.resolve to handle .. and relative paths correctly.
 * 
 * @param filePath - The file path to check
 * @param rootDir - The root directory
 * @returns true if filePath is within rootDir
 */
export function isPathWithinRoot(filePath: string, rootDir: string): boolean {
  // Resolve both paths to absolute paths
  const resolvedPath = normalizePathForComparison(nodePath.resolve(rootDir, filePath));
  const resolvedRoot = normalizePathForComparison(nodePath.resolve(rootDir));
  
  // Check if the resolved path starts with the resolved root
  // Add trailing slash to avoid matching /project-other when rootDir is /project
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + '/');
}

/**
 * Validate a file path for security (path traversal prevention)
 * Cross-platform safe: works on Windows (C:\...), Mac, and Linux
 * 
 * @param filePath - The file path to validate
 * @param rootDir - The workspace root directory
 * @returns true if valid, throws error if invalid
 */
export function validateFilePath(filePath: string, rootDir: string): boolean {
  const normalizedPath = normalizePathForComparison(filePath);
  
  // Check for obvious path traversal patterns
  if (normalizedPath.includes('..')) {
    // Resolve and verify the path is still within root
    if (!isPathWithinRoot(filePath, rootDir)) {
      throw new Error(`Path traversal detected: ${filePath} resolves outside workspace`);
    }
  }
  
  // Check for absolute paths
  const isAbsoluteUnix = normalizedPath.startsWith('/');
  const isAbsoluteWindows = /^[a-z]:/i.test(normalizedPath);
  
  if (isAbsoluteUnix || isAbsoluteWindows) {
    if (!isPathWithinRoot(filePath, rootDir)) {
      throw new Error(`File path is outside workspace: ${filePath}`);
    }
  } else {
    // Relative path - resolve and check
    const resolvedPath = nodePath.resolve(rootDir, filePath);
    if (!isPathWithinRoot(resolvedPath, rootDir)) {
      throw new Error(`File path is outside workspace: ${filePath}`);
    }
  }
  
  return true;
}

/**
 * Validate and sanitize string input
 * 
 * @param input - The string to sanitize
 * @param maxLength - Maximum allowed length (default: 10000)
 * @returns Sanitized string
 */
export function sanitizeString(input: string, maxLength = 10000): string {
  if (typeof input !== 'string') {
    throw new TypeError('Expected string input');
  }
  
  if (input.length > maxLength) {
    throw new Error(`Input exceeds maximum length of ${maxLength} characters`);
  }
  
  // Remove null bytes which can cause issues
  return input.replaceAll('\0', '');
}

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
  /** Allow additional properties for MCP SDK compatibility */
  [key: string]: unknown;
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
 * Result of set_workspace tool
 */
export interface SetWorkspaceResult {
  /** Whether the workspace was successfully set */
  success: boolean;
  /** The new workspace path */
  workspacePath: string;
  /** Number of files indexed during warmup */
  filesIndexed: number;
  /** Time taken to index in milliseconds */
  indexingTimeMs: number;
  /** Previous workspace path (if any) */
  previousWorkspace?: string;
  /** Message describing the result */
  message: string;
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

/**
 * Symbol information for get_symbol_graph result
 */
export interface SymbolInfo {
  /** Symbol name */
  name: string;
  /** Symbol ID (unique identifier: filePath:symbolName) */
  id: string;
  /** Symbol kind (e.g., 'FunctionDeclaration', 'ClassDeclaration') */
  kind: string;
  /** Line number where symbol is defined */
  line: number;
  /** Whether the symbol is exported */
  isExported: boolean;
  /** Symbol type category for filtering */
  category?: 'function' | 'class' | 'variable' | 'interface' | 'type' | 'other';
  /** Parent symbol ID (for methods/properties belonging to a class) */
  parentSymbolId?: string;
}

/**
 * Symbol dependency edge for get_symbol_graph result
 */
export interface SymbolDependencyEdge {
  /** Source symbol ID */
  sourceSymbolId: string;
  /** Target symbol ID */
  targetSymbolId: string;
  /** Target file path */
  targetFilePath: string;
  /** Relative path of target file from workspace root */
  targetRelativePath: string;
}

/**
 * Result of get_symbol_graph tool
 */
export interface GetSymbolGraphResult {
  /** The analyzed file path */
  filePath: string;
  /** Relative path from workspace root */
  relativePath: string;
  /** Number of exported symbols found */
  symbolCount: number;
  /** Number of symbol dependencies found */
  dependencyCount: number;
  /** List of exported symbols */
  symbols: SymbolInfo[];
  /** List of symbol dependencies */
  dependencies: SymbolDependencyEdge[];
  /** Whether to show this in symbol view mode (vs file view) */
  isSymbolView: boolean;
}

/**
 * Result of find_unused_symbols tool
 */
export interface FindUnusedSymbolsResult {
  /** The analyzed file path */
  filePath: string;
  /** Relative path from workspace root */
  relativePath: string;
  /** Number of unused exported symbols found */
  unusedCount: number;
  /** List of unused exported symbols (potentially dead code) */
  unusedSymbols: SymbolInfo[];
  /** Total number of exported symbols in the file */
  totalExportedSymbols: number;
  /** Percentage of exports that are unused */
  unusedPercentage: number;
}

export interface GetSymbolDependentsResult {
  /** The file path containing the symbol */
  filePath: string;
  /** The name of the symbol */
  symbolName: string;
  /** Number of dependents found */
  dependentCount: number;
  /** List of dependents (usages) */
  dependents: SymbolDependencyEdge[];
}

/**
 * Call chain entry for trace_function_execution result
 */
export interface CallChainEntry {
  /** Depth in the call chain (1 = direct call from root) */
  depth: number;
  /** The symbol making the call */
  callerSymbolId: string;
  /** The symbol being called */
  calledSymbolId: string;
  /** The module path as written in the import */
  calledFilePath: string;
  /** The resolved absolute file path (null if unresolved) */
  resolvedFilePath: string | null;
  /** Relative path from workspace root (null if unresolved) */
  resolvedRelativePath: string | null;
}

/**
 * Result of trace_function_execution tool
 */
export interface TraceFunctionExecutionResult {
  /** The root symbol being traced */
  rootSymbol: {
    id: string;
    filePath: string;
    relativePath: string;
    symbolName: string;
  };
  /** Maximum depth used for tracing */
  maxDepth: number;
  /** Number of calls in the chain */
  callCount: number;
  /** Number of unique symbols visited */
  uniqueSymbolCount: number;
  /** Whether the trace hit the max depth limit */
  maxDepthReached: boolean;
  /** The full call chain in traversal order */
  callChain: CallChainEntry[];
  /** List of all unique symbol IDs visited */
  visitedSymbols: string[];
}

// ============================================================================
// NEW: Symbol Callers Result (O(1) lookup)
// ============================================================================

/**
 * Caller entry from the symbol reverse index
 */
export interface SymbolCallerInfo {
  /** The symbol that calls the target */
  callerSymbolId: string;
  /** The file containing the caller */
  callerFilePath: string;
  /** Relative path from workspace root */
  callerRelativePath: string;
  /** Whether this is a type-only import */
  isTypeOnly: boolean;
}

/**
 * Result of get_symbol_callers tool
 */
export interface GetSymbolCallersResult {
  /** The symbol ID being queried */
  symbolId: string;
  /** Total number of callers */
  callerCount: number;
  /** Number of runtime callers (non-type imports) */
  runtimeCallerCount: number;
  /** Number of type-only callers */
  typeOnlyCallerCount: number;
  /** List of all callers */
  callers: SymbolCallerInfo[];
  /** Unique files that contain callers */
  callerFiles: string[];
}

// ============================================================================
// NEW: Breaking Changes Analysis Result
// ============================================================================

/**
 * Types of breaking changes that can be detected
 */
export type BreakingChangeType =
  | 'parameter-added-required'     // New required parameter added
  | 'parameter-removed'            // Parameter removed
  | 'parameter-type-changed'       // Parameter type changed
  | 'parameter-optional-to-required' // Optional param became required
  | 'return-type-changed'          // Return type changed
  | 'visibility-reduced'           // public → private/protected
  | 'member-removed'               // Interface/class member removed
  | 'member-type-changed'          // Interface/class member type changed
  | 'member-optional-to-required'  // Optional member became required
  | 'type-alias-changed';          // Type alias definition changed

/**
 * A single breaking change detected
 */
export interface BreakingChangeInfo {
  /** Type of breaking change */
  type: BreakingChangeType;
  /** Name of the affected symbol */
  symbolName: string;
  /** Human-readable description */
  description: string;
  /** Severity (error = definite break, warning = potential break) */
  severity: 'error' | 'warning';
  /** The old value/signature */
  oldValue?: string;
  /** The new value/signature */
  newValue?: string;
  /** Line number in the new file */
  line?: number;
}

/**
 * Result of analyze_breaking_changes tool
 */
export interface AnalyzeBreakingChangesResult {
  /** The file being analyzed */
  filePath: string;
  /** Total number of breaking changes detected */
  breakingChangeCount: number;
  /** Number of error-level changes */
  errorCount: number;
  /** Number of warning-level changes */
  warningCount: number;
  /** List of all breaking changes */
  breakingChanges: BreakingChangeInfo[];
  /** List of non-breaking changes (for info) */
  nonBreakingChanges: string[];
  /** Symbols that were removed entirely */
  removedSymbols: string[];
  /** Symbols that were added */
  addedSymbols: string[];
}

// ============================================================================
// NEW: Impact Analysis Result
// ============================================================================

/**
 * Impact level categorization
 */
export type ImpactLevel = 'high' | 'medium' | 'low';

/**
 * Information about an impacted file/symbol
 */
export interface ImpactedItem {
  /** The symbol ID that would be affected */
  symbolId: string;
  /** The file path */
  filePath: string;
  /** Relative path from workspace root */
  relativePath: string;
  /** How the item uses the target symbol */
  usageType: 'runtime' | 'type-only';
  /** Depth in dependency chain (1 = direct, 2+ = transitive) */
  depth: number;
}

/**
 * Result of get_impact_analysis tool
 */
export interface GetImpactAnalysisResult {
  /** The target symbol being analyzed */
  targetSymbol: {
    id: string;
    filePath: string;
    relativePath: string;
    symbolName: string;
  };
  /** Overall impact level */
  impactLevel: ImpactLevel;
  /** Total number of impacted items */
  totalImpactCount: number;
  /** Number of directly impacted items (depth=1) */
  directImpactCount: number;
  /** Number of transitively impacted items (depth>1) */
  transitiveImpactCount: number;
  /** Number of runtime impacts */
  runtimeImpactCount: number;
  /** Number of type-only impacts */
  typeOnlyImpactCount: number;
  /** List of all impacted items */
  impactedItems: ImpactedItem[];
  /** Unique files affected */
  affectedFiles: string[];
  /** Summary for LLM consumption */
  summary: string;
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
 * Cross-platform safe.
 */
export function enrichDependency(dep: Dependency, workspaceRoot: string): DependencyInfo {
  const relativePath = getRelativePath(dep.path, workspaceRoot);
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
 * Cross-platform safe: uses Node.js path.relative which handles
 * Windows drive letters and path separators correctly.
 * 
 * @param absolutePath - The absolute path to convert
 * @param workspaceRoot - The workspace root directory
 * @returns Relative path with forward slashes (for consistent output)
 */
export const getRelativePath = _getRelativePath;
