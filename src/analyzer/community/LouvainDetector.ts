import { normalizePath } from '../../shared/path.js';
import type { CommunityGraph, CommunityResult } from './types.js';

function buildAdjacency(nodes: string[], edges: Array<{ source: string; target: string }>): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const n of nodes) adj.set(n, new Set());

  for (const e of edges) {
    adj.get(e.source)?.add(e.target);
    adj.get(e.target)?.add(e.source);
  }

  return adj;
}

function initializeAssignments(nodes: string[], adj: Map<string, Set<string>>): Map<string, number> {
  const assignments = new Map<string, number>();
  let nextId = 1;

  for (const n of nodes) {
    if ((adj.get(n)?.size ?? 0) === 0) {
      assignments.set(n, 0);
      continue;
    }

    assignments.set(n, nextId++);
  }

  return assignments;
}

function optimizeAssignments(nodes: string[], adj: Map<string, Set<string>>, assignments: Map<string, number>): void {
  for (let pass = 0; pass < 100; pass++) {
    let improved = false;
    const ordered = [...nodes]
      .filter(node => assignments.get(node) !== 0)
      .sort((a, b) => a.localeCompare(b));

    for (const node of ordered) {
      const currentComm = assignments.get(node)!;
      const neighbors = adj.get(node) ?? new Set<string>();
      const commEdges = new Map<number, number>();

      for (const neighbor of neighbors) {
        const communityId = assignments.get(neighbor)!;
        if (communityId !== 0) {
          commEdges.set(communityId, (commEdges.get(communityId) ?? 0) + 1);
        }
      }

      const bestCommunity = getBestCommunity(currentComm, commEdges);
      if (bestCommunity !== currentComm) {
        assignments.set(node, bestCommunity);
        improved = true;
      }
    }

    if (!improved) break;
  }
}

function getBestCommunity(currentCommunity: number, commEdges: Map<number, number>): number {
  let bestComm = currentCommunity;
  let bestScore = commEdges.get(currentCommunity) ?? 0;

  for (const [communityId, count] of commEdges) {
    if (count > bestScore) {
      bestComm = communityId;
      bestScore = count;
    }
  }

  return bestComm;
}

function remapCommunityIds(assignments: Map<string, number>): { assignments: Map<string, number>; count: number } {
  const remapOld = new Set<number>();
  for (const value of assignments.values()) {
    if (value !== 0) remapOld.add(value);
  }

  const remap = new Map<number, number>();
  let idx = 1;
  for (const oldId of [...remapOld].sort((a, b) => a - b)) {
    remap.set(oldId, idx++);
  }

  for (const [key, value] of assignments) {
    if (value !== 0) assignments.set(key, remap.get(value)!);
  }

  return { assignments, count: remap.size };
}

export function detectCommunities(graph: CommunityGraph): CommunityResult {
  const nodes = graph.nodes.map(name => normalizePath(name));
  const edges = graph.edges.map(edge => ({
    source: normalizePath(edge.source),
    target: normalizePath(edge.target),
  }));

  const adjacency = buildAdjacency(nodes, edges);
  const assignments = initializeAssignments(nodes, adjacency);

  if (edges.length === 0) {
    return { assignments, count: 0 };
  }

  optimizeAssignments(nodes, adjacency, assignments);
  return remapCommunityIds(assignments);
}
