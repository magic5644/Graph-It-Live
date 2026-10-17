import cytoscape from "cytoscape";
import ELK from "elkjs/lib/elk.bundled.js";
import { describe, expect, it, vi } from "vitest";
import type { ArchitectureSummaryMessage, ArchitectureUnitLevel } from "@/shared/architecture-types";
import {
  applyMinImports,
  ARCHITECTURE_FONT_SIZE,
  cappedUnitEdges,
  fitReadable,
  levelSummary,
  measureUnitLevel,
  MIN_READABLE_ZOOM,
  toLevelElements,
  unitColor,
  UNIT_EDGES_PER_UNIT,
} from "@/webview/components/architecture/architectureElements";
import { applyElkLayout, applyRoutes, toElkGraph } from "@/webview/components/architecture/elkLayout";
import { buildArchitectureStylesheet } from "@/webview/components/cytoscape/CytoscapeTheme";

const colors = { foreground: "#fff", background: "#000", border: "#888", edge: "#888", accent: "#08f", error: "#f00" };

// web → ui → core ↔ types (cycle), web → core; tool stands alone. Groups: web/pages (1), ui (2), core (3), types (4), tool (5).
const units: ArchitectureUnitLevel = {
  units: [
    { key: "apps/web", name: "@ws/web", fileCount: 3, internalEdgeCount: 1, layer: 2 },
    { key: "packages/ui", name: "@ws/ui", fileCount: 1, internalEdgeCount: 0, layer: 1 },
    { key: "packages/core", name: "@ws/core", fileCount: 1, internalEdgeCount: 0, layer: 0 },
    { key: "packages/types", name: "@ws/types", fileCount: 1, internalEdgeCount: 0, layer: 0 },
    { key: "tool", name: "tool", fileCount: 1, internalEdgeCount: 0, layer: 0 },
  ],
  unitEdges: [
    { from: "apps/web", to: "packages/ui", fileEdgeCount: 2, kind: "down" },
    { from: "apps/web", to: "packages/core", fileEdgeCount: 1, kind: "down" },
    { from: "packages/core", to: "packages/types", fileEdgeCount: 1, kind: "cycle" },
    { from: "packages/types", to: "packages/core", fileEdgeCount: 1, kind: "cycle" },
    { from: "packages/ui", to: "packages/core", fileEdgeCount: 1, kind: "down" },
  ],
  upwardEdges: 0,
  cycles: 1,
  totals: { files: 7, fileEdges: 7, intraUnitEdges: 1, interUnitEdges: 6 },
  groupUnits: { 1: "apps/web", 2: "apps/web", 3: "packages/ui", 4: "packages/core", 5: "packages/types", 6: "tool" },
  groupLayers: { 1: 1, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
  groupEdgeKinds: { "1>2": "down" },
};

const summary: ArchitectureSummaryMessage = {
  type: "architectureSummary",
  revision: "r1",
  stale: false,
  context: {
    communityMode: "path", revision: "r1", graphKind: "imports", scope: "workspace", exclusions: "",
    indexedAt: undefined, maxFiles: undefined, truncated: false, failedFiles: 0,
  },
  provenance: { facts: "", grouping: "", interpretation: "" },
  scannedFiles: 7,
  analyzedFiles: 7,
  totals: { files: 7, fileEdges: 7, intraGroupEdges: 0, interGroupEdges: 7 },
  unassigned: { fileCount: 0, internalEdgeCount: 0 },
  groups: [
    { id: 1, key: "apps/web", label: "apps/web", fileCount: 1, internalEdgeCount: 0 },
    { id: 2, key: "apps/web/pages", label: "apps/web/pages", fileCount: 2, internalEdgeCount: 0 },
    { id: 3, key: "packages/ui", label: "packages/ui", fileCount: 1, internalEdgeCount: 0 },
    { id: 4, key: "packages/core", label: "packages/core", fileCount: 1, internalEdgeCount: 0 },
    { id: 5, key: "packages/types", label: "packages/types", fileCount: 1, internalEdgeCount: 0 },
    { id: 6, key: "tool", label: "tool", fileCount: 1, internalEdgeCount: 0 },
  ],
  groupEdges: [
    { from: 1, to: 2, fileEdgeCount: 1, fromLabel: "apps/web", toLabel: "apps/web/pages" },
    { from: 2, to: 3, fileEdgeCount: 2, fromLabel: "apps/web/pages", toLabel: "packages/ui" },
  ],
  totalGroups: 6,
  hiddenGroups: 0,
  hiddenGroupEdges: 0,
  units,
};

const canvas = (elements = toLevelElements(summary, null)) =>
  cytoscape({ headless: true, styleEnabled: true, style: buildArchitectureStylesheet(colors), elements });

describe("levelSummary", () => {
  it("draws the units as groups, unit edges as group edges, nothing unassigned", () => {
    const level = levelSummary(summary, null);
    expect(level.groups.map(group => [group.id, group.key, group.label, group.fileCount])).toEqual([
      [1, "apps/web", "@ws/web", 3], [2, "packages/ui", "@ws/ui", 1], [3, "packages/core", "@ws/core", 1],
      [4, "packages/types", "@ws/types", 1], [5, "tool", "tool", 1],
    ]);
    expect(level.groupEdges[0]).toEqual({ from: 1, to: 2, fileEdgeCount: 2, fromLabel: "@ws/web", toLabel: "@ws/ui" });
    expect(level).toMatchObject({ unassigned: { fileCount: 0 }, totalGroups: 5, hiddenGroups: 0, hiddenGroupEdges: 0 });
  });

  it("keeps the entered unit's groups and the edges between them", () => {
    const level = levelSummary(summary, "apps/web");
    expect(level.groups.map(group => group.id)).toEqual([1, 2]);
    expect(level.groupEdges).toEqual([summary.groupEdges[0]]);
    expect(level.totalGroups).toBe(2);
  });

  it("returns a summary without units as it is", () => {
    const louvain = { ...summary, units: undefined };
    expect(levelSummary(louvain, null)).toBe(louvain);
    expect(toLevelElements(louvain, null).filter(element => element.group === "nodes")).toHaveLength(6);
  });
});

describe("toLevelElements", () => {
  it("colours each unit, keys it by unit, and marks unit edges with their kind", () => {
    const elements = toLevelElements(summary, null);
    const nodes = elements.filter(element => element.group === "nodes").map(element => element.data);
    expect(nodes.map(node => [node.id, node.key, node.unitKey, node.layer])).toEqual([
      ["group-1", "units:apps/web", "apps/web", 2], ["group-2", "units:packages/ui", "packages/ui", 1],
      ["group-3", "units:packages/core", "packages/core", 0], ["group-4", "units:packages/types", "packages/types", 0],
      ["group-5", "units:tool", "tool", 0],
    ]);
    expect(new Set(nodes.map(node => node.color)).size).toBe(5);
    const edges = elements.filter(element => element.group === "edges").map(element => element.data);
    expect(edges.map(edge => [edge.id, edge.kind, edge.unitEdge, edge.capped])).toEqual([
      ["edge-1-2", "down", true, false], ["edge-1-3", "down", true, false], ["edge-3-4", "cycle", true, false],
      ["edge-4-3", "cycle", true, false], ["edge-2-3", "down", true, false],
    ]);
  });

  it("gives an entered unit's groups the unit's colour", () => {
    const nodes = toLevelElements(summary, "apps/web").filter(element => element.group === "nodes");
    expect(nodes.map(node => node.data.color)).toEqual([unitColor(0), unitColor(0)]);
  });
});

describe("cappedUnitEdges", () => {
  it("hides down edges beyond UNIT_EDGES_PER_UNIT per unit, never upward or cycle ones", () => {
    const many: ArchitectureUnitLevel = {
      ...units,
      units: units.units.slice(0, 1),
      unitEdges: [
        ...Array.from({ length: UNIT_EDGES_PER_UNIT + 1 }, (_, index) =>
          ({ from: "apps/web", to: `lib${index}`, fileEdgeCount: 9 - index, kind: "down" as const })),
        { from: "lib0", to: "apps/web", fileEdgeCount: 1, kind: "upward" },
      ],
    };
    expect([...cappedUnitEdges(many)]).toEqual([`apps/web\0lib${UNIT_EDGES_PER_UNIT}`]);
    expect(cappedUnitEdges(units).size).toBe(0);
  });

  it("is what min-imports 1 hides, and a threshold overrides it", () => {
    const elements = toLevelElements(summary, null).map(element =>
      (element.data.id === "edge-2-3" ? { ...element, data: { ...element.data, capped: true } } : element));
    const cy = canvas(elements);
    expect(applyMinImports(cy, 1)).toBe(4);
    expect(cy.getElementById("edge-2-3").hasClass("weak")).toBe(true);
    expect(applyMinImports(cy, 2)).toBe(1);
    expect(cy.getElementById("edge-2-3").hasClass("weak")).toBe(true);
    expect(cy.getElementById("edge-1-2").hasClass("weak")).toBe(false);
  });
});

/** The ELK layout the webview's worker computes, run in-thread (elk.bundled) and applied. */
async function layOut(cy: cytoscape.Core) {
  return applyElkLayout(cy, await new ELK().layout(toElkGraph(cy)));
}

describe("ELK layered layout of the units", () => {
  it("puts every unit on the row of its layer, dependents above, so every down edge goes down", async () => {
    const cy = canvas();
    await layOut(cy);
    const y = (id: string) => cy.getElementById(id).position("y");
    expect(y("group-1")).toBeLessThan(y("group-2"));
    expect(y("group-2")).toBeLessThan(y("group-3"));
    // The core ↔ types cycle is spread over two rows; the isolated layer-0 unit sits on the bottom row.
    expect(y("group-4")).not.toBe(y("group-3"));
    expect(y("group-5")).toBe(Math.max(y("group-3"), y("group-4")));
    expect(measureUnitLevel(cy)).toMatchObject({ units: 5, colors: 5, redEdges: 2, edgesNotDown: 0, hiddenEdges: 0 });
  });

  it("routes every edge orthogonally, with no segment through a unit box (the workspaces-project units above)", async () => {
    const cy = canvas();
    const routes = await layOut(cy);
    expect(routes.size).toBe(cy.edges().length);
    applyRoutes(cy, cy.edges(), routes);
    expect(measureUnitLevel(cy).routedEdges).toBe(cy.edges().length);
    // Boxes shrunk by a pixel: a route starts and ends on the border of its units.
    const boxes = cy.nodes().map((node) => {
      const { x, y } = node.position();
      const [w, h] = [Number(node.data("width")) / 2 - 1, Number(node.data("height")) / 2 - 1];
      return { id: node.id(), x1: x - w, x2: x + w, y1: y - h, y2: y + h };
    });
    for (const [key, { points }] of routes) {
      for (const [index, from] of points.slice(0, -1).entries()) {
        const to = points[index + 1];
        expect(from.x === to.x || from.y === to.y, `${key} segment ${index} is not orthogonal`).toBe(true);
        const [x1, x2] = [Math.min(from.x, to.x), Math.max(from.x, to.x)];
        const [y1, y2] = [Math.min(from.y, to.y), Math.max(from.y, to.y)];
        const crossed = boxes.filter((box) => x1 < box.x2 && box.x1 < x2 && y1 < box.y2 && box.y1 < y2);
        expect(crossed.map((box) => box.id), `${key} segment ${index}`).toEqual([]);
      }
    }
  });
});

describe("fitReadable", () => {
  it("never zooms out below a readable label size", async () => {
    const cy = canvas();
    await layOut(cy);
    // Headless: no viewport size, so fit leaves the zoom alone; force a tiny zoom first.
    cy.zoom(0.1);
    fitReadable(cy);
    expect(cy.zoom()).toBeGreaterThanOrEqual(MIN_READABLE_ZOOM);
    expect(measureUnitLevel(cy).minLabelPx).toBeGreaterThanOrEqual(8);
    expect(ARCHITECTURE_FONT_SIZE * MIN_READABLE_ZOOM).toBeCloseTo(8);
  });
});

describe("an entered unit", () => {
  it("lays its groups on their layers, with the unit colour and its edge kinds", async () => {
    const elements = toLevelElements(summary, "apps/web");
    const nodes = elements.filter(element => element.group === "nodes").map(element => element.data);
    expect(nodes.map(node => [node.id, node.layer])).toEqual([["group-1", 1], ["group-2", 0]]);
    expect(elements.filter(element => element.group === "edges").map(element => [element.data.kind, element.data.capped])).toEqual([["down", false]]);
    const cy = canvas(elements);
    await layOut(cy);
    expect(cy.getElementById("group-1").position("y")).toBeLessThan(cy.getElementById("group-2").position("y"));
  });
});

describe("fitReadable on a large graph", () => {
  it("keeps the top centre of the graph in view at the readable zoom", () => {
    const wide = Array.from({ length: 40 }, (_, index) =>
      ({ group: "nodes" as const, data: { id: `n${index}` }, position: { x: index * 150, y: 100 + index * 60 } }));
    const cy = cytoscape({ headless: true, elements: wide });
    // Headless has no viewport: stand in a 400px-wide view whose fit would zoom far out.
    vi.spyOn(cy, "width").mockReturnValue(400);
    vi.spyOn(cy, "fit").mockImplementation(() => cy.zoom(0.05));
    fitReadable(cy);
    expect(cy.zoom()).toBeCloseTo(MIN_READABLE_ZOOM);
    const box = cy.elements().renderedBoundingBox();
    expect(box.y1).toBeCloseTo(30, 0);
    expect((box.x1 + box.x2) / 2).toBeCloseTo(200, 0);
  });
});
