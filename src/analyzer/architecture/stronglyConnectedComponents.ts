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

interface TarjanState {
  index: Map<string, number>;
  lowLink: Map<string, number>;
  stack: string[];
  onStack: Set<string>;
  work: { node: string; next: number }[];
  components: string[][];
}

function visit(state: TarjanState, node: string): void {
  state.index.set(node, state.index.size);
  state.lowLink.set(node, state.index.size - 1);
  state.stack.push(node);
  state.onStack.add(node);
  state.work.push({ node, next: 0 });
}

function lowerTo(state: TarjanState, node: string, value: number): void {
  state.lowLink.set(node, Math.min(state.lowLink.get(node)!, value));
}

/** `node` is done: hand its low link to its parent, and pop its component when it is a root. */
function finish(state: TarjanState, node: string): void {
  state.work.pop();
  const parent = state.work.at(-1);
  if (parent) lowerTo(state, parent.node, state.lowLink.get(node)!);
  if (state.lowLink.get(node) !== state.index.get(node)) return;
  const component: string[] = [];
  let member: string;
  do {
    member = state.stack.pop()!;
    state.onStack.delete(member);
    component.push(member);
  } while (member !== node);
  state.components.push(component.toReversed());
}

/**
 * Tarjan's algorithm, iterative so a long dependency chain cannot overflow the stack.
 * Components come out sinks first (reverse topological order); ties follow `nodes` order.
 */
export function stronglyConnectedComponents(nodes: readonly string[], successors: ReadonlyMap<string, readonly string[]>): string[][] {
  const state: TarjanState = { index: new Map(), lowLink: new Map(), stack: [], onStack: new Set(), work: [], components: [] };
  for (const start of nodes) {
    if (!state.index.has(start)) visit(state, start);
    while (state.work.length > 0) {
      const frame = state.work.at(-1)!;
      const target = successors.get(frame.node)?.[frame.next++];
      if (target === undefined) finish(state, frame.node);
      else if (!state.index.has(target)) visit(state, target);
      else if (state.onStack.has(target)) lowerTo(state, frame.node, state.index.get(target)!);
    }
  }
  return state.components;
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
