import { exploreArchitecture, groupDetail, overviewArchitecture } from "@/analyzer/architecture/ArchitectureExplorer";
import type { ArchitectureGraph } from "@/analyzer/architecture/ArchitectureGraphBuilder";
import { aggregateCommunityGroups } from "@/analyzer/community/groupAggregation";
import type { ArchitectureSummaryMessage } from "@/shared/architecture-types";
import type { GraphData } from "@/shared/graph-types";
import {
  applyMinImports,
  ARCHITECTURE_FCOSE_LAYOUT,
  type Expansions,
  FILE_CAP_MESSAGE,
  MAX_RENDERED_FILES,
  mergeGroupDetail,
  placeNewFiles,
  renderedFileCount,
  findGroups,
  fitReadable,
  focusGroup,
  highlightFocus,
  type LayoutBox,
  measureInteraction,
  measureIsolated,
  nodeBox,
  separateOverlaps,
  toArchitectureElements,
} from "@/webview/components/architecture/architectureElements";
import { buildArchitectureStylesheet } from "@/webview/components/cytoscape/CytoscapeTheme";
import cytoscape from "cytoscape";
// eslint-disable-next-line @typescript-eslint/no-require-imports
cytoscape.use(require("cytoscape-fcose"));
import { describe, expect, it, vi } from "vitest";

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

  it("marks the isolated groups of the summary, the unassigned node included", () => {
    const summary = { ...summaryOf(graphData), isolatedGroups: [0, 2] };
    const isolated = toArchitectureElements(summary).filter((element) => element.data.isolated === true).map((element) => element.data.id);
    expect(isolated.sort()).toEqual(["group-0", "group-2"]);
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
    const colors = { foreground: "#fff", background: "#000", border: "#888", edge: "#888", accent: "#08f", error: "#f00" };
    const cy = cytoscape({ headless: true, styleEnabled: true, style: buildArchitectureStylesheet(colors), elements: toArchitectureElements(summary) });
    cy.layout(ARCHITECTURE_FCOSE_LAYOUT as cytoscape.LayoutOptions).run();
    const boxes = cy.nodes().map((node) => ({ ...node.position(), width: node.outerWidth(), height: node.outerHeight() }));
    separateOverlaps(boxes);
    expect(boxes).toHaveLength(150);
    expect(overlaps(boxes)).toBe(0);
    // Fitted in a small view, every label (the 20 largest and any highlighted group alike) is drawn at 8px or more.
    cy.nodes().forEach((node, index) => { node.position({ x: boxes[index].x, y: boxes[index].y }); });
    vi.spyOn(cy, "width").mockReturnValue(400);
    vi.spyOn(cy, "fit").mockImplementation(() => cy.zoom(0.35));
    fitReadable(cy);
    expect(measureIsolated(cy).minLabelPx).toBeGreaterThanOrEqual(8);
    cy.destroy();
  });
});

describe("highlight, find and min-imports filter", () => {
  const colors = { foreground: "#fff", background: "#000", border: "#888", edge: "#888", accent: "#08f", error: "#f00" };
  // group-0 (unassigned main) → group-1 (ui): 1 import; group-1 (ui) → group-2 (store): 2 imports.
  const createCy = () =>
    cytoscape({ headless: true, styleEnabled: true, style: buildArchitectureStylesheet(colors), elements: toArchitectureElements(summaryOf(graphData)) });

  it("draws no count label and fades nothing by default", () => {
    const cy = createCy();
    expect(measureInteraction(cy)).toEqual({ highlightedGroups: 0, fadedGroups: 0, labelledEdges: 0, shownGroupEdges: 2, shownFileEdges: 0 });
    cy.destroy();
  });

  it("highlights a group's neighbourhood, labels its edges and fades the rest, then clears", () => {
    const cy = createCy();
    highlightFocus(cy, cy.$("#group-2"));
    expect(measureInteraction(cy)).toEqual({ highlightedGroups: 2, fadedGroups: 1, labelledEdges: 1, shownGroupEdges: 2, shownFileEdges: 0 });
    expect(cy.$("#edge-1-2").style("label")).toBe("2");
    expect(cy.$("#edge-0-1").hasClass("faded")).toBe(true);

    highlightFocus(cy, cy.$("#group-1"));
    expect(measureInteraction(cy)).toMatchObject({ highlightedGroups: 3, fadedGroups: 0, labelledEdges: 2 });

    highlightFocus(cy, cy.collection());
    expect(measureInteraction(cy)).toEqual({ highlightedGroups: 0, fadedGroups: 0, labelledEdges: 0, shownGroupEdges: 2, shownFileEdges: 0 });
    cy.destroy();
  });

  it("highlights a hovered edge with the two groups at its ends", () => {
    const cy = createCy();
    highlightFocus(cy, cy.$("#edge-0-1"));
    expect(measureInteraction(cy)).toEqual({ highlightedGroups: 2, fadedGroups: 1, labelledEdges: 1, shownGroupEdges: 2, shownFileEdges: 0 });
    expect(cy.$("#group-2").hasClass("faded")).toBe(true);
    cy.destroy();
  });

  it("hides the edges below the min-imports threshold and leaves them out of the neighbourhood", () => {
    const cy = createCy();
    expect(applyMinImports(cy, 2)).toBe(1);
    expect(cy.$("#edge-0-1").style("display")).toBe("none");
    highlightFocus(cy, cy.$("#group-1"));
    expect(measureInteraction(cy)).toEqual({ highlightedGroups: 2, fadedGroups: 1, labelledEdges: 1, shownGroupEdges: 1, shownFileEdges: 0 });

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
        shownFileEdges: 0,
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

// a (3 files), b (3 files) and c (1 file). Most depended-on first, a pages as [a3, a1] then [a2],
// so the internal pair a1 → a2 crosses pages of 2 files; b pages as [b1, b2] then [b3].
const IMPORTS: Record<string, string[]> = {
  "a/a1.ts": ["b/b1.ts", "b/b2.ts", "a/a2.ts", "a/a3.ts"],
  "a/a2.ts": ["b/b3.ts", "c/c1.ts"],
  "a/a3.ts": ["b/b1.ts"],
  "b/b1.ts": ["a/a1.ts"],
  "b/b2.ts": [],
  "b/b3.ts": ["c/c1.ts"],
  "c/c1.ts": ["a/a3.ts"],
};
const GROUP_IDS: Record<string, number> = { a: 1, b: 2, c: 3 };

function detailGraph(): ArchitectureGraph {
  const files = Object.keys(IMPORTS);
  const groupOf = (file: string) => file.split("/")[0];
  const edges = files.flatMap(source => IMPORTS[source].map(target =>
    ({ source: `/w/${source}`, target: `/w/${target}`, sourceRelative: source, targetRelative: target })));
  const nodes = files.map(file => ({
    id: `/w/${file}`, path: `/w/${file}`, relativePath: file, extension: "ts",
    dependencyCount: IMPORTS[file].length,
    dependentCount: edges.filter(edge => edge.targetRelative === file).length,
    communityId: GROUP_IDS[groupOf(file)], communityKey: groupOf(file),
  }));
  const nodeMetadata = Object.fromEntries(nodes.map(node => [node.path, { communityId: node.communityId, communityKey: node.communityKey }]));
  return {
    context: { revision: "r1", communityMode: "path" },
    graphData: { nodes: nodes.map(node => node.path), edges, nodeMetadata },
    nodes, edges, scannedFiles: files.length, analyzedFiles: files.length,
  } as unknown as ArchitectureGraph;
}

describe("expanded groups", () => {
  const graph = detailGraph();
  const summary: ArchitectureSummaryMessage = { type: "architectureSummary", revision: "r1", stale: false, ...overviewArchitecture(graph, 150) };
  const expand = (pages: Record<number, number>, limit = 2) => {
    let expansions: Expansions = new Map();
    for (const [group, count] of Object.entries(pages)) {
      for (let index = 0; index < count; index++) {
        expansions = mergeGroupDetail(expansions, groupDetail(graph, Number(group), { offset: index * limit, limit })).expansions;
      }
    }
    return expansions;
  };
  const edgesOf = (elements: ReturnType<typeof toArchitectureElements>) => elements.filter(element => element.group === "edges");
  const nodeIds = (elements: ReturnType<typeof toArchitectureElements>) =>
    elements.filter(element => element.group === "nodes").map(element => element.data.id);

  /**
   * No id repeats, every edge joins drawn nodes and is labelled with what its evidence lists;
   * group edges are all kept, and once the expanded groups are fully loaded, the file edges of a
   * group edge touching one add up to its count.
   */
  function expectConserved(expansions: Expansions) {
    const elements = toArchitectureElements(summary, expansions);
    const ids = elements.map(element => element.data.id);
    expect(new Set(ids).size).toBe(ids.length);
    const nodes = new Set(nodeIds(elements));
    const drawn = new Map<string, number>();
    for (const edge of edgesOf(elements)) {
      expect(nodes.has(String(edge.data.source)) && nodes.has(String(edge.data.target))).toBe(true);
      const { from, to, sourceFile, targetFile } = edge.data as { from: number; to: number; sourceFile?: string; targetFile?: string };
      expect(edge.data.label).toBe(String(exploreArchitecture(graph, { from, to, sourceFile, targetFile }).page.total));
      expect(edge.data.fileEdge).toBe(sourceFile !== undefined || targetFile !== undefined);
      if (!edge.data.fileEdge) continue;
      const key = `${from}>${to}`;
      drawn.set(key, (drawn.get(key) ?? 0) + Number(edge.data.fileEdgeCount));
    }
    expect(edgesOf(elements).filter(edge => !edge.data.fileEdge).map(edge => edge.data.id))
      .toEqual(summary.groupEdges.map(edge => `edge-${edge.from}-${edge.to}`));
    const fullyLoaded = [...expansions.values()].every(expansion => expansion.nextOffset === undefined);
    for (const edge of summary.groupEdges) {
      const count = drawn.get(`${edge.from}>${edge.to}`) ?? 0;
      const touched = expansions.has(edge.from) || expansions.has(edge.to);
      if (fullyLoaded && touched) expect(count).toBe(edge.fileEdgeCount);
      else expect(count).toBeLessThanOrEqual(edge.fileEdgeCount);
    }
    return elements;
  }

  it("draws the same picture as the summary with nothing expanded", () => {
    expect(toArchitectureElements(summary, new Map())).toEqual(toArchitectureElements(summary));
    expectConserved(new Map());
  });

  it.each([
    [{ 1: 1 }], [{ 1: 2 }], [{ 2: 1 }], [{ 1: 1, 2: 1 }], [{ 1: 2, 2: 1 }], [{ 1: 1, 2: 2 }], [{ 1: 2, 2: 2 }],
    [{ 1: 2, 2: 2, 3: 1 }], [{ 3: 1 }], [{ 1: 1, 3: 1 }],
  ])("labels every edge with its evidence total and keeps every group edge, for pages %j", (pages) => {
    expectConserved(expand(pages));
  });

  it("draws a group's first page in a compound, with a +N more files node", () => {
    const elements = expectConserved(expand({ 1: 1 }));
    const ids = nodeIds(elements);

    expect(ids).toEqual(expect.arrayContaining(["group-1", "file:a/a3.ts", "file:a/a1.ts", "more-1"]));
    expect(ids).not.toContain("file:a/a2.ts");
    expect(elements.find(element => element.data.id === "more-1")?.data).toMatchObject({ parent: "group-1", label: "+1 more files" });
    expect(elements.find(element => element.data.id === "group-1")?.data).toMatchObject({ expanded: true, label: "a · 3 files" });
    // a1 → b1 and a1 → b2 go to the collapsed b, labelled with their count, with a1 as the evidence filter.
    expect(edgesOf(elements).find(edge => edge.data.id === "file:a/a1.ts->group-2")?.data)
      .toMatchObject({ label: "2", from: 1, to: 2, sourceFile: "a/a1.ts", fromName: "a/a1.ts", toName: "b" });
  });

  it("draws an internal pair once its target's page is loaded", () => {
    const pair = (elements: ReturnType<typeof toArchitectureElements>) =>
      edgesOf(elements).filter(edge => edge.data.id === "file:a/a1.ts->file:a/a2.ts");

    expect(pair(toArchitectureElements(summary, expand({ 1: 1 })))).toHaveLength(0);
    expect(pair(toArchitectureElements(summary, expand({ 1: 2 })))).toHaveLength(1);
  });

  it("keeps the group edges on an expanded group and flags its file edges", () => {
    const edges = edgesOf(toArchitectureElements(summary, expand({ 1: 2 })));
    expect(edges.filter(edge => !edge.data.fileEdge).map(edge => edge.data.source)).toContain("group-1");
    expect(edges.filter(edge => edge.data.fileEdge).length).toBeGreaterThan(0);
    expect(edgesOf(toArchitectureElements(summary, new Map())).every(edge => edge.data.fileEdge === false)).toBe(true);
  });

  it("focuses a group: only it, its files and what its edges reach stay drawn", () => {
    const colors = { foreground: "#000", background: "#fff", border: "#999", edge: "#888", accent: "#00f", error: "#f00" };
    const cy = cytoscape({ headless: true, styleEnabled: true, style: buildArchitectureStylesheet(colors), elements: toArchitectureElements(summary, expand({ 3: 1 })) });
    const shown = focusGroup(cy, cy.getElementById("group-3"));
    const visible = cy.nodes().filter(node => node.style("display") !== "none").map(node => node.id());

    // c imports a3 and is imported by a2 and b3: a and b stay, as compound-free groups.
    expect(shown.nodes().filter(node => !node.isChild()).map(node => node.id()).sort()).toEqual(["group-1", "group-2", "group-3"]);
    expect(visible).toContain("file:c/c1.ts");
    expect(focusGroup(cy, cy.collection())).toHaveLength(cy.elements().length);
    expect(cy.elements(".hidden")).toHaveLength(0);
    // File edges stay hidden until highlighted.
    expect(cy.edges("[?fileEdge]").filter(edge => edge.style("display") !== "none")).toHaveLength(0);
    highlightFocus(cy, cy.getElementById("file:c/c1.ts"));
    expect(cy.edges("[?fileEdge]").filter(edge => edge.style("display") !== "none").length).toBeGreaterThan(0);
  });

  it("shows file edges for a highlighted file only, whatever the min-imports filter, and counts drawn group edges", () => {
    const colors = { foreground: "#000", background: "#fff", border: "#999", edge: "#888", accent: "#00f", error: "#f00" };
    const cy = cytoscape({ headless: true, styleEnabled: true, style: buildArchitectureStylesheet(colors), elements: toArchitectureElements(summary, expand({ 1: 2 })) });
    const shownFileEdges = () => cy.edges("[?fileEdge]").filter(edge => edge.style("display") !== "none");

    // Hovering a group linked to the expanded one does not draw the files' edges into it.
    highlightFocus(cy, cy.getElementById("group-2"));
    expect(shownFileEdges()).toHaveLength(0);
    // a1 → b1 and a1 → b2 are one import each per file pair: the filter keeps them for a highlighted file.
    expect(applyMinImports(cy, 2)).toBe(cy.edges("[!fileEdge]").filter(edge => edge.data("fileEdgeCount") >= 2).length);
    highlightFocus(cy, cy.getElementById("file:a/a1.ts"));
    expect(shownFileEdges().length).toBeGreaterThan(0);

    applyMinImports(cy, 1);
    focusGroup(cy, cy.getElementById("group-3"));
    expect(applyMinImports(cy, 1)).toBe(cy.edges("[!fileEdge]").not(".hidden").length);
    expect(cy.edges("[!fileEdge]").not(".hidden").length).toBeLessThan(cy.edges("[!fileEdge]").length);
  });

  it("draws file → file edges between two expanded groups, and pairs with an unloaded file once it is loaded", () => {
    const both = edgesOf(expectConserved(expand({ 1: 2, 2: 2 })))
      .filter(edge => edge.data.fileEdge && [edge.data.from, edge.data.to].sort().join() === "1,2");
    expect(both.every(edge => String(edge.data.source).startsWith("file:") && String(edge.data.target).startsWith("file:"))).toBe(true);
    expect(both).toHaveLength(5);

    // b3 is not loaded: a2 → b3 waits for b's second page, no edge stands in for it.
    const partial = edgesOf(expectConserved(expand({ 1: 2, 2: 1 })));
    expect(partial.some(edge => String(edge.data.target) === "more-2" || String(edge.data.source) === "more-2")).toBe(false);
    expect(partial.some(edge => edge.data.id === "file:a/a2.ts->file:b/b3.ts")).toBe(false);
  });

  it("merges each page once and in order, and keeps counts from the full graph", () => {
    const first = groupDetail(graph, 1, { limit: 2 });
    const once = mergeGroupDetail(new Map(), first).expansions;
    const twice = mergeGroupDetail(once, first);
    const skipped = mergeGroupDetail(new Map(), groupDetail(graph, 1, { offset: 2, limit: 2 }));

    expect(twice).toEqual({ expansions: once, capReached: false });
    expect(skipped.expansions.size).toBe(0);
    expect(once.get(1)).toMatchObject({ total: 3, nextOffset: 2 });
    expect(renderedFileCount(once)).toBe(2);
    expect(toArchitectureElements(summary, once).filter(element => element.data.unassigned === false && element.data.id === "group-1")[0].data.label)
      .toBe("a · 3 files");
  });

  it(`refuses a page that would draw more than ${MAX_RENDERED_FILES} files`, () => {
    const page = (id: number, count: number) => ({
      ...groupDetail(graph, 1),
      group: { ...groupDetail(graph, 1).group, id },
      files: Array.from({ length: count }, (_, index) => ({ relativePath: `g${id}/f${index}.ts`, dependencyCount: 0, dependentCount: 0 })),
      internalPairs: [], outgoingPairs: [], outgoing: [], incoming: [],
      page: { total: count, offset: 0, returned: count, truncated: false, nextOffset: undefined, limit: 500 },
    });
    const full = mergeGroupDetail(new Map(), page(1, 300)).expansions;
    const refused = mergeGroupDetail(full, page(2, 201));

    expect(refused).toEqual({ expansions: full, capReached: true });
    expect(mergeGroupDetail(full, page(2, 200)).capReached).toBe(false);
    expect(FILE_CAP_MESSAGE).toBe("Collapse a group first (500 files shown)");
  });

  it("lays out only the files without a position: a first page around the group, the next one below", () => {
    const colors = { foreground: "#000", background: "#fff", border: "#999", edge: "#888", accent: "#00f", error: "#f00" };
    const headless = (expansions: Expansions) =>
      cytoscape({ headless: true, styleEnabled: true, style: buildArchitectureStylesheet(colors), elements: toArchitectureElements(summary, expansions) });
    const first = headless(expand({ 1: 1 }));
    placeNewFiles(first, new Map(), () => ({ x: 1000, y: 500 }));
    const box = first.$('[?file], [?more]').boundingBox();
    expect((box.x1 + box.x2) / 2).toBeCloseTo(1000, 0);

    const positions = new Map(first.$('[?file], [?more]').map(node => [node.id(), { ...node.position() }]));
    const second = headless(expand({ 1: 2 }));
    second.nodes().forEach(node => {
      const saved = positions.get(node.id());
      if (saved) node.position(saved);
    });
    placeNewFiles(second, positions, () => ({ x: 0, y: 0 }));
    for (const [id, saved] of positions) {
      if (second.getElementById(id).nonempty()) expect(second.getElementById(id).position()).toEqual(saved);
    }
    const added = second.getElementById("file:a/a2.ts");
    expect(added.position("y")).toBeGreaterThan(box.y2);
  });

  it("keys file nodes and edges by normalized paths, whatever the separators", () => {
    const detail = groupDetail(graph, 1, { limit: 2 });
    const windows = {
      ...detail,
      files: detail.files.map(file => ({ ...file, relativePath: file.relativePath.replaceAll("/", "\\") })),
      outgoing: detail.outgoing.map(entry => ({ ...entry, relativePath: entry.relativePath.replaceAll("/", "\\") })),
    };
    const elements = toArchitectureElements(summary, mergeGroupDetail(new Map(), windows).expansions);

    expect(nodeIds(elements)).toEqual(expect.arrayContaining(["file:a/a3.ts", "file:a/a1.ts"]));
    expect(edgesOf(elements).map(edge => String(edge.data.source))).toContain("file:a/a1.ts");
  });
});
