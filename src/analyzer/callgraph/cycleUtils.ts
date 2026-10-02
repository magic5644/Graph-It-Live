/**
 * Shared directed-cycle detection for analyzer and webview graphs.
 * No vscode imports — safe in both layers.
 */

/**
 * An edge belongs to a cycle exactly when its endpoints are in the same
 * strongly connected component. Iterative Kosaraju traversal keeps this
 * O(V + E) and avoids call-stack overflow on deep dependency graphs.
 */
export function detectCycleEdges(
  edges: Array<{ source: string; target: string }>,
): Set<string> {
  const adjacency = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  for (const { source, target } of edges) {
    if (!adjacency.has(source)) adjacency.set(source, []);
    if (!adjacency.has(target)) adjacency.set(target, []);
    adjacency.get(source)?.push(target);
    if (!reverse.has(target)) reverse.set(target, []);
    reverse.get(target)?.push(source);
  }

  const visited = new Set<string>();
  const finishOrder: string[] = [];
  for (const node of adjacency.keys()) {
    const stack = [{ node, exiting: false }];
    while (stack.length > 0) {
      const entry = stack.pop()!;
      if (entry.exiting) {
        finishOrder.push(entry.node);
      } else if (!visited.has(entry.node)) {
        visited.add(entry.node);
        stack.push({ node: entry.node, exiting: true });
        for (const neighbor of adjacency.get(entry.node) ?? []) {
          if (!visited.has(neighbor)) stack.push({ node: neighbor, exiting: false });
        }
      }
    }
  }

  const components = new Map<string, number>();
  for (const node of finishOrder.reverse()) {
    if (components.has(node)) continue;
    const component = components.size;
    const stack = [node];
    components.set(node, component);
    while (stack.length > 0) {
      for (const neighbor of reverse.get(stack.pop()!) ?? []) {
        if (!components.has(neighbor)) {
          components.set(neighbor, component);
          stack.push(neighbor);
        }
      }
    }
  }

  return new Set(edges
    .filter(({ source, target }) => components.get(source) === components.get(target))
    .map(({ source, target }) => `${source}->${target}`));
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
 * that belong to a directed cycle and have both endpoints in cycleNodes.
 *
 * @param edges - All edges to check
 * @param cycleNodes - Set of node IDs in cycles (from detectCycles)
 * @returns Array of edge identifiers (source+target+type) that form cycles
 */
export function getCyclicEdgeIds(
  edges: Array<{ source: string; target: string }>,
  cycleNodes: Set<string>,
): string[] {
  const cycleEdges = detectCycleEdges(edges);
  return edges
    .filter((e) => cycleNodes.has(e.source) && cycleNodes.has(e.target) && cycleEdges.has(`${e.source}->${e.target}`))
    .map((e) => `${e.source}::${e.target}`);
}
