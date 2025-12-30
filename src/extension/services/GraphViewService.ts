import { Spider } from '../../analyzer/Spider';
import type { UnusedAnalysisCache } from './UnusedAnalysisCache';

type Logger = {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  debug: (message: string, ...args: unknown[]) => void;
};

import type { GraphData } from '../../shared/types';

export interface GraphViewServiceConfig {
  unusedAnalysisConcurrency: number;
  unusedAnalysisMaxEdges: number;
}

export class GraphViewService {
  constructor(
    private readonly spider: Spider,
    private readonly logger: Logger,
    private readonly config: GraphViewServiceConfig,
    private readonly unusedCache?: UnusedAnalysisCache
  ) {}

  async buildGraphData(filePath: string, checkUsage: boolean = false, existingGraphData?: GraphData): Promise<GraphData> {
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

    const enrichedData: GraphData = {
      nodes: graphData.nodes,
      edges: graphData.edges,
      nodeLabels: graphData.nodeLabels,
    };

    if (checkUsage) {
      await this.populateUnusedEdges(enrichedData);
    }

    if (await this.hasParentCounts()) {
      await this.populateParentCounts(enrichedData);
    }

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
        parentCounts[node] = count;
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
    
    for (let i = 0; i < sourceFiles.length; i += CONCURRENCY) {
      const batch = sourceFiles.slice(i, i + CONCURRENCY);
      const batchResults = await this.processBatch(batch, edgesBySource);

      // Collect unused edges from batch
      for (const results of batchResults) {
        for (const { edge, isUsed } of results) {
          if (!isUsed) {
            unusedEdges.push(`${edge.source}->${edge.target}`);
          }
        }
      }
      
      processedFiles = this.reportProgress(processedFiles + batch.length, sourceFiles.length, onProgress);
    }

    return unusedEdges;
  }

  private async processBatch(
    batch: string[],
    edgesBySource: Map<string, Array<{ source: string; target: string }>>
  ): Promise<Array<Array<{ edge: { source: string; target: string }; isUsed: boolean }>>> {
    return Promise.all(
      batch.map(sourceFile => this.analyzeSourceFile(sourceFile, edgesBySource.get(sourceFile)!))
    );
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
