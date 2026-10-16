import { overviewArchitecture } from "@/analyzer/architecture/ArchitectureExplorer";
import type { ArchitectureGraph } from "@/analyzer/architecture/ArchitectureGraphBuilder";
import { aggregateCommunityGroups } from "@/analyzer/community/groupAggregation";
import type { ArchitectureSummaryMessage } from "@/shared/architecture-types";
import type { GraphData } from "@/shared/graph-types";
import {
  applyMinImports,
  ARCHITECTURE_FCOSE_LAYOUT,
  findGroups,
  highlightFocus,
  type LayoutBox,
  measureInteraction,
  nodeBox,
  separateOverlaps,
  toArchitectureElements,
} from "@/webview/components/architecture/architectureElements";
import { buildArchitectureStylesheet } from "@/webview/components/cytoscape/CytoscapeTheme";
import cytoscape from "cytoscape";
// eslint-disable-next-line @typescript-eslint/no-require-imports
cytoscape.use(require("cytoscape-fcose"));
import { describe, expect, it } from "vitest";

// ui/a imports store/b and store/c; main stays unassigned and imports ui/a. Raw Windows
// paths in nodes and edges; nodeMetadata keys are normalized, as computeNodeMetadata writes them.
const graphData: GraphData = {
  nodes: [String.raw`C:\ui\a.ts`, String.raw`C:\store\b.ts`, String.raw`C:\store\c.ts`, String.raw`C:\main.ts`],
  edges: [
    { source: String.raw`C:\ui\a.ts`, target: String.raw`C:\store\b.ts` },
    { source: String.raw`C:\ui\a.ts`, target: String.raw`C:\store\c.ts` },
    { source: String.raw`C:\main.ts`, target: String.raw`C:\ui\a.ts` },
  ],
  nodeMetadata: {
    "c:/ui/a.ts": { communityId: 1, communityKey: "ui" },
    "c:/store/b.ts": { communityId: 2, communityKey: "store" },
    "c:/store/c.ts": { communityId: 2, communityKey: "store" },
    "c:/main.ts": { communityId: 0, communityKey: "" },
  },
} as GraphData;

function summaryOf(data: GraphData): ArchitectureSummaryMessage {
  const graph = { context: { revision: "r1", communityMode: "path" }, graphData: data, scannedFiles: 4, analyzedFiles: 4 } as unknown as ArchitectureGraph;
  return { type: "architectureSummary", revision: "r1", stale: false, ...overviewArchitecture(graph, 150) };
}

describe("toArchitectureElements", () => {
  it("renders one node per group plus unassigned and one edge per group edge", () => {
    const aggregation = aggregateCommunityGroups(graphData);
    const elements = toArchitectureElements(summaryOf(graphData));
    const nodes = elements.filter(element => element.group === "nodes");
    const edges = elements.filter(element => element.group === "edges");

    expect(nodes).toHaveLength(aggregation.groups.length + 1);
    expect(edges).toHaveLength(aggregation.groupEdges.length);
    expect(nodes.map(node => node.data.label)).toEqual(["store\n2 files", "ui\n1 file", "unassigned\n1 file"]);
    expect(nodes.find(node => node.data.id === "group-0")?.data).toMatchObject({ unassigned: true, key: "path:" });
    expect(edges.map(edge => [edge.data.source, edge.data.target, edge.data.label])).toEqual([
      ["group-0", "group-1", "1"],
      ["group-1", "group-2", "2"],
    ]);
    expect(edges[1].data.tooltip).toBe("ui → store\n2 file imports");
  });

  it("scales node size and edge width on a log scale", () => {
    const [store, ui] = toArchitectureElements(summaryOf(graphData));
    expect(store.data).toMatchObject({ key: "path:store", width: 65, height: 54, textWidth: 49 });
    expect(Number(store.data.height)).toBeGreaterThan(Number(ui.data.height));
    const edges = toArchitectureElements(summaryOf(graphData)).filter(element => element.group === "edges");
    expect(edges.map(edge => edge.data.width)).toEqual([1, 2]);
  });

  it("omits the unassigned node when every file has a group", () => {
    const grouped = {
      ...graphData,
      nodes: graphData.nodes.slice(0, 3),
      edges: graphData.edges.slice(0, 2),
    } as GraphData;
    const elements = toArchitectureElements(summaryOf(grouped));
    expect(elements.some(element => element.data.id === "group-0")).toBe(false);
    expect(elements.filter(element => element.group === "nodes")).toHaveLength(2);
  });
});

describe("nodeBox", () => {
  it("keeps the file-count side for a short label", () => {
    expect(nodeBox(["ui", "1 file"], 60)).toEqual({ width: 60, height: 60, textWidth: 44 });
  });

  it("widens the node to the label, then wraps it and grows the height", () => {
    const wide = nodeBox(["dynamic-import", "2 files"], 54);
    expect(wide).toEqual({ width: 14 * 7 + 16, height: 54, textWidth: 14 * 7 });

    // 60 characters wrap over 3 lines of at most 140px, plus the file-count line.
    const long = nodeBox(["x".repeat(60), "2 files"], 54);
    expect(long).toEqual({ width: 156, height: 4 * 11 + 16, textWidth: 140 });
  });

  it("counts an empty label as one line and spaces as characters", () => {
    expect(nodeBox(["", "1 file"], 60)).toEqual({ width: 60, height: 60, textWidth: 44 });
    expect(nodeBox(["a b c d e f g h i j k l m n o p q r s t u v w x y z", "2 files"], 54).height).toBe(4 * 11 + 16);
  });
});

describe("separateOverlaps", () => {
  const intersect = (a: LayoutBox, b: LayoutBox) =>
    Math.abs(a.x - b.x) < (a.width + b.width) / 2 && Math.abs(a.y - b.y) < (a.height + b.height) / 2;
  const overlaps = (boxes: LayoutBox[]) =>
    boxes.flatMap((a, i) => boxes.slice(i + 1).filter((b) => intersect(a, b))).length;

  it("pushes stacked and crossing boxes apart along the shallowest axis", () => {
    const stacked = [0, 1, 2, 3].map(() => ({ x: 0, y: 0, width: 50, height: 50 }));
    const wide = [{ x: 0, y: 0, width: 200, height: 20 }, { x: 10, y: 5, width: 200, height: 20 }];
    separateOverlaps(stacked);
    separateOverlaps(wide);
    expect(overlaps(stacked)).toBe(0);
    expect(wide.map((box) => box.x)).toEqual([0, 10]);
    expect(wide[1].y - wide[0].y).toBeGreaterThanOrEqual(20 + 12);
    const tall = [{ x: 0, y: 0, width: 20, height: 200 }, { x: -5, y: 10, width: 20, height: 200 }];
    separateOverlaps(tall);
    expect(tall.map((box) => box.y)).toEqual([0, 10]);
    expect(tall[0].x - tall[1].x).toBeGreaterThanOrEqual(20 + 12);
  });

  it("leaves boxes that already keep their gap where they are", () => {
    const boxes = [{ x: 0, y: 0, width: 50, height: 50 }, { x: 0, y: -62, width: 50, height: 50 }];
    separateOverlaps(boxes);
    expect(boxes.map((box) => box.y)).toEqual([0, -62]);
  });

  it("accepts no box and a single box", () => {
    const single = [{ x: 3, y: 4, width: 50, height: 50 }];
    expect(() => separateOverlaps([])).not.toThrow();
    separateOverlaps(single);
    expect(single).toEqual([{ x: 3, y: 4, width: 50, height: 50 }]);
  });

  it("stops after maxRounds", () => {
    const boxes = [0, 1, 2].map(() => ({ x: 0, y: 0, width: 50, height: 50 }));
    separateOverlaps(boxes, 0);
    expect(overlaps(boxes)).toBe(3);
  });

  it("leaves no overlap after a real fcose layout of 150 groups of very different sizes", () => {
    const groups = Array.from({ length: 150 }, (_, index) => ({
      id: index + 1,
      key: `packages/some-rather-long-folder-name-${index}`,
      label: `packages/some-rather-long-folder-name-${index}`,
      fileCount: Math.round(900 / (index + 1)) + 1,
      internalEdgeCount: 0,
    }));
    const groupEdges = groups.slice(1).map((group, index) => ({
      from: group.id,
      to: (index * 7) % group.id + 1,
      fileEdgeCount: 1 + (index % 9),
      fromLabel: group.label,
      toLabel: "",
    }));
    const summary = { ...summaryOf(graphData), groups, groupEdges, unassigned: { fileCount: 0, internalEdgeCount: 0 } };
    const colors = { foreground: "#fff", background: "#000", border: "#888", edge: "#888", accent: "#08f" };
    const cy = cytoscape({ headless: true, styleEnabled: true, style: buildArchitectureStylesheet(colors), elements: toArchitectureElements(summary) });
    cy.layout(ARCHITECTURE_FCOSE_LAYOUT as cytoscape.LayoutOptions).run();
    const boxes = cy.nodes().map((node) => ({ ...node.position(), width: node.outerWidth(), height: node.outerHeight() }));
    separateOverlaps(boxes);
    expect(boxes).toHaveLength(150);
    expect(overlaps(boxes)).toBe(0);
    cy.destroy();
  });
});

describe("highlight, find and min-imports filter", () => {
  const colors = { foreground: "#fff", background: "#000", border: "#888", edge: "#888", accent: "#08f" };
  // group-0 (unassigned main) → group-1 (ui): 1 import; group-1 (ui) → group-2 (store): 2 imports.
  const createCy = () =>
    cytoscape({ headless: true, styleEnabled: true, style: buildArchitectureStylesheet(colors), elements: toArchitectureElements(summaryOf(graphData)) });

  it("draws no count label and fades nothing by default", () => {
    const cy = createCy();
    expect(measureInteraction(cy)).toEqual({ highlightedGroups: 0, fadedGroups: 0, labelledEdges: 0, shownGroupEdges: 2 });
    cy.destroy();
  });

  it("highlights a group's neighbourhood, labels its edges and fades the rest, then clears", () => {
    const cy = createCy();
    highlightFocus(cy, cy.$("#group-2"));
    expect(measureInteraction(cy)).toEqual({ highlightedGroups: 2, fadedGroups: 1, labelledEdges: 1, shownGroupEdges: 2 });
    expect(cy.$("#edge-1-2").style("label")).toBe("2");
    expect(cy.$("#edge-0-1").hasClass("faded")).toBe(true);

    highlightFocus(cy, cy.$("#group-1"));
    expect(measureInteraction(cy)).toMatchObject({ highlightedGroups: 3, fadedGroups: 0, labelledEdges: 2 });

    highlightFocus(cy, cy.collection());
    expect(measureInteraction(cy)).toEqual({ highlightedGroups: 0, fadedGroups: 0, labelledEdges: 0, shownGroupEdges: 2 });
    cy.destroy();
  });

  it("highlights a hovered edge with the two groups at its ends", () => {
    const cy = createCy();
    highlightFocus(cy, cy.$("#edge-0-1"));
    expect(measureInteraction(cy)).toEqual({ highlightedGroups: 2, fadedGroups: 1, labelledEdges: 1, shownGroupEdges: 2 });
    expect(cy.$("#group-2").hasClass("faded")).toBe(true);
    cy.destroy();
  });

  it("hides the edges below the min-imports threshold and leaves them out of the neighbourhood", () => {
    const cy = createCy();
    expect(applyMinImports(cy, 2)).toBe(1);
    expect(cy.$("#edge-0-1").style("display")).toBe("none");
    highlightFocus(cy, cy.$("#group-1"));
    expect(measureInteraction(cy)).toEqual({ highlightedGroups: 2, fadedGroups: 1, labelledEdges: 1, shownGroupEdges: 1 });

    applyMinImports(cy, 3);
    expect(measureInteraction(cy).shownGroupEdges).toBe(0);
    applyMinImports(cy, 1);
    expect(measureInteraction(cy).shownGroupEdges).toBe(2);
    cy.destroy();
  });

  it("handles a graph without edges and an empty graph", () => {
    const noEdges = { ...summaryOf(graphData), groupEdges: [] };
    for (const summary of [noEdges, { ...noEdges, groups: [], unassigned: { fileCount: 0, internalEdgeCount: 0 } }]) {
      const cy = cytoscape({ headless: true, styleEnabled: true, style: buildArchitectureStylesheet(colors), elements: toArchitectureElements(summary) });
      expect(applyMinImports(cy, 2)).toBe(0);
      highlightFocus(cy, findGroups(cy, "ui"));
      expect(measureInteraction(cy)).toEqual({
        highlightedGroups: cy.nodes().empty() ? 0 : 1,
        fadedGroups: cy.nodes().empty() ? 0 : 2,
        labelledEdges: 0,
        shownGroupEdges: 0,
      });
      cy.destroy();
    }
  });

  it("finds groups by label or key, case-insensitive, and nothing for a blank query", () => {
    const cy = createCy();
    expect(findGroups(cy, "  UI ").map((node) => node.id())).toEqual(["group-1"]);
    expect(findGroups(cy, "unassigned").map((node) => node.id())).toEqual(["group-0"]);
    expect(findGroups(cy, "   ").empty()).toBe(true);
    expect(findGroups(cy, "nope").empty()).toBe(true);
    cy.destroy();
  });
});
