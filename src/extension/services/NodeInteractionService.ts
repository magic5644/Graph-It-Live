import { Spider } from '../../analyzer/Spider';

type Logger = {
  debug: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
};

export interface NodeExpansionResult {
  command: 'expandedGraph';
  nodeId: string;
  data: Awaited<ReturnType<Spider['crawlFrom']>>;
}

export interface ReferencingFilesResult {
  command: 'referencingFiles';
  nodeId: string;
  data: {
    nodes: string[];
    edges: { source: string; target: string }[];
    parentCounts?: Record<string, number>;
  };
}

export class NodeInteractionService {
  constructor(
    private readonly spider: Spider,
    private readonly logger: Logger
  ) {}

  async expandNode(nodeId: string, knownNodes: string[] | undefined): Promise<NodeExpansionResult> {
    this.logger.debug('Expanding node', nodeId);
    const knownNodesSet = new Set(knownNodes || []);
    const newGraphData = await this.spider.crawlFrom(nodeId, knownNodesSet, 10);
    return {
      command: 'expandedGraph',
      nodeId,
      data: newGraphData,
    };
  }

  async getReferencingFiles(nodeId: string): Promise<ReferencingFilesResult> {
    this.logger.debug('Finding referencing files for', nodeId);
    const referencingFiles = await this.spider.findReferencingFiles(nodeId);
    this.logger.debug('Found', referencingFiles.length, 'referencing files');

    const nodes = referencingFiles.map((d) => d.path);
    const edges = referencingFiles.map((d) => ({
      source: d.path,
      target: nodeId,
    }));

    const parentCounts = await this.populateParentCounts(nodes);

    return {
      command: 'referencingFiles',
      nodeId,
      data: {
        nodes,
        edges,
        parentCounts: Object.keys(parentCounts).length > 0 ? parentCounts : undefined,
      },
    };
  }

  private async populateParentCounts(nodes: string[]): Promise<Record<string, number>> {
    if (!this.spider.hasReverseIndex()) {
      return {};
    }

    const parentCounts: Record<string, number> = {};
    await Promise.all(
      nodes.map(async (node) => {
        try {
          const refs = await this.spider.findReferencingFiles(node);
          if (refs && refs.length > 0) {
            parentCounts[node] = refs.length;
          }
        } catch (err) {
          this.logger.debug(
            'Failed to compute parent counts for',
            node,
            err instanceof Error ? err.message : String(err)
          );
        }
      })
    );

    return parentCounts;
  }
}
