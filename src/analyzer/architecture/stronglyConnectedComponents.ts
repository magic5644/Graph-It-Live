/**
 * Strongly connected components and layers of a directed graph, shared by the architecture
 * units (layers, cycle edges) and the views built on them.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

export interface LayeredGraph {
  /** Components, each listing its nodes; a dependency's component comes before its dependents'. */
  components: string[][];
  componentOf: Map<string, number>;
  /** 0 = depends on no other component, else 1 + the highest layer it depends on. */
  layerOf: Map<string, number>;
}

/**
 * Tarjan's algorithm, iterative so a long dependency chain cannot overflow the stack.
 * Components come out sinks first (reverse topological order); ties follow `nodes` order.
 */
export function stronglyConnectedComponents(nodes: readonly string[], successors: ReadonlyMap<string, readonly string[]>): string[][] {
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const work: { node: string; next: number }[] = [];
  const components: string[][] = [];

  const visit = (node: string) => {
    index.set(node, index.size);
    lowLink.set(node, index.size - 1);
    stack.push(node);
    onStack.add(node);
    work.push({ node, next: 0 });
  };
  const lowerTo = (node: string, value: number) => lowLink.set(node, Math.min(lowLink.get(node)!, value));
  /** Pops the component rooted at `root` off the stack. */
  const popComponent = (root: string) => {
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== root);
    components.push(component.reverse());
  };

  for (const start of nodes) {
    if (!index.has(start)) visit(start);
    while (work.length > 0) {
      const frame = work.at(-1)!;
      const target = successors.get(frame.node)?.[frame.next++];
      if (target === undefined) {
        work.pop();
        const parent = work.at(-1);
        if (parent) lowerTo(parent.node, lowLink.get(frame.node)!);
        if (lowLink.get(frame.node) === index.get(frame.node)) popComponent(frame.node);
      } else if (!index.has(target)) {
        visit(target);
      } else if (onStack.has(target)) {
        lowerTo(frame.node, index.get(target)!);
      }
    }
  }
  return components;
}

/** Collapses cycles, then ranks each component by the longest dependency chain below it. */
export function layerGraph(nodes: readonly string[], successors: ReadonlyMap<string, readonly string[]>): LayeredGraph {
  const components = stronglyConnectedComponents(nodes, successors);
  const componentOf = new Map<string, number>();
  components.forEach((members, id) => members.forEach((node) => componentOf.set(node, id)));
  // Sinks first: every component a component depends on already has its layer.
  const componentLayer: number[] = [];
  components.forEach((members, id) => {
    let layer = 0;
    for (const node of members) {
      for (const target of successors.get(node) ?? []) {
        const targetComponent = componentOf.get(target);
        if (targetComponent !== undefined && targetComponent !== id) layer = Math.max(layer, componentLayer[targetComponent] + 1);
      }
    }
    componentLayer[id] = layer;
  });
  const layerOf = new Map([...componentOf].map(([node, id]) => [node, componentLayer[id]]));
  return { components, componentOf, layerOf };
}
