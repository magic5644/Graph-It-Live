import type {
  GraphContextConfidence,
  GraphContextEdge,
  GraphContextNode,
  GraphContextNodeKind,
  GraphContextRelation,
  GraphContextSnapshot,
} from '@/shared/graph-context-types';

const MAX_COMMUNITY_PASSES = 100;

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
    const detected = detectFederatedCommunities(this.nodes, this.edges);
    this.assignments = detected.assignments;

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

  getCommunity(communityId: number): GraphContextCommunity | undefined {
    const nodes = this.nodes.filter(node => this.assignments.get(node.id) === communityId);
    if (nodes.length === 0) return undefined;
    const nodeIds = new Set(nodes.map(node => node.id));
    return {
      id: communityId,
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

function detectFederatedCommunities(
  nodes: GraphContextNode[],
  edges: GraphContextEdge[],
): { assignments: Map<string, number>; count: number } {
  const adjacency = new Map(nodes.map(node => [node.id, new Map<string, number>()]));
  for (const edge of edges) {
    if (!adjacency.has(edge.source) || !adjacency.has(edge.target)) continue;
    incrementWeight(adjacency.get(edge.source) as Map<string, number>, edge.target);
    incrementWeight(adjacency.get(edge.target) as Map<string, number>, edge.source);
  }

  const degrees = new Map([...adjacency].map(([id, neighbors]) => (
    [id, [...neighbors.values()].reduce((total, weight) => total + weight, 0)]
  )));
  const assignments = new Map<string, number>();
  const totals = new Map<number, number>();
  let nextCommunityId = 1;
  for (const node of nodes) {
    const nodeDegree = degrees.get(node.id) ?? 0;
    const communityId = nodeDegree === 0 ? 0 : nextCommunityId++;
    assignments.set(node.id, communityId);
    if (communityId > 0) totals.set(communityId, nodeDegree);
  }

  const doubledEdgeWeight = [...degrees.values()].reduce((total, value) => total + value, 0);
  // ponytail: 100 passes bounds worst-case work; raise only if measured large-graph convergence needs it.
  for (let pass = 0; pass < MAX_COMMUNITY_PASSES; pass += 1) {
    let moved = false;
    for (const node of nodes) {
      const nodeDegree = degrees.get(node.id) ?? 0;
      if (nodeDegree === 0) continue;
      const currentCommunity = assignments.get(node.id) as number;
      totals.set(currentCommunity, (totals.get(currentCommunity) ?? 0) - nodeDegree);
      const weightsByCommunity = new Map<number, number>();
      for (const [neighborId, weight] of adjacency.get(node.id) as Map<string, number>) {
        const communityId = assignments.get(neighborId) as number;
        weightsByCommunity.set(communityId, (weightsByCommunity.get(communityId) ?? 0) + weight);
      }

      let bestCommunity = currentCommunity;
      let bestGain = 0;
      for (const [communityId, weight] of [...weightsByCommunity].sort(([left], [right]) => left - right)) {
        const gain = weight - ((totals.get(communityId) ?? 0) * nodeDegree / doubledEdgeWeight);
        if (gain > bestGain) {
          bestCommunity = communityId;
          bestGain = gain;
        }
      }
      assignments.set(node.id, bestCommunity);
      totals.set(bestCommunity, (totals.get(bestCommunity) ?? 0) + nodeDegree);
      moved ||= bestCommunity !== currentCommunity;
    }
    if (!moved) break;
  }

  const canonicalCommunities = new Map<number, string[]>();
  for (const [nodeId, communityId] of assignments) {
    if (communityId === 0) continue;
    const members = canonicalCommunities.get(communityId);
    if (members) members.push(nodeId);
    else canonicalCommunities.set(communityId, [nodeId]);
  }
  const remappedIds = new Map([...canonicalCommunities]
    .sort(([, left], [, right]) => left[0].localeCompare(right[0]))
    .map(([communityId], index) => [communityId, index + 1]));
  for (const [nodeId, communityId] of assignments) {
    if (communityId > 0) assignments.set(nodeId, remappedIds.get(communityId) as number);
  }
  return { assignments, count: remappedIds.size };
}

function incrementWeight(weights: Map<string, number>, key: string): void {
  weights.set(key, (weights.get(key) ?? 0) + 1);
}
