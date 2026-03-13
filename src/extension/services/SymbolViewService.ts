import { LspCallHierarchyAnalyzer } from "../../analyzer/LspCallHierarchyAnalyzer";
import { Spider } from "../../analyzer/Spider";
import { convertSpiderToLspFormat } from "../../shared/converters";
import { normalizePath } from "../../shared/path";
import type { IntraFileGraph, SymbolDependency, SymbolInfo } from "../../shared/types";

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
  constructor(
    private readonly spider: Spider,
    private readonly logger: Logger,
  ) { }

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
      .filter((s) => s.parentSymbolId)
      .forEach((s) =>
        edges.push({
          source: s.parentSymbolId!,
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
}
