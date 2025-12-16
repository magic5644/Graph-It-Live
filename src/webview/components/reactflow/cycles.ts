/**
 * Cycle detection (DFS) for directed graphs.
 * Returns a set of node ids involved in a cycle.
 */
export function detectCycles(edges: Array<{ source: string; target: string }>): Set<string> {
  const cycleNodes = new Set<string>();
  const adjacency = new Map<string, string[]>();

  edges.forEach(({ source, target }) => {
    if (!adjacency.has(source)) adjacency.set(source, []);
    adjacency.get(source)!.push(target);
  });

  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  const dfs = (node: string, path: string[]): void => {
    visited.add(node);
    recursionStack.add(node);

    for (const neighbor of adjacency.get(node) || []) {
      if (!visited.has(neighbor)) {
        dfs(neighbor, [...path, node]);
      } else if (recursionStack.has(neighbor)) {
        const cycleStart = path.indexOf(neighbor);
        if (cycleStart !== -1) {
          path.slice(cycleStart).forEach((n) => cycleNodes.add(n));
        }
        cycleNodes.add(neighbor);
        cycleNodes.add(node);
      }
    }

    recursionStack.delete(node);
  };

  adjacency.forEach((_, node) => {
    if (!visited.has(node)) dfs(node, []);
  });

  return cycleNodes;
}

