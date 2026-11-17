/**
 * Shared directed-cycle detection for analyzer and webview graphs.
 * No vscode imports — safe in both layers.
 */

function getFinishOrder(adjacency: Map<string, string[]>): string[] {
  const visited = new Set<string>();
  const finishOrder: string[] = [];
  for (const node of adjacency.keys()) {
    const stack = [{ node, exiting: false }];
    while (stack.length > 0) {
      const entry = stack.pop()!;
      if (entry.exiting) {
        finishOrder.push(entry.node);
        continue;
      }
      if (visited.has(entry.node)) continue;
      visited.add(entry.node);
      stack.push({ node: entry.node, exiting: true });
      for (const neighbor of adjacency.get(entry.node) ?? []) {
        stack.push({ node: neighbor, exiting: false });
      }
    }
  }

  return finishOrder;
}

function findComponents(reverse: Map<string, string[]>, finishOrder: string[]): Map<string, number> {
  const components = new Map<string, number>();
  for (const node of finishOrder) {
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
  return components;
}

interface CycleEdge {
  source: string;
  target: string;
  relationType?: string;
}

/**
 * Edges that can close a cycle: a pair with a `containment` edge (Rust `mod x;`) is dropped, even
 * when a use edge of the same pair was recorded too, since Rust lets a parent and the child it
 * declares reference each other.
 */
export function withoutContainment<E extends CycleEdge>(edges: readonly E[]): E[] {
  const contained = new Set(edges.filter((e) => e.relationType === "containment").map((e) => `${e.source}\0${e.target}`));
  return edges.filter((e) => !contained.has(`${e.source}\0${e.target}`));
}

/**
 * An edge belongs to a cycle exactly when its endpoints are in the same
 * strongly connected component. Iterative Kosaraju traversal keeps this
 * O(V + E) and avoids call-stack overflow on deep dependency graphs.
 */
export function detectCycleEdges(
  edges: Array<{ source: string; target: string }>,
): Set<string> {
  return new Set(edgesInCycles(edges).cycleEdges.map(({ source, target }) => `${source}->${target}`));
}

/** The usage edges inside a strongly connected component, with each node's component. */
function edgesInCycles<E extends CycleEdge>(edges: readonly E[]): { cycleEdges: E[]; components: Map<string, number> } {
  const usage = withoutContainment(edges);
  const adjacency = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  for (const { source, target } of usage) {
    if (!adjacency.has(source)) adjacency.set(source, []);
    if (!adjacency.has(target)) adjacency.set(target, []);
    adjacency.get(source)?.push(target);
    if (!reverse.has(target)) reverse.set(target, []);
    reverse.get(target)?.push(source);
  }

  const finishOrder = getFinishOrder(adjacency);
  finishOrder.reverse();
  const components = findComponents(reverse, finishOrder);
  return { cycleEdges: usage.filter(({ source, target }) => components.get(source) === components.get(target)), components };
}

/** Whether a cycle runs at runtime: `type-only` only when every import closing it is type-only (#740). */
export type CycleKind = "runtime" | "type-only";

/**
 * Cycle edges (`source->target`) split by kind in one pass (#745): a component whose every edge is
 * type-only is erased at runtime and drawn apart; a component with one runtime edge stays runtime.
 */
export function cycleEdgesByKind(edges: ReadonlyArray<CycleEdge & { typeOnly?: boolean }>): Record<"runtime" | "typeOnly", Set<string>> {
  const { cycleEdges, components } = edgesInCycles(edges);
  const runtimeComponents = new Set(cycleEdges.filter((edge) => !edge.typeOnly).map(({ source }) => components.get(source)));
  const byKind = { runtime: new Set<string>(), typeOnly: new Set<string>() };
  for (const { source, target } of cycleEdges) {
    byKind[runtimeComponents.has(components.get(source)) ? "runtime" : "typeOnly"].add(`${source}->${target}`);
  }
  return byKind;
}

/** Kind of each cycle (files in order, the first repeated last) over `edges` (#745). */
export function cycleKinds(cycles: readonly (readonly string[])[], edges: ReadonlyArray<CycleEdge & { typeOnly?: boolean }>): CycleKind[] {
  const typeOnly = new Set(edges.filter((edge) => edge.typeOnly).map(({ source, target }) => `${source}\0${target}`));
  return cycles.map((cycle) => (cycle.slice(1).every((file, index) => typeOnly.has(`${cycle[index]}\0${file}`)) ? "type-only" : "runtime"));
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
