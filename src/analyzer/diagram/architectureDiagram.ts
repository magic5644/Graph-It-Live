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
import type { ArchitectureUnitEdgeKind } from "../../shared/architecture-model";
import { ELK_LAYERED_OPTIONS, layerPartition } from "../../shared/elkLayered";
import { normalizePath } from "../../shared/path";
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
  members: string[];
}

export interface DiagramText {
  title: string;
  caption: string;
  counts: string;
  hidden: string | undefined;
  rules: string | undefined;
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
  options: { folder?: string; violations?: Violations } = {},
): DiagramInput {
  const { folder, violations = [] } = options;
  const workspace = workspaceName(workspaceRoot);
  const date = source.graph.context.indexedAt?.slice(0, 10);
  if (folder === undefined) {
    const { units, unitEdges, context } = source.units;
    const { edge, count, accepted } = edgeRules(violations, (file) => source.assignment.unitOf.get(file));
    return {
      workspace, scope: "units", noun: "units", revision: context.revision, date, violations: count, acceptedViolations: accepted,
      nodes: units.map(({ key, name, layer, fileCount, internalEdgeCount }) => ({ key, label: name, layer, fileCount, internalEdgeCount })),
      edges: unitEdges.map(({ from, to, fileEdgeCount, kind }) => ({ from, to, fileEdgeCount, kind, ...edge(from, to) })),
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
function cyclesOf(nodes: readonly string[], edges: readonly DiagramEdge[]): string[][] {
  const successors = new Map<string, string[]>();
  for (const { from, to } of edges.filter((edge) => edge.kind === "cycle")) successors.set(from, [...(successors.get(from) ?? []), to]);
  return stronglyConnectedComponents(nodes, successors)
    .filter((members) => members.length > 1)
    .map((members) => members.toSorted(byCodeUnit))
    .sort((left, right) => byCodeUnit(left[0], right[0]));
}

/** The largest `maxNodes` nodes (by files, then key) and the edges between them. */
export function capNodes(input: DiagramInput, maxNodes: number) {
  const nodes = input.nodes
    .toSorted((left, right) => right.fileCount - left.fileCount || byCodeUnit(left.key, right.key))
    .slice(0, maxNodes)
    .sort((left, right) => byCodeUnit(left.key, right.key));
  const kept = new Set(nodes.map((node) => node.key));
  const edges = input.edges
    .filter((edge) => kept.has(edge.from) && kept.has(edge.to))
    .sort((left, right) => byCodeUnit(left.from, right.from) || byCodeUnit(left.to, right.to));
  return { nodes, edges, hidden: input.nodes.length - nodes.length };
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
const brokenRules = (edges: readonly DiagramEdge[]) => [...new Set(edges.flatMap((edge) => edge.rules))].sort(byCodeUnit);

/**
 * The counts of the whole level, the header lines, the note naming what the cap leaves out and
 * the names of the broken rules: shared by the graph and the matrix.
 */
export function diagramHeader(input: DiagramInput, hidden: number, drawn: number): { counts: DiagramCounts; text: DiagramText } {
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
      caption: [scope, `revision ${input.revision.slice(0, 12)}`, ...(input.date ? [input.date] : [])].join(" · "),
      counts: [plural(counts.nodes, input.noun), plural(counts.layers, "layers"), plural(counts.cycles, "cycles"), plural(counts.violations, "violations") + accepted].join(" · "),
      hidden: hidden > 0 ? `${plural(hidden, "more " + input.noun)} not drawn: the ${drawn} largest are drawn` : undefined,
      rules: rules.length > 0 ? fitLabel(`broken rules: ${rules.join(", ")}`, 96) : undefined,
    },
  };
}

/** Notes drawn above the legend, bottom one last. */
export const legendNotes = (text: DiagramText) => [text.hidden, text.rules].filter((note) => note !== undefined);

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
 * come from the labels, so a label always fits its box. At most `maxNodes` nodes are drawn.
 */
export async function layoutDiagram(input: DiagramInput, options: { maxNodes?: number } = {}): Promise<DiagramLayout> {
  const { nodes, edges, hidden } = capNodes(input, Math.max(1, options.maxNodes ?? MAX_DIAGRAM_NODES));
  const cycles = cyclesOf(nodes.map((node) => node.key), edges);
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
  const { counts, text } = diagramHeader(input, hidden, nodes.length);
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
    cycles: cycles.map((members, index) => ({ members, ...at(placed.get(`c${index}`)) })),
    hidden,
    counts,
  };
}
