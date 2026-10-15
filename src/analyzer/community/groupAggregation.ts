import type { GraphData } from '../../shared/graph-types.js';
import { normalizePath } from '../../shared/path.js';

export interface CommunityGroup {
  id: number;
  key: string;
  /** Legend label; the communityKey today, kept separate so renderers never parse keys. */
  label: string;
  fileCount: number;
  /** Distinct directed file pairs with both ends in this group. */
  internalEdgeCount: number;
}

export interface CommunityGroupEdge {
  from: number;
  to: number;
  /** Distinct directed file pairs from a file of `from` to a file of `to`. */
  fileEdgeCount: number;
}

export interface CommunityGroupAggregation {
  groups: CommunityGroup[];
  /** Files with communityId 0 (no domain, or isolated under Louvain). */
  unassigned: { fileCount: number; internalEdgeCount: number };
  /** Inter-group edges; group 0 stands for the unassigned files. */
  groupEdges: CommunityGroupEdge[];
  /** intraGroupEdges + interGroupEdges === fileEdges; unassigned→unassigned pairs count as intra. */
  totals: { files: number; fileEdges: number; intraGroupEdges: number; interGroupEdges: number };
}

/**
 * Aggregates the file graph by the communityId already stored in nodeMetadata (path or
 * Louvain detector, see computeNodeMetadata). Counts distinct directed file pairs, so they
 * are independent of the edge weights Louvain uses. Call it on the full graph, before any
 * display cap. Louvain ids are only meaningful within the graph they were computed on.
 *
 * CRITICAL ARCHITECTURE RULE: NO import from 'vscode' — pure Node.js only.
 */
export function aggregateCommunityGroups(graphData: GraphData): CommunityGroupAggregation {
  const communityOf = (filePath: string): number =>
    graphData.nodeMetadata?.[normalizePath(filePath)]?.communityId ?? 0;

  const edges = graphData.edges.map(edge => [normalizePath(edge.source), normalizePath(edge.target)] as const);
  const pairs = new Map(edges.map(pair => [`${pair[0]}\0${pair[1]}`, pair]));
  // Edge ends count as files too, so every pair has both groups and intra + inter adds up.
  const files = new Set([...graphData.nodes.map(normalizePath), ...edges.flat()]);

  const groups = new Map<number, CommunityGroup>();
  let unassignedFiles = 0;
  for (const filePath of files) {
    const id = communityOf(filePath);
    if (id === 0) {
      unassignedFiles += 1;
      continue;
    }
    const group = groups.get(id);
    if (group) {
      group.fileCount += 1;
    } else {
      const key = graphData.nodeMetadata?.[filePath]?.communityKey ?? '';
      groups.set(id, { id, key, label: key, fileCount: 1, internalEdgeCount: 0 });
    }
  }

  const groupEdges = new Map<string, CommunityGroupEdge>();
  let unassignedInternal = 0;
  let interGroupEdges = 0;
  for (const [source, target] of pairs.values()) {
    const from = communityOf(source);
    const to = communityOf(target);
    if (from !== to) {
      interGroupEdges += 1;
      const key = `${from}>${to}`;
      groupEdges.set(key, { from, to, fileEdgeCount: (groupEdges.get(key)?.fileEdgeCount ?? 0) + 1 });
    } else if (from === 0) {
      unassignedInternal += 1;
    } else {
      groups.get(from)!.internalEdgeCount += 1;
    }
  }

  return {
    groups: [...groups.values()].sort((left, right) => left.id - right.id),
    unassigned: { fileCount: unassignedFiles, internalEdgeCount: unassignedInternal },
    groupEdges: [...groupEdges.values()].sort((left, right) => left.from - right.from || left.to - right.to),
    totals: {
      files: files.size,
      fileEdges: pairs.size,
      intraGroupEdges: pairs.size - interGroupEdges,
      interGroupEdges,
    },
  };
}
