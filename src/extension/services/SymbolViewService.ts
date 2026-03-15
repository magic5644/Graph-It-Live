import { LspCallHierarchyAnalyzer } from "../../analyzer/LspCallHierarchyAnalyzer";
import { Spider } from "../../analyzer/Spider";
import { convertSpiderToLspFormat } from "../../shared/converters";
import { normalizePath } from "../../shared/path";
import type { IntraFileGraph, SymbolDependency, SymbolInfo } from "../../shared/types";
import type { ICallGraphQueryService } from "./ICallGraphQueryService";

type Logger = {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
};

type RelationType = "dependency" | "call" | "reference";

interface SymbolGraphResult {
  nodes: string[];
  edges: {
    source: string;
    target: string;
    relationType?: RelationType;
  }[];
  symbolData: { symbols: SymbolInfo[]; dependencies: SymbolDependency[] };
  incomingDependencies?: SymbolDependency[];
  referencingFiles: string[];
  parentCounts?: Record<string, number>;
  intraFileGraph?: IntraFileGraph;
}

/**
 * Service for building symbol-level dependency graphs.
 *
 * Uses AST-based analysis (ts-morph / tree-sitter) for fast, accurate
 * symbol extraction and dependency analysis.
 */
export class SymbolViewService {
  private callGraphQuery?: ICallGraphQueryService;

  constructor(
    private readonly spider: Spider,
    private readonly logger: Logger,
  ) { }

  /**
   * Inject the call graph query service for cross-file caller enrichment.
   * Optional — symbol view works without it (graceful degradation).
   */
  setCallGraphQueryService(service: ICallGraphQueryService): void {
    this.callGraphQuery = service;
  }

  /**
   * Build a symbol graph for a file.
   *
   * @param resolvedFilePath - Absolute path to the file to analyze
   * @param rootNodeId - ID for the root node (usually the file path)
   * @returns The symbol graph with nodes, edges, and metadata
   */
  async buildSymbolGraph(
    resolvedFilePath: string,
    rootNodeId: string,
  ): Promise<SymbolGraphResult> {
    this.logger.debug(`Building symbol graph for: ${resolvedFilePath}`);

    // Get AST-based symbol data
    const symbolData = await this.spider.getSymbolGraph(resolvedFilePath);
    const referencingDependency =
      await this.spider.findReferencingFiles(resolvedFilePath);
    const referencingFiles = referencingDependency.map((d) => d.path);

    this.logger.debug(
      `AST analysis complete: ${symbolData.symbols.length} symbols, ${symbolData.dependencies.length} dependencies`,
    );

    // Build intra-file call graph from AST data
    let intraFileGraph: IntraFileGraph | undefined;
    try {
      const lspData = convertSpiderToLspFormat(symbolData, resolvedFilePath);
      const analyzer = new LspCallHierarchyAnalyzer();
      intraFileGraph = analyzer.buildIntraFileGraph(resolvedFilePath, lspData);
      this.logger.debug(
        `Intra-file graph: ${intraFileGraph.nodes.length} nodes, ${intraFileGraph.edges.length} edges, hasCycle=${intraFileGraph.hasCycle}`,
      );
    } catch (err) {
      this.logger.warn(`Failed to build intra-file graph: ${err}`);
    }

    // Collect incoming dependencies from files that reference this one
    const incomingDependencies = await this.collectIncomingDependencies(
      referencingFiles,
      resolvedFilePath,
    );
    this.logger.debug(
      `Incoming dependencies: ${incomingDependencies.length} from ${referencingFiles.length} referencing files`,
    );

    // Enrich with cross-file callers from the call graph SQLite DB
    this.enrichWithCallGraphCallers(
      incomingDependencies,
      resolvedFilePath,
      symbolData.symbols,
    );

    // Build payload from AST analysis
    const payload = this.buildPayload(symbolData, resolvedFilePath, rootNodeId);

    return {
      ...payload,
      symbolData,
      incomingDependencies,
      referencingFiles,
      parentCounts:
        referencingFiles.length > 0
          ? { [rootNodeId]: referencingFiles.length }
          : undefined,
      intraFileGraph,
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
      .filter((s): s is typeof s & { parentSymbolId: string } => !!s.parentSymbolId)
      .forEach((s) =>
        edges.push({
          source: s.parentSymbolId,
          target: s.id,
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
   * Collect incoming dependencies: symbols in the current file that are called
   * by other files. For each referencing file, analyse its symbol graph and
   * pick the dependencies whose resolved targetFilePath matches ours.
   */
  private async collectIncomingDependencies(
    referencingFilePaths: string[],
    targetFilePath: string,
  ): Promise<SymbolDependency[]> {
    const normalizedTarget = normalizePath(targetFilePath);
    const incoming: SymbolDependency[] = [];

    for (const refPath of referencingFilePaths) {
      try {
        const { dependencies } = await this.spider.getSymbolGraph(refPath);
        for (const dep of dependencies) {
          if (normalizePath(dep.targetFilePath) === normalizedTarget) {
            // Reconstruct targetSymbolId with the normalised path so it
            // matches the current file's symbol IDs
            const symbolName = dep.targetSymbolId.split(":").pop() ?? "";
            incoming.push({
              ...dep,
              targetSymbolId: `${normalizedTarget}:${symbolName}`,
            });
          }
        }
      } catch {
        // Skip files that fail to analyse
      }
    }

    return incoming;
  }

  /**
   * Enrich incoming dependencies with cross-file callers from the call graph
   * SQLite database. Mutates the `incomingDependencies` array in place,
   * deduplicating against existing entries.
   */
  private enrichWithCallGraphCallers(
    incomingDependencies: SymbolDependency[],
    targetFilePath: string,
    symbols: SymbolInfo[],
  ): void {
    if (!this.callGraphQuery?.isIndexed()) return;

    // Only query top-level exported symbols to limit DB load
    const exportedSymbols = symbols
      .filter((s) => s.isExported && !s.parentSymbolId);
    const exportedNames = exportedSymbols.map((s) => s.name);

    if (exportedNames.length === 0) return;

    try {
      const externalCallers = this.callGraphQuery.findExternalCallers(
        targetFilePath,
        exportedNames,
      );

      if (externalCallers.length === 0) return;

      const normalizedTarget = normalizePath(targetFilePath);

      // Build set of valid exported symbol IDs to guard against name collisions
      // (e.g., a top-level function and a class method sharing the same bare name)
      const exportedIdSet = new Set(
        exportedSymbols.map((s) => `${normalizedTarget}:${s.name}`),
      );

      // Build dedup set from existing incoming deps
      const existingKeys = new Set(
        incomingDependencies.map(
          (d) => `${d.sourceSymbolId}\0${d.targetSymbolId}`,
        ),
      );

      for (const caller of externalCallers) {
        const sourceId = `${caller.callerFilePath}:${caller.callerName}`;
        const targetId = `${normalizedTarget}:${caller.targetSymbolName}`;

        // Skip if the target doesn't match an actual exported symbol
        if (!exportedIdSet.has(targetId)) continue;

        const key = `${sourceId}\0${targetId}`;

        if (!existingKeys.has(key)) {
          existingKeys.add(key);
          incomingDependencies.push({
            sourceSymbolId: sourceId,
            targetSymbolId: targetId,
            targetFilePath: caller.callerFilePath,
            relationType: "call",
          });
        }
      }

      this.logger.debug(
        `Call graph enrichment: ${externalCallers.length} external callers found`,
      );
    } catch (err) {
      this.logger.warn(`Failed to query call graph for external callers: ${err}`);
    }
  }
}
