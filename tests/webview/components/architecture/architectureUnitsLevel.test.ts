import cytoscape from "cytoscape";
import ELK from "elkjs/lib/elk.bundled.js";
import { describe, expect, it, vi } from "vitest";
import type { ArchitectureSummaryMessage, ArchitectureUnitLevel } from "@/shared/architecture-types";
import {
  applyMinImports,
  applyRoleFilter,
  ARCHITECTURE_FONT_SIZE,
  cappedUnitEdges,
  fitReadable,
  levelSummary,
  linkedElements,
  measureIsolated,
  markNodes,
  measureInteraction,
  measureUnitLevel,
  nearestNode,
  describeNode,
  layerBands,
  bandLabel,
  packBelow,
  packIsolatedGroups,
  placeNewFiles,
  MIN_READABLE_ZOOM,
  roleBadge,
  toLevelElements,
  unitColor,
  UNIT_EDGES_PER_UNIT,
} from "@/webview/components/architecture/architectureElements";
import { applyElkLayout, applyRoutes, toElkGraph } from "@/webview/components/architecture/elkLayout";
import { buildArchitectureStylesheet } from "@/webview/components/cytoscape/CytoscapeTheme";

const colors = { foreground: "#fff", background: "#000", border: "#888", edge: "#888", accent: "#08f", error: "#f00", findMatch: "rgb(234, 92, 0)", findMatchOpacity: 0.4, contrastBorder: "#6fc3df" };

// web → ui → core ↔ types (cycle), web → core; tool stands alone. Groups: web/pages (1), ui (2), core (3), types (4), tool (5).
const units: ArchitectureUnitLevel = {
  units: [
    { key: "apps/web", name: "@ws/web", fileCount: 3, internalEdgeCount: 1, layer: 2, role: "frontend", confidence: "inferred", evidence: [{ role: "frontend", detail: "`react` in dependencies" }, { role: "frontend", detail: "`index.html`" }] },
    { key: "packages/ui", name: "@ws/ui", fileCount: 1, internalEdgeCount: 0, layer: 1, role: "library", confidence: "declared", evidence: [{ role: "library", detail: 'declared by roles["@ws/ui"] in graphit.architecture.json' }, { role: "library", detail: "imported by `@ws/web`" }] },
    { key: "packages/core", name: "@ws/core", fileCount: 1, internalEdgeCount: 0, layer: 0, role: "library", confidence: "inferred", evidence: [{ role: "library", detail: "imported by `@ws/types`, `@ws/ui`, `@ws/web`" }] },
    { key: "packages/types", name: "@ws/types", fileCount: 1, internalEdgeCount: 0, layer: 0, role: "library", confidence: "inferred", evidence: [{ role: "library", detail: "imported by `@ws/core`" }] },
    { key: "tool", name: "tool", fileCount: 1, internalEdgeCount: 0, layer: 0, role: "unknown", confidence: "inferred", evidence: [] },
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
  roleCounts: { frontend: 1, library: 3, unknown: 1 },
  totals: { files: 7, fileEdges: 7, intraUnitEdges: 1, interUnitEdges: 6 },
  groupUnits: { 1: "apps/web", 2: "apps/web", 3: "packages/ui", 4: "packages/core", 5: "packages/types", 6: "tool" },
  groupLayers: { 1: 1, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
  groupEdgeKinds: { "1>2": "down" },
  nestedGroups: [],
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

  it("states an entered unit's hidden groups and edges, and only its isolated groups", () => {
    const capped = {
      ...summary,
      isolatedGroups: [2, 6],
      units: { ...units, groupsByUnit: { "apps/web": { totalGroups: 5, hiddenGroups: 3, hiddenGroupEdges: 4 } } },
    };
    expect(levelSummary(capped, "apps/web")).toMatchObject({ totalGroups: 5, hiddenGroups: 3, hiddenGroupEdges: 4, isolatedGroups: [2] });
    expect(levelSummary(capped, "tool")).toMatchObject({ totalGroups: 1, hiddenGroups: 0, hiddenGroupEdges: 0, isolatedGroups: [6] });
    expect(levelSummary(capped, null).isolatedGroups).toEqual([]);
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

  it("badges each unit with its role, and lists the role's evidence in its tooltip", () => {
    const nodes = toLevelElements(summary, null).filter(element => element.group === "nodes").map(element => element.data);
    expect(nodes.map(node => [node.role, String(node.label).split("\n")[0]])).toEqual([
      ["frontend", "[frontend?]"], ["library", "[library]"], ["library", "[library?]"], ["library", "[library?]"], ["unknown", "[unknown?]"],
    ]);
    expect(nodes[0].tooltip).toBe("apps/web\n3 files\n1 internal edge\nRole: frontend (inferred)\n- `react` in dependencies\n- `index.html`");
    expect(nodes[1].tooltip).toContain('Role: library (declared)\n- declared by roles["@ws/ui"] in graphit.architecture.json\n- imported by `@ws/web`');
    expect(nodes[4].tooltip).toContain("Role: unknown (inferred)\n- no evidence");
    // Evidence for another role than the unit's says which.
    const mixed = { ...units.units[0], evidence: [...units.units[0].evidence, { role: "library" as const, detail: "imported by `x`" }] };
    const withMixed = { ...summary, units: { ...units, units: [mixed, ...units.units.slice(1)] } };
    expect(toLevelElements(withMixed, null)[0].data.tooltip).toContain("\n- library: imported by `x`");
    expect(roleBadge({ role: "service", confidence: "declared" })).toBe("[service]");
  });

  it("filters the units by role, hiding the others and their edges, and measures what is left", () => {
    const cy = canvas();
    expect(applyRoleFilter(cy, "library")).toBe(3);
    expect(cy.nodes().filter(node => node.visible()).map(node => node.data("unitKey"))).toEqual(["packages/ui", "packages/core", "packages/types"]);
    expect(cy.edges().filter(edge => edge.visible()).map(edge => edge.id())).toEqual(["edge-3-4", "edge-4-3", "edge-2-3"]);
    expect(measureUnitLevel(cy)).toMatchObject({ units: 5, roleBadges: 5, roleTooltips: 5, shownUnits: 3 });
    expect(applyRoleFilter(cy, null)).toBe(5);
    expect(cy.elements(".filtered")).toHaveLength(0);
    // Groups of an entered unit have no role: a filter leaves them drawn.
    const inside = canvas(toLevelElements(summary, "apps/web"));
    expect(applyRoleFilter(inside, "library")).toBe(0);
    expect(inside.nodes(".filtered")).toHaveLength(0);
  });

  it("draws the edges breaking a declared rule red and dashed, with their rules, at the units and group levels", () => {
    const totals = { files: 7, unmatchedFiles: 0, rules: 1, brokenRules: 1, violations: 2, newViolations: 2, errors: 2, newErrors: 2, warnings: 0, resolved: 0 };
    const ruled: ArchitectureSummaryMessage = {
      ...summary,
      rules: { configFile: "graphit.architecture.json", totals, rules: [], configWarnings: [], unitEdges: { "apps/web>packages/core": ["web-not-core"] }, groupEdges: { "1>2": ["inner"] } },
    };
    const cy = canvas(toLevelElements(ruled, null));
    const violating = cy.edges("[?violation]");
    expect(violating.map(edge => edge.id())).toEqual(["edge-1-3"]);
    expect(violating[0].data("tooltip")).toContain("Breaks: web-not-core");
    expect(violating[0].style("line-style")).toBe("dashed");
    expect(violating[0].style("line-color")).toBe("rgb(255,0,0)");
    expect(cy.edges("[!violation]").every(edge => edge.style("line-style") === "solid")).toBe(true);
    const inUnit = toLevelElements(ruled, "apps/web").filter(element => element.group === "edges");
    expect(inUnit.map(element => [element.data.id, element.data.rules])).toEqual([["edge-1-2", ["inner"]]]);
    // Without a violation, the rules leave the elements as they are.
    expect(toLevelElements({ ...ruled, rules: { ...ruled.rules!, totals: { ...totals, violations: 0 } } }, null)).toEqual(toLevelElements(summary, null));
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

  it("never hides an edge breaking a declared rule", () => {
    const many: ArchitectureUnitLevel = {
      ...units,
      units: units.units.slice(0, 1),
      unitEdges: Array.from({ length: UNIT_EDGES_PER_UNIT + 1 }, (_, index) =>
        ({ from: "apps/web", to: `lib${index}`, fileEdgeCount: 9 - index, kind: "down" as const })),
    };
    const rules = { configFile: "graphit.architecture.json", rules: [], configWarnings: [], groupEdges: {}, unitEdges: { [`apps/web>lib${UNIT_EDGES_PER_UNIT}`]: ["r"] } };
    expect(cappedUnitEdges(many, rules).size).toBe(0);
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

describe("isolated groups", () => {
  it("packs boxes in rows below the other groups, left-aligned and wrapped at their width", () => {
    const boxes = [0, 1, 2].map(() => ({ x: 0, y: 0, width: 300, height: 40 }));
    packBelow(boxes, { x1: -100, x2: 600, y2: 200 });
    expect(boxes.map(({ x, y }) => [x, y])).toEqual([[50, 268], [362, 268], [50, 320]]);
  });

  it("packs about square without other groups, never narrower than a few groups", () => {
    const boxes = Array.from({ length: 9 }, () => ({ x: 0, y: 0, width: 88, height: 88 }));
    packBelow(boxes);
    expect(new Set(boxes.map(box => box.y)).size).toBe(3);
    expect(boxes[0]).toMatchObject({ x: 44, y: 44 });
    const one = [{ x: 0, y: 0, width: 50, height: 50 }];
    packBelow(one);
    expect(one[0]).toMatchObject({ x: 25, y: 25 });
  });

  it("leaves them out of the ELK layout, packs them below the laid-out groups, and measures it", async () => {
    // tool (group 6) has no edge inside its unit; at the units level nothing is isolated.
    const level = { ...summary, isolatedGroups: [6], units: { ...units, groupUnits: { ...units.groupUnits, 6: "apps/web" } } };
    const cy = canvas(toLevelElements(level, "apps/web"));
    expect(cy.nodes("[?isolated]").map(node => node.id())).toEqual(["group-6"]);
    expect(toElkGraph(cy).children?.map(child => child.id)).toEqual(["group-1", "group-2"]);
    expect(linkedElements(cy).nodes().map(node => node.id())).toEqual(["group-1", "group-2"]);
    await layOut(cy);
    packIsolatedGroups(cy);
    const tool = cy.getElementById("group-6").boundingBox({ includeLabels: false });
    const linked = cy.nodes().not("[?isolated]").boundingBox({ includeLabels: false });
    expect(tool.y1).toBeGreaterThan(linked.y2);
    expect(measureIsolated(cy)).toEqual({ isolatedBelow: 1, minLabelPx: ARCHITECTURE_FONT_SIZE });
  });

  it("moves an expanded isolated group with its files, and does nothing without isolated groups", () => {
    // Styled: a compound's box follows its files.
    const cy = cytoscape({
      headless: true,
      styleEnabled: true,
      style: buildArchitectureStylesheet(colors),
      layout: { name: "preset" },
      elements: [
        { group: "nodes", data: { id: "a" }, position: { x: 0, y: 0 } },
        { group: "nodes", data: { id: "b", isolated: true } },
        { group: "nodes", data: { id: "f", parent: "b" }, position: { x: 500, y: -500 } },
      ],
    });
    packIsolatedGroups(cy);
    expect(cy.getElementById("f").position("y")).toBeGreaterThan(0);
    expect(linkedElements(cy).map(element => element.id())).toEqual(["a"]);
    const plain = cytoscape({ headless: true, layout: { name: "preset" }, elements: [{ group: "nodes", data: { id: "a" }, position: { x: 3, y: 4 } }] });
    packIsolatedGroups(plain);
    expect(plain.getElementById("a").position()).toEqual({ x: 3, y: 4 });
    expect(measureIsolated(plain).isolatedBelow).toBe(0);
  });
});

describe("cycle blocks, layer bands and contrast (units level)", () => {
  // core ↔ types is the one cycle the extension sends.
  const cyclic = { ...summary, units: { ...units, cycleUnits: [["packages/core", "packages/types"]] } };
  const white = { r: 255, g: 255, b: 255, a: 1 };

  it("draws each cycle as one block around its units, titled with their count, without recomputing it", () => {
    const nodes = toLevelElements(cyclic, null).filter(element => element.group === "nodes").map(element => element.data);
    expect(nodes[0]).toMatchObject({ id: "cycle-0", cycle: true, label: "Cycle · 2 units", layer: 0, key: "cycle:packages/core|packages/types" });
    expect(nodes.filter(node => node.parent === "cycle-0").map(node => node.unitKey)).toEqual(["packages/core", "packages/types"]);
    // Without cycleUnits, no block: the webview never derives one from the edge kinds.
    expect(toLevelElements(summary, null).some(element => element.data.cycle)).toBe(false);
    // A unit without any unit edge says so.
    expect(String(nodes.find(node => node.unitKey === "tool")?.tooltip)).toContain("\nNo cross-unit imports");
  });

  it("lays the block out with ELK, keeps every down edge going down, and measures bands, blocks and red labels", async () => {
    const cy = canvas(toLevelElements(cyclic, null));
    await layOut(cy);
    const measured = measureUnitLevel(cy, white);
    // web (2), ui (1), core/types/tool (0): three layers, every unit inside its band.
    expect(measured).toMatchObject({
      units: 5, cycleBlocks: 1, cycleMembersOutside: 0, layerBands: 3, unitsOutsideBand: 0, edgesNotDown: 0,
      redEdges: 2, labelledRedEdges: 2,
    });
    const block = cy.getElementById("cycle-0");
    const box = block.boundingBox({ includeLabels: false });
    for (const member of block.children().toArray()) {
      const { x, y } = member.position();
      expect(x > box.x1 && x < box.x2 && y > box.y1 && y < box.y2).toBe(true);
    }
    // Bands tile the picture top to bottom, highest layer first.
    const bands = layerBands(cy);
    expect(bands.map(band => band.layer)).toEqual([2, 1, 0]);
    for (let i = 1; i < bands.length; i++) expect(bands[i].y1).toBe(bands[i - 1].y2);
    expect([bandLabel(2), bandLabel(0)]).toEqual(["Layer 2", "Layer 0 · shared"]);
  });

  it("counts a cycle unit the extension sent but drawn outside its block", () => {
    const cy = canvas(toLevelElements(cyclic, null));
    expect(measureUnitLevel(cy).cycleMembersOutside).toBe(0);
    cy.getElementById("group-4").move({ parent: null });
    expect(measureUnitLevel(cy).cycleMembersOutside).toBe(1);
  });

  it("never lays out a cycle block's units as new files of an expanded group (a redraw keeps them where ELK put them)", async () => {
    const cy = canvas(toLevelElements(cyclic, null));
    await layOut(cy);
    const before = cy.nodes().map(node => `${node.id()}@${node.position("x")},${node.position("y")}`);
    placeNewFiles(cy, new Map(), () => ({ x: 5000, y: 5000 }));
    expect(cy.nodes().map(node => `${node.id()}@${node.position("x")},${node.position("y")}`)).toEqual(before);
  });

  it("leaves a block of filtered units, and hidden nodes, out of the bands and the picture", () => {
    const cy = canvas(toLevelElements(cyclic, null));
    applyRoleFilter(cy, "frontend");
    expect(cy.getElementById("cycle-0").hasClass("filtered")).toBe(true);
    expect(layerBands(cy).map(band => band.layer)).toEqual([2]);
    applyRoleFilter(cy, null);
    expect(cy.getElementById("cycle-0").hasClass("filtered")).toBe(false);
  });

  it("measures the lowest label contrast over the fill blended on the background", () => {
    const light = cytoscape({
      headless: true, styleEnabled: true, elements: toLevelElements(cyclic, null),
      style: buildArchitectureStylesheet({ ...colors, foreground: "#3b3b3b" }, "vscode-light"),
    });
    expect(measureUnitLevel(light, white).minLabelContrast).toBeGreaterThanOrEqual(4.5);
    // Without a background colour, nothing is measured.
    expect(measureUnitLevel(light).minLabelContrast).toBeUndefined();
    // A label in the fill's own colour fails, and the measure says so.
    const unreadable = cytoscape({
      headless: true, styleEnabled: true, elements: toLevelElements(cyclic, null),
      style: [...buildArchitectureStylesheet({ ...colors, foreground: "#ffffff" }, "vscode-light")],
    });
    expect(measureUnitLevel(unreadable, white).minLabelContrast).toBeLessThan(4.5);
  });

  it("rings selected and found nodes in the accent colour, never in the unit's", () => {
    const cy = canvas(toLevelElements(cyclic, null));
    markNodes(cy, "selected", cy.getElementById("group-1"));
    markNodes(cy, "found", cy.getElementById("group-2").union(cy.getElementById("group-3")));
    expect(measureInteraction(cy)).toMatchObject({ selectedGroups: 1, foundGroups: 2, ringedGroups: 3 });
    for (const id of ["group-1", "group-2"]) {
      expect(Number.parseFloat(cy.getElementById(id).style("border-width"))).toBeGreaterThanOrEqual(3);
      expect(cy.getElementById(id).style("border-color")).not.toBe(cy.getElementById(id).style("background-color"));
    }
    // A new mark replaces the previous one.
    markNodes(cy, "selected", cy.getElementById("group-4"));
    expect(cy.nodes(".selected").map(node => node.id())).toEqual(["group-4"]);
    markNodes(cy, "found", cy.collection());
    expect(measureInteraction(cy)).toMatchObject({ selectedGroups: 1, foundGroups: 0, ringedGroups: 1 });
  });

  it("moves the selection to the nearest node in an arrow's direction, and describes it", async () => {
    const cy = canvas(toLevelElements(cyclic, null));
    await layOut(cy);
    const groups = cy.nodes().filter(node => !node.data("cycle"));
    // No selection: the top-left node, here the web app on the top layer.
    const first = nearestNode(groups, undefined, "ArrowDown");
    expect(first?.id()).toBe("group-1");
    const below = nearestNode(groups, first, "ArrowDown");
    expect(below?.data("layer")).toBeLessThan(2);
    expect(nearestNode(groups, first, "ArrowUp")).toBeUndefined();
    const core = cy.getElementById("group-3");
    expect(describeNode(core)).toBe("@ws/core, layer 0, 1 outgoing, 3 incoming, in cycle");
    expect(describeNode(cy.getElementById("group-1"))).toBe("@ws/web, layer 2, 2 outgoing, 0 incoming");
    for (const direction of ["ArrowLeft", "ArrowRight"] as const) {
      const next = nearestNode(groups, core, direction);
      if (next) expect(Math.abs(next.position("y") - core.position("y"))).toBeLessThanOrEqual(Math.abs(next.position("x") - core.position("x")));
    }
  });
});
