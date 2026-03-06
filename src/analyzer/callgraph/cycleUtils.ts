/**
 * Cycle detection (DFS) for directed graphs.
 * Shared utility between the call graph analyzer and the webview ReactFlow renderer.
 *
 * No vscode imports — safe to use in analyzer/ and webview/ layers.
 */

/**
 * Detects cycles in a directed graph using DFS.
 * Returns a Set of directed edge keys ("source->target") that participate in
 * at least one cycle. Only the specific back-edges and the edges along the
 * cycle path are included — edges that merely connect two nodes that happen
 * to be cycle participants are NOT marked.
 *
 * @param edges - Array of directed edges with source and target node IDs
 * @returns Set of edge keys ("source->target") that form cycles
 */
export function detectCycleEdges(
  edges: Array<{ source: string; target: string }>,
): Set<string> {
  const cycleEdgeKeys = new Set<string>();
  const adjacency = new Map<string, string[]>();

  for (const { source, target } of edges) {
    const list = adjacency.get(source);
    if (list) {
      list.push(target);
    } else {
      adjacency.set(source, [target]);
    }
  }

  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function dfs(node: string, path: string[]): void {
    visited.add(node);
    recursionStack.add(node);
    const currentPath = [...path, node];

    for (const neighbor of adjacency.get(node) ?? []) {
      if (!visited.has(neighbor)) {
        dfs(neighbor, currentPath);
      } else if (recursionStack.has(neighbor)) {
        // Found a back-edge → mark each edge along the cycle path.
        const cycleStart = currentPath.indexOf(neighbor);
        if (cycleStart >= 0) {
          const cyclePath = currentPath.slice(cycleStart);
          for (let i = 0; i < cyclePath.length - 1; i++) {
            cycleEdgeKeys.add(`${cyclePath[i]}->${cyclePath[i + 1]}`);
          }
          // Close the cycle: last node → neighbor (which is cyclePath[0])
          cycleEdgeKeys.add(`${cyclePath.at(-1)}->${neighbor}`);
        } else {
          // Fallback: only mark the back-edge itself
          cycleEdgeKeys.add(`${node}->${neighbor}`);
        }
      }
    }

    recursionStack.delete(node);
  }

  for (const node of adjacency.keys()) {
    if (!visited.has(node)) dfs(node, []);
  }

  return cycleEdgeKeys;
}

/**
 * Legacy wrapper: returns the set of node IDs involved in at least one cycle.
 * Kept for backward compatibility with the ReactFlow file-level cycle renderer.
 */
export function detectCycles(
  edges: Array<{ source: string; target: string }>,
): Set<string> {
  const cycleEdgeKeys = detectCycleEdges(edges);
  const cycleNodes = new Set<string>();
  for (const key of cycleEdgeKeys) {
    const arrowIdx = key.indexOf("->");
    cycleNodes.add(key.slice(0, arrowIdx));
    cycleNodes.add(key.slice(arrowIdx + 2));
  }
  return cycleNodes;
}

/**
 * Given a set of edges and the cycle node set, returns the IDs of edges
 * where both source and target are cycle participants.
 *
 * @param edges - All edges to check
 * @param cycleNodes - Set of node IDs in cycles (from detectCycles)
 * @returns Array of edge identifiers (source+target+type) that form cycles
 */
export function getCyclicEdgeIds(
  edges: Array<{ source: string; target: string }>,
  cycleNodes: Set<string>,
): string[] {
  return edges
    .filter((e) => cycleNodes.has(e.source) && cycleNodes.has(e.target))
    .map((e) => `${e.source}::${e.target}`);
}
