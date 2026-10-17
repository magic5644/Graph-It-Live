import { describe, expect, it } from "vitest";
import { layerGraph, stronglyConnectedComponents } from "@/analyzer/architecture/stronglyConnectedComponents";

const graph = (edges: Record<string, string[]>) => new Map(Object.entries(edges));

describe("stronglyConnectedComponents", () => {
  it("returns one component per node of an acyclic graph, dependencies first", () => {
    expect(stronglyConnectedComponents(["a", "b", "c"], graph({ a: ["b"], b: ["c"] }))).toEqual([["c"], ["b"], ["a"]]);
  });

  it("groups the nodes of a cycle, self-loops included", () => {
    const components = stronglyConnectedComponents(["a", "b", "c", "d"], graph({ a: ["b"], b: ["c", "a"], c: ["c"], d: ["a"] }));
    expect(components).toEqual([["c"], ["a", "b"], ["d"]]);
  });

  it("handles an empty graph and unknown successors", () => {
    expect(stronglyConnectedComponents([], new Map())).toEqual([]);
    expect(stronglyConnectedComponents(["a"], graph({ a: [] }))).toEqual([["a"]]);
  });

  it("does not overflow the stack on a long chain", () => {
    const nodes = Array.from({ length: 50_000 }, (_, index) => `n${index}`);
    const successors = new Map(nodes.slice(0, -1).map((node, index) => [node, [nodes[index + 1]]]));
    expect(stronglyConnectedComponents(nodes, successors)).toHaveLength(nodes.length);
  });
});

describe("layerGraph", () => {
  it("ranks a chain A → B → C as 2, 1, 0", () => {
    const { layerOf } = layerGraph(["A", "B", "C"], graph({ A: ["B"], B: ["C"] }));
    expect(Object.fromEntries(layerOf)).toEqual({ A: 2, B: 1, C: 0 });
  });

  it("gives the members of a cycle one layer, above what they depend on", () => {
    const { layerOf, componentOf } = layerGraph(["app", "x", "y", "lib"], graph({ app: ["x"], x: ["y"], y: ["x", "lib"] }));
    expect(Object.fromEntries(layerOf)).toEqual({ app: 2, x: 1, y: 1, lib: 0 });
    expect(componentOf.get("x")).toBe(componentOf.get("y"));
    expect(componentOf.get("app")).not.toBe(componentOf.get("x"));
  });

  it("ranks by the longest chain below a node", () => {
    const { layerOf } = layerGraph(["a", "b", "c"], graph({ a: ["b", "c"], b: ["c"] }));
    expect(layerOf.get("a")).toBe(2);
  });
});
