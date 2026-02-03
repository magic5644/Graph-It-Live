/**
 * Graph traversal utilities for computing related nodes and edges
 */

import { type Edge, type Node } from 'reactflow';

export interface HighlightState {
  highlightedNodes: Set<string>;
  highlightedEdges: Set<string>;
}

/**
 * Compute all nodes and edges related to a given symbol using bidirectional BFS
 * @param symbolId - The ID of the symbol to start from
 * @param nodes - All nodes in the graph
 * @param edges - All edges in the graph
 * @returns HighlightState containing sets of highlighted node/edge IDs
 */
export function computeRelatedNodes(
  symbolId: string,
  nodes: Node[],
  edges: Edge[],
): HighlightState {
  const highlightedNodes = new Set<string>();
  const highlightedEdges = new Set<string>();

  // Find the starting node
  const startNode = nodes.find((n) => n.id === symbolId);
  if (!startNode) {
    return { highlightedNodes, highlightedEdges };
  }

  // Build adjacency maps for bidirectional traversal
  const outgoing = new Map<string, string[]>(); // node -> [targets]
  const incoming = new Map<string, string[]>(); // node -> [sources]

  edges.forEach((edge) => {
    // Outgoing: source -> target
    const targets = outgoing.get(edge.source) || [];
    targets.push(edge.target);
    outgoing.set(edge.source, targets);

    // Incoming: target -> source
    const sources = incoming.get(edge.target) || [];
    sources.push(edge.source);
    incoming.set(edge.target, sources);
  });

  // BFS: Traverse both outgoing and incoming directions
  const queue: string[] = [symbolId];
  const visited = new Set<string>([symbolId]);

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    highlightedNodes.add(currentId);

    // Traverse outgoing edges (dependencies)
    const outgoingTargets = outgoing.get(currentId) || [];
    outgoingTargets.forEach((target) => {
      // Find edge(s) from current to target
      edges.forEach((edge) => {
        if (edge.source === currentId && edge.target === target) {
          highlightedEdges.add(edge.id);
        }
      });

      if (!visited.has(target)) {
        visited.add(target);
        queue.push(target);
      }
    });

    // Traverse incoming edges (dependents)
    const incomingSources = incoming.get(currentId) || [];
    incomingSources.forEach((source) => {
      // Find edge(s) from source to current
      edges.forEach((edge) => {
        if (edge.source === source && edge.target === currentId) {
          highlightedEdges.add(edge.id);
        }
      });

      if (!visited.has(source)) {
        visited.add(source);
        queue.push(source);
      }
    });
  }

  return { highlightedNodes, highlightedEdges };
}
