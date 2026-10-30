import { Spider } from '../../analyzer/Spider';
import { computeNodeMetadata } from '../../analyzer/NodeMetadataBuilder';
import { normalizePath } from '../../shared/path';
import { mapWithConcurrency } from '../../shared/concurrency';
import type { UnusedAnalysisCache } from './UnusedAnalysisCache';

type Logger = {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  debug: (message: string, ...args: unknown[]) => void;
};

import type { CommunityMode, GraphData } from '../../shared/types';

export interface GraphViewServiceConfig {
  unusedAnalysisConcurrency: number;
  unusedAnalysisMaxEdges: number;
}

export class GraphViewService {
  constructor(
    private readonly spider: Spider,
    private readonly logger: Logger,
    private readonly config: GraphViewServiceConfig,
    private readonly unusedCache?: UnusedAnalysisCache,
    private readonly getCommunityMode: () => CommunityMode = () => 'path'
  ) {}

  async buildGraphData(
    filePath: string,
    checkUsage: boolean = false,
    existingGraphData?: GraphData,
    referencingFiles?: Set<string>
  ): Promise<GraphData> {
    const graphData = existingGraphData ?? await this.spider.crawl(filePath);
    if (!existingGraphData) {
      this.logger.info('Crawl completed:', graphData.nodes.length, 'nodes,', graphData.edges.length, 'edges');
    }

    if (graphData.nodes.length === 0) {
      this.logger.warn('No nodes found for', filePath);
    } else if (graphData.edges.length === 0) {
      this.logger.warn('No edges found despite', graphData.nodes.length, 'nodes');
      this.logger.debug('Nodes:', graphData.nodes);
    }

    // Apply symbol-based filtering if referencingFiles is set
    let filteredNodes = graphData.nodes;
    let filteredEdges = graphData.edges;

    if (referencingFiles && referencingFiles.size > 0) {
      this.logger.debug('Filtering graph to', referencingFiles.size, 'referencing files');

      // Filter nodes to only include files that reference the selected symbol
      filteredNodes = graphData.nodes.filter(node => referencingFiles.has(node));

      // Filter edges to only include those between referencing files
      filteredEdges = graphData.edges.filter(edge =>
        referencingFiles.has(edge.source) && referencingFiles.has(edge.target)
      );

      this.logger.info(
        'Symbol filtering applied:',
        filteredNodes.length,
        'nodes,',
        filteredEdges.length,
        'edges (from',
        graphData.nodes.length,
        '/',
        graphData.edges.length,
        ')'
      );
    }

    const enrichedData: GraphData = {
      nodes: filteredNodes,
      edges: filteredEdges,
      nodeLabels: graphData.nodeLabels,
    };

    if (checkUsage) {
      await this.populateUnusedEdges(enrichedData);
    }

    if (await this.hasParentCounts()) {
      await this.populateParentCounts(enrichedData);
    }

    // Compute per-node metadata (hubScore, fileExtension) from parentCounts.
    // computeNodeMetadata is pure — no FS reads, no vscode imports.
    computeNodeMetadata(enrichedData, this.spider.workspaceRoot, this.getCommunityMode());

    return enrichedData;
  }

  private async hasParentCounts(): Promise<boolean> {
    return this.spider.hasReverseIndex();
  }

  private async populateParentCounts(graphData: GraphData): Promise<void> {
    const parentCounts: Record<string, number> = {};
    for (const node of graphData.nodes) {
      const count = this.spider.getCallerCount(node);
      if (count > 0) {
        parentCounts[normalizePath(node)] = count;
      }
    }

    if (Object.keys(parentCounts).length > 0) {
      graphData.parentCounts = parentCounts;
    }
  }

  private async populateUnusedEdges(
    graphData: GraphData,
    onProgress?: (current: number, total: number) => void
  ): Promise<void> {
    // Check if graph exceeds threshold
    if (this.shouldSkipAnalysis(graphData.edges.length)) {
      return;
    }
    
    // Group edges by source file
    const edgesBySource = this.groupEdgesBySource(graphData.edges);
    this.logger.info(`Analyzing ${edgesBySource.size} source files for unused edges (${graphData.edges.length} total edges)`);

    // Analyze in batches with configurable concurrency
    const unusedEdges = await this.analyzeBatches(edgesBySource, onProgress);

    this.logAnalysisResults(unusedEdges.length, graphData.edges.length);
    if (unusedEdges.length > 0) {
      graphData.unusedEdges = unusedEdges;
    }
  }

  private shouldSkipAnalysis(edgeCount: number): boolean {
    if (this.config.unusedAnalysisMaxEdges > 0 && edgeCount > this.config.unusedAnalysisMaxEdges) {
      this.logger.warn(
        `Skipping unused analysis: ${edgeCount} edges exceeds threshold of ${this.config.unusedAnalysisMaxEdges}. ` +
        `Use toolbar button for manual analysis or increase graph-it-live.unusedAnalysisMaxEdges setting.`
      );
      return true;
    }
    return false;
  }

  private groupEdgesBySource(edges: Array<{ source: string; target: string }>): Map<string, Array<{ source: string; target: string }>> {
    const edgesBySource = new Map<string, Array<{ source: string; target: string }>>();
    for (const edge of edges) {
      const group = edgesBySource.get(edge.source) || [];
      group.push(edge);
      edgesBySource.set(edge.source, group);
    }
    return edgesBySource;
  }

  private async analyzeBatches(
    edgesBySource: Map<string, Array<{ source: string; target: string }>>,
    onProgress?: (current: number, total: number) => void
  ): Promise<string[]> {
    const unusedEdges: string[] = [];
    const CONCURRENCY = this.config.unusedAnalysisConcurrency;
    const sourceFiles = Array.from(edgesBySource.keys());
    let processedFiles = 0;
    
    // Bounded pool: a slow file no longer holds back a whole batch; results stay in source order.
    const allResults = await mapWithConcurrency(sourceFiles, CONCURRENCY, async (sourceFile) => {
      const results = await this.analyzeSourceFile(sourceFile, edgesBySource.get(sourceFile) ?? []);
      processedFiles = this.reportProgress(processedFiles + 1, sourceFiles.length, onProgress);
      return results;
    });

    for (const results of allResults) {
      for (const { edge, isUsed } of results) {
        if (!isUsed) {
          unusedEdges.push(`${edge.source}->${edge.target}`);
        }
      }
    }

    return unusedEdges;
  }

  private async analyzeSourceFile(
    sourceFile: string,
    edges: Array<{ source: string; target: string }>
  ): Promise<Array<{ edge: { source: string; target: string }; isUsed: boolean }>> {
    const targetFiles = edges.map(e => e.target);
    
    try {
      const usageMap = await this.getUsageMap(sourceFile, targetFiles);
      return edges.map(edge => ({ edge, isUsed: usageMap.get(edge.target) ?? true }));
    } catch (error) {
      this.logger.warn(`Failed to analyze ${sourceFile}, assuming all edges used:`, error);
      return edges.map(edge => ({ edge, isUsed: true }));
    }
  }

  private async getUsageMap(sourceFile: string, targetFiles: string[]): Promise<Map<string, boolean>> {
    // Try cache first
    let usageMap = await this.unusedCache?.get(sourceFile, targetFiles) ?? null;
    
    if (usageMap) {
      this.logger.debug(`Cache hit for ${sourceFile} (${targetFiles.length} targets)`);
      return usageMap;
    }

    // Cache miss - perform analysis
    usageMap = await this.spider.verifyDependencyUsageBatch(sourceFile, targetFiles);
    
    // Store in cache
    if (this.unusedCache && usageMap.size > 0) {
      await this.unusedCache.set(sourceFile, usageMap);
    }

    return usageMap;
  }

  private reportProgress(processed: number, total: number, onProgress?: (current: number, total: number) => void): number {
    const count = Math.min(processed, total);
    this.logger.debug(`Progress: ${count}/${total} source files analyzed`);
    onProgress?.(count, total);
    return count;
  }

  private logAnalysisResults(unusedCount: number, totalCount: number): void {
    if (unusedCount > 0) {
      this.logger.info(`Found ${unusedCount} unused edges out of ${totalCount} total`);
    } else {
      this.logger.info(`All ${totalCount} edges are in use`);
    }
  }
}
