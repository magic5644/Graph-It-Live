import { overviewArchitecture } from "@/analyzer/architecture/ArchitectureExplorer";
import type { ArchitectureGraph } from "@/analyzer/architecture/ArchitectureGraphBuilder";
import { aggregateCommunityGroups } from "@/analyzer/community/groupAggregation";
import type { ArchitectureSummaryMessage } from "@/shared/architecture-types";
import type { GraphData } from "@/shared/graph-types";
import { toArchitectureElements } from "@/webview/components/architecture/architectureElements";
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
    expect(nodes.find(node => node.data.id === "group-0")?.data.unassigned).toBe(true);
    expect(edges.map(edge => [edge.data.source, edge.data.target, edge.data.label])).toEqual([
      ["group-0", "group-1", "1"],
      ["group-1", "group-2", "2"],
    ]);
    expect(edges[1].data.tooltip).toBe("ui → store\n2 file imports");
  });

  it("scales node size and edge width on a log scale", () => {
    const [store, ui] = toArchitectureElements(summaryOf(graphData));
    expect(Number(store.data.size)).toBeGreaterThan(Number(ui.data.size));
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
