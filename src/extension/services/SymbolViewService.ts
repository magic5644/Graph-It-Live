import { Spider } from "../../analyzer/Spider";
import type { SymbolDependency, SymbolInfo } from "../../shared/types";
import type {
  CallHierarchyOptions,
  IntraFileCallGraph,
} from "./LspCallHierarchyService";

type Logger = {
  debug: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
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
      this._lspService = new LspCallHierarchyService();

      // Helper to convert file path to URI
      const createUri = (filePath: string) => vscode.Uri.file(filePath);

      // Wrap the service to accept file paths instead of URIs
      const originalService = this._lspService as unknown as {
        isCallHierarchyAvailable(
          uri: ReturnType<typeof vscode.Uri.file>,
        ): Promise<boolean>;
        buildIntraFileCallGraph(
          uri: ReturnType<typeof vscode.Uri.file>,
          options?: CallHierarchyOptions,
        ): Promise<IntraFileCallGraph>;
      };

      return {
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
    const opts = { ...DEFAULT_SYMBOL_GRAPH_OPTIONS, ...options };

    // Step 1: Get AST-based symbol data (always)
    const symbolData = await this.spider.getSymbolGraph(resolvedFilePath);
    const referencingDependency =
      await this.spider.findReferencingFiles(resolvedFilePath);
    const referencingFiles = referencingDependency.map((d) => d.path);

    // Build base payload from AST analysis
    const payload = this.buildPayload(symbolData, resolvedFilePath, rootNodeId);

    // Step 2: If call hierarchy is enabled, enrich with LSP data
    if (opts.includeCallHierarchy) {
      const enrichedResult = await this.tryEnrichWithLsp(
        payload,
        symbolData,
        resolvedFilePath,
        rootNodeId,
        referencingFiles,
        opts as SymbolGraphOptions & { includeCallHierarchy: true },
      );
      if (enrichedResult) {
        return enrichedResult;
      }
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
    try {
      const lspService = await this.getLspService();
      if (!lspService) {
        this.logger.debug(
          "LSP service not available (likely running outside VS Code)",
        );
        return null;
      }

      const uri = { fsPath: resolvedFilePath };
      const isAvailable = await lspService.isCallHierarchyAvailable(uri);

      if (!isAvailable) {
        this.logger.debug("LSP call hierarchy not available for this file");
        return null;
      }

      const callGraph = await lspService.buildIntraFileCallGraph(uri, {
        maxFileLines: opts.maxFileLines,
        ...opts.callHierarchyOptions,
      });

      return this.processCallGraph(
        callGraph,
        payload,
        symbolData,
        resolvedFilePath,
        rootNodeId,
        referencingFiles,
      );
    } catch (error) {
      this.logger.warn("Failed to get LSP call hierarchy:", String(error));
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

    return {
      ...mergedResult,
      symbolData: this.enrichSymbolDataWithCallRelations(symbolData, callGraph),
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
}
