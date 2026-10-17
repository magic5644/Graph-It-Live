import cytoscape from "cytoscape";
import { describe, expect, it } from "vitest";
import type { ArchitectureSummaryMessage, ArchitectureUnitLevel } from "@/shared/architecture-types";
import {
  applyMinImports,
  ARCHITECTURE_FONT_SIZE,
  cappedUnitEdges,
  fitReadable,
  layoutUnits,
  levelSummary,
  measureUnitLevel,
  MIN_READABLE_ZOOM,
  toLevelElements,
  unitColor,
  UNIT_EDGES_PER_UNIT,
} from "@/webview/components/architecture/architectureElements";
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

describe("layoutUnits", () => {
  it("puts every unit on the row of its layer, dependents above, so every down edge goes down", () => {
    const cy = canvas();
    layoutUnits(cy);
    const y = (id: string) => cy.getElementById(id).position("y");
    expect(y("group-1")).toBeLessThan(y("group-2"));
    expect(y("group-2")).toBeLessThan(y("group-3"));
    // Layer 0, the isolated unit included, shares the bottom row.
    expect(y("group-4")).toBe(y("group-3"));
    expect(y("group-5")).toBe(y("group-3"));
    expect(measureUnitLevel(cy)).toMatchObject({ units: 5, colors: 5, redEdges: 2, edgesNotDown: 0, hiddenEdges: 0 });
  });
});

describe("fitReadable", () => {
  it("never zooms out below a readable label size", () => {
    const cy = canvas();
    layoutUnits(cy);
    // Headless: no viewport size, so fit leaves the zoom alone; force a tiny zoom first.
    cy.zoom(0.1);
    fitReadable(cy);
    expect(cy.zoom()).toBeGreaterThanOrEqual(MIN_READABLE_ZOOM);
    expect(measureUnitLevel(cy).minLabelPx).toBeGreaterThanOrEqual(8);
    expect(ARCHITECTURE_FONT_SIZE * MIN_READABLE_ZOOM).toBeCloseTo(8);
  });
});
