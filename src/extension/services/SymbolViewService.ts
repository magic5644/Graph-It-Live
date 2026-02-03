import * as vscode from "vscode";
import { LspCallHierarchyAnalyzer } from "../../analyzer/LspCallHierarchyAnalyzer";
import { Spider } from "../../analyzer/Spider";
import type { IntraFileGraph, SymbolDependency, SymbolInfo } from "../../shared/types";
import type {
    CallHierarchyOptions,
    IntraFileCallGraph,
} from "./LspCallHierarchyService";

type Logger = {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
};

type RelationType = "dependency" | "call" | "reference";

/**
 * Interface for LSP call hierarchy service to allow mocking in tests
 */
export interface ILspCallHierarchyService {
  isCallHierarchyAvailable(uri: { fsPath: string }): Promise<boolean>;
  buildIntraFileCallGraph(
    uri: { fsPath: string },
    options?: CallHierarchyOptions,
  ): Promise<IntraFileCallGraph>;
}

interface SymbolGraphResult {
  nodes: string[];
  edges: {
    source: string;
    target: string;
    relationType?: RelationType;
  }[];
  symbolData: { symbols: SymbolInfo[]; dependencies: SymbolDependency[] };
  incomingDependencies?: SymbolDependency[]; // External calls TO symbols in this file
  referencingFiles: string[];
  parentCounts?: Record<string, number>;
  /** Metadata about the analysis */
  metadata?: {
    /** Whether LSP call hierarchy was used */
    lspUsed: boolean;
    /** Any warnings from the analysis */
    warnings: string[];
    /** Number of call edges added by LSP */
    callEdgesCount: number;
  };
  /** Symbol-level graph with cycle detection (if LSP used) */
  graph?: IntraFileGraph;
}

/**
 * Options for building the symbol graph
 */
export interface SymbolGraphOptions {
  /** Include LSP-based call hierarchy (who calls who) */
  includeCallHierarchy?: boolean;
  /** Maximum file size in lines for LSP analysis */
  maxFileLines?: number;
  /** LSP call hierarchy options */
  callHierarchyOptions?: CallHierarchyOptions;
}

const DEFAULT_SYMBOL_GRAPH_OPTIONS: SymbolGraphOptions = {
  includeCallHierarchy: false,
  maxFileLines: 5000,
};

/**
 * Service for building symbol-level dependency graphs.
 *
 * Supports two analysis modes:
 * 1. AST-only (default): Uses ts-morph for fast, accurate dependency analysis
 * 2. Hybrid (AST + LSP): Combines AST dependencies with LSP call hierarchy
 *
 * The hybrid mode provides richer call flow information but may be slower
 * and requires an active language server.
 */
export class SymbolViewService {
  private _lspService: ILspCallHierarchyService | undefined;

  constructor(
    private readonly spider: Spider,
    private readonly logger: Logger,
    lspService?: ILspCallHierarchyService,
  ) {
    this._lspService = lspService;
  }

  /**
   * Lazy initialization of LSP service to avoid importing vscode in tests
   */
  private async getLspService(): Promise<ILspCallHierarchyService | undefined> {
    if (this._lspService) {
      return this._lspService;
    }

    try {
      // Dynamic import to avoid requiring vscode at module load time
      const vscode = await import("vscode");
      const { LspCallHierarchyService } =
        await import("./LspCallHierarchyService");
      const rawService = new LspCallHierarchyService();

      // Helper to convert file path to URI
      const createUri = (filePath: string) => vscode.Uri.file(filePath);

      // Wrap the service to accept file paths instead of URIs
      const originalService = rawService as unknown as {
        isCallHierarchyAvailable(
          uri: ReturnType<typeof vscode.Uri.file>,
        ): Promise<boolean>;
        buildIntraFileCallGraph(
          uri: ReturnType<typeof vscode.Uri.file>,
          options?: CallHierarchyOptions,
        ): Promise<IntraFileCallGraph>;
      };

      // Create and cache the wrapped service
      this._lspService = {
        isCallHierarchyAvailable: async (uri: { fsPath: string }) =>
          originalService.isCallHierarchyAvailable(createUri(uri.fsPath)),
        buildIntraFileCallGraph: async (
          uri: { fsPath: string },
          options?: CallHierarchyOptions,
        ) =>
          originalService.buildIntraFileCallGraph(
            createUri(uri.fsPath),
            options,
          ),
      };

      return this._lspService;
    } catch {
      // vscode not available (e.g., in tests)
      return undefined;
    }
  }

  /**
   * Build a symbol graph for a file.
   *
   * @param resolvedFilePath - Absolute path to the file to analyze
   * @param rootNodeId - ID for the root node (usually the file path)
   * @param options - Options for the analysis
   * @returns The symbol graph with nodes, edges, and metadata
   */
  async buildSymbolGraph(
    resolvedFilePath: string,
    rootNodeId: string,
    options: SymbolGraphOptions = {},
  ): Promise<SymbolGraphResult> {
    // T094: Log symbol analysis start
    this.logger.debug(`Building symbol graph for: ${resolvedFilePath}`);
    
    const opts = { ...DEFAULT_SYMBOL_GRAPH_OPTIONS, ...options };

    // Step 1: Get AST-based symbol data (always)
    const symbolData = await this.spider.getSymbolGraph(resolvedFilePath);
    const referencingDependency =
      await this.spider.findReferencingFiles(resolvedFilePath);
    const referencingFiles = referencingDependency.map((d) => d.path);

    // T094: Log AST analysis results
    this.logger.debug(
      `AST analysis complete: ${symbolData.symbols.length} symbols, ${symbolData.dependencies.length} dependencies`,
    );

    // Log first few symbol IDs for debugging
    if (symbolData.symbols.length > 0) {
      this.logger.info(`[SYMBOLS] First 2 symbol IDs:`, symbolData.symbols.slice(0, 2).map(s => ({ name: s.name, id: s.id })));
    }

    // Build base payload from AST analysis
    const payload = this.buildPayload(symbolData, resolvedFilePath, rootNodeId);

    // Step 2: If call hierarchy is enabled, enrich with LSP data
    if (opts.includeCallHierarchy) {
      // T094: Log LSP enrichment attempt
      this.logger.debug('Attempting LSP call hierarchy enrichment');
      
      const enrichedResult = await this.tryEnrichWithLsp(
        payload,
        symbolData,
        resolvedFilePath,
        rootNodeId,
        referencingFiles,
        opts as SymbolGraphOptions & { includeCallHierarchy: true },
      );
      if (enrichedResult) {
        // T094: Log successful LSP enrichment
        this.logger.debug(
          `LSP enrichment successful: ${enrichedResult.metadata?.callEdgesCount ?? 0} call edges added`,
        );
        return enrichedResult;
      }
      
      // T094: Log fallback to AST-only
      this.logger.debug('LSP unavailable, using AST-only analysis');
    }

    // Return AST-only result
    return this.buildAstOnlyResult(
      payload,
      symbolData,
      referencingFiles,
      rootNodeId,
    );
  }

  /**
   * Try to enrich the graph with LSP call hierarchy data
   */
  private async tryEnrichWithLsp(
    payload: ReturnType<typeof this.buildPayload>,
    symbolData: { symbols: SymbolInfo[]; dependencies: SymbolDependency[] },
    resolvedFilePath: string,
    rootNodeId: string,
    referencingFiles: string[],
    opts: SymbolGraphOptions & { includeCallHierarchy: true },
  ): Promise<SymbolGraphResult | null> {
    // T093: Comprehensive error handling for LSP operations
    try {
      const lspService = await this.getLspService();
      if (!lspService) {
        this.logger.debug(
          "LSP service not available (likely running outside VS Code)",
        );
        return null;
      }

      const uri = vscode.Uri.file(resolvedFilePath);
      
      this.logger.info(`Attempting LSP call hierarchy analysis for ${resolvedFilePath}`);

      // T093: Skip availability check and directly try to build call graph
      // The availability check was too strict and rejected files where LSP actually works
      // Instead, we rely on buildIntraFileCallGraph's internal error handling

      // T093: Handle call graph build failures with detailed errors
      let callGraph: IntraFileCallGraph | undefined;
      try {
        callGraph = await lspService.buildIntraFileCallGraph(uri, {
          maxFileLines: opts.maxFileLines,
          ...opts.callHierarchyOptions,
        });
      } catch (buildError) {
        this.logger.warn(
          `Failed to build call graph for ${resolvedFilePath}: ${buildError instanceof Error ? buildError.message : String(buildError)}`,
        );
        return null;
      }

      // T093: Handle graph processing failures
      try {
        return this.processCallGraph(
          callGraph,
          payload,
          symbolData,
          resolvedFilePath,
          rootNodeId,
          referencingFiles,
          opts,
        );
      } catch (processError) {
        this.logger.warn(
          `Failed to process call graph for ${resolvedFilePath}: ${processError instanceof Error ? processError.message : String(processError)}`,
        );
        return null;
      }
    } catch (error) {
      // T093: Top-level error handler for unexpected failures
      this.logger.warn(
        `Unexpected error during LSP enrichment for ${resolvedFilePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Process call graph and merge it into the result
   */
  private processCallGraph(
    callGraph: IntraFileCallGraph | undefined,
    payload: ReturnType<typeof this.buildPayload>,
    symbolData: { symbols: SymbolInfo[]; dependencies: SymbolDependency[] },
    resolvedFilePath: string,
    rootNodeId: string,
    referencingFiles: string[],
    _opts: SymbolGraphOptions & { includeCallHierarchy: true },
  ): SymbolGraphResult | null {
    if (!callGraph || !callGraph.lspUsed || callGraph.edges.length === 0) {
      if (callGraph?.warnings.length) {
        this.logger.warn(
          "LSP call hierarchy warnings:",
          callGraph.warnings.join(", "),
        );
      }
      return null;
    }

    const mergedResult = this.mergeCallHierarchy(
      payload,
      callGraph,
      resolvedFilePath,
    );

    this.logger.debug(
      `Merged ${callGraph.edges.length} call edges from LSP into symbol graph`,
    );

    // Build IntraFileGraph with cycle detection
    const analyzer = new LspCallHierarchyAnalyzer();
    const includeIncomingCalls = true; // Always enable incoming calls
    const graph = analyzer.buildIntraFileGraph(
      resolvedFilePath,
      {
        symbols: callGraph.nodes.map((node) => ({
          name: node.name,
          kind: node.kind,
          range: {
            start: node.line - 1, // Convert back to 0-indexed
            end: node.line - 1,
          },
          containerName: undefined,
          uri: resolvedFilePath,
        })),
        callHierarchyItems: new Map(),
        outgoingCalls: this.buildOutgoingCallsMap(callGraph, resolvedFilePath),
        incomingCalls: this.buildIncomingCallsMap(callGraph, resolvedFilePath),
      },
      includeIncomingCalls,
    );

    this.logger.info(`[WEBVIEW-SEND] Incoming edges in graph: ${graph.incomingEdges?.length ?? 0}`);

    // Extract incoming dependencies from callGraph edges (includes external calls AND references)
    const incomingDeps = callGraph.edges
      .filter(edge => edge.direction === 'incoming')
      .map(edge => ({
        sourceSymbolId: edge.source,
        targetSymbolId: edge.target,
        targetFilePath: resolvedFilePath,
        relationType: edge.type,
      }));

    // Normalize incomingDeps to use the same symbol IDs as AST-based symbolData
    // Build a lookup: filePath -> map of simple name -> full symbol id
    const nameLookup: Record<string, Map<string, string>> = {};
    for (const s of symbolData.symbols) {
      const [file, fullName] = s.id.split(":");
      if (!nameLookup[file]) nameLookup[file] = new Map();
      // Store exact name
      nameLookup[file].set(fullName, s.id);
      // Also store short name (after last dot) to help match methods
      const short = fullName.includes('.') ? fullName.split('.').pop()! : fullName;
      if (!nameLookup[file].has(short)) nameLookup[file].set(short, s.id);
    }

    const findFullId = (symbolId: string): string => {
      const [file, name] = symbolId.split(":");
      const map = nameLookup[file];
      if (!map) return symbolId;
      if (map.has(name)) return map.get(name)!;
      // Try suffix match (for cases like Class.method)
      for (const [k, v] of map.entries()) {
        if (k.endsWith(`.${name}`)) return v;
      }
      return symbolId;
    };

    // Apply normalization
    for (const dep of incomingDeps) {
      const originalTarget = dep.targetSymbolId;
      const originalSource = dep.sourceSymbolId;
      dep.targetSymbolId = findFullId(dep.targetSymbolId);
      dep.sourceSymbolId = findFullId(dep.sourceSymbolId);
      if (dep.targetSymbolId !== originalTarget || dep.sourceSymbolId !== originalSource) {
        this.logger.debug('[WEBVIEW-SEND] Normalized incomingDep', { originalTarget, originalSource, newTarget: dep.targetSymbolId, newSource: dep.sourceSymbolId });
      }
    }

    this.logger.info(`[WEBVIEW-SEND] callGraph.edges total: ${callGraph.edges.length}`);
    this.logger.info(`[WEBVIEW-SEND] callGraph incoming edges: ${callGraph.edges.filter(e => e.direction === 'incoming').length}`);
    this.logger.info(`[WEBVIEW-SEND] callGraph reference edges: ${callGraph.edges.filter(e => e.type === 'reference').length}`);
    this.logger.info(`[WEBVIEW-SEND] FULL incomingDeps with IDs:`, incomingDeps.slice(0, 2).map(d => ({
      source: d.sourceSymbolId,
      target: d.targetSymbolId,
      type: d.relationType,
    })));
    this.logger.info(`[WEBVIEW-SEND] Extracted incomingDependencies: ${incomingDeps.length}`, incomingDeps.map(d => `${d.sourceSymbolId.split(':').pop()} -> ${d.targetSymbolId.split(':').pop()} (${d.relationType})`));

    return {
      ...mergedResult,
      symbolData: this.enrichSymbolDataWithCallRelations(symbolData, callGraph),
      incomingDependencies: incomingDeps,
      referencingFiles,
      parentCounts:
        referencingFiles.length > 0
          ? { [rootNodeId]: referencingFiles.length }
          : undefined,
      metadata: {
        lspUsed: true,
        warnings: callGraph.warnings,
        callEdgesCount: callGraph.edges.length,
      },
      graph,
    };
  }

  /**
   * Build AST-only result without LSP enrichment
   */
  private buildAstOnlyResult(
    payload: ReturnType<typeof this.buildPayload>,
    symbolData: { symbols: SymbolInfo[]; dependencies: SymbolDependency[] },
    referencingFiles: string[],
    rootNodeId: string,
  ): SymbolGraphResult {
    return {
      ...payload,
      symbolData,
      incomingDependencies: [],
      referencingFiles,
      parentCounts:
        referencingFiles.length > 0
          ? { [rootNodeId]: referencingFiles.length }
          : undefined,
      metadata: {
        lspUsed: false,
        warnings: [],
        callEdgesCount: 0,
      },
    };
  }

  /**
   * Build the base payload from AST symbol data
   */
  private buildPayload(
    symbolData: { symbols: SymbolInfo[]; dependencies: SymbolDependency[] },
    resolvedFilePath: string,
    rootNodeId: string,
  ): {
    nodes: string[];
    edges: {
      source: string;
      target: string;
      relationType?: RelationType;
    }[];
  } {
    const nodes = new Set<string>([rootNodeId]);

    // Add ALL symbols from this file (includes internal/private ones)
    symbolData.symbols.forEach((s) => nodes.add(s.id));

    // Add external symbol dependencies (symbols from other files)
    // Only add if the target symbol is NOT from the current file
    symbolData.dependencies.forEach((d) => {
      const targetFilePath = d.targetSymbolId.split(":")[0]; // Extract file path from symbol ID
      if (targetFilePath !== resolvedFilePath) {
        nodes.add(d.targetSymbolId);
      }
    });

    const edges: {
      source: string;
      target: string;
      relationType?: RelationType;
    }[] = [];

    // Add edges from file root to TOP-LEVEL symbols (both exported and internal)
    // Changed from filtering only isExported to show ALL top-level symbols
    symbolData.symbols
      .filter((s) => !s.parentSymbolId) // Top-level symbols (no parent)
      .forEach((s) =>
        edges.push({
          source: rootNodeId,
          target: s.id,
          relationType: "dependency",
        }),
      );

    // Add structural edges (Parent -> Child) for nested symbols (methods inside classes)
    symbolData.symbols
      .filter((s) => s.parentSymbolId)
      .forEach((s) =>
        edges.push({
          source: s.parentSymbolId!,
          target: s.id,
          // using 'dependency' as generic structural link for now
          relationType: "dependency",
        }),
      );

    // Add edges from symbols to their dependencies
    symbolData.dependencies.forEach((d) =>
      edges.push({
        source: d.sourceSymbolId,
        target: d.targetSymbolId,
        relationType: d.relationType || "dependency",
      }),
    );

    this.logger.debug("Built symbol graph payload", nodes.size, "nodes");

    return {
      nodes: Array.from(nodes),
      edges,
    };
  }

  /**
   * Merge LSP call hierarchy data into the base payload
   */
  private mergeCallHierarchy(
    payload: {
      nodes: string[];
      edges: {
        source: string;
        target: string;
        relationType?: RelationType;
      }[];
    },
    callGraph: IntraFileCallGraph,
    _resolvedFilePath: string,
  ): {
    nodes: string[];
    edges: {
      source: string;
      target: string;
      relationType?: RelationType;
    }[];
  } {
    const nodesSet = new Set(payload.nodes);
    const edgesSet = new Set(
      payload.edges.map((e) => `${e.source}->${e.target}`),
    );
    const mergedEdges = [...payload.edges];

    // Add call edges from LSP that don't already exist
    for (const callEdge of callGraph.edges) {
      const edgeKey = `${callEdge.source}->${callEdge.target}`;

      if (!edgesSet.has(edgeKey)) {
        edgesSet.add(edgeKey);
        mergedEdges.push({
          source: callEdge.source,
          target: callEdge.target,
          relationType: callEdge.type,
        });

        // Ensure source and target nodes exist
        nodesSet.add(callEdge.source);
        nodesSet.add(callEdge.target);
      }
    }

    return {
      nodes: Array.from(nodesSet),
      edges: mergedEdges,
    };
  }

  /**
   * Enrich symbol data with call relation information
   */
  private enrichSymbolDataWithCallRelations(
    symbolData: { symbols: SymbolInfo[]; dependencies: SymbolDependency[] },
    callGraph: IntraFileCallGraph,
  ): { symbols: SymbolInfo[]; dependencies: SymbolDependency[] } {
    const enrichedDependencies: SymbolDependency[] =
      symbolData.dependencies.map((d) => ({
        ...d,
        relationType: d.relationType || ("dependency" as const),
      }));

    // Add call dependencies from LSP
    for (const edge of callGraph.edges) {
      // Check if this edge already exists as a dependency
      const existingIndex = enrichedDependencies.findIndex(
        (d) =>
          d.sourceSymbolId === edge.source && d.targetSymbolId === edge.target,
      );

      if (existingIndex === -1) {
        // Add new call dependency
        enrichedDependencies.push({
          sourceSymbolId: edge.source,
          targetSymbolId: edge.target,
          targetFilePath: edge.target.split(":")[0] || "",
          relationType: edge.type,
          callLocations: edge.locations,
        });
      } else {
        // Upgrade existing dependency to call if applicable
        const existing = enrichedDependencies[existingIndex];
        if (edge.type === "call" && existing.relationType !== "call") {
          enrichedDependencies[existingIndex] = {
            ...existing,
            relationType: "call",
            callLocations: edge.locations,
          };
        }
      }
    }

    return {
      symbols: symbolData.symbols,
      dependencies: enrichedDependencies,
    };
  }

  /**
   * Builds a Map of outgoing calls for LspCallHierarchyAnalyzer
   */
  private buildOutgoingCallsMap(
    callGraph: IntraFileCallGraph,
    filePath: string,
  ): Map<string, Array<{ to: { name: string; uri: string; kind: number; range: { start: number; end: number } }; fromRanges: Array<{ start: number; end: number }> }>> {
    const outgoingCalls = new Map<
      string,
      Array<{
        to: { name: string; uri: string; kind: number; range: { start: number; end: number } };
        fromRanges: Array<{ start: number; end: number }>;
      }>
    >();

    for (const edge of callGraph.edges) {
      // Only process outgoing edges
      if (edge.direction && edge.direction !== 'outgoing') {
        continue;
      }

      if (!outgoingCalls.has(edge.source)) {
        outgoingCalls.set(edge.source, []);
      }

      // Find target node to get its kind
      const targetNode = callGraph.nodes.find((n) => n.id === edge.target);
      if (!targetNode) {
        continue;
      }

      // Extract target name from symbol ID (format: filePath:symbolName)
      const targetName = edge.target.split(":").pop() || edge.target;

      outgoingCalls.get(edge.source)!.push({
        to: {
          name: targetName,
          uri: filePath,
          kind: targetNode.kind,
          range: {
            start: targetNode.line - 1,
            end: targetNode.line - 1,
          },
        },
        fromRanges:
          edge.locations?.map((loc) => ({
            start: loc.line - 1,
            end: loc.line - 1,
          })) || [],
      });
    }

    return outgoingCalls;
  }

  /**
   * Build map of incoming calls (who calls each symbol) from call graph edges
   */
  private buildIncomingCallsMap(
    callGraph: IntraFileCallGraph,
    filePath: string,
  ): Map<string, Array<{ from: { name: string; uri: string; kind: number; range: { start: number; end: number } }; fromRanges: Array<{ start: number; end: number }> }>> {
    const incomingCalls = new Map<
      string,
      Array<{
        from: { name: string; uri: string; kind: number; range: { start: number; end: number } };
        fromRanges: Array<{ start: number; end: number }>;
      }>
    >();

    for (const edge of callGraph.edges) {
      // Only process incoming edges
      if (edge.direction && edge.direction !== 'incoming') {
        continue;
      }

      // For incoming calls, the target is being called by the source
      if (!incomingCalls.has(edge.target)) {
        incomingCalls.set(edge.target, []);
      }

      // Find source node to get its kind
      const sourceNode = callGraph.nodes.find((n) => n.id === edge.source);
      if (!sourceNode) {
        continue;
      }

      // Extract source name from symbol ID (format: filePath:symbolName)
      const sourceName = edge.source.split(":").pop() || edge.source;

      incomingCalls.get(edge.target)!.push({
        from: {
          name: sourceName,
          uri: filePath,
          kind: sourceNode.kind,
          range: {
            start: sourceNode.line - 1,
            end: sourceNode.line - 1,
          },
        },
        fromRanges:
          edge.locations?.map((loc) => ({
            start: loc.line - 1,
            end: loc.line - 1,
          })) || [],
      });
    }

    return incomingCalls;
  }
}
