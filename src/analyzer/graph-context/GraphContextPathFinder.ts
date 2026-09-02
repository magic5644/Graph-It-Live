import path from 'node:path';
import { normalizePath } from '@/shared/path';
import type {
  GraphContextNode,
  GraphContextPath,
  GraphContextRelation,
  GraphContextSeed,
  GraphContextSnapshot,
} from '@/shared/graph-context-types';
import { compileFileScope } from './FileScopeMatcher';
import { resolveSeeds } from './GraphContextResolver';

export interface GraphContextPathOptions {
  directed?: boolean;
  maxHops?: number;
  relations?: GraphContextRelation[];
  scope?: string;
}

export function findShortestPath(
  snapshot: GraphContextSnapshot,
  from: GraphContextSeed,
  to: GraphContextSeed,
  options: GraphContextPathOptions = {},
): GraphContextPath | null {
  const fromNode = resolveSeeds(from, snapshot, options.scope).selected;
  const toNode = resolveSeeds(to, snapshot, options.scope).selected;
  if (!fromNode || !toNode) return null;

  if (fromNode.id === toNode.id) {
    return { nodeIds: [fromNode.id], edgeIndexes: [], hops: 0 };
  }

  const maxHops = normalizeMaxHops(options.maxHops, snapshot.nodes.length);
  if (maxHops === 0) return null;

  const allowedNodeIds = getAllowedNodeIds(snapshot.nodes, options.scope);
  const adjacency = buildAdjacency(snapshot, allowedNodeIds, options);
  const queue: QueueEntry[] = [{ nodeId: fromNode.id, hops: 0 }];
  const visited = new Set<string>([fromNode.id]);
  const predecessors = new Map<string, Predecessor>();

  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (current.hops >= maxHops) continue;

    for (const step of adjacency.get(current.nodeId) ?? []) {
      if (visited.has(step.nodeId)) continue;

      visited.add(step.nodeId);
      predecessors.set(step.nodeId, {
        nodeId: current.nodeId,
        edgeIndex: step.edgeIndex,
      });

      if (step.nodeId === toNode.id) {
        return buildPath(fromNode.id, toNode.id, predecessors);
      }

      queue.push({ nodeId: step.nodeId, hops: current.hops + 1 });
    }
  }

  return null;
}

interface QueueEntry {
  nodeId: string;
  hops: number;
}

interface TraversalStep {
  nodeId: string;
  edgeIndex: number;
}

interface Predecessor {
  nodeId: string;
  edgeIndex: number;
}

function normalizeMaxHops(maxHops: number | undefined, nodeCount: number): number {
  if (maxHops === undefined) return nodeCount;
  if (!Number.isFinite(maxHops)) return maxHops === Number.POSITIVE_INFINITY ? nodeCount : 0;
  return Math.max(0, Math.floor(maxHops));
}

function getAllowedNodeIds(nodes: GraphContextNode[], scope: string | undefined): Set<string> {
  if (scope === undefined) return new Set(nodes.map(node => node.id));

  const matcher = compileFileScope('/', scope);
  return new Set(nodes.filter(node => (
    node.path !== undefined
    && matcher.matches(`/${normalizeRelativePath(node.path)}`)
  )).map(node => node.id));
}

function normalizeRelativePath(filePath: string): string {
  return normalizePath(path.posix.normalize(normalizePath(filePath))).replace(/^\.\//, '');
}

function buildAdjacency(
  snapshot: GraphContextSnapshot,
  allowedNodeIds: Set<string>,
  options: GraphContextPathOptions,
): Map<string, TraversalStep[]> {
  const adjacency = new Map<string, TraversalStep[]>();
  const relations = options.relations === undefined
    ? undefined
    : new Set<GraphContextRelation>(options.relations);
  const directed = options.directed ?? true;

  snapshot.edges.forEach((edge, edgeIndex) => {
    if (relations && !relations.has(edge.relation)) return;
    if (!allowedNodeIds.has(edge.source) || !allowedNodeIds.has(edge.target)) return;

    addStep(adjacency, edge.source, { nodeId: edge.target, edgeIndex });
    if (!directed) {
      addStep(adjacency, edge.target, { nodeId: edge.source, edgeIndex });
    }
  });

  for (const steps of adjacency.values()) {
    steps.sort((left, right) => (
      left.nodeId.localeCompare(right.nodeId) || left.edgeIndex - right.edgeIndex
    ));
  }

  return adjacency;
}

function addStep(
  adjacency: Map<string, TraversalStep[]>,
  sourceId: string,
  step: TraversalStep,
): void {
  const steps = adjacency.get(sourceId);
  if (steps) {
    steps.push(step);
  } else {
    adjacency.set(sourceId, [step]);
  }
}

function buildPath(
  fromId: string,
  toId: string,
  predecessors: Map<string, Predecessor>,
): GraphContextPath {
  const reversedNodeIds = [toId];
  const reversedEdgeIndexes: number[] = [];
  let currentId = toId;

  while (currentId !== fromId) {
    const predecessor = predecessors.get(currentId);
    if (!predecessor) break;
    reversedEdgeIndexes.push(predecessor.edgeIndex);
    reversedNodeIds.push(predecessor.nodeId);
    currentId = predecessor.nodeId;
  }

  const edgeIndexes = reversedEdgeIndexes.reverse();
  return {
    nodeIds: reversedNodeIds.reverse(),
    edgeIndexes,
    hops: edgeIndexes.length,
  };
}
