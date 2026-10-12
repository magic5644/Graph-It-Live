import type {
  GraphContextConfidence,
  GraphContextEdge,
  GraphContextNode,
  GraphContextNodeKind,
  GraphContextRelation,
  GraphContextSnapshot,
} from '@/shared/graph-context-types';
import { normalizePath } from '@/shared/path';
import { detectLouvainCommunities, labelCommunity } from '../community/LouvainCommunityDetector';

export interface GraphContextGraphStats {
  nodeCount: number;
  edgeCount: number;
  communityCount: number;
  relationCounts: Partial<Record<GraphContextRelation, number>>;
  nodeKindCounts: Partial<Record<GraphContextNodeKind, number>>;
  confidenceCounts: Partial<Record<GraphContextConfidence, number>>;
}

export interface GraphContextHub {
  node: GraphContextNode;
  communityId: number;
  inDegree: number;
  outDegree: number;
  totalDegree: number;
}

export interface GraphContextCommunity {
  id: number;
  /** Dominant folder of the members, else the path of the hub. */
  label: string;
  nodes: GraphContextNode[];
  edges: GraphContextEdge[];
}

export class GraphContextCommunities {
  readonly graphStats: GraphContextGraphStats;
  private readonly assignments: Map<string, number>;
  private readonly nodes: GraphContextNode[];
  private readonly edges: GraphContextEdge[];
  private readonly degrees = new Map<string, { incoming: number; outgoing: number }>();

  constructor(snapshot: GraphContextSnapshot) {
    this.nodes = [...snapshot.nodes].sort((left, right) => left.id.localeCompare(right.id));
    this.edges = [...snapshot.edges].sort(compareEdges);
    const detected = detectLouvainCommunities({
      nodes: this.nodes.map(node => node.id),
      edges: this.edges,
    });
    this.assignments = new Map(this.nodes.map(node => [
      node.id,
      detected.assignments.get(normalizePath(node.id)) ?? 0,
    ]));

    const relationCounts: Partial<Record<GraphContextRelation, number>> = {};
    const nodeKindCounts: Partial<Record<GraphContextNodeKind, number>> = {};
    const confidenceCounts: Partial<Record<GraphContextConfidence, number>> = {};
    for (const node of this.nodes) increment(nodeKindCounts, node.kind);
    for (const edge of this.edges) {
      increment(relationCounts, edge.relation);
      increment(confidenceCounts, edge.confidence);
      const sourceDegree = this.degrees.get(edge.source) ?? { incoming: 0, outgoing: 0 };
      sourceDegree.outgoing += 1;
      this.degrees.set(edge.source, sourceDegree);
      const targetDegree = this.degrees.get(edge.target) ?? { incoming: 0, outgoing: 0 };
      targetDegree.incoming += 1;
      this.degrees.set(edge.target, targetDegree);
    }
    this.graphStats = {
      nodeCount: this.nodes.length,
      edgeCount: this.edges.length,
      communityCount: detected.count,
      relationCounts,
      nodeKindCounts,
      confidenceCounts,
    };
  }

  topHubs(limit = 10, includeExternal = false): GraphContextHub[] {
    return this.nodes
      .filter(node => includeExternal || node.kind !== 'external')
      .map(node => {
        const nodeDegree = this.degrees.get(node.id) ?? { incoming: 0, outgoing: 0 };
        return {
          node,
          communityId: this.assignments.get(node.id) ?? 0,
          inDegree: nodeDegree.incoming,
          outDegree: nodeDegree.outgoing,
          totalDegree: nodeDegree.incoming + nodeDegree.outgoing,
        };
      })
      .sort((left, right) => right.totalDegree - left.totalDegree || left.node.id.localeCompare(right.node.id))
      .slice(0, Math.max(0, Math.floor(limit)));
  }

  private totalDegree(node: GraphContextNode): number {
    const nodeDegree = this.degrees.get(node.id);
    return nodeDegree === undefined ? 0 : nodeDegree.incoming + nodeDegree.outgoing;
  }

  getCommunity(communityId: number): GraphContextCommunity | undefined {
    const nodes = this.nodes.filter(node => this.assignments.get(node.id) === communityId);
    if (nodes.length === 0) return undefined;
    const nodeIds = new Set(nodes.map(node => node.id));
    const hub = nodes.reduce((best, node) => (this.totalDegree(node) > this.totalDegree(best) ? node : best), nodes[0]);
    return {
      id: communityId,
      label: labelCommunity(
        nodes.flatMap(node => (node.path === undefined ? [] : [node.path])),
        hub.path ?? hub.name,
      ),
      nodes,
      edges: this.edges.filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
    };
  }
}

function increment<Key extends string>(counts: Partial<Record<Key, number>>, key: Key): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function compareEdges(left: GraphContextEdge, right: GraphContextEdge): number {
  return [left.source, left.target, left.relation, left.confidence]
    .join('\u0000')
    .localeCompare([right.source, right.target, right.relation, right.confidence].join('\u0000'));
}
