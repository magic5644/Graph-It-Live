import { Spider } from '../../analyzer/Spider';

type Logger = {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  debug: (message: string, ...args: unknown[]) => void;
};

interface GraphData {
  nodes: string[];
  edges: { source: string; target: string }[];
  nodeLabels?: Record<string, string>;
  parentCounts?: Record<string, number>;
}

export class GraphViewService {
  constructor(
    private readonly spider: Spider,
    private readonly logger: Logger
  ) {}

  async buildGraphData(filePath: string): Promise<GraphData> {
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
}
