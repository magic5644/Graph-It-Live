import { Spider } from '../../analyzer/Spider';

type Logger = {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  debug: (message: string, ...args: unknown[]) => void;
};

import type { GraphData } from '../../shared/types';

export class GraphViewService {
  constructor(
    private readonly spider: Spider,
    private readonly logger: Logger
  ) {}

  async buildGraphData(filePath: string, checkUsage: boolean = false): Promise<GraphData> {
    const graphData = await this.spider.crawl(filePath);
    this.logger.info('Crawl completed:', graphData.nodes.length, 'nodes,', graphData.edges.length, 'edges');

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

  private async populateUnusedEdges(graphData: GraphData): Promise<void> {
    const unusedEdges: string[] = [];
    
    // Optimization: Group edges by source file to minimize AST parsing
    // Each source file is only analyzed once using batch API
    const edgesBySource = new Map<string, Array<{ source: string; target: string }>>();
    for (const edge of graphData.edges) {
      const group = edgesBySource.get(edge.source) || [];
      group.push(edge);
      edgesBySource.set(edge.source, group);
    }

    this.logger.info(`Analyzing ${edgesBySource.size} source files for unused edges (${graphData.edges.length} total edges)`);

    // Process source files with concurrency limit to avoid memory explosion
    const CONCURRENCY = 8; // Process 8 source files at a time
    const sourceFiles = Array.from(edgesBySource.keys());
    
    for (let i = 0; i < sourceFiles.length; i += CONCURRENCY) {
      const batch = sourceFiles.slice(i, i + CONCURRENCY);
      
      const batchResults = await Promise.all(
        batch.map(async (sourceFile) => {
          const edges = edgesBySource.get(sourceFile)!;
          const targetFiles = edges.map(e => e.target);
          
          try {
            // OPTIMIZATION: Use batch API to analyze all targets from this source in one AST pass
            const usageMap = await this.spider.verifyDependencyUsageBatch(sourceFile, targetFiles);
            
            const results: Array<{ edge: { source: string; target: string }; isUsed: boolean }> = [];
            for (const edge of edges) {
              const isUsed = usageMap.get(edge.target) ?? true; // Default to used on missing
              results.push({ edge, isUsed });
            }
            return results;
          } catch (error) {
            this.logger.warn(`Failed to analyze ${sourceFile}, assuming all edges used:`, error);
            // On error, mark all as used to be safe
            return edges.map(edge => ({ edge, isUsed: true }));
          }
        })
      );

      // Collect unused edges from this batch
      for (const results of batchResults) {
        for (const { edge, isUsed } of results) {
          if (!isUsed) {
            unusedEdges.push(`${edge.source}->${edge.target}`);
          }
        }
      }
      
      // Progress logging
      const processed = Math.min(i + CONCURRENCY, sourceFiles.length);
      this.logger.debug(`Progress: ${processed}/${sourceFiles.length} source files analyzed`);
    }

    if (unusedEdges.length > 0) {
      graphData.unusedEdges = unusedEdges;
      this.logger.info(`Found ${unusedEdges.length} unused edges out of ${graphData.edges.length} total`);
    } else {
      this.logger.info(`All ${graphData.edges.length} edges are in use`);
    }
  }
}
