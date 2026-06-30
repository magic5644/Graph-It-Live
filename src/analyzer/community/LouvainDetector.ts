import { normalizePath } from '../../shared/path.js';
import type { CommunityGraph, CommunityResult } from './types.js';

export function detectCommunities(graph: CommunityGraph): CommunityResult {
  const nodes = graph.nodes.map(n => normalizePath(n));
  const edges = graph.edges.map(e => ({
    source: normalizePath(e.source),
    target: normalizePath(e.target),
  }));

  // Build adjacency: undirected (import graph treated as undirected for modularity)
  const adj = new Map<string, Set<string>>();
  for (const n of nodes) adj.set(n, new Set());
  for (const e of edges) {
    adj.get(e.source)?.add(e.target);
    adj.get(e.target)?.add(e.source);
  }

  // Init: each node in its own community (1-indexed, 0 reserved for isolated)
  const assignments = new Map<string, number>();
  let nextId = 1;
  for (const n of nodes) {
    if ((adj.get(n)?.size ?? 0) === 0) {
      assignments.set(n, 0); // isolated
    } else {
      assignments.set(n, nextId++);
    }
  }

  const totalEdges = edges.length;
  if (totalEdges === 0) {
    return { assignments, count: 0 };
  }

  // Degree map
  const degree = new Map<string, number>();
  for (const n of nodes) degree.set(n, adj.get(n)?.size ?? 0);

  // Phase 1: local modularity optimization
  // Iterate until no improvement (max 100 passes)
  for (let pass = 0; pass < 100; pass++) {
    let improved = false;
    // Deterministic order (sorted for reproducibility)
    const ordered = [...nodes].filter(n => assignments.get(n) !== 0).sort();

    for (const node of ordered) {
      const currentComm = assignments.get(node)!;
      const neighbors = adj.get(node) ?? new Set<string>();

      // Count edges to each neighboring community
      const commEdges = new Map<number, number>();
      for (const nb of neighbors) {
        const c = assignments.get(nb)!;
        if (c !== 0) commEdges.set(c, (commEdges.get(c) ?? 0) + 1);
      }

      // Find best community (max edges = greedy modularity proxy)
      let bestComm = currentComm;
      let bestScore = commEdges.get(currentComm) ?? 0;
      for (const [c, count] of commEdges) {
        if (count > bestScore) { bestComm = c; bestScore = count; }
      }

      if (bestComm !== currentComm) {
        assignments.set(node, bestComm);
        improved = true;
      }
    }

    if (!improved) break;
  }

  // Remap community ids to contiguous 1-indexed
  const remapOld = new Set<number>();
  for (const v of assignments.values()) if (v !== 0) remapOld.add(v);
  const remap = new Map<number, number>();
  let idx = 1;
  for (const old of [...remapOld].sort((a, b) => a - b)) remap.set(old, idx++);

  for (const [k, v] of assignments) {
    if (v !== 0) assignments.set(k, remap.get(v)!);
  }

  const count = remap.size;
  return { assignments, count };
}
