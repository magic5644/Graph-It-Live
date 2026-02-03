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
import type { CallEdge, CycleType, IntraFileGraph, SymbolNode } from "@/shared/types";

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
 * LSP Call Hierarchy Incoming Call (subset of vscode.CallHierarchyIncomingCall)
 * Étape 5: Support for incoming calls analysis
 */
export interface LspIncomingCall {
  from: LspCallHierarchyItem;
  fromRanges: Array<{ start: number; end: number }>;
}

/**
 * Result of LSP analysis
 */
export interface LspAnalysisResult {
  symbols: LspSymbol[];
  callHierarchyItems: Map<string, LspCallHierarchyItem>;
  outgoingCalls: Map<string, LspOutgoingCall[]>;
  incomingCalls?: Map<string, LspIncomingCall[]>; // Étape 5: Optional incoming calls
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
   * @param includeIncomingCalls - Whether to include incoming call edges (Étape 5)
   * @returns IntraFileGraph with nodes, edges, cycle detection
   */
  public buildIntraFileGraph(
    filePath: string,
    lspData: LspAnalysisResult,
    includeIncomingCalls = false, // Étape 5: optional parameter
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

    // Étape 5: Step 2b: Build incoming call edges if requested
    const incomingEdges = includeIncomingCalls && lspData.incomingCalls
      ? this.buildIncomingCallEdges(normalizedFilePath, lspData.incomingCalls, nodes)
      : undefined;

    // Step 3: Detect cycles using DFS
    const { hasCycle, cycleNodes, cycleType } = this.detectCycles(
      nodes,
      edges,
    );

    return {
      filePath: normalizedFilePath,
      nodes,
      edges,
      incomingEdges, // Étape 5
      hasCycle,
      cycleNodes: hasCycle ? cycleNodes : undefined,
      cycleType: hasCycle ? cycleType : undefined,
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
      const symbolId = this.generateSymbolId(filePath, symbol.name, symbol.containerName);
      const symbolType = this.mapKindToType(symbol.kind);
      
      // T089: Generate contextual names for anonymous functions
      const contextualName = this.generateContextualName(symbol);

      return {
        id: symbolId,
        name: contextualName || symbol.name,
        originalName: contextualName ? symbol.name : undefined,
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

        // Try to match target with container if available (for scoped symbols)
        const targetId = this.generateSymbolId(filePath, call.to.name);

        // Only create edge if both source and target are in our node list
        if (nodeIdSet.has(sourceId) && nodeIdSet.has(targetId)) {
          const callLine = call.fromRanges[0]?.start ?? 0;

          edges.push({
            source: sourceId,
            target: targetId,
            relation: "calls", // LSP call hierarchy always represents calls
            direction: "outgoing", // Étape 5: Mark as outgoing call
            line: callLine,
          });
        }
      }
    }

    return edges;
  }

  /**
   * Étape 5: Builds incoming call edges (callers → target) from LSP incoming call hierarchy
   * 
   * @param filePath - File path being analyzed
   * @param incomingCalls - Map of symbol ID to its incoming calls
   * @param nodes - All symbols in the file
   * @returns Array of incoming call edges
   */
  private buildIncomingCallEdges(
    filePath: string,
    incomingCalls: Map<string, LspIncomingCall[]>,
    nodes: SymbolNode[],
  ): CallEdge[] {
    const edges: CallEdge[] = [];
    const normalizedFilePath = normalizePath(filePath);
    const nodeIdSet = new Set(nodes.map((n) => n.id));

    for (const [targetId, calls] of incomingCalls.entries()) {
      for (const call of calls) {
        // Filter external calls: only include if caller is in the same file
        const callerUri = normalizePath(call.from.uri);
        if (callerUri !== normalizedFilePath) {
          // External caller - skip for intra-file analysis
          continue;
        }

        // Generate source ID for the caller
        const sourceId = this.generateSymbolId(filePath, call.from.name);

        // Only create edge if both source (caller) and target (callee) are in our node list
        if (nodeIdSet.has(sourceId) && nodeIdSet.has(targetId)) {
          const callLine = call.fromRanges[0]?.start ?? 0;

          edges.push({
            source: sourceId,
            target: targetId,
            relation: "calls", // Incoming call is still a "calls" relationship
            direction: "incoming", // Étape 5: Mark as incoming call
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
  ): { hasCycle: boolean; cycleNodes: string[]; cycleType?: CycleType } {
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
          // Recurse but don't mark this node as part of the cycle
          // Only nodes actually in the cycle should be marked
          if (dfs(neighbor)) {
            return true;
          }
        } else if (recursionStack.has(neighbor)) {
          // Cycle detected: mark all nodes in the recursion stack as part of the cycle
          // This captures the entire cycle path (e.g., A→B→C→A marks all 3 nodes)
          for (const stackNode of recursionStack) {
            cycleNodes.add(stackNode);
          }
          cycleNodes.add(neighbor); // Also add the node that closes the cycle
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

    // Analyze cycle pattern if detected
    if (hasCycle) {
      const cycleType = this.analyzeCyclePattern(
        Array.from(cycleNodes),
        edges,
      );
      return {
        hasCycle,
        cycleNodes: Array.from(cycleNodes),
        cycleType,
      };
    }

    return {
      hasCycle,
      cycleNodes: [],
    };
  }

  /**
   * Analyzes the pattern of a detected cycle to classify its type.
   * This helps distinguish intentional recursion (common in interpreters, parsers)
   * from potentially problematic circular dependencies.
   *
   * @param cycleNodes - Node IDs involved in the cycle
   * @param edges - All call edges in the graph
   * @returns Classification of the cycle type
   */
  private analyzeCyclePattern(
    cycleNodes: string[],
    edges: CallEdge[],
  ): CycleType {
    // Self-recursive: A function calling itself directly
    // Example: factorial(n) calls factorial(n-1)
    const selfLoops = edges.filter((e) => e.source === e.target);
    if (selfLoops.length > 0 && cycleNodes.length === 1) {
      return "self-recursive";
    }

    // Mutual-recursive: Two functions calling each other (A ↔ B)
    // Example: eval() ↔ execute() in interpreters
    if (cycleNodes.length === 2) {
      return "mutual-recursive";
    }

    // Complex: Cycle involving 3 or more functions (A → B → C → A)
    // Less common, may indicate architectural issues
    return "complex";
  }

  /**
   * Generates a unique symbol ID: ${filePath}:${symbolName}
   * Optionally includes container name to avoid collisions (e.g., methods with same name in different classes)
   */
  private generateSymbolId(
    filePath: string,
    symbolName: string,
    containerName?: string
  ): string {
    const normalized = normalizePath(filePath);
    
    // Include container name for scoped symbols to avoid collisions
    // Example: "file.ts:MyClass.method" vs "file.ts:OtherClass.method"
    if (containerName) {
      return `${normalized}:${containerName}.${symbolName}`;
    }
    
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

  /**
   * Check for array method callbacks (map, filter, reduce, etc.)
   */
  private getArrayMethodCallbackName(container: string): string | undefined {
    if (container.includes('map')) return 'map callback';
    if (container.includes('filter')) return 'filter predicate';
    if (container.includes('reduce')) return 'reduce callback';
    if (container.includes('foreach')) return 'forEach callback';
    if (container.includes('find')) return 'find predicate';
    if (container.includes('some') || container.includes('every')) return 'predicate callback';
    if (container.includes('sort')) return 'sort comparator';
    return undefined;
  }

  /**
   * Check for event handler callbacks (onClick, onSubmit, etc.)
   */
  private getEventHandlerName(container: string): string | undefined {
    if (container.includes('onclick')) return 'onClick handler';
    if (container.includes('onsubmit')) return 'onSubmit handler';
    if (container.includes('onchange')) return 'onChange handler';
    if (container.includes('onload')) return 'onLoad handler';
    if (/on[a-z]+/.exec(container)) return `${container} handler`;
    return undefined;
  }

  /**
   * Check for promise chain callbacks (then, catch, finally)
   */
  private getPromiseCallbackName(container: string): string | undefined {
    if (container.includes('then')) return 'then callback';
    if (container.includes('catch')) return 'catch handler';
    if (container.includes('finally')) return 'finally callback';
    return undefined;
  }

  /**
   * Check for timer callbacks (setTimeout, setInterval, etc.)
   */
  private getTimerCallbackName(container: string): string | undefined {
    if (container.includes('settimeout')) return 'setTimeout callback';
    if (container.includes('setinterval')) return 'setInterval callback';
    if (container.includes('requestanimationframe')) return 'animation frame callback';
    return undefined;
  }

  /**
   * Check for generic callback/handler patterns
   */
  private getGenericCallbackName(container: string): string | undefined {
    if (container.includes('callback')) return 'callback function';
    if (container.includes('handler')) return 'handler function';
    return undefined;
  }

  /**
   * T089: Generate contextual names for anonymous functions
   * Detects arrow functions and callbacks based on naming patterns
   * 
   * Examples:
   * - "(anonymous)" in "map" container → "map callback"
   * - "(anonymous)" in "filter" container → "filter predicate"
   * - "(anonymous)" in "onClick" container → "onClick handler"
   * - "(anonymous)" in "setTimeout" container → "setTimeout callback"
   */
  private generateContextualName(symbol: LspSymbol): string | undefined {
    const name = symbol.name.toLowerCase();
    const container = symbol.containerName?.toLowerCase() || '';

    // Skip if not an anonymous function pattern
    if (!name.includes('anonymous') && !name.includes('arrow') && !name.includes('<function>')) {
      return undefined;
    }

    // Check different callback patterns in order
    return this.getArrayMethodCallbackName(container) ||
           this.getEventHandlerName(container) ||
           this.getPromiseCallbackName(container) ||
           this.getTimerCallbackName(container) ||
           this.getGenericCallbackName(container);
  }
}
