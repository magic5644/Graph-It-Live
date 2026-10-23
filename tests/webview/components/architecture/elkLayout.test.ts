import cytoscape from "cytoscape";
import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import { describe, expect, it } from "vitest";
import { applyElkLayout, applyRoutes, type EdgeRoute, routeKey, toElkGraph } from "@/webview/components/architecture/elkLayout";
import { buildArchitectureStylesheet } from "@/webview/components/cytoscape/CytoscapeTheme";

const colors = { foreground: "#fff", background: "#000", border: "#888", edge: "#888", accent: "#08f", error: "#f00", findMatch: "rgb(234, 92, 0)", findMatchOpacity: 0.4, contrastBorder: "#6fc3df" };
const node = (id: string, extra: Record<string, string | number> = {}) => ({ group: "nodes" as const, data: { id, key: `k:${id}`, width: 60, height: 30, ...extra } });
const edge = (source: string, target: string) => ({ group: "edges" as const, data: { id: `${source}->${target}`, source, target } });
const canvas = (elements: cytoscape.ElementDefinition[]) =>
  cytoscape({ headless: true, styleEnabled: true, style: buildArchitectureStylesheet(colors), elements });

/**
 * A unit with nested folders (#384) and a cycle block (#394), above a layer-0 unit: compounds
 * at two depths, edges across folders, out of the unit, into and inside the cycle block.
 */
const nested = () => canvas([
  node("unit", { layer: 1 }),
  node("src", { parent: "unit" }),
  node("src/a", { parent: "src" }),
  node("src/b", { parent: "src" }),
  node("lib", { parent: "unit" }),
  node("lib/c", { parent: "lib" }),
  node("cycle", { parent: "unit" }),
  node("cycle/d", { parent: "cycle" }),
  node("cycle/e", { parent: "cycle" }),
  node("base", { layer: 0 }),
  edge("src/a", "lib/c"),
  edge("src/b", "base"),
  edge("lib/c", "cycle/d"),
  edge("cycle/d", "cycle/e"),
  edge("cycle/e", "cycle/d"),
  edge("cycle", "base"),
]);

const flatten = (graph: ElkNode): ElkNode[] => (graph.children ?? []).flatMap((child) => [child, ...flatten(child)]);
type Box = { x1: number; x2: number; y1: number; y2: number };
const overlap = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;

describe("toElkGraph", () => {
  it("nests compounds and turns layers into partitions, the highest layer first", () => {
    const graph = toElkGraph(nested());
    expect(graph.layoutOptions).toMatchObject({ "elk.algorithm": "layered", "elk.partitioning.activate": "true", "elk.hierarchyHandling": "INCLUDE_CHILDREN" });
    expect(graph.children?.map((child) => [child.id, child.layoutOptions?.["elk.partitioning.partition"]])).toEqual([["unit", "0"], ["base", "1"]]);
    const unit = graph.children?.[0];
    expect(unit?.width).toBeUndefined();
    expect(unit?.children?.map((child) => [child.id, child.children?.map((leaf) => leaf.id)])).toEqual([
      ["src", ["src/a", "src/b"]], ["lib", ["lib/c"]], ["cycle", ["cycle/d", "cycle/e"]],
    ]);
    // Nodes without a layer (an expanded group's files) get no partition.
    expect(unit?.children?.[0].children?.[0]).toEqual({ id: "src/a", layoutOptions: undefined, width: 60, height: 30 });
    expect(graph.edges).toHaveLength(6);
    expect(graph.edges?.[0]).toEqual({ id: "src/a->lib/c", sources: ["src/a"], targets: ["lib/c"] });
  });
});

describe("ELK layout of compounds", () => {
  it("lays out nested folders and a cycle block in one run: children inside parents, no overlapping boxes", async () => {
    const cy = nested();
    const layout = await new ELK().layout(toElkGraph(cy));
    const routes = applyElkLayout(cy, layout);
    expect(routes.size).toBe(cy.edges().length);
    // Edges ending on a compound (cycle → base) and crossing the hierarchy are drawn on their route too.
    applyRoutes(cy, cy.edges(), routes);
    expect(cy.edges("[?routed]")).toHaveLength(cy.edges().length);

    // ELK's own boxes: every child inside its parent.
    const box = (entry: ElkNode): Box => ({ x1: entry.x ?? 0, y1: entry.y ?? 0, x2: (entry.x ?? 0) + (entry.width ?? 0), y2: (entry.y ?? 0) + (entry.height ?? 0) });
    for (const parent of flatten(layout)) {
      for (const child of parent.children ?? []) {
        const [outer, inner] = [box(parent), box(child)];
        expect(inner.x1 >= outer.x1 && inner.x2 <= outer.x2 && inner.y1 >= outer.y1 && inner.y2 <= outer.y2, `${child.id} in ${parent.id}`).toBe(true);
      }
    }
    // What Cytoscape draws: no two sibling boxes overlap, at any depth.
    const siblings = new Map<string, cytoscape.NodeSingular[]>();
    cy.nodes().forEach((entry) => {
      const parent = entry.isChild() ? entry.parent().first().id() : "";
      siblings.set(parent, [...(siblings.get(parent) ?? []), entry]);
    });
    let overlappingGroups = 0;
    for (const group of siblings.values()) {
      const bodies = group.map((entry) => entry.boundingBox({ includeLabels: false, includeOverlays: false }));
      bodies.forEach((a, i) => { overlappingGroups += bodies.slice(i + 1).filter((b) => overlap(a, b)).length; });
    }
    expect(overlappingGroups).toBe(0);
    // The unit (layer 1) sits above the layer-0 unit.
    expect(cy.getElementById("unit").boundingBox().y2).toBeLessThan(cy.getElementById("base").boundingBox().y1);
  });
});

describe("a 500-node level", () => {
  it("leaves the webview thread a small share of the work: ELK's run is what the worker takes off it", async () => {
    // Ten layers of 50 units, each unit importing two units of lower layers.
    const elements: cytoscape.ElementDefinition[] = Array.from({ length: 500 }, (_, i) => node(`n${i}`, { layer: 9 - Math.floor(i / 50) }));
    for (let i = 50; i < 500; i++) {
      for (const step of [3, 21]) elements.push(edge(`n${i}`, `n${(i * 7 + step) % (i - (i % 50))}`));
    }
    const cy = canvas(elements);
    let started = performance.now();
    const graph = toElkGraph(cy);
    let mainThread = performance.now() - started;
    started = performance.now();
    const layout = await new ELK().layout(graph);
    const worker = performance.now() - started;
    started = performance.now();
    applyRoutes(cy, cy.edges(), applyElkLayout(cy, layout));
    mainThread += performance.now() - started;
    expect(cy.edges("[?routed]")).toHaveLength(900);
    // ~80× apart locally; 5× keeps slow CI runners green.
    expect(mainThread * 5, `main thread ${Math.round(mainThread)} ms, ELK ${Math.round(worker)} ms`).toBeLessThan(worker);
  }, 60_000);
});

describe("applyRoutes", () => {
  const pair = () => canvas([node("a"), node("b"), edge("a", "b")]);
  const route = (cy: cytoscape.Core, points: EdgeRoute["points"]): Map<string, EdgeRoute> => {
    cy.getElementById("a").position({ x: 0, y: 0 });
    cy.getElementById("b").position({ x: 100, y: 200 });
    return new Map([[routeKey(cy.edges().first()), { points, source: { x: 0, y: 0 }, target: { x: 100, y: 200 } }]]);
  };

  it("draws a route as segments whose points are ELK's bend points", () => {
    const cy = pair();
    const points = [{ x: 0, y: 15 }, { x: 0, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 185 }];
    applyRoutes(cy, cy.edges(), route(cy, points));
    const data = cy.edges().first().data();
    expect(data).toMatchObject({ routed: true, sourceEndpoint: "0px 15px", targetEndpoint: "0px -15px" });
    // Cytoscape puts a bend at S + w·(E − S) + d·n, n = (−dy, dx) / |E − S|: back to ELK's bends.
    const [start, end] = [points[0], points[3]];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const normal = { x: -(end.y - start.y) / length, y: (end.x - start.x) / length };
    const bends = data.segmentWeights.map((w: number, i: number) => ({
      x: start.x + w * (end.x - start.x) + data.segmentDistances[i] * normal.x,
      y: start.y + w * (end.y - start.y) + data.segmentDistances[i] * normal.y,
    }));
    bends.forEach((bend: { x: number; y: number }, i: number) => {
      expect(bend.x).toBeCloseTo(points[i + 1].x);
      expect(bend.y).toBeCloseTo(points[i + 1].y);
    });
    expect(cy.edges().first().pstyle("curve-style").strValue).toBe("segments");
  });

  it("gives a straight route its midpoint as only segment point", () => {
    const cy = pair();
    applyRoutes(cy, cy.edges(), route(cy, [{ x: 0, y: 15 }, { x: 100, y: 185 }]));
    const data = cy.edges().first().data();
    expect(data.segmentWeights).toHaveLength(1);
    expect(data.segmentWeights[0]).toBeCloseTo(0.5);
    expect(data.segmentDistances[0]).toBeCloseTo(0);
  });

  it("leaves the default curve once an end moved, to an edge without route, or to a zero-length route", () => {
    const cy = pair();
    const routes = route(cy, [{ x: 0, y: 15 }, { x: 0, y: 100 }, { x: 100, y: 185 }]);
    applyRoutes(cy, cy.edges(), routes);
    expect(cy.edges().first().data("routed")).toBe(true);
    cy.getElementById("b").position({ x: 140, y: 200 });
    applyRoutes(cy, cy.edges(), routes);
    expect(cy.edges().first().data("routed")).toBeUndefined();
    expect(cy.edges().first().data("segmentWeights")).toBeUndefined();
    expect(cy.edges().first().pstyle("curve-style").strValue).toBe("bezier");

    applyRoutes(cy, cy.edges(), new Map());
    expect(cy.edges().first().data("routed")).toBeUndefined();
    applyRoutes(cy, cy.edges(), route(cy, [{ x: 5, y: 5 }, { x: 5, y: 5 }]));
    expect(cy.edges().first().data("routed")).toBeUndefined();
  });

  it("keys routes by node key, stable across builds, else by node id, as normalized paths", () => {
    const cy = canvas([node("a"), { group: "nodes", data: { id: "file:x.ts" } }, edge("a", "file:x.ts")]);
    expect(routeKey(cy.edges().first())).toBe("k:a>file:x.ts");
    const windows = canvas([
      { group: "nodes", data: { id: "g", key: String.raw`path:apps\web` } },
      { group: "nodes", data: { id: String.raw`file:C:\ws\src\x.ts` } },
      edge("g", String.raw`file:C:\ws\src\x.ts`),
    ]);
    expect(routeKey(windows.edges().first())).toBe("path:apps/web>file:C:/ws/src/x.ts");
  });

  it("handles an empty level", () => {
    const cy = canvas([]);
    expect(toElkGraph(cy)).toMatchObject({ id: "root", children: [], edges: [] });
    expect(applyElkLayout(cy, { id: "root" }).size).toBe(0);
    expect(() => applyRoutes(cy, cy.edges(), new Map())).not.toThrow();
  });

  it("skips ELK edges without a section or no longer drawn", () => {
    const cy = pair();
    const routes = applyElkLayout(cy, {
      id: "root",
      children: [{ id: "a", x: 0, y: 0, width: 60, height: 30 }, { id: "gone", x: 0, y: 0, width: 1, height: 1 }],
      edges: [{ id: "a->b", sources: ["a"], targets: ["b"] }, { id: "gone->a", sources: ["gone"], targets: ["a"], sections: [{ id: "s", startPoint: { x: 0, y: 0 }, endPoint: { x: 1, y: 1 } }] }],
    });
    expect(routes.size).toBe(0);
    expect(cy.getElementById("a").position()).toEqual({ x: 30, y: 15 });
  });
});
