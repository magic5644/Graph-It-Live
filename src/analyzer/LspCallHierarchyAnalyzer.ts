/**
 * LSP-Based Call Hierarchy Analyzer
 *
 * Analyzes intra-file symbol-level call hierarchies using LSP (Language Server Protocol) results.
 * This module is in the analyzer layer and has NO vscode imports - it processes LSP results
 * passed from the extension layer.
 *
 * Key Responsibilities:
 * - Build IntraFileGraph from LSP symbol and call hierarchy data
 * - Filter external calls (symbols from different files)
 * - Detect cycles using DFS traversal
 * - Normalize paths for cross-platform compatibility
 * - Generate contextual names for anonymous functions
 *
 * Architecture: Pure Node.js, no VS Code dependencies
 */

import { normalizePath } from "@/shared/path";
import type { CallEdge, IntraFileGraph, SymbolNode } from "@/shared/types";

/**
 * LSP Symbol Information (subset of vscode.SymbolInformation)
 * Passed from extension layer to avoid vscode dependencies
 */
export interface LspSymbol {
  name: string;
  kind: number; // vscode.SymbolKind enum value
  range: { start: number; end: number };
  containerName?: string;
  uri: string;
}

/**
 * LSP Call Hierarchy Item (subset of vscode.CallHierarchyItem)
 */
export interface LspCallHierarchyItem {
  name: string;
  kind: number;
  uri: string;
  range: { start: number; end: number };
  detail?: string;
}

/**
 * LSP Call Hierarchy Outgoing Call (subset of vscode.CallHierarchyOutgoingCall)
 */
export interface LspOutgoingCall {
  to: LspCallHierarchyItem;
  fromRanges: Array<{ start: number; end: number }>;
}

/**
 * Result of LSP analysis
 */
export interface LspAnalysisResult {
  symbols: LspSymbol[];
  callHierarchyItems: Map<string, LspCallHierarchyItem>;
  outgoingCalls: Map<string, LspOutgoingCall[]>;
}

/**
 * Analyzes LSP data to build an intra-file call hierarchy graph
 */
export class LspCallHierarchyAnalyzer {
  /**
   * Builds an IntraFileGraph from LSP analysis results
   *
   * @param filePath - Absolute path to the file being analyzed
   * @param lspData - LSP analysis results (symbols, call hierarchy)
   * @returns IntraFileGraph with nodes, edges, cycle detection
   */
  public buildIntraFileGraph(
    filePath: string,
    lspData: LspAnalysisResult,
  ): IntraFileGraph {
    const normalizedFilePath = normalizePath(filePath);

    // Step 1: Convert LSP symbols to SymbolNodes
    const nodes = this.convertLspSymbolsToNodes(
      normalizedFilePath,
      lspData.symbols,
    );

    // Step 2: Build edges from call hierarchy (filter external calls)
    const edges = this.buildCallEdges(
      normalizedFilePath,
      lspData.outgoingCalls,
      nodes,
    );

    // Step 3: Detect cycles using DFS
    const { hasCycle, cycleNodes } = this.detectCycles(nodes, edges);

    return {
      filePath: normalizedFilePath,
      nodes,
      edges,
      hasCycle,
      cycleNodes: hasCycle ? cycleNodes : undefined,
    };
  }

  /**
   * Converts LSP symbols to SymbolNode entities
   */
  private convertLspSymbolsToNodes(
    filePath: string,
    lspSymbols: LspSymbol[],
  ): SymbolNode[] {
    return lspSymbols.map((symbol) => {
      const symbolId = this.generateSymbolId(filePath, symbol.name);
      const symbolType = this.mapKindToType(symbol.kind);

      return {
        id: symbolId,
        name: symbol.name,
        originalName: undefined, // Will be set for anonymous functions in Phase 8
        kind: symbol.kind,
        type: symbolType,
        range: symbol.range,
        isExported: this.isSymbolExported(symbol),
        isExternal: false, // Symbols in current file are never external
        parentSymbolId: symbol.containerName
          ? this.generateSymbolId(filePath, symbol.containerName)
          : undefined,
      };
    });
  }

  /**
   * Builds CallEdge list from LSP call hierarchy, filtering external calls
   */
  private buildCallEdges(
    filePath: string,
    outgoingCalls: Map<string, LspOutgoingCall[]>,
    nodes: SymbolNode[],
  ): CallEdge[] {
    const edges: CallEdge[] = [];
    const normalizedFilePath = normalizePath(filePath);
    const nodeIdSet = new Set(nodes.map((n) => n.id));

    for (const [sourceId, calls] of outgoingCalls.entries()) {
      for (const call of calls) {
        // Filter external calls: only include if target is in the same file
        const targetUri = normalizePath(call.to.uri);
        if (targetUri !== normalizedFilePath) {
          // External call - skip for intra-file analysis
          continue;
        }

        const targetId = this.generateSymbolId(filePath, call.to.name);

        // Only create edge if both source and target are in our node list
        if (nodeIdSet.has(sourceId) && nodeIdSet.has(targetId)) {
          const callLine = call.fromRanges[0]?.start ?? 0;

          edges.push({
            source: sourceId,
            target: targetId,
            relation: "calls", // LSP call hierarchy always represents calls
            line: callLine,
          });
        }
      }
    }

    return edges;
  }

  /**
   * Detects cycles in the call graph using DFS traversal
   */
  private detectCycles(
    nodes: SymbolNode[],
    edges: CallEdge[],
  ): { hasCycle: boolean; cycleNodes: string[] } {
    const adjacencyList = new Map<string, string[]>();
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const cycleNodes = new Set<string>();

    // Build adjacency list
    for (const edge of edges) {
      if (!adjacencyList.has(edge.source)) {
        adjacencyList.set(edge.source, []);
      }
      adjacencyList.get(edge.source)!.push(edge.target);
    }

    // DFS helper function
    const dfs = (nodeId: string): boolean => {
      visited.add(nodeId);
      recursionStack.add(nodeId);

      const neighbors = adjacencyList.get(nodeId) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          if (dfs(neighbor)) {
            cycleNodes.add(nodeId);
            return true;
          }
        } else if (recursionStack.has(neighbor)) {
          // Cycle detected
          cycleNodes.add(nodeId);
          cycleNodes.add(neighbor);
          return true;
        }
      }

      recursionStack.delete(nodeId);
      return false;
    };

    // Run DFS from all unvisited nodes
    let hasCycle = false;
    for (const node of nodes) {
      if (!visited.has(node.id)) {
        if (dfs(node.id)) {
          hasCycle = true;
        }
      }
    }

    return {
      hasCycle,
      cycleNodes: Array.from(cycleNodes),
    };
  }

  /**
   * Generates a unique symbol ID: ${filePath}:${symbolName}
   */
  private generateSymbolId(filePath: string, symbolName: string): string {
    const normalized = normalizePath(filePath);
    return `${normalized}:${symbolName}`;
  }

  /**
   * Maps vscode.SymbolKind enum to simplified type for color coding
   *
   * VS Code SymbolKind values:
   * - Function = 12, Method = 6
   * - Class = 5, Interface = 11
   * - Variable = 13, Constant = 14, Property = 7
   */
  private mapKindToType(kind: number): "class" | "function" | "variable" {
    // Function-like: Function (12), Method (6), Constructor (9)
    if (kind === 12 || kind === 6 || kind === 9) {
      return "function";
    }

    // Class-like: Class (5), Interface (11), Enum (10), Module (2)
    if (kind === 5 || kind === 11 || kind === 10 || kind === 2) {
      return "class";
    }

    // Variable-like: Variable (13), Constant (14), Property (7), Field (8)
    return "variable";
  }

  /**
   * Determines if a symbol is exported (simplified heuristic).
   * FUTURE ENHANCEMENT: Use LSP document symbol details for precise export detection.
   * Current heuristic (top-level = exported) is sufficient for symbol visibility.
   */
  private isSymbolExported(symbol: LspSymbol): boolean {
    // Heuristic: Top-level symbols (no container) are likely exported
    // This will be refined in implementation with actual LSP data
    return !symbol.containerName;
  }
}
