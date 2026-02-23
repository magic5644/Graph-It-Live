/**
 * MCP Worker Helper Functions
 * 
 * Pure utility functions extracted from McpWorker.ts for better modularity and testability.
 * All functions here are stateless and have no side effects.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SUPPORTED_SYMBOL_ANALYSIS_EXTENSIONS } from "../../shared/constants";
import { normalizePath } from "../../shared/path";
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
// LSP Conversion Utilities
// ============================================================================

/**
 * Map string kind to LSP SymbolKind number (vscode.SymbolKind enum)
 */
export function mapKindToLspNumber(kind: string): number {
  switch (kind.toLowerCase()) {
    case "function":
    case "method":
      return 12; // Function
    case "class":
      return 5; // Class
    case "variable":
    case "property":
      return 13; // Variable
    case "interface":
      return 11; // Interface
    default:
      return 13; // Variable (default)
  }
}

/**
 * Convert Spider's symbol graph data to LSP format
 */
export function convertSpiderToLspFormat(
  symbolGraphData: { 
    symbols: Array<{ name: string; kind: string; line: number; parentSymbolId?: string }>; 
    dependencies: Array<{ sourceSymbolId: string; targetSymbolId: string }> 
  },
  filePath: string,
): {
  symbols: Array<{ name: string; kind: number; range: { start: number; end: number }; containerName?: string; uri: string }>;
  callHierarchyItems: Map<string, { name: string; kind: number; uri: string; range: { start: number; end: number } }>;
  outgoingCalls: Map<string, Array<{ to: { name: string; kind: number; uri: string; range: { start: number; end: number } }; fromRanges: Array<{ start: number; end: number }> }>>;
} {
  const normalizedFilePath = normalizePath(filePath);

  const extractSymbolName = (symbolId: string): string => {
    const separatorIndex = symbolId.lastIndexOf(":");
    if (separatorIndex < 0 || separatorIndex === symbolId.length - 1) {
      return symbolId;
    }
    return symbolId.slice(separatorIndex + 1);
  };

  // Convert Spider symbols to LSP format
  const lspSymbols = symbolGraphData.symbols.map((sym) => ({
    name: sym.name,
    kind: mapKindToLspNumber(sym.kind),
    range: { start: sym.line, end: sym.line },
    containerName: sym.parentSymbolId ? sym.name : undefined, // For hierarchy
    uri: normalizedFilePath,
  }));

  // Convert Spider dependencies to LSP call hierarchy format
  const callHierarchyItems = new Map<string, { name: string; kind: number; uri: string; range: { start: number; end: number } }>();
  const outgoingCalls = new Map<string, Array<{ to: { name: string; kind: number; uri: string; range: { start: number; end: number } }; fromRanges: Array<{ start: number; end: number }> }>>();

  for (const symbol of lspSymbols) {
    callHierarchyItems.set(symbol.name, {
      name: symbol.name,
      kind: symbol.kind,
      uri: normalizedFilePath,
      range: symbol.range,
    });
  }

  for (const dep of symbolGraphData.dependencies) {
    const sourceSymbolName = extractSymbolName(dep.sourceSymbolId);
    const sourceSymbolId = `${normalizedFilePath}:${sourceSymbolName}`;
    if (!outgoingCalls.has(sourceSymbolId)) {
      outgoingCalls.set(sourceSymbolId, []);
    }
    
    // Extract symbol name from targetSymbolId (format: "filePath:symbolName")
    // This prevents LspCallHierarchyAnalyzer from double-concatenating the ID
    const symbolName = extractSymbolName(dep.targetSymbolId);
    
    outgoingCalls.get(sourceSymbolId)!.push({
      to: {
        name: symbolName,
        kind: 12,
        uri: normalizedFilePath,
        range: { start: 0, end: 0 },
      },
      fromRanges: [{ start: 0, end: 0 }],
    });
  }

  return {
    symbols: lspSymbols,
    callHierarchyItems,
    outgoingCalls,
  };
}

/**
 * Filter edges by actual usage verification (parallelized)
 * Note: This function requires access to Spider instance, so it stays in McpWorker.ts
 * but is exported here as a type/interface for documentation purposes
 */
export type FilterEdgesByUsageFn = (edges: EdgeInfo[]) => Promise<EdgeInfo[]>;
