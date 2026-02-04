import dagre from '@dagrejs/dagre';
import type { Edge, Node } from 'reactflow';
import { Position } from 'reactflow';
import { charWidth, maxNodeWidth, minNodeWidth, nodeHeight } from '../../utils/nodeUtils';
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


function radialLayout(nodes: Node[], edges: Edge[], rootId: string): { nodes: Node[]; edges: Edge[] } {
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

  // BFS for depth
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

  const positioned: Node[] = [];
  const sortedDepths = [...nodesByDepth.keys()].sort((a, b) => a - b);
  const layerHeight = 250;

  for (const d of sortedDepths) {
    const group = nodesByDepth.get(d)!;
    const radius = d * layerHeight;
    const angleStep = (2 * Math.PI) / group.length;

    group.forEach((node, idx) => {
      const angle = idx * angleStep;
      positioned.push({
        ...node,
        position: {
          x: radius * Math.cos(angle),
          y: radius * Math.sin(angle),
        },
        targetPosition: Position.Left, // Should ideally be dynamic for radial
        sourcePosition: Position.Right,
      });
    });
  }

  // Arrange unconnected in a grid far away or separate circle
  const unconnectedRadius = (sortedDepths.length + 1) * layerHeight;
  unconnected.forEach((node, idx) => {
    const angle = (idx / unconnected.length) * 2 * Math.PI;
    positioned.push({
      ...node,
      position: {
        x: unconnectedRadius * Math.cos(angle),
        y: unconnectedRadius * Math.sin(angle),
      },
      targetPosition: Position.Left,
      sourcePosition: Position.Right,
    });
  });

  return { nodes: positioned, edges };
}

function forceLayout(nodes: Node[], edges: Edge[], _rootId: string): { nodes: Node[]; edges: Edge[] } {
  // Simple force-directed layout simulation
  // 1. Initialize positions (e.g. circle or random)
  // 2. Iterative repulsion/attraction

  // Initial random positions
  const currentNodes = nodes.map((n, _i) => ({
    ...n,
    x: n.position.x || (Math.random() * 800),
    y: n.position.y || (Math.random() * 600),
    vx: 0,
    vy: 0
  }));

  const k = 200; // Optimal distance
  const iterations = 100;
  const width = 1000;
  const height = 800;
  const center = { x: width / 2, y: height / 2 };

  for (let i = 0; i < iterations; i++) {
    // Repulsion
    for (let u = 0; u < currentNodes.length; u++) {
      for (let v = 0; v < currentNodes.length; v++) {
        if (u === v) continue;
        const nodeU = currentNodes[u];
        const nodeV = currentNodes[v];
        const dx = nodeU.x - nodeV.x;
        const dy = nodeU.y - nodeV.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.1) dist = 0.1; // avoid div by zero

        const force = (k * k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        nodeU.vx += fx;
        nodeU.vy += fy;
      }
    }

    // Attraction
    edges.forEach(e => {
      const u = currentNodes.find(n => n.id === e.source);
      const v = currentNodes.find(n => n.id === e.target);
      if (u && v) {
        const dx = v.x - u.x;
        const dy = v.y - u.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.1) dist = 0.1;

        const force = (dist * dist) / k;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        u.vx += fx;
        u.vy += fy;
        v.vx -= fx;
        v.vy -= fy;
      }
    });

    // Gravity to center to prevent flying away
    currentNodes.forEach(n => {
      const dx = center.x - n.x;
      const dy = center.y - n.y;
      const strength = 0.05;
      n.vx += dx * strength;
      n.vy += dy * strength;
    });

    // Update positions
    const t = 1 - (i / iterations); // Temperature cooling
    currentNodes.forEach(n => {
      // Limit velocity
      const vMag = Math.hypot(n.vx, n.vy);
      if (vMag > 100) { // cap
        n.vx = (n.vx / vMag) * 100;
        n.vy = (n.vy / vMag) * 100;
      }

      n.x += n.vx * (0.1 * t);
      n.y += n.vy * (0.1 * t);

      // Damping
      n.vx *= 0.5;
      n.vy *= 0.5;
    });
  }

  const layoutedNodes = currentNodes.map(n => ({
    ...n, // preserves original node props
    position: { x: n.x, y: n.y },
    targetPosition: Position.Top,
    sourcePosition: Position.Bottom,
  }));

  return { nodes: layoutedNodes, edges };
}

export function layoutGraph(
  nodes: Node[],
  edges: Edge[],
  rootId: string,
  maxDagreNodes: number,
  layoutType: 'hierarchical' | 'force' | 'radial' = 'hierarchical'
): { nodes: Node[]; edges: Edge[] } {
  if (layoutType === 'force') {
    return forceLayout(nodes, edges, rootId);
  }
  if (layoutType === 'radial') {
    return radialLayout(nodes, edges, rootId);
  }

  // Default to Hierarchical (Dagre) or Fast Layout for large graphs
  return nodes.length > maxDagreNodes ? fastLayout(nodes, edges, rootId) : dagreLayout(nodes, edges);
}
