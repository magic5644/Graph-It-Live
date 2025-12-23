import type { GraphData } from '../../shared/types';

export function mergeEdgesUnique(
  base: Array<{ source: string; target: string }>,
  incoming: Array<{ source: string; target: string }>
): Array<{ source: string; target: string }> {
  const merged: Array<{ source: string; target: string }> = [...base];
  const seen = new Set<string>(base.map((e) => `${e.source}->${e.target}`));
  for (const edge of incoming) {
    const key = `${edge.source}->${edge.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(edge);
  }
  return merged;
}

export function mergeGraphDataUnion(base: GraphData, incoming: GraphData): GraphData {
  const nodes = Array.from(new Set([...(base.nodes ?? []), ...(incoming.nodes ?? [])]));
  const edges = mergeEdgesUnique(base.edges ?? [], incoming.edges ?? []);

  const labels = { ...base.nodeLabels, ...incoming.nodeLabels };
  const parentCounts = { ...base.parentCounts, ...incoming.parentCounts };

  return {
    nodes,
    edges,
    nodeLabels: Object.keys(labels).length > 0 ? labels : undefined,
    parentCounts: Object.keys(parentCounts).length > 0 ? parentCounts : undefined,
    unusedEdges: [...new Set([...(base.unusedEdges || []), ...(incoming.unusedEdges || [])])],
  };
}

