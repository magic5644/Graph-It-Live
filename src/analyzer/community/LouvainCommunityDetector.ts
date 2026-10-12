import path from 'node:path';
import { normalizePath } from '../../shared/path.js';
import type { CommunityGraph, CommunityResult } from './types.js';

/** Undirected weighted graph of one Louvain level; every edge appears in both neighbor lists. */
interface LevelGraph {
  neighbors: number[][];
  weights: number[][];
  selfLoops: number[];
  degrees: number[];
}

// Moves must beat staying put by more than float noise, otherwise local moving can oscillate.
const MIN_GAIN = 1e-12;

/**
 * Deterministic Louvain: local moving by modularity gain, then aggregation, repeated
 * until no node moves. Nodes are visited in sorted ID order and ties keep the current
 * community, so the same graph always gives the same assignments, whatever input order.
 * Isolated nodes get community 0; others get 1..count, largest community first.
 */
export function detectLouvainCommunities(graph: CommunityGraph): CommunityResult {
  const ids = [...new Set(graph.nodes.map(node => normalizePath(node)))].sort(compareIds);
  const indexById = new Map(ids.map((id, index) => [id, index]));
  const adjacency = ids.map(() => new Map<number, number>());
  const selfLoops = ids.map(() => 0);
  for (const edge of graph.edges) {
    const source = indexById.get(normalizePath(edge.source));
    const target = indexById.get(normalizePath(edge.target));
    const weight = edge.weight ?? 1;
    if (source === undefined || target === undefined || !Number.isFinite(weight) || weight <= 0) continue;
    if (source === target) {
      selfLoops[source] += weight;
      continue;
    }
    adjacency[source].set(target, (adjacency[source].get(target) ?? 0) + weight);
    adjacency[target].set(source, (adjacency[target].get(source) ?? 0) + weight);
  }

  let level = toLevelGraph(adjacency, selfLoops);
  const originalDegrees = level.degrees;
  const totalWeight = originalDegrees.reduce((total, degree) => total + degree, 0);
  let membership = ids.map((_id, index) => index);
  while (totalWeight > 0) {
    const moved = moveNodes(level, totalWeight);
    if (moved === undefined) break;
    membership = membership.map(node => moved.community[node]);
    level = aggregate(level, moved.community, moved.count);
  }

  return toResult(ids, membership, originalDegrees);
}

/**
 * Names a community after the folder holding the most members (ties: first folder in
 * sorted order), or after its hub when that folder is the workspace root or unknown.
 */
export function labelCommunity(memberPaths: readonly string[], hubLabel: string): string {
  const folderCounts = new Map<string, number>();
  for (const memberPath of memberPaths) {
    const folder = path.posix.dirname(normalizePath(memberPath));
    folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
  }
  let dominant = '.';
  let dominantCount = 0;
  for (const [folder, count] of [...folderCounts].sort(([left], [right]) => compareIds(left, right))) {
    if (count > dominantCount) {
      dominant = folder;
      dominantCount = count;
    }
  }
  return dominant === '.' ? hubLabel : dominant;
}

// Code-unit order, not localeCompare: assignments must not depend on the host locale.
function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function toLevelGraph(adjacency: Map<number, number>[], selfLoops: number[]): LevelGraph {
  const neighbors: number[][] = [];
  const weights: number[][] = [];
  const degrees: number[] = [];
  adjacency.forEach((links, node) => {
    const sorted = [...links].sort(([left], [right]) => left - right);
    neighbors.push(sorted.map(([neighbor]) => neighbor));
    weights.push(sorted.map(([, weight]) => weight));
    degrees.push(sorted.reduce((total, [, weight]) => total + weight, 2 * selfLoops[node]));
  });
  return { neighbors, weights, selfLoops, degrees };
}

/** Mutable state of one local-moving phase. */
interface MovePhase {
  graph: LevelGraph;
  totalWeight: number;
  community: number[];
  totals: number[];
  linkWeights: Float64Array;
}

/** One local-moving phase; returns undefined when no node changed community. */
function moveNodes(graph: LevelGraph, totalWeight: number): { community: number[]; count: number } | undefined {
  const phase: MovePhase = {
    graph,
    totalWeight,
    community: graph.degrees.map((_degree, node) => node),
    totals: [...graph.degrees],
    linkWeights: new Float64Array(graph.degrees.length),
  };
  let movedAny = false;
  let moved = true;
  while (moved) {
    moved = false;
    for (let node = 0; node < graph.degrees.length; node += 1) {
      if (moveNode(phase, node)) moved = true;
    }
    movedAny ||= moved;
  }
  return movedAny ? renumber(phase.community) : undefined;
}

/** Moves `node` to the neighbor community with the best modularity gain; true when it moved. */
function moveNode(phase: MovePhase, node: number): boolean {
  const { graph, community, totals, linkWeights, totalWeight } = phase;
  const degree = graph.degrees[node];
  if (degree === 0) return false;
  const current = community[node];
  totals[current] -= degree;
  const touched: number[] = [];
  graph.neighbors[node].forEach((neighbor, index) => {
    const neighborCommunity = community[neighbor];
    if (linkWeights[neighborCommunity] === 0) touched.push(neighborCommunity);
    linkWeights[neighborCommunity] += graph.weights[node][index];
  });

  let best = current;
  let bestGain = linkWeights[current] - totals[current] * degree / totalWeight;
  for (const candidate of touched) {
    const gain = linkWeights[candidate] - totals[candidate] * degree / totalWeight;
    if (gain > bestGain + MIN_GAIN) {
      best = candidate;
      bestGain = gain;
    }
    linkWeights[candidate] = 0;
  }
  totals[best] += degree;
  community[node] = best;
  return best !== current;
}

/** Renumbers communities 0..count-1 in order of first member. */
function renumber(community: number[]): { community: number[]; count: number } {
  const ids = new Map<number, number>();
  for (const id of community) {
    if (!ids.has(id)) ids.set(id, ids.size);
  }
  return { community: community.map(id => ids.get(id) as number), count: ids.size };
}

function aggregate(graph: LevelGraph, community: number[], count: number): LevelGraph {
  const adjacency = Array.from({ length: count }, () => new Map<number, number>());
  const selfLoops = Array.from({ length: count }, () => 0);
  graph.neighbors.forEach((neighbors, node) => {
    const source = community[node];
    selfLoops[source] += graph.selfLoops[node];
    neighbors.forEach((neighbor, index) => {
      const target = community[neighbor];
      const weight = graph.weights[node][index];
      // Internal edges are listed from both endpoints: count half from each side.
      if (source === target) selfLoops[source] += weight / 2;
      else adjacency[source].set(target, (adjacency[source].get(target) ?? 0) + weight);
    });
  });
  return toLevelGraph(adjacency, selfLoops);
}

function toResult(ids: string[], membership: number[], degrees: number[]): CommunityResult {
  const members = new Map<number, number[]>();
  membership.forEach((group, node) => {
    if (degrees[node] === 0) return;
    const list = members.get(group);
    if (list) list.push(node);
    else members.set(group, [node]);
  });
  // Members are pushed in sorted ID order, so list[0] is each community's smallest ID.
  const ordered = [...members.values()].sort((left, right) => right.length - left.length || left[0] - right[0]);
  const assignments = new Map(ids.map(id => [id, 0]));
  ordered.forEach((list, index) => {
    for (const node of list) assignments.set(ids[node], index + 1);
  });
  return { assignments, count: ordered.length };
}
