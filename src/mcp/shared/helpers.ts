/**
 * MCP Worker Helper Functions
 * 
 * Pure utility functions extracted from McpWorker.ts for better modularity and testability.
 * All functions here are stateless and have no side effects.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SUPPORTED_SYMBOL_ANALYSIS_EXTENSIONS } from "../../shared/constants";
import {
  toWorkspaceRelativePath,
  validateWorkspacePath,
} from "../../shared/pathSecurity";
import { detectLanguageFromExtension } from "../../shared/utils/languageDetection";
import type { EdgeInfo, NodeInfo } from "../types";
import type { GraphNodeMetadata } from "../../shared/graph-types";


// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Get relative path from workspace root, with cross-platform compatibility
 */
export function getRelativePath(absolutePath: string, workspaceRoot: string): string {
  return toWorkspaceRelativePath(absolutePath, workspaceRoot);
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
  metadata?: Record<string, GraphNodeMetadata>,
): NodeInfo[] {
  return nodePaths.map((nodePath) => {
    const meta = metadata?.[nodePath];
    const node: NodeInfo = {
      path: nodePath,
      relativePath: getRelativePath(nodePath, rootDir),
      extension: nodePath.split(".").pop() ?? "",
      dependencyCount: dependencyCount.get(nodePath) ?? 0,
      dependentCount: dependentCount.get(nodePath) ?? 0,
    };
    if (meta?.hubScore !== undefined) node.hubScore = meta.hubScore;
    if (meta?.communityId !== undefined) node.communityId = meta.communityId;
    return node;
  });
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

interface DfsFrame {
  node: string;
  neighbors: string[];
  index: number;
}

function collectCyclesFrom(
  startNode: string,
  graph: Map<string, Set<string>>,
  visited: Set<string>,
  cycles: string[][],
): void {
  const active = new Set<string>([startNode]);
  const path = [startNode];
  const stack: DfsFrame[] = [{
    node: startNode,
    neighbors: [...(graph.get(startNode) ?? [])],
    index: 0,
  }];
  visited.add(startNode);

  while (stack.length > 0) {
    const frame = stack.at(-1);
    if (!frame) return;
    if (frame.index >= frame.neighbors.length) {
      active.delete(frame.node);
      path.pop();
      stack.pop();
      continue;
    }

    const neighbor = frame.neighbors[frame.index++];
    if (!visited.has(neighbor)) {
      visited.add(neighbor);
      active.add(neighbor);
      path.push(neighbor);
      stack.push({
        node: neighbor,
        neighbors: [...(graph.get(neighbor) ?? [])],
        index: 0,
      });
    } else if (active.has(neighbor)) {
      const cycleStart = path.indexOf(neighbor);
      cycles.push([...path.slice(cycleStart), neighbor]);
    }
  }
}

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
    graph.get(edge.source)?.add(edge.target);
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();

  // Run DFS from each unvisited node
  for (const startNode of graph.keys()) {
    if (!visited.has(startNode)) collectCyclesFrom(startNode, graph, visited, cycles);
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

/**
 * Validate that a scope path is a directory inside the workspace root.
 * Prevents path traversal attacks.
 *
 * @param scopePath - The scope path to validate (must be absolute)
 * @param rootDir   - The workspace root directory
 * @throws if scopePath is not absolute, contains null bytes, or is outside rootDir
 */
export function validateScopePath(scopePath: string, rootDir: string): void {
  // Reject null bytes (common injection vector)
  if (scopePath.includes("\0")) {
    throw new Error(`INVALID_SCOPE_PATH: Path contains null bytes: ${scopePath}`);
  }

  if (!path.isAbsolute(scopePath)) {
    throw new Error(`INVALID_SCOPE_PATH: Scope path must be absolute. Got: ${scopePath}`);
  }

  try {
    validateWorkspacePath(scopePath, rootDir);
  } catch (error) {
    throw new Error(
      `INVALID_SCOPE_PATH: Scope path '${scopePath}' is outside workspace root '${rootDir}'`,
      { cause: error },
    );
  }
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
