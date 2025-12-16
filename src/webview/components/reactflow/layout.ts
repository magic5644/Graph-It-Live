import dagre from 'dagre';
import type { Edge, Node } from 'reactflow';
import { Position } from 'reactflow';
import { nodeHeight, minNodeWidth, maxNodeWidth, charWidth } from '../../utils/nodeUtils';
import { normalizePath } from '../../utils/path';

export function calculateNodeWidth(label: string): number {
  const estimatedWidth = label.length * charWidth + 24;
  return Math.max(minNodeWidth, Math.min(maxNodeWidth, estimatedWidth));
}

function fastLayout(nodes: Node[], edges: Edge[], rootId: string): { nodes: Node[]; edges: Edge[] } {
  const root = normalizePath(rootId);
  const children = new Map<string, string[]>();
  edges.forEach((edge) => {
    const source = normalizePath(edge.source);
    const target = normalizePath(edge.target);
    if (!children.has(source)) children.set(source, []);
    children.get(source)!.push(target);
  });

  const depth = new Map<string, number>();
  const queue: string[] = [root];
  depth.set(root, 0);

  for (const current of queue) {
    const currentDepth = depth.get(current) ?? 0;
    const nextDepth = currentDepth + 1;
    for (const child of children.get(current) || []) {
      if (!depth.has(child)) {
        depth.set(child, nextDepth);
        queue.push(child);
      }
    }
  }

  const nodesByDepth = new Map<number, Node[]>();
  const unconnected: Node[] = [];
  for (const node of nodes) {
    const d = depth.get(normalizePath(node.id));
    if (typeof d === 'number') {
      if (!nodesByDepth.has(d)) nodesByDepth.set(d, []);
      nodesByDepth.get(d)!.push(node);
    } else {
      unconnected.push(node);
    }
  }

  const xStep = 260;
  const yStep = nodeHeight + 24;
  const positioned: Node[] = [];
  const sortedDepths = [...nodesByDepth.keys()].sort((a, b) => a - b);
  for (const d of sortedDepths) {
    const group = nodesByDepth.get(d)!;
    group.forEach((node, idx) => {
      positioned.push({
        ...node,
        position: { x: d * xStep, y: idx * yStep },
        targetPosition: Position.Left,
        sourcePosition: Position.Right,
      });
    });
  }

  const maxDepth = sortedDepths.length ? sortedDepths[sortedDepths.length - 1]! : 0;
  const unconnectedX = (maxDepth + 1) * xStep;
  unconnected.forEach((node, idx) => {
    positioned.push({
      ...node,
      position: { x: unconnectedX, y: idx * yStep },
      targetPosition: Position.Left,
      sourcePosition: Position.Right,
    });
  });

  return { nodes: positioned, edges };
}

function dagreLayout(nodes: Node[], edges: Edge[], direction: 'TB' | 'LR' = 'LR'): { nodes: Node[]; edges: Edge[] } {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({ rankdir: direction, nodesep: 30, ranksep: 50, align: 'UL' });

  nodes.forEach((node) => {
    const width = (node.style?.width as number) || minNodeWidth;
    dagreGraph.setNode(node.id, { width, height: nodeHeight });
  });
  edges.forEach((edge) => dagreGraph.setEdge(edge.source, edge.target));

  dagre.layout(dagreGraph);

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    const width = (node.style?.width as number) || minNodeWidth;
    return {
      ...node,
      targetPosition: Position.Left,
      sourcePosition: Position.Right,
      position: {
        x: nodeWithPosition.x - width / 2,
        y: nodeWithPosition.y - nodeHeight / 2,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
}

export function layoutGraph(nodes: Node[], edges: Edge[], rootId: string, maxDagreNodes: number): { nodes: Node[]; edges: Edge[] } {
  return nodes.length > maxDagreNodes ? fastLayout(nodes, edges, rootId) : dagreLayout(nodes, edges);
}

