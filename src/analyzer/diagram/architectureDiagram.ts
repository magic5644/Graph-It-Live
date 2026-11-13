/**
 * A static architecture diagram of one level of the Architecture view: the units of a workspace,
 * or the folder groups of an entered unit or folder. Layers run top to bottom (layer 0 at the
 * bottom), the members of a cycle sit in one block, edge weights become stroke widths. Laid out
 * by ELK layered as the webview lays it out (elkjs runs in Node), so a given index revision
 * always gives the same geometry. diagramSvg.ts draws it.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import ELK, { type ElkExtendedEdge, type ElkNode } from "elkjs/lib/elk.bundled.js";
import type { ArchitectureUnitEdgeKind, UnitRole } from "../../shared/architecture-model";
import { ELK_LAYERED_OPTIONS, layerPartition } from "../../shared/elkLayered";
import { normalizePath } from "../../shared/path";
import { cycleCuts } from "../architecture/architectureAssessment";
import { buildMatrix } from "../architecture/architectureMatrix";
import { rulesByEdge, type ArchitectureViolation } from "../architecture/architectureRules";
import { byCodeUnit } from "../architecture/architectureUnits";
import { viewUnitLevel, type UnitSource } from "../architecture/architectureView";
import { stronglyConnectedComponents } from "../architecture/stronglyConnectedComponents";
import { CYCLE_PADDING, SIZES, snap } from "./diagramStyle";

/** Nodes drawn at most: the largest are kept, a note counts the others. */
export const MAX_DIAGRAM_NODES = 60;

export interface DiagramNode {
  key: string;
  label: string;
  /** 0 = depends on no other node of the level. */
  layer: number;
  fileCount: number;
  /** File pairs inside the node: the matrix diagonal. */
  internalEdgeCount?: number;
  /** Units level only: the unit's role, declared or inferred. */
  role?: UnitRole;
}

export interface DiagramEdge {
  from: string;
  to: string;
  /** Distinct directed file pairs: the stroke width. */
  fileEdgeCount: number;
  kind: ArchitectureUnitEdgeKind;
  /** Names of the rules its file pairs break. */
  rules: string[];
  /** Every violating pair of the edge is in the baseline. */
  accepted?: boolean;
}

/** One level of the architecture, workspace-relative only. */
export interface DiagramInput {
  /** Workspace folder name, never its absolute path. */
  workspace: string;
  /** "units", or the entered unit or folder key. */
  scope: string;
  /** What a node is: "units" or "groups". */
  noun: string;
  revision: string;
  /** Day of the indexed revision (YYYY-MM-DD), when known. */
  date: string | undefined;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** Rule-breaking file pairs between two nodes of the level. */
  violations: number;
  /** Those of `violations` the baseline accepts. */
  acceptedViolations?: number;
  /** The view filters drawn, for the caption: "role library", "min. 3 imports". */
  filters?: string[];
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacedNode extends DiagramNode, Box {
  /** The label as drawn: control characters replaced, too long ones cut with "…". */
  text: string;
  meta: string;
}

export interface PlacedEdge extends DiagramEdge {
  points: { x: number; y: number }[];
  stroke: number;
}

export interface PlacedCycle extends Box {
  /** The members drawn. */
  members: string[];
  /** Members of the cycle in the whole level. */
  size: number;
}

export interface DiagramText {
  title: string;
  caption: string;
  counts: string;
  /** What the drawing leaves out of the level, one line each. */
  hidden: string[];
  rules: string | undefined;
  /** Matrix only: how to read a cell. */
  reading?: string;
}

export interface DiagramCounts {
  nodes: number;
  layers: number;
  cycles: number;
  violations: number;
}

export interface DiagramLayout {
  input: DiagramInput;
  /** Header lines, the size-cap note and the broken rules' names, as drawn. */
  text: DiagramText;
  width: number;
  height: number;
  /** Where the graph starts below the header. */
  top: number;
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  cycles: PlacedCycle[];
  /** Nodes of the level left out by the size cap. */
  hidden: number;
  counts: DiagramCounts;
}

/** `new: false` marks a pair the baseline accepts. */
type Violations = readonly (Pick<ArchitectureViolation, "rule" | "source" | "target"> & { new?: boolean })[];

/** Last folder name of the workspace root: diagrams never show an absolute path. */
export function workspaceName(workspaceRoot: string): string {
  return normalizePath(workspaceRoot).split("/").findLast((segment) => segment !== "") ?? "workspace";
}

/** The rules of each edge (`from>to` keys), the violating pairs between two distinct keys, and those the baseline accepts. */
function edgeRules(violations: Violations, keyOf: (file: string) => string | undefined) {
  const between = violations.filter(({ source, target }) => {
    const from = keyOf(source);
    return from !== undefined && keyOf(target) !== undefined && from !== keyOf(target);
  });
  const fresh = between.filter((violation) => violation.new !== false);
  const rules = rulesByEdge(between, keyOf);
  const freshRules = rulesByEdge(fresh, keyOf);
  const edge = (from: string, to: string) => {
    const names = rules[`${from}>${to}`] ?? [];
    return { rules: names, ...(names.length > 0 && freshRules[`${from}>${to}`] === undefined ? { accepted: true } : {}) };
  };
  return { edge, count: between.length, accepted: between.length - fresh.length };
}

/**
 * The diagram input of a path-mode build (`viewArchitecture(...).source`): the units, or with
 * `folder` the groups of that unit or folder, as `graph-it architecture --level units` and
 * `--folder` report them. Violations (checkArchitecture) colour the edges whose pairs they hold.
 */
export function architectureDiagramInput(
  source: UnitSource,
  workspaceRoot: string,
  options: DiagramInputOptions = {},
): DiagramInput {
  const { minImports = 1 } = options;
  const input = levelInput(source, workspaceRoot, options);
  if (minImports <= 1) return input;
  // As the view's Min. imports: weaker edges are not drawn, the violations still count.
  const edges = input.edges.filter((edge) => edge.fileEdgeCount >= minImports);
  return { ...input, edges, filters: [...(input.filters ?? []), `min. ${minImports} imports`] };
}

export interface DiagramInputOptions {
  folder?: string;
  violations?: Violations;
  /** Units level only: draws the units of this role, as the view's role legend does. */
  role?: string;
  /** Draws the edges of at least this many file pairs, as the view's Min. imports does. */
  minImports?: number;
}

function levelInput(source: UnitSource, workspaceRoot: string, { folder, violations = [], role }: DiagramInputOptions): DiagramInput {
  const workspace = workspaceName(workspaceRoot);
  const date = source.graph.context.indexedAt?.slice(0, 10);
  if (folder === undefined) {
    const { unitEdges, context } = source.units;
    const units = source.units.units.filter((unit) => role === undefined || unit.role === role);
    const kept = new Set(units.map((unit) => unit.key));
    const keyOf = (file: string) => {
      const key = source.assignment.unitOf.get(file);
      return key !== undefined && kept.has(key) ? key : undefined;
    };
    const { edge, count, accepted } = edgeRules(violations, keyOf);
    return {
      workspace, scope: "units", noun: "units", revision: context.revision, date, violations: count, acceptedViolations: accepted,
      ...(role === undefined ? {} : { filters: [`role ${role}`] }),
      nodes: units.map(({ key, name, layer, fileCount, internalEdgeCount, role: unitRole }) => ({ key, label: name, layer, fileCount, internalEdgeCount, role: unitRole })),
      edges: unitEdges
        .filter(({ from, to }) => kept.has(from) && kept.has(to))
        .map(({ from, to, fileEdgeCount, kind }) => ({ from, to, fileEdgeCount, kind, ...edge(from, to) })),
    };
  }
  const level = viewUnitLevel(source, Number.POSITIVE_INFINITY, folder);
  if (level.groups.length === 0) {
    throw new Error(`No file below folder "${folder}". Pass a unit key or a folder key of the workspace.`);
  }
  const keys = new Map(level.groups.map((group) => [group.id, group.key]));
  const groupOf = new Map(level.graph.nodes.map((node) => [node.relativePath, node.communityKey]));
  const { edge, count, accepted } = edgeRules(violations, (file) => groupOf.get(file));
  const { groupLayers, groupEdgeKinds } = level.units;
  return {
    workspace, scope: folder, noun: "groups", revision: level.revision, date, violations: count, acceptedViolations: accepted,
    nodes: level.groups.map(({ id, key, label, fileCount, internalEdgeCount }) => ({ key, label, layer: groupLayers[id] ?? 0, fileCount, internalEdgeCount })),
    edges: level.groupEdges.filter((groupEdge) => keys.has(groupEdge.from) && keys.has(groupEdge.to)).map(({ from, to, fileEdgeCount }) => {
      const [fromKey, toKey] = [keys.get(from)!, keys.get(to)!];
      return { from: fromKey, to: toKey, fileEdgeCount, kind: groupEdgeKinds[`${from}>${to}`] ?? "down", ...edge(fromKey, toKey) };
    }),
  };
}

// shortcut: East Asian wide and emoji ranges only, no full Unicode width table; upgrade if labels in other scripts overflow.
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;

/** Width of a text in monospace cells: a wide character takes two. */
const cells = (text: string) => Array.from(text).reduce((sum, char) => sum + (WIDE.test(char) ? 2 : 1), 0);

/** Upper bound of a text's drawn width at `fontSize`. */
export const textWidth = (text: string, fontSize: number) => cells(text) * SIZES.monoAdvance * fontSize;

/** Text XML accepts, read as stored: lone surrogates, control characters and bidi overrides replaced with U+FFFD. */
export const sanitizeText = (text: string) => text.toWellFormed().replaceAll(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, String.fromCodePoint(0xfffd));

/** A label safe to draw, cut to `max` cells with "…". */
export function fitLabel(label: string, max: number = SIZES.maxLabelChars): string {
  const clean = sanitizeText(label);
  if (cells(clean) <= max) return clean;
  let text = "";
  for (const char of clean) {
    if (cells(text + char) > max - 1) break;
    text += char;
  }
  return `${text}…`;
}

/** 1 px for one file pair, half a pixel more each time the count doubles, at most SIZES.maxStroke. */
export const strokeWidth = (fileEdgeCount: number) =>
  Math.min(SIZES.maxStroke, SIZES.hairline + Math.floor(Math.log2(Math.max(1, fileEdgeCount))) / 2);

/** Cycles among `nodes`: strongly connected components of two nodes or more over the cycle edges, sorted. */
export function cyclesOf(nodes: readonly string[], edges: readonly DiagramEdge[]): string[][] {
  const successors = new Map<string, string[]>();
  for (const { from, to } of edges.filter((edge) => edge.kind === "cycle")) successors.set(from, [...(successors.get(from) ?? []), to]);
  return stronglyConnectedComponents(nodes, successors)
    .filter((members) => members.length > 1)
    .map((members) => members.toSorted(byCodeUnit))
    .sort((left, right) => byCodeUnit(left[0], right[0]));
}

/** What a drawing leaves out of its level; the counts line still covers the whole level. */
export interface DrawOptions {
  /** Nodes drawn at most (default MAX_DIAGRAM_NODES). */
  maxNodes?: number;
  /** Leaves out the nodes with no edge to another node of the level. */
  connectedOnly?: boolean;
  /** Keeps the most coupled nodes (file pairs in and out) instead of the largest, cycle members first. */
  byCoupling?: boolean;
  /** On a level with cycles, draws only the edges that cut them (cycleCuts) and their ends. */
  cutsOnly?: boolean;
}

/** The edges that cut the level's cycles and the note counting the rest, or undefined without a cycle. */
function cutView(input: DiagramInput) {
  const matrix = buildMatrix(
    input.nodes.map(({ key, label, internalEdgeCount }) => ({ id: key, key, label, internalEdgeCount: internalEdgeCount ?? 0 })),
    input.edges,
  );
  const cut = new Set(cycleCuts(matrix).flatMap((cycle) => cycle.cells.map((cell) => `${matrix.rows[cell.row].key}>${matrix.rows[cell.column].key}`)));
  if (cut.size === 0) return undefined;
  const edges = input.edges.filter((edge) => cut.has(`${edge.from}>${edge.to}`));
  const ends = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  const inCycle = matrix.cycles.flatMap((cycle) => cycle.members);
  const pairs = edges.reduce((total, edge) => total + edge.fileEdgeCount, 0);
  const full = input.scope === "units" ? "graph-it diagram" : `graph-it diagram --folder ${JSON.stringify(fitLabel(input.scope, 64))}`;
  const left = [
    [inCycle.filter((key) => !ends.has(key)).length, input.noun, " of a cycle"],
    [input.nodes.length - inCycle.length, input.noun, " outside cycles"],
    [input.edges.length - edges.length, "other edges", ""],
  ] as const;
  const notDrawn = left.filter(([count]) => count > 0).map(([count, noun, where]) => plural(count, noun) + where);
  const notes = [
    `only the edges that cut a cycle drawn: ${edges.length} in the level (${plural(pairs, "file pairs")})`,
    ...(notDrawn.length > 0 ? [`${notDrawn.join(", ")} not drawn; all of them: ${full}`] : []),
  ];
  return { edges, notes };
}

/** Which nodes the cap drew, and how many of those it left out sit in a cycle. */
function drawnNote(coupled: { inCycle: ReadonlySet<string> } | undefined, left: readonly DiagramNode[]) {
  if (coupled === undefined) return "largest are drawn";
  const count = left.filter((node) => coupled.inCycle.has(node.key)).length;
  return "most coupled are drawn, cycle members first" + (count > 0 ? ` (${count} of them in a cycle)` : "");
}

/** The coupled order: cycle members first, then by file pairs in and out, then by key. */
function byCoupling(nodes: readonly DiagramNode[], input: DiagramInput) {
  const pairs = new Map<string, number>();
  for (const { from, to, fileEdgeCount } of input.edges) {
    pairs.set(from, (pairs.get(from) ?? 0) + fileEdgeCount);
    pairs.set(to, (pairs.get(to) ?? 0) + fileEdgeCount);
  }
  const inCycle = new Set(cyclesOf(input.nodes.map((node) => node.key), input.edges).flat());
  const ranked = nodes.toSorted((left, right) =>
    Number(inCycle.has(right.key)) - Number(inCycle.has(left.key)) || (pairs.get(right.key) ?? 0) - (pairs.get(left.key) ?? 0) || byCodeUnit(left.key, right.key));
  return { ranked, inCycle };
}

/**
 * The nodes and edges drawn, at most `maxNodes` nodes (the largest by default), the nodes of the
 * level left out and the note that names them.
 */
export function capNodes(input: DiagramInput, options: DrawOptions = {}) {
  const maxNodes = Math.max(1, options.maxNodes ?? MAX_DIAGRAM_NODES);
  const cut = options.cutsOnly ? cutView(input) : undefined;
  const drawable = cut?.edges ?? input.edges;
  const linked = new Set(drawable.flatMap((edge) => [edge.from, edge.to]));
  // A level without any edge keeps its nodes: an empty drawing says less than lone boxes.
  const candidates = linked.size > 0 && (cut !== undefined || options.connectedOnly) ? input.nodes.filter((node) => linked.has(node.key)) : input.nodes;
  const coupled = options.byCoupling ? byCoupling(candidates, input) : undefined;
  const ranked = coupled?.ranked ?? candidates.toSorted((left, right) => right.fileCount - left.fileCount || byCodeUnit(left.key, right.key));
  const nodes = ranked.slice(0, maxNodes).sort((left, right) => byCodeUnit(left.key, right.key));
  const kept = new Set(nodes.map((node) => node.key));
  const edges = drawable
    .filter((edge) => kept.has(edge.from) && kept.has(edge.to))
    .sort((left, right) => byCodeUnit(left.from, right.from) || byCodeUnit(left.to, right.to));
  const isolated = cut === undefined && options.connectedOnly ? input.nodes.length - candidates.length : 0;
  const capped = candidates.length - nodes.length;
  const notes = [
    ...(cut?.notes ?? []),
    isolated > 0 ? `${plural(isolated, input.noun)} with no edge to the others not drawn` : undefined,
    capped > 0 ? `${plural(capped, "more " + input.noun)} not drawn: the ${nodes.length} ${drawnNote(coupled, ranked.slice(maxNodes))}` : undefined,
  ].filter((note) => note !== undefined);
  return { nodes, edges, hidden: input.nodes.length - nodes.length, notes };
}

/** Legend samples, left to right: a 24 px line sample, 8 px, the text, 16 px to the next. */
export const LEGEND_ITEMS = [
  { kind: "down", text: "dependency" },
  { kind: "accent", text: "upward or cycle" },
  { kind: "error", text: "breaks a rule" },
  { kind: "weight", text: "width = file pairs" },
] as const;

const ACCEPTED_ITEM = { kind: "accepted", text: "accepted in baseline" } as const;

/** Which legend items a drawing needs: the baseline one when an edge is accepted, the width one for the graph only. */
export interface LegendOptions {
  accepted?: boolean;
  weight?: boolean;
}

/** Each legend item's x offset from the legend's start, and the legend's width. */
export function legendLayout({ accepted = false, weight = true }: LegendOptions = {}) {
  let x = 0;
  const shown = LEGEND_ITEMS.filter((item) => weight || item.kind !== "weight");
  const items = [...shown, ...(accepted ? [ACCEPTED_ITEM] : [])].map((item) => {
    const placed = { ...item, x };
    x += snap(32 + textWidth(item.text, SIZES.caption) + 16);
    return placed;
  });
  return { items, width: x - 16 };
}

const plural = (count: number, noun: string) => `${count} ${count === 1 ? noun.replace(/s$/, "") : noun}`;

/** Distinct rule names of the level's edges, sorted. */
export const brokenRules = (edges: readonly DiagramEdge[]) => [...new Set(edges.flatMap((edge) => edge.rules))].sort(byCodeUnit);

/**
 * The counts of the whole level, the header lines, the note naming what the cap leaves out and
 * the names of the broken rules: shared by the graph and the matrix.
 */
export function diagramHeader(input: DiagramInput, hidden: string[] = []): { counts: DiagramCounts; text: DiagramText } {
  const counts = {
    nodes: input.nodes.length,
    layers: new Set(input.nodes.map((node) => node.layer)).size,
    cycles: cyclesOf(input.nodes.map((node) => node.key), input.edges).length,
    violations: input.violations,
  };
  const scope = input.scope === "units" ? "units" : `folder ${fitLabel(input.scope, 64)}`;
  const accepted = input.acceptedViolations ? ` (${input.acceptedViolations} accepted)` : "";
  const rules = brokenRules(input.edges);
  return {
    counts,
    text: {
      title: `Architecture · ${fitLabel(input.workspace, 48)}`,
      caption: [scope, ...(input.filters ?? []).map((filter) => fitLabel(filter, 48)), `revision ${input.revision.slice(0, 12)}`, ...(input.date ? [input.date] : [])].join(" · "),
      counts: [plural(counts.nodes, input.noun), plural(counts.layers, "layers"), plural(counts.cycles, "cycles"), plural(counts.violations, "violations") + accepted].join(" · "),
      hidden,
      rules: rules.length > 0 ? fitLabel(`broken rules: ${rules.join(", ")}`, 96) : undefined,
    },
  };
}

/** Notes drawn above the legend, bottom one last. */
export const legendNotes = (text: DiagramText) => [...text.hidden, text.rules, text.reading].filter((note) => note !== undefined);

/** Height of the legend and its notes, one 20 px line per note. */
export const legendHeight = (text: DiagramText) => SIZES.legendHeight + 20 * legendNotes(text).length;

/** Widest of the header lines, the notes and the legend: the canvas fits it. */
export function textBound(text: DiagramText, legend: LegendOptions): number {
  const lines = [[text.title, SIZES.title], [text.caption, SIZES.caption], [text.counts, SIZES.caption], ...legendNotes(text).map((note) => [note, SIZES.caption] as const)] as const;
  return Math.max(legendLayout(legend).width, ...lines.map(([line, size]) => textWidth(line, size)));
}

/** Whether any edge of the level is drawn as accepted. */
export const hasAccepted = (edges: readonly DiagramEdge[]) => edges.some((edge) => edge.accepted === true);

/** The view's options; the margins lie outside the graph, so the root needs no padding. */
const ELK_OPTIONS = { ...ELK_LAYERED_OPTIONS, "elk.padding": "[top=0,left=0,bottom=0,right=0]" };

/** Every node of an ELK result, nested ones included. */
const flatten = (node: ElkNode): ElkNode[] => (node.children ?? []).flatMap((child) => [child, ...flatten(child)]);

const round = (value: number | undefined) => Math.round((value ?? 0) * 10) / 10;

/**
 * Lays one level out: ELK layered, top to bottom, each node's layer a partition (highest on
 * top), the members of each cycle inside one block that carries their shared layer. Box sizes
 * come from the labels, so a label always fits its box. `options` choose the nodes drawn (capNodes).
 */
export async function layoutDiagram(input: DiagramInput, options: DrawOptions = {}): Promise<DiagramLayout> {
  const { nodes, edges, hidden, notes } = capNodes(input, options);
  const kept = new Set(nodes.map((node) => node.key));
  // The cycles of the whole level: a cut view draws no cycle edge back, its block still holds the members.
  const levelCycles = cyclesOf(input.nodes.map((node) => node.key), input.edges)
    .map((members) => ({ members: members.filter((key) => kept.has(key)), size: members.length }))
    .filter(({ members }) => members.length > 1);
  const cycles = levelCycles.map(({ members }) => members);
  const cycleOf = new Map(cycles.flatMap((members, index) => members.map((key) => [key, index])));
  const id = new Map(nodes.map((node, index) => [node.key, `n${index}`]));
  const top = Math.max(0, ...nodes.map((node) => node.layer));
  const partition = (layer: number) => layerPartition(top, layer);
  const sized = nodes.map((node) => {
    const text = fitLabel(node.label);
    const meta = `${node.fileCount} ${node.fileCount === 1 ? "file" : "files"} · layer ${node.layer}`;
    const width = snap(Math.max(SIZES.minNodeWidth, textWidth(text, SIZES.label) + 2 * SIZES.nodePaddingX, textWidth(meta, SIZES.meta) + 2 * SIZES.nodePaddingX));
    return { ...node, text, meta, width, height: SIZES.nodeHeight };
  });
  const leaf = (node: (typeof sized)[number], inCycle: boolean): ElkNode =>
    ({ id: id.get(node.key)!, width: node.width, height: node.height, layoutOptions: inCycle ? undefined : partition(node.layer) });
  const byKey = new Map(sized.map((node) => [node.key, node]));
  const elkEdges: ElkExtendedEdge[] = edges.map((edge, index) => ({ id: `e${index}`, sources: [id.get(edge.from)!], targets: [id.get(edge.to)!] }));
  const graph: ElkNode = {
    id: "root",
    layoutOptions: ELK_OPTIONS,
    children: [
      ...sized.filter((node) => !cycleOf.has(node.key)).map((node) => leaf(node, false)),
      // Units of one cycle share a layer: the block carries it.
      ...cycles.map((members, index): ElkNode => ({
        id: `c${index}`,
        // ELK reads a compound's padding on the compound, not on the root.
        layoutOptions: { ...partition(byKey.get(members[0])!.layer), "elk.padding": CYCLE_PADDING },
        children: members.map((key) => leaf(byKey.get(key)!, true)),
      })),
    ],
    edges: elkEdges,
  };
  const result = await new ELK().layout(graph);
  const placed = new Map(flatten(result).map((node) => [node.id, node]));
  const header = SIZES.margin + SIZES.headerHeight;
  const at = (node: ElkNode | undefined): Box =>
    ({ x: round(SIZES.margin + (node?.x ?? 0)), y: round(header + (node?.y ?? 0)), width: round(node?.width), height: round(node?.height) });
  const shift = (point: { x: number; y: number }) => ({ x: round(SIZES.margin + point.x), y: round(header + point.y) });
  const routes = new Map((result.edges ?? []).map((edge) => [edge.id, edge.sections ?? []]));
  const { counts, text } = diagramHeader(input, notes);
  return {
    input,
    text,
    width: snap(SIZES.margin * 2 + Math.max(result.width ?? 0, textBound(text, { accepted: hasAccepted(edges) }))),
    height: snap(header + (result.height ?? 0) + SIZES.margin + legendHeight(text)),
    top: header,
    nodes: sized.map((node) => ({ ...node, ...at(placed.get(id.get(node.key)!)), width: node.width, height: node.height })),
    edges: edges.map((edge, index) => ({
      ...edge,
      stroke: strokeWidth(edge.fileEdgeCount),
      points: (routes.get(`e${index}`) ?? []).flatMap((section) => [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]).map(shift),
    })),
    cycles: levelCycles.map(({ members, size }, index) => ({ members, size, ...at(placed.get(`c${index}`)) })),
    hidden,
    counts,
  };
}
