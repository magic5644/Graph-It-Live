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

export interface ExpansionCallbacks {
  signal?: AbortSignal;
  onBatch?: (
    batch: Awaited<ReturnType<Spider['crawlFrom']>>,
    totals: { nodes: number; edges: number }
  ) => Promise<void> | void;
  totalHint?: number;
}

export class NodeInteractionService {
  constructor(
    private readonly spider: Spider,
    private readonly logger: Logger
  ) {}

  async expandNode(
    nodeId: string,
    knownNodes: string[] | undefined,
    callbacks?: ExpansionCallbacks
  ): Promise<NodeExpansionResult> {
    this.logger.debug('Expanding node', nodeId);
    const knownNodesSet = new Set(knownNodes || []);
    const aggregatedNodes = new Set<string>();
    const aggregatedEdges: { source: string; target: string }[] = [];
    const aggregatedLabels: Record<string, string> = {};

    const edgeIds = new Set<string>();

    const addEdge = (edge: { source: string; target: string }): void => {
      const id = `${edge.source}->${edge.target}`;
      if (edgeIds.has(id)) return;
      edgeIds.add(id);
      aggregatedEdges.push(edge);
    };

    const handleBatch = async (batch: Awaited<ReturnType<Spider['crawlFrom']>>): Promise<void> => {
      batch.nodes.forEach((node) => aggregatedNodes.add(node));
      batch.edges.forEach(addEdge);
      if (batch.nodeLabels) {
        Object.assign(aggregatedLabels, batch.nodeLabels);
      }
      await callbacks?.onBatch?.(batch, { nodes: aggregatedNodes.size, edges: aggregatedEdges.length });
    };

    const newGraphData = await this.spider.crawlFrom(nodeId, knownNodesSet, 10, {
      onBatch: callbacks?.onBatch ? handleBatch : undefined,
      signal: callbacks?.signal,
      totalHint: callbacks?.totalHint,
    });

    // Ensure final batch is captured even if no streaming callback
    await handleBatch(newGraphData);

    return {
      command: 'expandedGraph',
      nodeId,
      data: {
        nodes: Array.from(aggregatedNodes),
        edges: aggregatedEdges,
        nodeLabels: Object.keys(aggregatedLabels).length > 0 ? aggregatedLabels : undefined,
      },
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
    for (const node of nodes) {
      try {
        const count = this.spider.getCallerCount(node);
        if (count > 0) {
          parentCounts[node] = count;
        }
      } catch (err) {
        this.logger.debug(
          'Failed to compute parent counts for',
          node,
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    return parentCounts;
  }
}
