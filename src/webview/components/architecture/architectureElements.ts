import type { Collection, Core } from "cytoscape";
import type { ArchitectureSummaryMessage } from "../../../shared/architecture-types";

export interface ArchitectureElement {
  group: "nodes" | "edges";
  data: Record<string, string | number | boolean>;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Must match the node `font-size` of buildArchitectureStylesheet; Cytoscape draws one line per font size. */
export const ARCHITECTURE_FONT_SIZE = 11;
/** Wider than the average 11px sans-serif glyph, so the line count is never underestimated. */
const CHAR_WIDTH = 7;
const PADDING = 8;
const MAX_TEXT_WIDTH = 140;

/**
 * Node box that holds its wrapped label: the side grows with the file count, and a long
 * label widens the node up to MAX_TEXT_WIDTH, then wraps (`text-overflow-wrap: anywhere`).
 * "anywhere" breaks between any two characters, so spaces never waste line width and
 * characters × CHAR_WIDTH / textWidth bounds the line count.
 */
export function nodeBox(lines: readonly string[], size: number): { width: number; height: number; textWidth: number } {
  const widest = Math.max(...lines.map((line) => line.length)) * CHAR_WIDTH;
  const textWidth = Math.min(MAX_TEXT_WIDTH, Math.max(size - 2 * PADDING, widest));
  const lineCount = lines.reduce((total, line) => total + Math.max(1, Math.ceil((line.length * CHAR_WIDTH) / textWidth)), 0);
  return {
    width: textWidth + 2 * PADDING,
    height: Math.max(size, lineCount * ARCHITECTURE_FONT_SIZE + 2 * PADDING),
    textWidth,
  };
}

/**
 * fcose options for the group graph: the repulsion grows with the node area so big groups
 * push each other apart. "proof" quality cost ~40% more time for no gain once
 * separateOverlaps runs, so the default quality stays.
 */
export const ARCHITECTURE_FCOSE_LAYOUT = {
  name: "fcose",
  animate: false,
  randomize: true,
  quality: "default",
  nodeDimensionsIncludeLabels: true,
  nodeSeparation: 120,
  idealEdgeLength: 160,
  nodeRepulsion: (node: { width(): number; height(): number }) => 4500 * Math.max(1, (node.width() * node.height()) / 2500),
  tilingPaddingVertical: 40,
  tilingPaddingHorizontal: 40,
};

/** A node's centre and outer size, in model coordinates. */
export interface LayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const GAP = 12;

/** Moves a and b apart along their shallowest overlap axis; false when they already keep GAP. */
function pushApart(a: LayoutBox, b: LayoutBox): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const overlapX = (a.width + b.width) / 2 + GAP - Math.abs(dx);
  const overlapY = (a.height + b.height) / 2 + GAP - Math.abs(dy);
  if (overlapX <= 0 || overlapY <= 0) return false;
  if (overlapX < overlapY) {
    const shift = (dx < 0 ? -overlapX : overlapX) / 2;
    a.x -= shift;
    b.x += shift;
  } else {
    const shift = (dy < 0 ? -overlapY : overlapY) / 2;
    a.y -= shift;
    b.y += shift;
  }
  return true;
}

/**
 * fcose only discourages overlaps, so big groups can still land on each other: push
 * overlapping boxes apart until none is left. O(n²) per round, fine for ~150 groups.
 */
export function separateOverlaps(boxes: LayoutBox[], maxRounds = 200): void {
  for (let round = 0; round < maxRounds; round++) {
    let moved = false;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        moved = pushApart(boxes[i], boxes[j]) || moved;
      }
    }
    if (!moved) return;
  }
}

/**
 * Cytoscape elements for a summary, one node per group and one edge per group edge.
 * Pure mapping: groups, counts and the display cap all come from the extension.
 */
export function toArchitectureElements(summary: ArchitectureSummaryMessage): ArchitectureElement[] {
  const groups = summary.unassigned.fileCount > 0
    ? [...summary.groups, { id: 0, key: "", label: "unassigned", ...summary.unassigned }]
    : summary.groups;
  const nodes = groups.map((group): ArchitectureElement => {
    const lines = [group.label, plural(group.fileCount, "file")];
    return {
      group: "nodes",
      data: {
        id: `group-${group.id}`,
        // Group ids are per build; the key is what a group keeps across builds.
        key: `${summary.context.communityMode}:${group.key}`,
        label: lines.join("\n"),
        ...nodeBox(lines, Math.round(32 + 14 * Math.log2(1 + group.fileCount))),
        unassigned: group.id === 0,
        search: `${group.label}\n${group.key}`.toLowerCase(),
        tooltip: `${group.key || group.label}\n${plural(group.fileCount, "file")}\n${plural(group.internalEdgeCount, "internal edge")}`,
      },
    };
  });
  const edges = summary.groupEdges.map((edge): ArchitectureElement => ({
    group: "edges",
    data: {
      id: `edge-${edge.from}-${edge.to}`,
      source: `group-${edge.from}`,
      target: `group-${edge.to}`,
      label: String(edge.fileEdgeCount),
      fileEdgeCount: edge.fileEdgeCount,
      width: Math.round((1 + Math.log2(edge.fileEdgeCount)) * 10) / 10,
      tooltip: `${edge.fromLabel} → ${edge.toLabel}\n${plural(edge.fileEdgeCount, "file import")}`,
    },
  }));
  return [...nodes, ...edges];
}

/** Hides (class `weak`) the group edges with fewer than `minImports` file imports; returns how many stay. */
export function applyMinImports(cy: Core, minImports: number): number {
  cy.batch(() => {
    cy.edges().forEach((edge) => {
      edge.toggleClass("weak", edge.data("fileEdgeCount") < minImports);
    });
  });
  return cy.edges().not(".weak").length;
}

/** Groups whose label or key contains `query`, case-insensitive; none for a blank query. */
export function findGroups(cy: Core, query: string): Collection {
  const needle = query.trim().toLowerCase();
  return needle ? cy.nodes().filter((node) => String(node.data("search")).includes(needle)) : cy.collection();
}

/**
 * Highlights `focus`, its shown edges and the groups at their ends, and fades the rest
 * (classes only, no relayout). An empty focus clears the highlight.
 */
export function highlightFocus(cy: Core, focus: Collection): void {
  cy.batch(() => {
    cy.elements().removeClass("faded highlighted");
    if (focus.empty()) return;
    const edges = focus.edges().union(focus.nodes().connectedEdges()).not(".weak");
    const shown = focus.union(edges).union(edges.connectedNodes());
    shown.addClass("highlighted");
    cy.elements().not(shown).addClass("faded");
  });
}

/** E2E observability, read from the computed style: what the stylesheet actually draws. */
export function measureInteraction(cy: Core) {
  const edges = cy.edges().filter((edge) => edge.style("display") !== "none");
  return {
    highlightedGroups: cy.nodes(".highlighted").length,
    fadedGroups: cy.nodes().filter((node) => Number(node.style("opacity")) < 1).length,
    labelledEdges: edges.filter((edge) => edge.style("label") !== "").length,
    shownGroupEdges: edges.length,
  };
}
