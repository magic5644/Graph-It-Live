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
/** A folder holding at least this many ADDED (or REMOVED) units is drawn as one box (#843). */
export const MIN_FOLD = 4;

/** The head as a reader names it: review-pr without --head (headRef "HEAD") reads the working tree, not the last commit. */
export const headLabel = (headRef: string): string => (headRef === "HEAD" ? "working tree" : headRef);
/** Cells of a ledger or footer line; a longer one is cut by the renderer. */
export const LEDGER_CELLS = 170;
const UNITS_COMMAND = "graph-it architecture --level units --format json";

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
  /** A fold: the member keys, sorted; the node stands for all of them (`key` is `<folder>/*`). */
  fold?: string[];
  /** Edges between members of a fold, not drawn. */
  foldEdges?: number;
  violations: { new: number; resolved: number };
}

export interface DeltaEdge {
  from: string;
  to: string;
  status: "ADDED" | "REMOVED" | "CHANGED" | "UNCHANGED";
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
interface Cycle { status: "ADDED" | "REMOVED"; ids: string[]; keys: string[]; /** The ids before folding: two cycles folded onto the same ids keep distinct ledger rows. */ unfolded?: string[] }

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
  const units = node.fold ? [plural(node.fold.length, "unit")] : [];
  if (node.status === "REWIRED") return [...units, "connections changed"];
  if (node.status === "UNCHANGED") return units;
  const role = roleText(node.role);
  return [...units, `files ${range(node.fileCount)}`, ...(role ? [role] : [])];
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
const contextNode = (id: string, status: DeltaStatus): DeltaNode => ({ id, key: keyOfId(id), label: keyOfId(id), status, fileCount: {}, violations: { new: 0, resolved: 0 } });

/** Units named by an edge or a cycle but absent from the diff's items: REWIRED when an ADDED or REMOVED edge touches them, else context. */
function contextNodes(nodes: Map<string, DeltaNode>, edges: DeltaEdge[], cycles: Cycle[]): void {
  const rewired = new Set(edges.filter((edge) => edge.status !== "CHANGED").flatMap((edge) => [edge.from, edge.to]));
  const add = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, contextNode(id, rewired.has(id) ? "REWIRED" : "UNCHANGED"));
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
    if (!nodes.has(id)) nodes.set(id, contextNode(id, "UNCHANGED"));
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
    // A cycle of n members has at least n edges: fewer drawn ones means the others are not drawn.
    const members = new Set(cycle.ids);
    const live = new Set<DeltaEdge["status"]>(cycle.status === "ADDED" ? ["ADDED", "CHANGED", "UNCHANGED"] : ["REMOVED", "CHANGED", "UNCHANGED"]);
    const drawn = edges.filter((edge) => live.has(edge.status) && members.has(edge.from) && members.has(edge.to)).length;
    for (const id of cycle.ids) {
      const node = nodes.get(id)!;
      node.inCycle = node.inCycle === undefined || node.inCycle === cycle.status ? cycle.status : "BOTH";
      if (drawn < cycle.ids.length && cycle.ids.length > 1) node.cycleEdgesHidden = true;
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

/** The edges drawn among the drawn units: violation edges, then changed, then unchanged, each the heaviest first, at most MAX_DELTA_EDGES, in key order. */
function selectEdges(edges: DeltaEdge[], drawn: ReadonlySet<string>): DeltaEdge[] {
  const weight = (edge: DeltaEdge) => Math.max(edge.pairs.before ?? 0, edge.pairs.after ?? 0);
  const tier = (edge: DeltaEdge) => (edge.violation === undefined ? 1 + Number(edge.status === "UNCHANGED") : 0);
  return edges
    .filter((edge) => drawn.has(edge.from) && drawn.has(edge.to))
    .toSorted((left, right) => tier(left) - tier(right) || weight(right) - weight(left) || byCodeUnit(`${left.from}\0${left.to}`, `${right.from}\0${right.to}`))
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

const sumSide = (counts: StructureCount[], side: keyof StructureCount): StructureCount =>
  counts.some((count) => count[side] !== undefined) ? { [side]: counts.reduce((total, count) => total + (count[side] ?? 0), 0) } : {};
const addCounts = (counts: StructureCount[]): StructureCount => ({ ...sumSide(counts, "before"), ...sumSide(counts, "after") });

/** One box for the members of a group: same status, same folder. */
function foldNode(members: DeltaNode[]): DeltaNode {
  const { status, key } = members[0];
  const label = `${key.slice(0, key.lastIndexOf("/"))}/*`;
  return { id: `${status}:${label}`, key: label, label, status, fileCount: addCounts(members.map((member) => member.fileCount)), fold: members.map((member) => member.key).toSorted(byCodeUnit), violations: { new: 0, resolved: 0 } };
}

/** The edges with each end mapped to its fold, merged per (from, to, status); edges inside one fold are counted per fold, not kept. */
function mergeEdges(edges: DeltaEdge[], foldOf: ReadonlyMap<string, string>): { edges: DeltaEdge[]; inside: Map<string, number> } {
  const inside = new Map<string, number>();
  if (foldOf.size === 0) return { edges, inside };
  const merged = new Map<string, DeltaEdge>();
  for (const edge of edges) {
    const from = foldOf.get(edge.from) ?? edge.from;
    const to = foldOf.get(edge.to) ?? edge.to;
    if (from === to) {
      inside.set(from, (inside.get(from) ?? 0) + 1);
      continue;
    }
    const key = `${from}\0${to}\0${edge.status}`;
    const prior = merged.get(key);
    merged.set(key, prior ? { ...prior, pairs: addCounts([prior.pairs, edge.pairs]) } : { ...edge, from, to });
  }
  return { edges: [...merged.values()], inside };
}

function addFoldEdges(nodes: DeltaNode[], inside: ReadonlyMap<string, number>): void {
  for (const node of nodes) if (inside.has(node.id)) node.foldEdges = (node.foldEdges ?? 0) + inside.get(node.id)!;
}

interface Folded { nodes: DeltaNode[]; edges: DeltaEdge[]; foldOf: Map<string, string> }

/**
 * ADDED (or REMOVED) units of one folder, at least MIN_FOLD of them, become one node. Kept apart: every other status
 * (their identity matters more than their count), a unit in `keep` (a violation end) and a unit with no folder.
 */
function foldUnits(nodes: DeltaNode[], edges: DeltaEdge[], keep: ReadonlySet<string>): Folded {
  const groups = new Map<string, DeltaNode[]>();
  for (const node of nodes) {
    if ((node.status !== "ADDED" && node.status !== "REMOVED") || keep.has(node.id) || !node.key.includes("/")) continue;
    const group = `${node.status}\0${node.key.slice(0, node.key.lastIndexOf("/"))}`;
    const list = groups.get(group);
    if (list) list.push(node);
    else groups.set(group, [node]);
  }
  const foldOf = new Map<string, string>();
  const folds: DeltaNode[] = [];
  for (const members of groups.values()) {
    if (members.length < MIN_FOLD) continue;
    const fold = foldNode(members);
    folds.push(fold);
    for (const member of members) foldOf.set(member.id, fold.id);
  }
  const merged = mergeEdges(edges, foldOf);
  const kept = [...nodes.filter((node) => !foldOf.has(node.id)), ...folds];
  addFoldEdges(kept, merged.inside);
  return { nodes: kept, edges: merged.edges, foldOf };
}

/** Head unit edges the diff does not list as ADDED or CHANGED: the unchanged ones (their ends are head keys, the drawn ids). */
function unchangedEdgeList(head: ReadonlyMap<string, number>, diff: DeltaEdge[]): DeltaEdge[] {
  const listed = new Set(diff.filter((edge) => edge.status !== "REMOVED").map((edge) => `${edge.from}\0${edge.to}`));
  return [...head].filter(([key]) => !listed.has(key)).map(([key, count]): DeltaEdge => {
    const [from, to] = key.split("\0");
    return { from, to, status: "UNCHANGED", pairs: { before: count, after: count }, rules: [] };
  });
}

/** For each head unit that is no node: its unchanged edges to drawn nodes (count, file pairs); `foldOf` maps a fold member to its drawn fold. */
function linkScores(known: ReadonlySet<string>, foldOf: ReadonlyMap<string, string>, drawn: ReadonlySet<string>, unchanged: DeltaEdge[]): { scores: Map<string, { count: number; pairs: number }>; units: Set<string> } {
  const scores = new Map<string, { count: number; pairs: number }>();
  const units = new Set<string>();
  for (const edge of unchanged) {
    for (const [unit, other] of [[edge.from, edge.to], [edge.to, edge.from]]) {
      if (known.has(unit)) continue;
      units.add(unit);
      if (!drawn.has(foldOf.get(other) ?? other)) continue;
      const score = scores.get(unit) ?? { count: 0, pairs: 0 };
      scores.set(unit, { count: score.count + 1, pairs: score.pairs + (edge.pairs.after ?? 0) });
    }
  }
  return { scores, units };
}

/**
 * Fills the unit slots the selected units leave free with the unchanged head units most linked to them (ranked once,
 * after folding, so a filled unit is never folded); `undrawn` counts the head units with unchanged edges left out.
 */
function fillContext(known: ReadonlySet<string>, folded: Folded, drawn: ReadonlySet<string>, unchanged: DeltaEdge[]): { added: DeltaNode[]; undrawn: number } {
  const slots = Math.max(0, MAX_DELTA_UNITS - drawn.size);
  const { scores, units } = linkScores(known, folded.foldOf, drawn, unchanged);
  const ranked = [...scores].toSorted(([leftKey, left], [rightKey, right]) => right.count - left.count || right.pairs - left.pairs || byCodeUnit(leftKey, rightKey));
  const added = ranked.slice(0, slots).map(([key]) => contextNode(key, "UNCHANGED"));
  return { added, undrawn: units.size - added.length };
}

interface UnchangedDrawing { edges: DeltaEdge[]; toUndrawn: number }

/** The unchanged edges between drawn nodes (ends mapped to folds); the rest is counted for the cut line. */
function drawUnchanged(unchanged: DeltaEdge[], folded: Folded, drawn: ReadonlySet<string>): UnchangedDrawing {
  // Only ADDED and REMOVED units fold, and no unchanged edge touches them: nothing merges inside a fold here.
  const merged = mergeEdges(unchanged, folded.foldOf);
  const between = merged.edges.filter((edge) => drawn.has(edge.from) && drawn.has(edge.to));
  return { edges: between, toUndrawn: merged.edges.length - between.length };
}

const LEDGER_RANK = { violation: 0, cycle: 1, unit: 2, edge: 3 } as const;
interface RankedRow extends DeltaLedgerRow { rank: number }

/** A fold: its status, size and what it holds in one row, the member names as long as the row fits LEDGER_CELLS. */
function foldRow(node: DeltaNode, command: string): RankedRow {
  const members = node.fold ?? [];
  const parent = node.key.slice(0, -1);
  const names = members.map((member) => member.slice(parent.length));
  const facts = [...unitFacts(node).slice(1), ...(node.foldEdges ? [`${plural(node.foldEdges, "edge")} inside`] : [])].join("; ");
  const suffix = facts ? " (" + facts + ")" : "";
  const start = `${node.status} ${plural(members.length, "unit")} ${node.key}${suffix}: `;
  const row = (shown: number) => start + names.slice(0, shown).join(", ") + (shown === names.length ? "" : ` … and ${names.length - shown} more: ${command}`);
  // A name and its separator take at least 3 cells: more than LEDGER_CELLS names never fit (bounds the loop on huge folds).
  let shown = Math.min(names.length, LEDGER_CELLS);
  while (shown > 0 && row(shown).length > LEDGER_CELLS) shown -= 1;
  return { rank: LEDGER_RANK.unit, target: node.id, change: node.status, text: row(shown) };
}

function unitRow(node: DeltaNode, command: string): RankedRow {
  if (node.fold) return foldRow(node, command);
  const rename = node.status === "RENAMED" ? node.label.slice(node.key.length + 1) : "";
  const detail = [...(rename ? [rename.slice(1, -1)] : []), ...unitFacts(node)].join(", ");
  const suffix = detail ? " (" + detail + ")" : "";
  return { rank: LEDGER_RANK.unit, target: node.id, change: node.status, text: `${node.status} unit ${node.key}${suffix}` };
}

function edgeRow(edge: DeltaEdge, keys: ReadonlyMap<string, string>): RankedRow {
  const label = (id: string) => keys.get(id) ?? keyOfId(id);
  const pairs = edge.status === "CHANGED" ? `${range(edge.pairs)} file pairs` : plural(edge.pairs.after ?? edge.pairs.before ?? 0, "file pair");
  return { rank: LEDGER_RANK.edge, target: `edge:${edge.from}->${edge.to}`, change: edge.status, text: `${edge.status} edge ${label(edge.from)} -> ${label(edge.to)} (${pairs})` };
}

function cycleRow(cycle: Cycle): RankedRow {
  return { rank: LEDGER_RANK.cycle, target: `cycle:${(cycle.unfolded ?? cycle.ids).join(",")}`, change: cycle.status, text: `${cycle.status} cycle ${cycle.keys.join(", ")}` };
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

/** What the unchanged edges leave out; absent when the review passed no head snapshot. */
interface UnchangedCut { capped: number; toUndrawn: number; units: number }

function unchangedCutLines(model: { head: string }, level: StructureLevelDiff, cut: UnchangedCut | undefined): string[] {
  if (cut === undefined) return [`${plural(level.compared.unchangedEdges, "unchanged unit edge")} not drawn: the review passed no head snapshot`];
  // The command lists the checked-out tree, not the head ref.
  const command = model.head === "HEAD" ? UNITS_COMMAND : `at ${model.head}, ${UNITS_COMMAND}`;
  return [
    ...(cut.capped > 0 ? [`${plural(cut.capped, "unchanged unit edge")} between drawn units not drawn (cap ${MAX_DELTA_EDGES}): ${command}`] : []),
    ...(cut.toUndrawn > 0 ? [`${plural(cut.toUndrawn, "unchanged unit edge")} to units not drawn: ${command}`] : []),
    ...(cut.units > 0 ? [`${plural(cut.units, "unchanged unit")} not drawn: ${command}`] : []),
  ];
}

// No --head for the working tree: --head HEAD would read the same tree, but reads as the last commit.
const reviewCommand = (model: { base: string; head: string }) =>
  ["graph-it review-pr --base", model.base, ...(model.head === "HEAD" ? [] : ["--head", model.head]), "--format json"].join(" ");

function cutLines(model: { base: string; head: string }, dropped: DeltaNode[], hidden: { edges: number; cycles: number; violations: number }, level: StructureLevelDiff, ledgerCut: number, unchanged: UnchangedCut | undefined): string[] {
  const command = reviewCommand(model);
  const changed = dropped.filter((node) => node.status !== "UNCHANGED");
  // A fold stands for its members: a dropped fold of 40 units is 40 units not drawn.
  const units = (nodes: DeltaNode[]) => nodes.reduce((sum, node) => sum + (node.fold?.length ?? 1), 0);
  const byStatus = words(STATUS_ORDER.map((status): [string, number] => [status.toLowerCase(), units(changed.filter((node) => node.status === status))]));
  const rest = words([["edges", hidden.edges], ["cycles", hidden.cycles], ["violations", hidden.violations]]);
  return [
    ...(changed.length > 0 ? [`${plural(units(changed), "changed unit")} not drawn (${byStatus}): ${command}`] : []),
    ...(rest === "none" ? [] : [`${rest} not drawn: ${command}`]),
    ...(ledgerCut > 0 ? [`${plural(ledgerCut, "ledger row")} not drawn: ${command}`] : []),
    ...(level.movedFiles.length > 0 ? [`${plural(level.movedFiles.length, "file")} moved between units: not drawn: ${command}`] : []),
    ...unchangedCutLines(model, level, unchanged),
  ];
}

/** The head map holds the unchanged edges the comparison counted; a gap means some are not drawn, never a silent drop. */
function countWarning(unchanged: DeltaEdge[] | undefined, level: StructureLevelDiff): string[] {
  if (unchanged === undefined || unchanged.length === level.compared.unchangedEdges) return [];
  return [`The head snapshot holds ${plural(unchanged.length, "unchanged unit edge")}, the comparison ${level.compared.unchangedEdges}: the unchanged edges drawn may be incomplete.`];
}

/** The drawn edges among `units`: changed ones and, with a head snapshot, the unchanged ones between them. */
function edgesAmong(folded: Folded, unchanged: DeltaEdge[] | undefined, units: ReadonlySet<string>): { context: UnchangedDrawing; drawnEdges: DeltaEdge[] } {
  const context = unchanged ? drawUnchanged(unchanged, folded, units) : { edges: [], toUndrawn: 0 };
  return { context, drawnEdges: selectEdges([...folded.edges, ...context.edges], units) };
}

/**
 * The selected and filled units and their edges. With a head snapshot, a context unit that keeps no drawn edge and is in
 * no drawn cycle is left out: the edge cap would make it a bare box (cal.com: a row of 21 cycle members).
 */
function drawWithContext(folded: Folded, unchanged: DeltaEdge[] | undefined, selected: ReadonlySet<string>, filled: DeltaNode[], cycles: Cycle[]) {
  const all = new Set([...selected, ...filled.map((node) => node.id)]);
  const first = edgesAmong(folded, unchanged, all);
  if (!unchanged) return { added: filled, drawn: all, bare: 0, ...first };
  const kept = new Set([
    ...first.drawnEdges.flatMap((edge) => [edge.from, edge.to]),
    ...cycles.filter((cycle) => cycle.ids.every((id) => all.has(id))).flatMap((cycle) => cycle.ids),
  ]);
  const bare = new Set([...folded.nodes.filter((node) => selected.has(node.id)), ...filled]
    .filter((node) => node.status === "UNCHANGED" && !kept.has(node.id)).map((node) => node.id));
  const drawn = new Set([...all].filter((id) => !bare.has(id)));
  return { added: filled.filter((node) => !bare.has(node.id)), drawn, bare: bare.size, ...(bare.size === 0 ? first : edgesAmong(folded, unchanged, drawn)) };
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
  const unfolded = [...nodes.values()].toSorted((left, right) => byCodeUnit(left.id, right.id));
  const unchanged = source.headUnitEdges ? unchangedEdgeList(source.headUnitEdges, edges) : undefined;
  // A rules-only change can break an unchanged edge: it is drawn red like a changed one (node counts are already set).
  if (unchanged) applyViolations(rows, new Map(), unchanged);
  // A violation end keeps its own box, so a merged edge never carries a violation.
  const keep = new Set(rows.flatMap((row) => [row.fromId, row.toId]).filter((id) => id !== undefined));
  const folded = foldUnits([...nodes.values()], edges, keep);
  // A cycle that holds every removed unit (cal.com app-store) is drawn on the fold: its ring and members follow the fold ids.
  const foldedCycles = cycles.map((cycle) => ({ ...cycle, ids: [...new Set(cycle.ids.map((id) => folded.foldOf.get(id) ?? id))], unfolded: cycle.ids }));
  const selected = select(folded.nodes.toSorted((left, right) => byCodeUnit(left.id, right.id)), folded.edges, foldedCycles);
  const filler = unchanged ? fillContext(new Set(nodes.keys()), folded, selected.drawn, unchanged) : { added: [], undrawn: 0 };
  const { added, drawn, bare, context, drawnEdges } = drawWithContext(folded, unchanged, selected.drawn, filler.added, foldedCycles);
  const all = [...folded.nodes, ...added].toSorted((left, right) => byCodeUnit(left.id, right.id));
  const { dropped } = selected;
  const drawnChanged = drawnEdges.filter((edge) => edge.status !== "UNCHANGED");
  const drawnCycles = foldedCycles.filter((cycle) => cycle.ids.every((id) => drawn.has(id)));
  const drawnNodes = all.filter((node) => drawn.has(node.id));
  markCycles(new Map(all.map((node) => [node.id, node])), drawnEdges, drawnCycles);
  const refs = { base: source.baseRef, head: source.headRef };
  const keys = new Map(all.map((node) => [node.id, node.key] as const));
  const ledger = [
    ...rows.map(violationRow),
    ...drawnCycles.map(cycleRow),
    ...drawnNodes.filter((node) => node.status !== "UNCHANGED").map((node) => unitRow(node, reviewCommand(refs))),
    ...drawnChanged.map((edge) => edgeRow(edge, keys)),
  ].toSorted((left, right) => left.rank - right.rank || byCodeUnit(`${left.target}\0${left.change}`, `${right.target}\0${right.change}`));
  const unique = [...new Map(ledger.map((row) => [`${row.target}\0${row.change}`, row])).values()];
  const hidden = {
    edges: folded.edges.length - drawnChanged.length,
    cycles: foldedCycles.length - drawnCycles.length,
    violations: rows.filter((row) => (row.fromId !== undefined && !drawn.has(row.fromId)) || (row.toId !== undefined && !drawn.has(row.toId))).length,
  };
  const unchangedCut = unchanged && { capped: context.edges.length - (drawnEdges.length - drawnChanged.length), toUndrawn: context.toUndrawn, units: filler.undrawn + bare };
  return {
    refs,
    nodes: drawnNodes,
    edges: drawnEdges,
    ledger: unique.slice(0, MAX_DELTA_LEDGER).map(({ target, change, text }) => ({ target, change, text })),
    cut: cutLines(refs, dropped, hidden, level, Math.max(0, unique.length - MAX_DELTA_LEDGER), unchangedCut),
    counts: countsLine(level, unfolded, cycles, rows),
    warnings: [...(source.structure?.warnings ?? []), ...countWarning(unchanged, level)],
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
