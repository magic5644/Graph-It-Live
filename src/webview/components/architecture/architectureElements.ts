import type { Collection, Core, LayoutOptions, NodeSingular, Position } from "cytoscape";
import type { ArchitectureUnit, ArchitectureUnitEdgeKind } from "../../../analyzer/architecture/architectureUnits";
import type {
  ArchitectureGroupDetailMessage,
  ArchitectureRulesView,
  ArchitectureSummaryMessage,
  ArchitectureUnitLevel,
} from "../../../shared/architecture-types";
import { normalizePath } from "../../utils/path";
import { blend, contrastRatio, parseColor, type Rgba, unitHue } from "./unitColors";

export interface ArchitectureElement {
  group: "nodes" | "edges";
  data: Record<string, string | number | boolean>;
}

export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

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
  // A cycle block's units are children too: they keep their unit positions.
  const fresh = cy.nodes().filter((node) => node.isChild() && !node.parent().data("cycle") && !filePositions.has(node.id()));
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

/** Narrowest packed area: a few groups without imports still share rows. */
const MIN_PACK_WIDTH = 400;

/**
 * Packs `boxes` (in order, largest first) in rows below `main`, the box of every other group,
 * left-aligned on it and wrapped at its width, or about square without one. Mutates x and y.
 */
export function packBelow(boxes: LayoutBox[], main?: { x1: number; x2: number; y2: number }): void {
  const area = boxes.reduce((total, box) => total + (box.width + GAP) * (box.height + GAP), 0);
  const width = Math.max(MIN_PACK_WIDTH, main ? main.x2 - main.x1 : Math.sqrt(area) * 1.5);
  const left = main?.x1 ?? 0;
  let x = left;
  let y = main ? main.y2 + 4 * GAP : 0;
  let rowHeight = 0;
  for (const box of boxes) {
    if (x > left && x + box.width > left + width) {
      x = left;
      y += rowHeight + GAP;
      rowHeight = 0;
    }
    box.x = x + box.width / 2;
    box.y = y + box.height / 2;
    x += box.width + GAP;
    rowHeight = Math.max(rowHeight, box.height);
  }
}

/** What a force layout places: every element but the isolated groups and their files. */
export function linkedElements(cy: Core): Collection {
  const isolated = cy.nodes("[?isolated]");
  return cy.elements().not(isolated.union(isolated.descendants()));
}

/** Packs the isolated groups in rows below the others (an expanded one with its files). */
export function packIsolatedGroups(cy: Core): void {
  const isolated = cy.nodes(":orphan[?isolated]");
  if (isolated.empty()) return;
  const others = cy.nodes(":orphan").not(isolated);
  // A compound's box comes from its files: its own position may not follow them yet.
  const boxes = isolated.map((node) => {
    const { x1, x2, y1, y2 } = node.boundingBox({ includeLabels: false });
    return { node, x: 0, y: 0, width: x2 - x1, height: y2 - y1, centre: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 } };
  });
  packBelow(boxes, others.nonempty() ? others.boundingBox({ includeLabels: false }) : undefined);
  for (const { node, x, y, centre } of boxes) {
    if (node.isParent()) node.children().shift({ x: x - centre.x, y: y - centre.y });
    else node.position({ x, y });
  }
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
const NO_EXPANSIONS: Expansions = new Map();

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

const groupSize = (fileCount: number) => Math.round(32 + 14 * Math.log2(1 + fileCount));

function groupNode(summary: ArchitectureSummaryMessage, group: SummaryGroup, expanded: boolean, isolated: boolean): ArchitectureElement {
  const lines = [group.label, plural(group.fileCount, "file")];
  return {
    group: "nodes",
    data: {
      id: `group-${group.id}`,
      groupId: group.id,
      // Group ids are per build; the key is what a group keeps across builds.
      key: `${summary.context.communityMode}:${group.key}`,
      groupKey: group.key,
      label: expanded ? lines.join(" · ") : lines.join("\n"),
      ...nodeBox(lines, groupSize(group.fileCount)),
      unassigned: group.id === 0,
      expanded,
      // No drawn edge to a group of its level: drawn apart, below the others.
      isolated,
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

function edgeElement(id: string, source: string, target: string, count: number, ends: EdgeEnds & { fromName: string; toName: string }): ArchitectureElement {
  const { from, to, sourceFile, targetFile, fromName, toName } = ends;
  return {
    group: "edges",
    data: {
      id, source, target, label: String(count), fileEdgeCount: count, width: edgeWidth(count), from, to, fromName, toName,
      // Drawn only for the hovered or selected file: all of them at once bury the picture.
      fileEdge: sourceFile !== undefined || targetFile !== undefined,
      ...(sourceFile === undefined ? {} : { sourceFile }),
      ...(targetFile === undefined ? {} : { targetFile }),
      tooltip: `${fromName} → ${toName}\n${plural(count, "file pair")} (static imports)`,
    },
  };
}

/**
 * Edges once some groups are expanded. Every edge is labelled with the full count of the file
 * pairs it stands for, which is what its evidence lists: group → group (an expanded group keeps
 * them on its compound), file ↔ collapsed group from a loaded file's boundary counts, and
 * file → file once both files are loaded. A pair with a file not loaded yet (counted in its
 * group's "+N more files" node) is drawn once its page is loaded.
 */
class EdgeCollector {
  readonly edges: ArchitectureElement[] = [];
  private readonly labels: Map<number, string>;
  /** Expanded group of every loaded file. */
  private readonly loaded = new Map<string, number>();

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

  private add(source: string, target: string, count: number, ends: EdgeEnds, id = `${source}->${target}`): void {
    const nameOf = (group: number) => (group === 0 ? "unassigned" : this.labels.get(group) ?? "");
    const fromName = ends.sourceFile ?? nameOf(ends.from);
    const toName = ends.targetFile ?? nameOf(ends.to);
    this.edges.push(edgeElement(id, source, target, count, { ...ends, fromName, toName }));
  }

  /** File → file pairs whose both ends are loaded. */
  filePairs(id: number, expansion: GroupExpansion): void {
    const pairs = [...expansion.internalPairs.map((pair) => ({ ...pair, toGroup: id })), ...expansion.outgoingPairs];
    for (const pair of pairs.filter((entry) => this.shown.has(entry.toGroup) && this.isLoaded(entry.target, entry.toGroup))) {
      this.add(fileNodeId(pair.source), fileNodeId(pair.target), 1, { from: id, to: pair.toGroup, sourceFile: pair.source, targetFile: pair.target });
    }
  }

  /** A loaded file's imports from and to each collapsed group, with the full count. */
  boundary(id: number, expansion: GroupExpansion): void {
    const collapsed = (group: number) => this.shown.has(group) && !this.expansions.has(group);
    for (const entry of expansion.outgoing.filter((candidate) => collapsed(candidate.toGroup))) {
      const ends = { from: id, to: entry.toGroup, sourceFile: entry.relativePath };
      this.add(fileNodeId(entry.relativePath), `group-${entry.toGroup}`, entry.fileEdgeCount, ends);
    }
    for (const entry of expansion.incoming.filter((candidate) => collapsed(candidate.fromGroup))) {
      const ends = { from: entry.fromGroup, to: id, targetFile: entry.relativePath };
      this.add(`group-${entry.fromGroup}`, fileNodeId(entry.relativePath), entry.fileEdgeCount, ends);
    }
  }

  groupEdge(edge: ArchitectureSummaryMessage["groupEdges"][number]): void {
    this.add(`group-${edge.from}`, `group-${edge.to}`, edge.fileEdgeCount, { from: edge.from, to: edge.to }, `edge-${edge.from}-${edge.to}`);
  }
}

function edgeElements(summary: ArchitectureSummaryMessage, expansions: Expansions, shown: Set<number>): ArchitectureElement[] {
  const collector = new EdgeCollector(summary, expansions, shown);
  for (const [id, expansion] of expansions) {
    collector.filePairs(id, expansion);
    collector.boundary(id, expansion);
  }
  for (const edge of summary.groupEdges) collector.groupEdge(edge);
  return collector.edges;
}

/**
 * Cytoscape elements for a summary: one node per group, a compound with its loaded files per
 * expanded group, and the edges between what is drawn. Pure mapping: groups, counts and the
 * display caps all come from the extension and the received pages.
 */
export function toArchitectureElements(summary: ArchitectureSummaryMessage, expansions: Expansions = NO_EXPANSIONS): ArchitectureElement[] {
  const groups = summary.unassigned.fileCount > 0
    ? [...summary.groups, { id: 0, key: "", label: "unassigned", ...summary.unassigned }]
    : summary.groups;
  const shown = new Set(groups.map((group) => group.id));
  const isolated = new Set(summary.isolatedGroups);
  const nodes = groups.flatMap((group) => {
    const expansion = expansions.get(group.id);
    const node = groupNode(summary, group, expansion !== undefined, isolated.has(group.id));
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

/** Hides (class `weak`) the group edges with fewer than `minImports` file imports, else the capped unit edges; returns how many stay drawn (focus included). */
export function applyMinImports(cy: Core, minImports: number): number {
  cy.batch(() => {
    cy.edges().forEach((edge) => {
      // A file edge stands for one file: the filter is about weak group relations. Without a
      // threshold, unit edges beyond the cap (`capped`) are the weak ones.
      const weak = minImports > 1 ? edge.data("fileEdgeCount") < minImports : edge.data("capped") === true;
      edge.toggleClass("weak", !edge.data("fileEdge") && weak);
    });
  });
  return cy.edges().filter((edge) => !edge.data("fileEdge") && !edge.hasClass("weak") && !edge.hasClass("hidden")).length;
}

/**
 * Keeps only `group`, its files and what its edges reach (with the compound around a reached
 * file); everything else gets class `hidden`. Returns what stays drawn. An empty group shows all.
 */
export function focusGroup(cy: Core, group: Collection): Collection {
  cy.batch(() => cy.elements().removeClass("hidden"));
  if (group.empty()) return cy.elements();
  const core = group.union(group.descendants());
  const edges = core.connectedEdges();
  const reached = edges.connectedNodes();
  const shown = core.union(edges).union(reached).union(reached.parents()).union(reached.parents().children());
  cy.batch(() => cy.elements().not(shown).addClass("hidden"));
  return shown;
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
    // A group's file edges stay hidden: only a file (or the edge itself) shows them.
    const nodeEdges = focus.nodes().connectedEdges("[!fileEdge]").union(focus.nodes("[?file]").connectedEdges());
    const edges = focus.edges().union(nodeEdges).not(".weak");
    const shown = focus.union(edges).union(edges.connectedNodes());
    shown.addClass("highlighted");
    // A faded compound (a cycle block) would fade the units it holds.
    cy.elements().not(shown).not(shown.parents()).addClass("faded");
  });
}

/** Marks `nodes` alone with `className` (`selected`: clicked or reached by arrow keys; `found`: Find matches). */
export function markNodes(cy: Core, className: "selected" | "found", nodes: Collection): void {
  cy.batch(() => {
    cy.nodes(`.${className}`).removeClass(className);
    nodes.nodes().addClass(className);
  });
}

/** Drawn with a focus ring: at least 3px of a border colour that is not the node's own fill colour. */
const ringed = (node: NodeSingular) =>
  Number.parseFloat(node.style("border-width")) >= 3 && node.style("border-color") !== node.style("background-color");

/** E2E observability, read from the computed style: what the stylesheet actually draws. */
export function measureInteraction(cy: Core) {
  const edges = cy.edges().filter((edge) => edge.style("display") !== "none");
  const marked = cy.nodes(".selected, .found");
  return {
    selectedGroups: cy.nodes(".selected").length,
    foundGroups: cy.nodes(".found").length,
    ringedGroups: marked.filter(ringed).length,
    highlightedGroups: cy.nodes(".highlighted").length,
    fadedGroups: cy.nodes().filter((node) => Number(node.style("opacity")) < 1).length,
    labelledEdges: edges.filter((edge) => edge.style("label") !== "").length,
    shownGroupEdges: edges.filter((edge) => !edge.data("fileEdge")).length,
    shownFileEdges: edges.filter((edge) => edge.data("fileEdge")).length,
  };
}

/** A unit's identity colour (legend, matrix rows); the canvas draws its hue in the theme's tone (unitColors.unitTone). */
export const unitColor = (index: number) => `hsl(${unitHue(index)}, 60%, 50%)`;

/** At the units level, the strongest edges up to this many per unit are drawn; upward and cycle edges always are. */
export const UNIT_EDGES_PER_UNIT = 3;

interface RankedEdge {
  key: string;
  fileEdgeCount: number;
  kind?: ArchitectureUnitEdgeKind;
}

/** Keys of the down edges beyond the UNIT_EDGES_PER_UNIT × nodes strongest; upward and cycle edges are never capped. */
function cappedKeys(edges: readonly RankedEdge[], nodes: number): Set<string> {
  const cap = UNIT_EDGES_PER_UNIT * nodes;
  return new Set(edges
    .toSorted((left, right) => right.fileEdgeCount - left.fileEdgeCount)
    .filter((edge, rank) => rank >= cap && edge.kind === "down")
    .map((edge) => edge.key));
}

/** Unit edges hidden by default (keys `from\0to`); an edge breaking a declared rule never is. */
export function cappedUnitEdges(level: ArchitectureUnitLevel, rules?: ArchitectureRulesView): Set<string> {
  const capped = cappedKeys(level.unitEdges.map((edge) => ({ ...edge, key: `${edge.from}\0${edge.to}` })), level.units.length);
  return new Set([...capped].filter((key) => !rules?.unitEdges[key.replace("\0", ">")]));
}

/** Unit edges the header says are hidden; none once min-imports takes over. */
export const hiddenUnitEdgeCount = (level: ArchitectureUnitLevel, minImports: number, rules?: ArchitectureRulesView) =>
  (minImports > 1 ? 0 : cappedUnitEdges(level, rules).size);

/** Largest file-pair count of a level's edges, the bound of the min-imports control. */
export const maxEdgeImports = (summary: ArchitectureSummaryMessage) =>
  Math.max(1, ...summary.groupEdges.map((edge) => edge.fileEdgeCount));

const unitName = (level: ArchitectureUnitLevel, key: string) => level.units.find((unit) => unit.key === key)?.name ?? key;

/**
 * What one level draws, shaped as a summary: the units (path mode, no unit entered, group id
 * = unit index + 1), the folder groups of the entered unit, or every group (Louvain).
 * Pure selection: units, groups and counts all come from the extension.
 */
export function levelSummary(summary: ArchitectureSummaryMessage, unit: string | null): ArchitectureSummaryMessage {
  const level = summary.units;
  if (!level) return summary;
  if (unit === null) {
    const idOf = new Map(level.units.map((entry, index) => [entry.key, index + 1]));
    return {
      ...summary,
      groups: level.units.map((entry, index) =>
        ({ id: index + 1, key: entry.key, label: entry.name, fileCount: entry.fileCount, internalEdgeCount: entry.internalEdgeCount })),
      groupEdges: level.unitEdges.map((edge) => ({
        from: idOf.get(edge.from)!, to: idOf.get(edge.to)!, fileEdgeCount: edge.fileEdgeCount,
        fromLabel: unitName(level, edge.from), toLabel: unitName(level, edge.to),
      })),
      unassigned: { fileCount: 0, internalEdgeCount: 0 },
      totalGroups: level.units.length,
      hiddenGroups: 0,
      hiddenGroupEdges: 0,
      isolatedGroups: [],
    };
  }
  const inUnit = (id: number) => level.groupUnits[id] === unit;
  const groups = summary.groups.filter((group) => inUnit(group.id));
  const counts = level.groupsByUnit?.[unit] ?? { totalGroups: groups.length, hiddenGroups: 0, hiddenGroupEdges: 0 };
  return {
    ...summary,
    groups,
    groupEdges: summary.groupEdges.filter((edge) => inUnit(edge.from) && inUnit(edge.to)),
    unassigned: { fileCount: 0, internalEdgeCount: 0 },
    ...counts,
    isolatedGroups: summary.isolatedGroups?.filter(inUnit),
  };
}

/**
 * Elements of a level: groups as toArchitectureElements draws them, plus, with units, the
 * colour of each unit (an entered unit's groups keep it), the layer of each node and the kind
 * of each edge (`upward` and `cycle` drawn red, `capped` hidden until min-imports overrides).
 * `folder` is the entered folder `summary` is the level of: a folder's own files keep the
 * folder's key, so its nodes get keys of their own.
 */
export function toLevelElements(
  summary: ArchitectureSummaryMessage,
  unit: string | null,
  expansions: Expansions = NO_EXPANSIONS,
  folder?: string,
): ArchitectureElement[] {
  const level = summary.units;
  const elements = toArchitectureElements(levelSummary(summary, unit), level && unit === null ? NO_EXPANSIONS : expansions);
  if (!level) return decorateViolations(elements, summary.rules, false);
  const decorated = unit === null ? decorateUnits(elements, level) : decorateUnitGroups(elements, level, unit, folder);
  return decorateViolations(decorated, summary.rules, unit === null);
}

/** Edges breaking a declared rule: drawn red and dashed, never capped, their rules in the tooltip. */
function decorateViolations(elements: ArchitectureElement[], rules: ArchitectureRulesView | undefined, unitsLevel: boolean): ArchitectureElement[] {
  if (!rules?.totals?.violations) return elements;
  return elements.map((element) => {
    if (element.group !== "edges" || element.data.fileEdge) return element;
    const { data } = element;
    const names = unitsLevel ? rules.unitEdges[`${data.fromUnit}>${data.toUnit}`] : rules.groupEdges[`${data.from}>${data.to}`];
    if (!names) return element;
    return { ...element, data: { ...data, violation: true, capped: false, rules: names, tooltip: `${data.tooltip}\nBreaks: ${names.join(", ")}` } };
  });
}

/** A unit's role badge: `[role]` when declared, `[role?]` when inferred. */
export const roleBadge = (unit: Pick<ArchitectureUnit, "role" | "confidence">) => `[${unit.role}${unit.confidence === "inferred" ? "?" : ""}]`;

/** The badge on top of the unit's label, and its role with every piece of evidence in the tooltip. */
function roleData(data: ArchitectureElement["data"], unit: ArchitectureUnit): ArchitectureElement["data"] {
  const lines = [roleBadge(unit), unit.name, plural(unit.fileCount, "file")];
  const evidence = unit.evidence.map((entry) => `\n- ${entry.role === unit.role ? "" : entry.role + ": "}${entry.detail}`).join("");
  return {
    role: unit.role,
    evidenceCount: unit.evidence.length,
    label: lines.join("\n"),
    ...nodeBox(lines, groupSize(unit.fileCount)),
    tooltip: `${data.tooltip}\nRole: ${unit.role} (${unit.confidence})${evidence || "\n- no evidence"}`,
  };
}

/** Hides (class `filtered`) the units of other roles and their edges; null shows them all. Returns the units left. */
export function applyRoleFilter(cy: Core, role: string | null): number {
  cy.batch(() => {
    cy.elements().removeClass("filtered");
    if (role === null) return;
    const out = cy.nodes().filter((node) => node.data("role") !== undefined && node.data("role") !== role);
    out.union(out.connectedEdges()).addClass("filtered");
    cy.nodes("[?cycle]").filter((block) => block.children().not(".filtered").empty()).addClass("filtered");
  });
  return cy.nodes().filter((node) => node.data("role") !== undefined && !node.hasClass("filtered")).length;
}

/**
 * One compound per cycle the extension sent (`cycleUnits`), titled with its size, around its units:
 * the block of each unit key.
 */
function cycleBlocks(level: ArchitectureUnitLevel): { blocks: ArchitectureElement[]; blockOf: Map<string, string> } {
  const blockOf = new Map<string, string>();
  const layerOf = new Map(level.units.map((unit) => [unit.key, unit.layer]));
  const blocks = (level.cycleUnits ?? []).map((members, index): ArchitectureElement => {
    const id = `cycle-${index}`;
    for (const member of members) blockOf.set(member, id);
    return {
      group: "nodes",
      data: {
        id, cycle: true, key: `cycle:${members.toSorted().join("|")}`, label: `Cycle · ${members.length} units`, search: "",
        // The unit keys the extension sent, to check that each one is drawn inside this block.
        members: members.join("\n"),
        // Units of one cycle share a layer.
        layer: layerOf.get(members[0]) ?? 0,
        tooltip: `${plural(members.length, "unit")} importing each other: ${members.map((member) => unitName(level, member)).join(", ")}`,
      },
    };
  });
  return { blocks, blockOf };
}

/** A unit with no unit edge says so: it is laid out on layer 0 without being shared. */
const linkedUnits = (level: ArchitectureUnitLevel) => new Set(level.unitEdges.flatMap((edge) => [edge.from, edge.to]));

function decorateUnits(elements: ArchitectureElement[], level: ArchitectureUnitLevel): ArchitectureElement[] {
  const idOf = new Map(level.units.map((entry, index) => [entry.key, index + 1]));
  const edgeOf = new Map(level.unitEdges.map((edge) => [`edge-${idOf.get(edge.from)}-${idOf.get(edge.to)}`, edge]));
  const capped = cappedUnitEdges(level);
  const { blocks, blockOf } = cycleBlocks(level);
  const linked = linkedUnits(level);
  const decorated = elements.map((element) => {
    if (element.group === "nodes") {
      const index = Number(element.data.groupId) - 1;
      const entry = level.units[index];
      if (!entry) return element;
      const data = { ...element.data, key: `units:${entry.key}`, unitKey: entry.key, layer: entry.layer, color: unitColor(index), hue: unitHue(index) };
      const role = roleData(data, entry);
      const block = blockOf.get(entry.key);
      return {
        ...element,
        data: {
          ...data, ...role,
          ...(block === undefined ? {} : { parent: block }),
          ...(linked.has(entry.key) ? {} : { tooltip: `${role.tooltip}\nNo cross-unit imports` }),
        },
      };
    }
    const edge = edgeOf.get(String(element.data.id));
    if (!edge) return element;
    return {
      ...element,
      data: {
        ...element.data, unitEdge: true, fromUnit: edge.from, toUnit: edge.to, kind: edge.kind,
        capped: capped.has(`${edge.from}\0${edge.to}`), tooltip: `${element.data.tooltip} · click files`,
      },
    };
  });
  return [...blocks, ...decorated];
}

/** A group's layer, its key within the entered folder, and `folder` (the key to enter) when it holds sub-folders. */
function folderGroupData(data: ArchitectureElement["data"], level: ArchitectureUnitLevel, nested: ReadonlySet<number>, folder?: string) {
  const layer = level.groupLayers[Number(data.groupId)];
  return {
    ...(layer === undefined ? {} : { layer }),
    ...(folder === undefined ? {} : { key: `${data.key}@${folder}` }),
    ...(nested.has(Number(data.groupId)) ? { folder: data.groupKey, tooltip: `${data.tooltip}\nSub-folders: double-click to enter` } : {}),
  };
}

/**
 * An entered unit's or folder's groups: the unit's colour, their layer within the level, the kind
 * of the edges between them, and `folder` (the key to enter) on the groups holding sub-folders.
 */
function decorateUnitGroups(elements: ArchitectureElement[], level: ArchitectureUnitLevel, unit: string, folder?: string): ArchitectureElement[] {
  const index = Math.max(0, level.units.findIndex((entry) => entry.key === unit));
  const color = unitColor(index);
  const hue = unitHue(index);
  const groupEdges = elements.filter((element) => element.group === "edges" && !element.data.fileEdge);
  const nodes = elements.filter((element) => element.group === "nodes" && element.data.parent === undefined).length;
  const ranked = groupEdges.map((element) => ({
    key: String(element.data.id),
    fileEdgeCount: Number(element.data.fileEdgeCount),
    kind: level.groupEdgeKinds[`${element.data.from}>${element.data.to}`],
  }));
  const kindOf = new Map(ranked.map((edge) => [edge.key, edge.kind]));
  const capped = cappedKeys(ranked, nodes);
  const nested = new Set(level.nestedGroups);
  return elements.map((element) => {
    if (element.group === "nodes" && element.data.parent !== undefined) return { ...element, data: { ...element.data, color, hue } };
    if (element.group === "nodes") return { ...element, data: { ...element.data, color, hue, ...folderGroupData(element.data, level, nested, folder) } };
    const kind = kindOf.get(String(element.data.id));
    return kind === undefined ? element : { ...element, data: { ...element.data, kind, capped: capped.has(String(element.data.id)) } };
  });
}

/** Zoom below which an ARCHITECTURE_FONT_SIZE label is drawn under 8px on screen. */
export const MIN_READABLE_ZOOM = 8 / ARCHITECTURE_FONT_SIZE;

const FIT_PADDING = 30;

/**
 * Fits everything, but never below MIN_READABLE_ZOOM: a larger graph keeps its top centre in
 * view (the units nobody depends on) and the rest is reached by panning.
 */
export function fitReadable(cy: Core): void {
  cy.fit(undefined, FIT_PADDING);
  if (cy.zoom() >= MIN_READABLE_ZOOM) return;
  const box = cy.elements().boundingBox();
  cy.zoom(MIN_READABLE_ZOOM);
  // Rendered = model × zoom + pan: put the box's top centre at the top centre of the view.
  cy.pan({ x: cy.width() / 2 - ((box.x1 + box.x2) / 2) * MIN_READABLE_ZOOM, y: FIT_PADDING - box.y1 * MIN_READABLE_ZOOM });
}

/** E2E observability of a group level: its isolated groups, how many sit below every other group, and the label size. */
export function measureIsolated(cy: Core) {
  const groups = cy.nodes(":orphan");
  const isolated = groups.filter("[?isolated]");
  const others = groups.not(isolated);
  const bottom = others.nonempty() ? others.boundingBox({ includeLabels: false }).y2 : Number.NEGATIVE_INFINITY;
  return {
    isolatedBelow: isolated.filter((node) => node.boundingBox({ includeLabels: false }).y1 >= bottom).length,
    minLabelPx: Math.round(ARCHITECTURE_FONT_SIZE * cy.zoom() * 100) / 100,
  };
}

/** A layer's row, in model coordinates: from the top of its highest node to the bottom of its lowest. */
export interface LayerBand {
  layer: number;
  y1: number;
  y2: number;
}

const BOX = { includeLabels: false };

/**
 * One band per layer of the drawn nodes (units, or groups of an entered level), top first. Rows
 * meet halfway between two layers, so the bands tile the picture; the isolated groups packed
 * below and the cycle blocks (their units count) are left out.
 */
export function layerBands(cy: Core): LayerBand[] {
  const rows = new Map<number, { y1: number; y2: number }>();
  cy.nodes("[layer]").not("[?cycle], [?isolated], .filtered").forEach((node) => {
    const { y1, y2 } = node.boundingBox(BOX);
    const layer = Number(node.data("layer"));
    const row = rows.get(layer);
    rows.set(layer, row ? { y1: Math.min(row.y1, y1), y2: Math.max(row.y2, y2) } : { y1, y2 });
  });
  const bands = [...rows].map(([layer, row]) => ({ layer, ...row })).sort((a, b) => a.y1 - b.y1);
  for (let i = 1; i < bands.length; i++) {
    const middle = (bands[i - 1].y2 + bands[i].y1) / 2;
    bands[i - 1].y2 = middle;
    bands[i].y1 = middle;
  }
  return bands;
}

/** A band's label: the lowest layer holds what the others depend on. */
export const bandLabel = (layer: number) => (layer === 0 ? "Layer 0 · shared" : `Layer ${layer}`);

export type Direction = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

/**
 * The drawn node nearest to `from` in `direction`: within a 45° cone around it, by distance,
 * a node further off the axis counting double. Without `from`, the top-left node.
 */
export function nearestNode(nodes: Collection, from: NodeSingular | undefined, direction: Direction): NodeSingular | undefined {
  const candidates = nodes.nodes().filter((node) => node !== from);
  if (!from) return candidates.toArray().sort((a, b) => a.position("y") - b.position("y") || a.position("x") - b.position("x"))[0] as NodeSingular | undefined;
  const origin = from.position();
  const axis = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[direction];
  let best: { node: NodeSingular; score: number } | undefined;
  candidates.forEach((node) => {
    const dx = node.position("x") - origin.x;
    const dy = node.position("y") - origin.y;
    const along = dx * axis[0] + dy * axis[1];
    const across = Math.abs(dx * axis[1] - dy * axis[0]);
    if (along <= 0 || across > along) return;
    const score = along + 2 * across;
    if (!best || score < best.score) best = { node, score };
  });
  return best?.node;
}

/** What the live region says about a selected node: its name, layer, edges and cycle. */
export function describeNode(node: NodeSingular): string {
  // A unit's label starts with its role badge; a group is named by its key.
  const label = node.data("unitKey") === undefined && node.data("groupKey") ? node.data("groupKey") : node.data("label");
  const name = String(label).split("\n").find((line) => !line.startsWith("[")) ?? "";
  const shown = (edges: Collection) => edges.filter((edge) => !edge.data("fileEdge")).length;
  const parts = [name];
  if (node.data("layer") !== undefined) parts.push(`layer ${node.data("layer")}`);
  parts.push(`${shown(node.outgoers("edge"))} outgoing`, `${shown(node.incomers("edge"))} incoming`);
  if (node.parent().data("cycle")) parts.push("in cycle");
  return parts.join(", ");
}

/** Lowest contrast of a node's label over its fill blended on `background`; undefined without a parseable colour. */
function labelContrast(node: NodeSingular, background: Rgba): number | undefined {
  const label = parseColor(String(node.style("color")));
  const fill = parseColor(String(node.style("background-color")));
  if (!label || !fill) return undefined;
  return contrastRatio(label, blend(fill, Number(node.style("background-opacity")), background));
}

/** E2E observability of the units level, read from what is drawn; `background` is the colour behind the canvas. */
export function measureUnitLevel(cy: Core, background?: Rgba) {
  const drawn = cy.edges().map((edge) => edge).filter((edge) => edge.style("display") !== "none");
  const units = cy.nodes("[unitKey]");
  const blocks = cy.nodes("[?cycle]");
  const red = drawn.filter((edge) => edge.data("kind") !== "down");
  const bands = layerBands(cy);
  const contrasts = background ? units.map((node) => labelContrast(node, background)).filter((value) => value !== undefined) : [];
  return {
    units: units.length,
    colors: new Set(units.map((node) => String(node.data("color")))).size,
    redEdges: red.length,
    labelledRedEdges: red.filter((edge) => edge.style("label") !== "").length,
    layerBands: bands.length,
    unitsOutsideBand: units.filter((node) => {
      const band = bands.find((entry) => entry.layer === node.data("layer"));
      return !band || node.position("y") < band.y1 || node.position("y") > band.y2;
    }).length,
    cycleBlocks: blocks.length,
    // Each unit key the extension sent for a cycle, drawn anywhere but inside that cycle's block.
    cycleMembersOutside: blocks.map((block) => {
      const inside = new Set(block.children().map((child) => String(child.data("unitKey"))));
      return String(block.data("members")).split("\n").filter((member) => !inside.has(member)).length;
    }).reduce((total, count) => total + count, 0),
    minLabelContrast: contrasts.length > 0 ? Math.round(Math.min(...contrasts) * 100) / 100 : undefined,
    /** Drawn down edges whose target is not below their source. */
    edgesNotDown: drawn.filter((edge) => edge.data("kind") === "down" && edge.target().position("y") <= edge.source().position("y")).length,
    routedEdges: drawn.filter((edge) => edge.data("routed") === true).length,
    hiddenEdges: cy.edges(".weak").length,
    minLabelPx: Math.round(ARCHITECTURE_FONT_SIZE * cy.zoom() * 100) / 100,
    roleBadges: units.filter((node) => String(node.data("label")).startsWith(`[${node.data("role")}`)).length,
    // The role line, then one line per piece of evidence ("- no evidence" without any).
    roleTooltips: units.filter((node) => {
      const [, role, ...evidence] = String(node.data("tooltip")).split("\nRole: ");
      return role !== undefined && evidence.length === 0 && role.startsWith(`${node.data("role")} (`)
        && role.split("\n- ").length - 1 === Math.max(1, Number(node.data("evidenceCount")));
    }).length,
    shownUnits: units.not(".filtered").length,
  };
}
