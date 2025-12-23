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
    
    // Process edges in parallel with a concurrency limit if needed, 
    // but here we just use Promise.all as the worker can handle queueing.
    // However, thousands of messages might overload it.
    // For now, simple implementation.
    
    const checks = await Promise.all(
      graphData.edges.map(async (edge) => {
        const isUsed = await this.spider.verifyDependencyUsage(edge.source, edge.target);
        return { edge, isUsed };
      })
    );

    for (const { edge, isUsed } of checks) {
      if (!isUsed) {
        // ID format matches buildGraph.ts: `${edge.source}->${edge.target}`
        // Ideally we should use a shared helper for ID generation
        // Note: verifyDependencyUsage takes raw paths, but edge.source/target from crawl are usually normalized.
        // We assume they match what buildGraph uses (normalized).
        unusedEdges.push(`${edge.source}->${edge.target}`);
      }
    }

    if (unusedEdges.length > 0) {
      graphData.unusedEdges = unusedEdges;
      this.logger.info(`Found ${unusedEdges.length} unused edges`);
    }
  }
}
