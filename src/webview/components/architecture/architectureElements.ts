import type { Collection, Core, LayoutOptions, NodeSingular, Position } from "cytoscape";
import type { ArchitectureGroupDetailMessage, ArchitectureSummaryMessage } from "../../../shared/architecture-types";
import { normalizePath } from "../../utils/path";

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

const GAP = 12;

/** fcose options for the files a page adds to an expanded group, laid out on their own. */
export const ARCHITECTURE_FILE_LAYOUT = {
  name: "fcose",
  animate: false,
  randomize: true,
  fit: false,
  quality: "default",
  nodeDimensionsIncludeLabels: true,
  nodeSeparation: 40,
  idealEdgeLength: 60,
};

/**
 * Lays out the files with no known position, per expanded group, without moving anything else:
 * a first page around the group's last centre, a later one below the files already shown.
 */
export function placeNewFiles(cy: Core, filePositions: ReadonlyMap<string, Position>, centreOf: (group: NodeSingular) => Position): void {
  const fresh = cy.nodes().filter((node) => node.isChild() && !filePositions.has(node.id()));
  fresh.parents().forEach((group) => {
    const added = group.children().intersection(fresh);
    const shown = group.children().difference(added);
    added.union(added.edgesWith(added)).layout(ARCHITECTURE_FILE_LAYOUT as LayoutOptions).run();
    const box = added.boundingBox();
    const above = shown.nonempty() ? shown.boundingBox() : undefined;
    const centre = above ? { x: (above.x1 + above.x2) / 2, y: above.y2 + GAP + box.h / 2 } : centreOf(group);
    added.shift({ x: centre.x - (box.x1 + box.x2) / 2, y: centre.y - (box.y1 + box.y2) / 2 });
  });
}

/** A node's centre and outer size, in model coordinates. */
export interface LayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}


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

type GroupDetail = ArchitectureGroupDetailMessage["detail"];

/** The pages received for one expanded group, in offset order. */
export interface GroupExpansion {
  group: GroupDetail["group"];
  files: GroupDetail["files"];
  internalPairs: GroupDetail["internalPairs"];
  outgoingPairs: GroupDetail["outgoingPairs"];
  outgoing: GroupDetail["outgoing"];
  incoming: GroupDetail["incoming"];
  /** Files of the group, loaded or not. */
  total: number;
  nextOffset?: number;
}

export type Expansions = ReadonlyMap<number, GroupExpansion>;

/** File nodes drawn at once, all expanded groups together. */
export const MAX_RENDERED_FILES = 500;
export const FILE_CAP_MESSAGE = `Collapse a group first (${MAX_RENDERED_FILES} files shown)`;

export const renderedFileCount = (expansions: Expansions) =>
  [...expansions.values()].reduce((total, expansion) => total + expansion.files.length, 0);

/**
 * Adds one page to the expanded groups. A page that is already merged or out of order changes
 * nothing, so a double click never duplicates a file; one that would pass the cap is refused.
 */
export function mergeGroupDetail(expansions: Expansions, detail: GroupDetail): { expansions: Expansions; capReached: boolean } {
  const current = expansions.get(detail.group.id);
  if (detail.page.offset !== (current?.files.length ?? 0)) return { expansions, capReached: false };
  if (renderedFileCount(expansions) + detail.files.length > MAX_RENDERED_FILES) return { expansions, capReached: true };
  const merged = new Map(expansions);
  merged.set(detail.group.id, {
    group: detail.group,
    files: [...(current?.files ?? []), ...detail.files],
    internalPairs: [...(current?.internalPairs ?? []), ...detail.internalPairs],
    outgoingPairs: [...(current?.outgoingPairs ?? []), ...detail.outgoingPairs],
    outgoing: [...(current?.outgoing ?? []), ...detail.outgoing],
    incoming: [...(current?.incoming ?? []), ...detail.incoming],
    total: detail.page.total,
    nextOffset: detail.page.nextOffset,
  });
  return { expansions: merged, capReached: false };
}

const fileNodeId = (relativePath: string) => `file:${normalizePath(relativePath)}`;
const edgeWidth = (count: number) => Math.round((1 + Math.log2(count)) * 10) / 10;

type SummaryGroup = ArchitectureSummaryMessage["groups"][number];

function groupNode(summary: ArchitectureSummaryMessage, group: SummaryGroup, expanded: boolean): ArchitectureElement {
  const lines = [group.label, plural(group.fileCount, "file")];
  return {
    group: "nodes",
    data: {
      id: `group-${group.id}`,
      groupId: group.id,
      // Group ids are per build; the key is what a group keeps across builds.
      key: `${summary.context.communityMode}:${group.key}`,
      label: expanded ? lines.join(" · ") : lines.join("\n"),
      ...nodeBox(lines, Math.round(32 + 14 * Math.log2(1 + group.fileCount))),
      unassigned: group.id === 0,
      expanded,
      search: `${group.label}\n${group.key}`.toLowerCase(),
      tooltip: `${group.key || group.label}\n${plural(group.fileCount, "file")}\n${plural(group.internalEdgeCount, "internal edge")}`,
    },
  };
}

/** The loaded files of an expanded group, then a "+N more files" node while pages are left. */
function fileNodes(groupId: number, expansion: GroupExpansion): ArchitectureElement[] {
  const parent = `group-${groupId}`;
  const nodes = expansion.files.map((file): ArchitectureElement => {
    const name = file.relativePath.slice(file.relativePath.lastIndexOf("/") + 1);
    return {
      group: "nodes",
      data: {
        id: fileNodeId(file.relativePath),
        parent,
        groupId,
        file: true,
        relativePath: file.relativePath,
        label: name,
        ...nodeBox([name], 24),
        search: file.relativePath.toLowerCase(),
        tooltip: `${file.relativePath}\n${plural(file.dependencyCount, "import")} · ${plural(file.dependentCount, "dependent")}`,
      },
    };
  });
  if (expansion.nextOffset !== undefined) {
    const label = `+${expansion.total - expansion.files.length} more files`;
    nodes.push({
      group: "nodes",
      data: { id: `more-${groupId}`, parent, groupId, more: true, label, ...nodeBox([label], 24), tooltip: "Load the next files" },
    });
  }
  return nodes;
}

/** The groups and, with a file restricting one end, the file pairs an edge stands for. */
interface EdgeEnds {
  from: number;
  to: number;
  sourceFile?: string;
  targetFile?: string;
}

const bump = (counts: Map<string, number>, key: string, value = 1) => counts.set(key, (counts.get(key) ?? 0) + value);

function edgeElement(id: string, source: string, target: string, count: number, ends: EdgeEnds & { fromName: string; toName: string }): ArchitectureElement {
  const { from, to, sourceFile, targetFile, fromName, toName } = ends;
  return {
    group: "edges",
    data: {
      id, source, target, label: String(count), fileEdgeCount: count, width: edgeWidth(count), from, to, fromName, toName,
      ...(sourceFile === undefined ? {} : { sourceFile }),
      ...(targetFile === undefined ? {} : { targetFile }),
      tooltip: `${fromName} → ${toName}\n${plural(count, "file import")}`,
    },
  };
}

/**
 * Edges once some groups are expanded. A file pair is drawn at the most detailed level both
 * ends are loaded at: file → file, file ↔ collapsed group, or towards the "+N more files" node of
 * an expanded group for its files not loaded yet. Each group edge keeps, at group level, only
 * the pairs no file end carries, so no pair is drawn twice or lost; internal pairs wait until
 * both files are loaded.
 */
class EdgeCollector {
  readonly edges: ArchitectureElement[] = [];
  private readonly labels: Map<number, string>;
  /** Expanded group of every loaded file. */
  private readonly loaded = new Map<string, number>();
  /** Pairs drawn below group level, per "from>to" group pair. */
  private readonly covered = new Map<string, number>();
  /** Pairs drawn file → file, per "source\0target group" and per "target\0source group". */
  private readonly fromLoaded = new Map<string, number>();
  private readonly intoLoaded = new Map<string, number>();

  constructor(
    summary: ArchitectureSummaryMessage,
    private readonly expansions: Expansions,
    private readonly shown: Set<number>,
  ) {
    this.labels = new Map(summary.groups.map((group) => [group.id, group.label]));
    for (const [id, expansion] of expansions) {
      for (const file of expansion.files) this.loaded.set(normalizePath(file.relativePath), id);
    }
  }

  private isLoaded(relativePath: string, group: number): boolean {
    return this.loaded.get(normalizePath(relativePath)) === group;
  }

  /** A collapsed group, or the "+N more files" node standing for an expanded group's unloaded files. */
  private groupEnd(id: number): string {
    return this.expansions.get(id)?.nextOffset === undefined ? `group-${id}` : `more-${id}`;
  }

  private add(source: string, target: string, count: number, ends: EdgeEnds, id = `${source}->${target}`): void {
    const nameOf = (group: number) => (group === 0 ? "unassigned" : this.labels.get(group) ?? "");
    const fromName = ends.sourceFile ?? nameOf(ends.from);
    const toName = ends.targetFile ?? nameOf(ends.to);
    this.edges.push(edgeElement(id, source, target, count, { ...ends, fromName, toName }));
  }

  /** File → file pairs whose both ends are loaded; must run for every group before `boundary`. */
  filePairs(id: number, expansion: GroupExpansion): void {
    for (const pair of expansion.internalPairs) {
      if (this.isLoaded(pair.target, id)) {
        this.add(fileNodeId(pair.source), fileNodeId(pair.target), 1, { from: id, to: id, sourceFile: pair.source, targetFile: pair.target });
      }
    }
    for (const pair of expansion.outgoingPairs.filter((entry) => this.shown.has(entry.toGroup) && this.isLoaded(entry.target, entry.toGroup))) {
      this.add(fileNodeId(pair.source), fileNodeId(pair.target), 1, { from: id, to: pair.toGroup, sourceFile: pair.source, targetFile: pair.target });
      bump(this.fromLoaded, `${pair.source}\0${pair.toGroup}`);
      bump(this.intoLoaded, `${pair.target}\0${id}`);
    }
  }

  /** What is left of each loaded file's boundary counts once the file → file pairs are drawn. */
  boundary(id: number, expansion: GroupExpansion): void {
    for (const entry of expansion.outgoing.filter((candidate) => this.shown.has(candidate.toGroup))) {
      bump(this.covered, `${id}>${entry.toGroup}`, entry.fileEdgeCount);
      const rest = entry.fileEdgeCount - (this.fromLoaded.get(`${entry.relativePath}\0${entry.toGroup}`) ?? 0);
      if (rest > 0) this.add(fileNodeId(entry.relativePath), this.groupEnd(entry.toGroup), rest, { from: id, to: entry.toGroup, sourceFile: entry.relativePath });
    }
    for (const entry of expansion.incoming.filter((candidate) => this.shown.has(candidate.fromGroup))) {
      // Pairs from loaded files of an expanded source group are already drawn from its side.
      const rest = entry.fileEdgeCount - (this.intoLoaded.get(`${entry.relativePath}\0${entry.fromGroup}`) ?? 0);
      bump(this.covered, `${entry.fromGroup}>${id}`, rest);
      if (rest > 0) this.add(this.groupEnd(entry.fromGroup), fileNodeId(entry.relativePath), rest, { from: entry.fromGroup, to: id, targetFile: entry.relativePath });
    }
  }

  /** The pairs of a group edge that no file end carries. */
  groupEdge(edge: ArchitectureSummaryMessage["groupEdges"][number]): void {
    const rest = edge.fileEdgeCount - (this.covered.get(`${edge.from}>${edge.to}`) ?? 0);
    if (rest > 0) this.add(this.groupEnd(edge.from), this.groupEnd(edge.to), rest, { from: edge.from, to: edge.to }, `edge-${edge.from}-${edge.to}`);
  }
}

function edgeElements(summary: ArchitectureSummaryMessage, expansions: Expansions, shown: Set<number>): ArchitectureElement[] {
  const collector = new EdgeCollector(summary, expansions, shown);
  for (const [id, expansion] of expansions) collector.filePairs(id, expansion);
  for (const [id, expansion] of expansions) collector.boundary(id, expansion);
  for (const edge of summary.groupEdges) collector.groupEdge(edge);
  return collector.edges;
}

/**
 * Cytoscape elements for a summary: one node per group, a compound with its loaded files per
 * expanded group, and the edges between what is drawn. Pure mapping: groups, counts and the
 * display caps all come from the extension and the received pages.
 */
export function toArchitectureElements(summary: ArchitectureSummaryMessage, expansions: Expansions = new Map()): ArchitectureElement[] {
  const groups = summary.unassigned.fileCount > 0
    ? [...summary.groups, { id: 0, key: "", label: "unassigned", ...summary.unassigned }]
    : summary.groups;
  const shown = new Set(groups.map((group) => group.id));
  const nodes = groups.flatMap((group) => {
    const expansion = expansions.get(group.id);
    const node = groupNode(summary, group, expansion !== undefined);
    return expansion ? [node, ...fileNodes(group.id, expansion)] : [node];
  });
  return [...nodes, ...edgeElements(summary, expansions, shown)];
}

const isFileNode = (id: unknown) => typeof id === "string" && id.startsWith("file:");

/** File nodes drawn, and edges with no file end (E2E observability). */
export function countRendered(elements: readonly ArchitectureElement[]) {
  return {
    renderedFiles: elements.filter((element) => element.data.file === true).length,
    groupLevelEdges: elements.filter((element) =>
      element.group === "edges" && !isFileNode(element.data.source) && !isFileNode(element.data.target)).length,
  };
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
