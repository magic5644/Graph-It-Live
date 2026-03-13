/**
 * MCP Worker Helper Functions
 * 
 * Pure utility functions extracted from McpWorker.ts for better modularity and testability.
 * All functions here are stateless and have no side effects.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SUPPORTED_SYMBOL_ANALYSIS_EXTENSIONS } from "../../shared/constants";
import { detectLanguageFromExtension } from "../../shared/utils/languageDetection";
import type { EdgeInfo, NodeInfo } from "../types";


// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Get relative path from workspace root, with cross-platform compatibility
 */
export function getRelativePath(absolutePath: string, workspaceRoot: string): string {
  // Use path.relative for cross-platform compatibility
  const relativePath = path.relative(workspaceRoot, absolutePath);

  // If the path is outside the workspace, path.relative returns a path starting with ..
  // In that case, return the original absolute path
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return absolutePath;
  }

  // Normalize to forward slashes for consistent output across platforms
  return relativePath.replaceAll("\\", "/");
}

// ============================================================================
// Graph Building Utilities
// ============================================================================

/**
 * Build edge counts for dependencies and dependents
 */
export function buildEdgeCounts(edges: { source: string; target: string }[]): {
  dependencyCount: Map<string, number>;
  dependentCount: Map<string, number>;
} {
  const dependencyCount = new Map<string, number>();
  const dependentCount = new Map<string, number>();

  for (const edge of edges) {
    dependencyCount.set(
      edge.source,
      (dependencyCount.get(edge.source) ?? 0) + 1,
    );
    dependentCount.set(edge.target, (dependentCount.get(edge.target) ?? 0) + 1);
  }

  return { dependencyCount, dependentCount };
}

/**
 * Build node info with counts and relative paths
 */
export function buildNodeInfo(
  nodePaths: string[],
  dependencyCount: Map<string, number>,
  dependentCount: Map<string, number>,
  rootDir: string,
): NodeInfo[] {
  return nodePaths.map((nodePath) => ({
    path: nodePath,
    relativePath: getRelativePath(nodePath, rootDir),
    extension: nodePath.split(".").pop() ?? "",
    dependencyCount: dependencyCount.get(nodePath) ?? 0,
    dependentCount: dependentCount.get(nodePath) ?? 0,
  }));
}

/**
 * Build edge info with relative paths
 */
export function buildEdgeInfo(
  edges: { source: string; target: string }[],
  rootDir: string,
): EdgeInfo[] {
  return edges.map((edge) => ({
    source: edge.source,
    target: edge.target,
    sourceRelative: getRelativePath(edge.source, rootDir),
    targetRelative: getRelativePath(edge.target, rootDir),
  }));
}

/**
 * Update node counts after edge filtering
 */
export function updateNodeCounts(nodes: NodeInfo[], edges: EdgeInfo[]): void {
  const { dependencyCount, dependentCount } = buildEdgeCounts(edges);

  for (const node of nodes) {
    node.dependencyCount = dependencyCount.get(node.path) || 0;
    node.dependentCount = dependentCount.get(node.path) || 0;
  }
}

/**
 * Apply pagination to nodes and edges
 */
export function applyPagination(
  nodes: NodeInfo[],
  edges: EdgeInfo[],
  limit?: number,
  offset: number = 0,
): { nodes: NodeInfo[]; edges: EdgeInfo[] } {
  const end = limit === undefined ? undefined : offset + limit;
  const paginatedNodes = nodes.slice(offset, end);

  // Filter edges to only include those with both nodes in paginated set
  const nodeSet = new Set(paginatedNodes.map((n) => n.path));
  const paginatedEdges = edges.filter(
    (e) => nodeSet.has(e.source) && nodeSet.has(e.target),
  );

  return { nodes: paginatedNodes, edges: paginatedEdges };
}

// ============================================================================
// Circular Dependency Detection
// ============================================================================

/**
 * Detect circular dependencies in the graph using DFS
 */
export function detectCircularDependencies(
  edges: { source: string; target: string }[],
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

// ============================================================================
// File Validation
// ============================================================================

/**
 * Validate that a file exists and is a regular file
 */
export async function validateFileExists(filePath: string): Promise<void> {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${filePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`File not found: ${filePath}`, { cause: error });
    }
    throw error;
  }
}

/**
 * Validate analysis input parameters
 */
export async function validateAnalysisInput(filePath: string): Promise<{ 
  ext: typeof SUPPORTED_SYMBOL_ANALYSIS_EXTENSIONS[number]; 
  language: string 
}> {
  // T064: Enhanced input validation - Absolute path check
  if (!path.isAbsolute(filePath)) {
    throw new Error(
      `FILE_NOT_FOUND: Path must be absolute. Got relative path: ${filePath}`,
    );
  }

  // T064: Validate file exists
  try {
    await validateFileExists(filePath);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(
      `FILE_NOT_FOUND: Cannot access file '${filePath}'. ${errorMessage}`,
      { cause: error }
    );
  }

  // T064: Validate supported extension
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_SYMBOL_ANALYSIS_EXTENSIONS.includes(ext as typeof SUPPORTED_SYMBOL_ANALYSIS_EXTENSIONS[number])) {
    throw new Error(
      `UNSUPPORTED_FILE_TYPE: File extension '${ext}' is not supported for symbol analysis. ` +
        `Supported extensions: ${SUPPORTED_SYMBOL_ANALYSIS_EXTENSIONS.join(", ")}. ` +
        `File: ${filePath}`,
    );
  }

  // Detect language using shared utility
  const language = detectLanguageFromExtension(ext);

  // After validation, we know ext is one of the supported extensions
  return { ext: ext as typeof SUPPORTED_SYMBOL_ANALYSIS_EXTENSIONS[number], language };
}

// ============================================================================
// LSP Conversion Utilities (re-exported from shared/converters)
// ============================================================================

export { convertSpiderToLspFormat, mapKindToLspNumber } from "../../shared/converters";

/**
 * Filter edges by actual usage verification (parallelized)
 * Note: This function requires access to Spider instance, so it stays in McpWorker.ts
 * but is exported here as a type/interface for documentation purposes
 */
export type FilterEdgesByUsageFn = (edges: EdgeInfo[]) => Promise<EdgeInfo[]>;
