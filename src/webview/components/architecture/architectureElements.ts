import type { ArchitectureSummaryMessage } from "../../../shared/architecture-types";

export interface ArchitectureElement {
  group: "nodes" | "edges";
  data: Record<string, string | number | boolean>;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Cytoscape elements for a summary, one node per group and one edge per group edge.
 * Pure mapping: groups, counts and the display cap all come from the extension.
 */
export function toArchitectureElements(summary: ArchitectureSummaryMessage): ArchitectureElement[] {
  const groups = summary.unassigned.fileCount > 0
    ? [...summary.groups, { id: 0, key: "", label: "unassigned", ...summary.unassigned }]
    : summary.groups;
  const nodes = groups.map((group): ArchitectureElement => ({
    group: "nodes",
    data: {
      id: `group-${group.id}`,
      label: `${group.label}\n${plural(group.fileCount, "file")}`,
      size: Math.round(32 + 14 * Math.log2(1 + group.fileCount)),
      unassigned: group.id === 0,
      tooltip: `${group.key || group.label}\n${plural(group.fileCount, "file")}\n${plural(group.internalEdgeCount, "internal edge")}`,
    },
  }));
  const edges = summary.groupEdges.map((edge): ArchitectureElement => ({
    group: "edges",
    data: {
      id: `edge-${edge.from}-${edge.to}`,
      source: `group-${edge.from}`,
      target: `group-${edge.to}`,
      label: String(edge.fileEdgeCount),
      width: Math.round((1 + Math.log2(edge.fileEdgeCount)) * 10) / 10,
      tooltip: `${edge.fromLabel} → ${edge.toLabel}\n${plural(edge.fileEdgeCount, "file import")}`,
    },
  }));
  return [...nodes, ...edges];
}
