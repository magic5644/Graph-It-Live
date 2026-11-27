/**
 * The model and the layout of the architecture delta diagram (#449): the structure diff of a review (#345)
 * and its rule violations drawn as two panels, Before and After, on one grid. It only reads what
 * `ReviewGateAnalyzer.analyzeArchitecture` already computed: no second comparison of the trees.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import ELK, { type ElkExtendedEdge, type ElkNode } from "elkjs/lib/elk.bundled.js";
import type { StructureCount, StructureCycleDiff, StructureEdgeDiff, StructureItemDiff, StructureLevelDiff } from "../../shared/architecture-model";
import { ELK_LAYERED_OPTIONS } from "../../shared/elkLayered";
import { byCodeUnit } from "../architecture/architectureUnits";
import { range } from "../architecture/architectureStructure";
import type { ArchitecturePair } from "../architecture/architectureReview";
import type { ArchitectureDeltaSource } from "../ReviewGateAnalyzer";
import { fitName, textWidth, type Box } from "./architectureDiagram";
import type { Point } from "./flowDiagram";
import { SIZES, snap } from "./diagramStyle";

export const MAX_DELTA_UNITS = 40;
export const MAX_DELTA_LEDGER = 60;
/** Edges drawn at most: past it, a wall of removed edges hides the units (cal.com: 176 removed). */
export const MAX_DELTA_EDGES = 60;

export type DeltaStatus = "ADDED" | "REMOVED" | "CHANGED" | "RENAMED" | "REWIRED" | "UNCHANGED";
const STATUS_ORDER: DeltaStatus[] = ["ADDED", "REMOVED", "CHANGED", "RENAMED", "REWIRED"];

export interface DeltaNode {
  /** `-<key>` for a REMOVED unit (a head unit may share the key), else the key. */
  id: string;
  key: string;
  /** RENAMED: "new (was old)". */
  label: string;
  status: DeltaStatus;
  fileCount: StructureCount;
  role?: { before?: string; after?: string };
  /** BOTH: member of a resolved cycle and of a new one (a cycle that grew or changed members). */
  inCycle?: "ADDED" | "REMOVED" | "BOTH";
  /** The node is in a cycle whose other edges are unchanged, so the diff does not draw them. */
  cycleEdgesHidden?: boolean;
  violations: { new: number; resolved: number };
}

export interface DeltaEdge {
  from: string;
  to: string;
  status: "ADDED" | "REMOVED" | "CHANGED";
  pairs: StructureCount;
  violation?: "new" | "accepted" | "resolved";
  rules: string[];
}

/** One line of the ledger; `(target, change)` is unique. */
export interface DeltaLedgerRow { target: string; change: string; text: string }

export interface DeltaModel {
  refs: { base: string; head: string };
  nodes: DeltaNode[];
  edges: DeltaEdge[];
  ledger: DeltaLedgerRow[];
  /** What the drawing leaves out, one line each, always with the command that lists it. */
  cut: string[];
  /** The header line, in words. */
  counts: string;
  warnings: string[];
}

type ViolationKind = "new" | "accepted" | "resolved";
interface ViolationRow { rule: string; from: string; to: string; kind: ViolationKind; pairs: number; fromId?: string; toId?: string }
interface Cycle { status: "ADDED" | "REMOVED"; ids: string[]; keys: string[] }

const idOf = (item: StructureItemDiff) => (item.status === "REMOVED" ? `-${item.key}` : item.key);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const words = (entries: [string, number][]) => entries.filter(([, value]) => value > 0).map(([word, value]) => `${value} ${word}`).join(", ") || "none";

function roleText(role: StructureItemDiff["role"]): string | undefined {
  if (role === undefined) return undefined;
  // An ADDED or REMOVED unit has one side only: no arrow from or to nothing.
  if (role.before === undefined || role.after === undefined || role.before === role.after) return `role ${role.after ?? role.before}`;
  return `role ${role.before} -> ${role.after}`;
}

/** What a unit's change is, after its status word: files and role, or "connections changed" for REWIRED. */
function unitFacts(node: DeltaNode): string[] {
  if (node.status === "REWIRED") return ["connections changed"];
  if (node.status === "UNCHANGED") return [];
  const role = roleText(node.role);
  return [`files ${range(node.fileCount)}`, ...(role ? [role] : [])];
}

const CYCLE_WORDS = { ADDED: "in new cycle", REMOVED: "in resolved cycle", BOTH: "in resolved and new cycles" } as const;

/** The line under a node's name: its status word first, so the shape and the colour are never the only key. */
export function deltaMeta(node: DeltaNode): string {
  const cycle = node.inCycle === undefined ? [] : [CYCLE_WORDS[node.inCycle]];
  const hidden = node.cycleEdgesHidden ? ["unchanged edges not drawn"] : [];
  const violations = node.violations.new > 0 ? [plural(node.violations.new, "new violation")] : [];
  const resolved = node.violations.resolved > 0 ? [`${node.violations.resolved} resolved`] : [];
  return [node.status === "UNCHANGED" ? "context" : node.status, ...unitFacts(node), ...cycle, ...hidden, ...violations, ...resolved].join(" · ");
}

/** The previous key without the folder it shares with the new one, so a cut label keeps the new name (cal.com `app-store/make` -> `make-v2`). */
function previousName(key: string, previous: string): string {
  let shared = 0;
  for (let slash = key.indexOf("/"); slash >= 0 && key.slice(0, slash + 1) === previous.slice(0, slash + 1); slash = key.indexOf("/", slash + 1)) shared = slash + 1;
  return previous.slice(shared) || previous;
}

function itemNode(item: StructureItemDiff): DeltaNode {
  const label = item.status === "RENAMED" ? `${item.key} (was ${previousName(item.key, item.previousKey ?? "")})` : item.key;
  return { id: idOf(item), key: item.key, label, status: item.status, fileCount: item.fileCount, ...(item.role ? { role: item.role } : {}), violations: { new: 0, resolved: 0 } };
}

const endId = (key: string, gone: boolean) => (gone ? `-${key}` : key);

/** The edges in drawn ids; an end flagged `gone` is a REMOVED unit, whose id differs from a head unit of the same key. */
const deltaEdges = (edges: StructureEdgeDiff[]): DeltaEdge[] =>
  edges.map((edge) => ({
    from: endId(edge.from, edge.gone?.includes("from") === true),
    to: endId(edge.to, edge.gone?.includes("to") === true),
    status: edge.status, pairs: edge.pairs, rules: [],
  }));

const deltaCycles = (cycles: StructureCycleDiff[]): Cycle[] =>
  cycles.map((cycle) => ({ status: cycle.status, keys: cycle.members, ids: cycle.members.map((member) => endId(member, cycle.gone?.includes(member) === true)) }));

const keyOfId = (id: string) => (id.startsWith("-") ? id.slice(1) : id);

/** Units named by an edge or a cycle but absent from the diff's items: REWIRED when an ADDED or REMOVED edge touches them, else context. */
function contextNodes(nodes: Map<string, DeltaNode>, edges: DeltaEdge[], cycles: Cycle[]): void {
  const rewired = new Set(edges.filter((edge) => edge.status !== "CHANGED").flatMap((edge) => [edge.from, edge.to]));
  const add = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { id, key: keyOfId(id), label: keyOfId(id), status: rewired.has(id) ? "REWIRED" : "UNCHANGED", fileCount: {}, violations: { new: 0, resolved: 0 } });
  };
  for (const edge of edges) [edge.from, edge.to].forEach(add);
  for (const cycle of cycles) cycle.ids.forEach(add);
}

/** A resolved violation names base labels: a RENAMED unit by its previous key, a REMOVED one as `-key`. */
function baseIds(items: StructureItemDiff[]): (label: string) => string {
  const mapped = new Map<string, string>();
  for (const item of items) {
    if (item.status === "RENAMED" && item.previousKey !== undefined) mapped.set(item.previousKey, item.key);
    else if (item.status === "REMOVED") mapped.set(item.key, `-${item.key}`);
  }
  return (label) => mapped.get(label) ?? label;
}

/** A violation end that names one element: its unit (element units take the element label, architectureRules `label`). */
const isUnitLabel = (label: string) => label !== "(no element)" && !label.includes(", ");

/**
 * Violation ends the diff does not name (a rules-only change) join as context, so a changed review never
 * draws empty panels; `(no element)` and multi-element ends stay ledger rows only.
 */
function violationContext(source: ArchitectureDeltaSource, items: StructureItemDiff[], nodes: Map<string, DeltaNode>): void {
  const toBase = baseIds(items);
  const ends = (source.architecture?.rules ?? []).flatMap((rule) => [
    ...rule.newViolations.flatMap((pair) => [pair.from, pair.to]),
    ...rule.resolvedViolations.flatMap((pair) => [toBase(pair.from), toBase(pair.to)]),
  ]);
  for (const id of ends.filter(isUnitLabel)) {
    if (!nodes.has(id)) nodes.set(id, { id, key: keyOfId(id), label: keyOfId(id), status: "UNCHANGED", fileCount: {}, violations: { new: 0, resolved: 0 } });
  }
}

function violationRows(source: ArchitectureDeltaSource, items: StructureItemDiff[], known: ReadonlySet<string>): ViolationRow[] {
  const rows = new Map<string, ViolationRow>();
  const toBase = baseIds(items);
  const add = (rule: string, pair: ArchitecturePair, kind: ViolationKind) => {
    const [fromId, toId] = kind === "resolved" ? [toBase(pair.from), toBase(pair.to)] : [pair.from, pair.to];
    const id = `${rule}\0${pair.from}\0${pair.to}\0${kind}`;
    const row = rows.get(id) ?? { rule, from: pair.from, to: pair.to, kind, pairs: 0, ...(known.has(fromId) ? { fromId } : {}), ...(known.has(toId) ? { toId } : {}) };
    row.pairs += 1;
    rows.set(id, row);
  };
  for (const rule of source.architecture?.rules ?? []) {
    for (const violation of rule.newViolations) add(rule.name, violation, violation.accepted ? "accepted" : "new");
    for (const violation of rule.resolvedViolations) add(rule.name, violation, "resolved");
  }
  return [...rows.values()].toSorted((left, right) => byCodeUnit(`${left.rule}\0${left.from}\0${left.to}\0${left.kind}`, `${right.rule}\0${right.from}\0${right.to}\0${right.kind}`));
}

const VIOLATION_RANK: Record<ViolationKind, number> = { new: 0, accepted: 1, resolved: 2 };

/** Marks the nodes and the edge one violation names. */
function markViolation(row: ViolationRow, nodes: Map<string, DeltaNode>, edges: DeltaEdge[]): void {
  for (const id of [row.fromId, row.toId]) {
    const node = id === undefined ? undefined : nodes.get(id);
    if (node) node.violations[row.kind === "resolved" ? "resolved" : "new"] += row.pairs;
  }
  const edge = edges.find((candidate) => candidate.from === row.fromId && candidate.to === row.toId);
  if (!edge) return;
  edge.rules = [...new Set([...edge.rules, row.rule])].sort(byCodeUnit);
  if (edge.violation === undefined || VIOLATION_RANK[row.kind] < VIOLATION_RANK[edge.violation]) edge.violation = row.kind;
}

/** Marks the node and edge each violation names; a violation of a unit the diff does not name is only a ledger row. */
function applyViolations(rows: ViolationRow[], nodes: Map<string, DeltaNode>, edges: DeltaEdge[]): void {
  for (const row of rows) markViolation(row, nodes, edges);
}

function markCycles(nodes: Map<string, DeltaNode>, edges: DeltaEdge[], cycles: Cycle[]): void {
  for (const cycle of cycles) {
    // A cycle of n members has at least n edges: fewer changed ones means the others are unchanged and not drawn.
    const members = new Set(cycle.ids);
    const live = new Set<DeltaEdge["status"]>(cycle.status === "ADDED" ? ["ADDED", "CHANGED"] : ["REMOVED", "CHANGED"]);
    const drawn = edges.filter((edge) => live.has(edge.status) && members.has(edge.from) && members.has(edge.to)).length;
    for (const id of cycle.ids) {
      const node = nodes.get(id)!;
      node.inCycle = node.inCycle === undefined || node.inCycle === cycle.status ? cycle.status : "BOTH";
      if (drawn < cycle.ids.length) node.cycleEdgesHidden = true;
    }
  }
}

const unitCounts = (nodes: DeltaNode[]) =>
  words(STATUS_ORDER.map((status): [string, number] => [status.toLowerCase(), nodes.filter((node) => node.status === status).length]));

function countsLine(level: StructureLevelDiff, nodes: DeltaNode[], cycles: Cycle[], rows: ViolationRow[]): string {
  const { items, edges } = level.compared;
  const edgeCount = (status: StructureEdgeDiff["status"]): [string, number] => [status.toLowerCase(), level.edges.filter((edge) => edge.status === status).length];
  const pairs = (kind: ViolationKind) => rows.filter((row) => row.kind === kind).reduce((sum, row) => sum + row.pairs, 0);
  return [
    `units ${items.before} -> ${items.after}: ${unitCounts(nodes)}`,
    `unit edges ${edges.before} -> ${edges.after}: ${words(["ADDED", "REMOVED", "CHANGED"].map((status) => edgeCount(status as StructureEdgeDiff["status"])))}`,
    `cycles: ${words([["added", cycles.filter((cycle) => cycle.status === "ADDED").length], ["resolved", cycles.filter((cycle) => cycle.status === "REMOVED").length]])}`,
    `violations (file pairs): ${words([["new", pairs("new")], ["accepted", pairs("accepted")], ["resolved", pairs("resolved")]])}`,
  ].join(" · ");
}

/** Rarer, content-level changes first: a branch that deletes 40 packages must not hide the one it adds (cal.com). */
const STATUS_TIER: Record<DeltaStatus, number> = { ADDED: 1, RENAMED: 1, CHANGED: 1, REMOVED: 2, REWIRED: 2, UNCHANGED: 3 };

/** The edges drawn among the drawn units: violation edges first, then the heaviest, at most MAX_DELTA_EDGES, in key order. */
function selectEdges(edges: DeltaEdge[], drawn: ReadonlySet<string>): DeltaEdge[] {
  const weight = (edge: DeltaEdge) => Math.max(edge.pairs.before ?? 0, edge.pairs.after ?? 0);
  return edges
    .filter((edge) => drawn.has(edge.from) && drawn.has(edge.to))
    .toSorted((left, right) => Number(right.violation !== undefined) - Number(left.violation !== undefined) || weight(right) - weight(left) || byCodeUnit(`${left.from}\0${left.to}`, `${right.from}\0${right.to}`))
    .slice(0, MAX_DELTA_EDGES)
    .toSorted((left, right) => byCodeUnit(`${left.from}\0${left.to}\0${left.status}`, `${right.from}\0${right.to}\0${right.status}`));
}

/** The units drawn: violation ends first, then by status tier, cycle members, the most changed edges, then the key. */
function select(nodes: DeltaNode[], edges: DeltaEdge[], cycles: Cycle[]): { drawn: Set<string>; dropped: DeltaNode[] } {
  if (nodes.length <= MAX_DELTA_UNITS) return { drawn: new Set(nodes.map((node) => node.id)), dropped: [] };
  const inCycle = new Set(cycles.flatMap((cycle) => cycle.ids));
  const degree = new Map<string, number>();
  for (const edge of edges) for (const id of [edge.from, edge.to]) degree.set(id, (degree.get(id) ?? 0) + 1);
  const tier = (node: DeltaNode) => {
    if (node.violations.new + node.violations.resolved > 0) return 0;
    return STATUS_TIER[node.status];
  };
  // Cycle membership breaks ties only: a cycle can hold every removed unit (cal.com app-store) and hide what was added.
  const ranked = nodes.toSorted((left, right) => tier(left) - tier(right) || Number(inCycle.has(right.id)) - Number(inCycle.has(left.id)) || (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) || byCodeUnit(left.id, right.id));
  return { drawn: new Set(ranked.slice(0, MAX_DELTA_UNITS).map((node) => node.id)), dropped: ranked.slice(MAX_DELTA_UNITS) };
}

const LEDGER_RANK = { violation: 0, cycle: 1, unit: 2, edge: 3 } as const;
interface RankedRow extends DeltaLedgerRow { rank: number }

function unitRow(node: DeltaNode): RankedRow {
  const rename = node.status === "RENAMED" ? node.label.slice(node.key.length + 1) : "";
  const detail = [...(rename ? [rename.slice(1, -1)] : []), ...unitFacts(node)].join(", ");
  const suffix = detail ? " (" + detail + ")" : "";
  return { rank: LEDGER_RANK.unit, target: node.id, change: node.status, text: `${node.status} unit ${node.key}${suffix}` };
}

function edgeRow(edge: DeltaEdge): RankedRow {
  const label = (id: string) => keyOfId(id);
  const pairs = edge.status === "CHANGED" ? `${range(edge.pairs)} file pairs` : plural(edge.pairs.after ?? edge.pairs.before ?? 0, "file pair");
  return { rank: LEDGER_RANK.edge, target: `edge:${edge.from}->${edge.to}`, change: edge.status, text: `${edge.status} edge ${label(edge.from)} -> ${label(edge.to)} (${pairs})` };
}

function cycleRow(cycle: Cycle): RankedRow {
  return { rank: LEDGER_RANK.cycle, target: `cycle:${cycle.ids.join(",")}`, change: cycle.status, text: `${cycle.status} cycle ${cycle.keys.join(", ")}` };
}

function violationRow(row: ViolationRow): RankedRow {
  const word = { new: "NEW", accepted: "ACCEPTED", resolved: "RESOLVED" }[row.kind];
  const drawn = row.fromId !== undefined && row.toId !== undefined;
  return {
    rank: LEDGER_RANK.violation,
    target: `violation:${row.rule}:${row.from}->${row.to}`,
    change: row.kind,
    text: `${word} violation ${row.rule}: ${row.from} -> ${row.to} (${plural(row.pairs, "file pair")})${drawn ? "" : " · ends are not single units: not drawn"}`,
  };
}

function cutLines(model: { base: string; head: string }, dropped: DeltaNode[], hidden: { edges: number; cycles: number; violations: number }, level: StructureLevelDiff, ledgerCut: number): string[] {
  const command = `graph-it review-pr --base ${model.base} --head ${model.head} --format json`;
  const changed = dropped.filter((node) => node.status !== "UNCHANGED");
  const byStatus = words(STATUS_ORDER.map((status): [string, number] => [status.toLowerCase(), changed.filter((node) => node.status === status).length]));
  const rest = words([["edges", hidden.edges], ["cycles", hidden.cycles], ["violations", hidden.violations]]);
  return [
    ...(changed.length > 0 ? [`${plural(changed.length, "changed unit")} not drawn (${byStatus}): ${command}`] : []),
    ...(rest === "none" ? [] : [`${rest} not drawn: ${command}`]),
    ...(ledgerCut > 0 ? [`${plural(ledgerCut, "ledger row")} not drawn: ${command}`] : []),
    ...(level.movedFiles.length > 0 ? [`${plural(level.movedFiles.length, "file")} moved between units: not drawn: ${command}`] : []),
    `${plural(level.compared.unchangedEdges, "unchanged unit edge")} not drawn`,
  ];
}

/** Builds the model of the delta from the review's structure diff and rule review; pure, sync. */
export function buildDeltaModel(source: ArchitectureDeltaSource): DeltaModel {
  const level = source.structure?.units;
  if (!level) throw new Error("No structure diff to draw: the review holds no unit comparison.");
  const nodes = new Map(level.items.map((item) => [idOf(item), itemNode(item)] as const));
  const edges = deltaEdges(level.edges);
  const cycles = deltaCycles(level.cycles);
  contextNodes(nodes, edges, cycles);
  violationContext(source, level.items, nodes);
  const rows = violationRows(source, level.items, new Set(nodes.keys()));
  applyViolations(rows, nodes, edges);
  const all = [...nodes.values()].toSorted((left, right) => byCodeUnit(left.id, right.id));
  const { drawn, dropped } = select(all, edges, cycles);
  const drawnEdges = selectEdges(edges, drawn);
  const drawnCycles = cycles.filter((cycle) => cycle.ids.every((id) => drawn.has(id)));
  const drawnNodes = all.filter((node) => drawn.has(node.id));
  markCycles(nodes, drawnEdges, drawnCycles);
  const ledger = [
    ...rows.map(violationRow),
    ...drawnCycles.map(cycleRow),
    ...drawnNodes.filter((node) => node.status !== "UNCHANGED").map(unitRow),
    ...drawnEdges.map(edgeRow),
  ].toSorted((left, right) => left.rank - right.rank || byCodeUnit(`${left.target}\0${left.change}`, `${right.target}\0${right.change}`));
  const unique = [...new Map(ledger.map((row) => [`${row.target}\0${row.change}`, row])).values()];
  const hidden = {
    edges: edges.length - drawnEdges.length,
    cycles: cycles.length - drawnCycles.length,
    violations: rows.filter((row) => (row.fromId !== undefined && !drawn.has(row.fromId)) || (row.toId !== undefined && !drawn.has(row.toId))).length,
  };
  const refs = { base: source.baseRef, head: source.headRef };
  return {
    refs,
    nodes: drawnNodes,
    edges: drawnEdges,
    ledger: unique.slice(0, MAX_DELTA_LEDGER).map(({ target, change, text }) => ({ target, change, text })),
    cut: cutLines(refs, dropped, hidden, level, Math.max(0, unique.length - MAX_DELTA_LEDGER)),
    counts: countsLine(level, all, cycles, rows),
    warnings: source.structure?.warnings ?? [],
  };
}

export interface DeltaPlacedNode extends DeltaNode, Box {
  text: string;
  meta: string;
}

export interface DeltaLayout {
  model: DeltaModel;
  /** One panel: Before and After both use this box. */
  width: number;
  height: number;
  nodes: DeltaPlacedNode[];
  edges: (DeltaEdge & { points: Point[] })[];
}

// No compounds here, so the components are packed into a wide-screen block instead of one row of units no edge links.
const ELK_OPTIONS = {
  ...ELK_LAYERED_OPTIONS,
  "elk.partitioning.activate": "false",
  // Left to right: a layer is a column, so many units removed together stack instead of making one 15,000 px row (cal.com).
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "SEPARATE_CHILDREN",
  "elk.separateConnectedComponents": "true",
  "elk.aspectRatio": "1.2",
  "elk.padding": "[top=0,left=0,bottom=0,right=0]",
};
const round = (value: number | undefined) => Math.round((value ?? 0) * 10) / 10;

/** One ELK run for the union of both panels, so a unit has the same place in Before and After. Coordinates are local to a panel. */
export async function layoutDelta(model: DeltaModel): Promise<DeltaLayout> {
  const sized = model.nodes.map((node, index) => {
    const text = fitName(node.label, 44);
    const meta = deltaMeta(node);
    const width = snap(Math.max(SIZES.minNodeWidth, textWidth(text, SIZES.label) + 2 * SIZES.nodePaddingX, textWidth(meta, SIZES.meta) + 2 * SIZES.nodePaddingX));
    return { ...node, text, meta, width, height: SIZES.nodeHeight, elk: `n${index}` };
  });
  const elkOf = new Map(sized.map((node) => [node.id, node.elk]));
  const linked = model.edges.filter((edge) => edge.from !== edge.to);
  const elkEdges: ElkExtendedEdge[] = linked.map((edge, index) => ({ id: `e${index}`, sources: [elkOf.get(edge.from)!], targets: [elkOf.get(edge.to)!] }));
  const graph: ElkNode = { id: "root", layoutOptions: ELK_OPTIONS, children: sized.map((node) => ({ id: node.elk, width: node.width, height: node.height })), edges: elkEdges };
  const result = await new ELK().layout(graph);
  const placed = new Map((result.children ?? []).map((node) => [node.id, node]));
  const routes = new Map((result.edges ?? []).map((edge) => [edge.id, edge.sections ?? []]));
  const point = (p: Point) => ({ x: round(p.x), y: round(p.y) });
  return {
    model,
    width: snap(result.width ?? 0),
    height: snap(result.height ?? 0),
    nodes: sized.map(({ elk, ...node }) => ({ ...node, x: round(placed.get(elk)?.x), y: round(placed.get(elk)?.y) })),
    edges: linked.map((edge, index) => ({ ...edge, points: (routes.get(`e${index}`) ?? []).flatMap((section) => [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]).map(point) })),
  };
}
