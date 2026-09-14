import type { Edge, Node } from 'reactflow';
import type { GraphData, GraphNodeMetadata } from '../../shared/types';
import { communityColor } from './communityColor';
import { normalizePath } from './path';

export function communitySelectionKey(metadata?: GraphNodeMetadata): string {
  return metadata?.communityKey === undefined
    ? `legacy:${metadata?.communityId ?? 0}`
    : `domain:${metadata.communityKey}`;
}

export function collectFileCommunities(nodes: Node[], metadata: GraphData['nodeMetadata']) {
  const groups = new Map<string, { key: string; id: number; label: string; color: string; count: number }>();
  for (const node of nodes) {
    const meta = metadata?.[normalizePath(node.id)];
    const key = communitySelectionKey(meta);
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
    } else {
      const id = meta?.communityId ?? 0;
      groups.set(key, {
        key, id, count: 1,
        label: meta?.communityKey || (id ? `Cluster ${id}` : 'Ungrouped'),
        color: communityColor(id),
      });
    }
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Presentation only: never feed visibility/focus back into layout or graph diffing. */
export function presentFileGraph(
  nodes: Node[], edges: Edge[], metadata: GraphData['nodeMetadata'],
  excluded: ReadonlySet<string>, filterCommunities: boolean, selectedEdgeId: string | null,
): { nodes: Node[]; edges: Edge[]; selectedEdgeId: string | null; visibleCount: number } {
  const visible = new Set(nodes.filter(node => !node.hidden &&
    (!filterCommunities || !excluded.has(communitySelectionKey(metadata?.[normalizePath(node.id)]))))
    .map(node => node.id));
  const availableEdges = edges.filter(edge => !edge.hidden && visible.has(edge.source) && visible.has(edge.target));
  const selected = availableEdges.find(edge => edge.id === selectedEdgeId);
  const relatedNodes = new Set<string>();
  const relatedEdges = new Set<string>();
  if (selected) {
    relatedNodes.add(selected.source);
    relatedNodes.add(selected.target);
    for (const edge of availableEdges) {
      if (edge.source === selected.source || edge.target === selected.source ||
          edge.source === selected.target || edge.target === selected.target) {
        relatedNodes.add(edge.source);
        relatedNodes.add(edge.target);
        relatedEdges.add(edge.id);
      }
    }
  }
  return {
    selectedEdgeId: selected?.id ?? null,
    visibleCount: visible.size,
    nodes: nodes.map(node => ({
      ...node, hidden: !visible.has(node.id),
      style: selected && !relatedNodes.has(node.id)
        ? { ...node.style, opacity: 0.25 * Number(node.style?.opacity ?? 1) }
        : node.style,
    })),
    edges: edges.map(edge => {
      const dimmed = selected && !relatedEdges.has(edge.id);
      return {
        ...edge,
        hidden: edge.hidden || !visible.has(edge.source) || !visible.has(edge.target),
        selected: edge.id === selected?.id,
        interactionWidth: 24,
        focusable: true,
        animated: dimmed ? false : edge.animated,
        style: {
          ...edge.style,
          ...(dimmed ? { opacity: 0.2 * Number(edge.style?.opacity ?? 1) } : {}),
          ...(relatedEdges.has(edge.id) ? { strokeWidth: edge.id === selected?.id ? 4 : Math.max(2.5, Number(edge.style?.strokeWidth) || 0) } : {}),
        },
        labelStyle: dimmed ? { ...edge.labelStyle, opacity: 0.2 } : edge.labelStyle,
        labelBgStyle: dimmed ? { ...edge.labelBgStyle, opacity: 0.2 } : edge.labelBgStyle,
      };
    }),
  };
}
