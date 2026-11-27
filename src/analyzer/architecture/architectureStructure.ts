/**
 * What a diff does to the structure the Architecture view draws (#345): the units and their
 * unit-scoped folder groups of the base and the head of a review, matched by the files they
 * hold (never by name alone: a renamed folder or unit is the same item), then compared.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import type {
  ArchitectureStructureDiff,
  StructureCount,
  StructureCycleDiff,
  StructureEdgeDiff,
  StructureItemDiff,
  StructureLevel,
  StructureLevelDiff,
  StructureMovedFile,
} from "../../shared/architecture-model";
import type { ArchitectureGraph } from "./ArchitectureGraphBuilder";
import type { ArchitectureConfig } from "./architectureRules";
import { viewUnitLevel } from "./architectureView";
import { byCodeUnit } from "./architectureUnits";
import { stronglyConnectedComponents } from "./stronglyConnectedComponents";
import { declaredStructure } from "./workspaceUnits";

/** A base item and a head item are the same one when their Dice overlap (2 * shared files / both sizes) reaches this. */
export const MATCH_MIN_DICE = 0.5;

/** `reason` of a rename read cut short by `diff.renameLimit`. */
export const RENAME_LIMIT_REASON = "diff.renameLimit";

/** Git renames from the base to the head, base path -> head path. */
export interface RenameInfo {
  moves: ReadonlyMap<string, string>;
  complete: boolean;
  /** Why it is incomplete: RENAME_LIMIT_REASON, or the failure. */
  reason?: string;
}

/** Names (of rules or elements) the diff adds, removes or changes. */
export interface NamedChanges {
  added: string[];
  removed: string[];
  changed: string[];
}

export function namedChanges(before: ReadonlyMap<string, unknown>, after: ReadonlyMap<string, unknown>): NamedChanges {
  const names = (map: ReadonlyMap<string, unknown>, keep: (name: string) => boolean) => [...map.keys()].filter(keep).sort(byCodeUnit);
  return {
    added: names(after, (name) => !before.has(name)),
    removed: names(before, (name) => !after.has(name)),
    changed: names(after, (name) => before.has(name) && JSON.stringify(before.get(name)) !== JSON.stringify(after.get(name))),
  };
}

interface LevelItem {
  name: string;
  fileCount: number;
  unit?: string;
  role?: string;
}

interface LevelSnapshot {
  items: Map<string, LevelItem>;
  /** Normalized workspace-relative file -> item key. */
  fileItem: Map<string, string>;
  /** `${from}\0${to}` -> distinct file pairs. */
  edges: Map<string, number>;
  /** Strongly connected sets of 2+ item keys; groups: within a unit. */
  cycles: string[][];
}

/** Both levels of one tree; the graph is not kept. */
export interface StructureSnapshot {
  /** own: the tree's config; head: the head's, the tree having none (base only); none: detected projects. */
  configFrom: "own" | "head" | "none";
  /** Base only: the reason its config is invalid, so the head's was used. */
  configError?: string;
  /** Elements and roles of the config the units were built from. */
  definition?: { elements: Record<string, unknown>; roles: unknown };
  files: number;
  units: LevelSnapshot;
  groups: LevelSnapshot;
}

const edgeKey = (from: string, to: string) => `${from}\0${to}`;

/** The units and folder groups of `graph`, as `viewUnitLevel` draws them with no group cap. */
export function buildStructureSnapshot(
  graph: ArchitectureGraph,
  root: string,
  config: ArchitectureConfig | undefined,
  origin: Pick<StructureSnapshot, "configFrom" | "configError">,
): StructureSnapshot {
  const { units, assignment } = declaredStructure(graph, root, config);
  const view = viewUnitLevel({ graph, units, assignment }, Number.POSITIVE_INFINITY);
  const keyOf = new Map(view.groups.map((group) => [group.id, group.key]));
  const groupUnits = view.units.groupUnits;
  return {
    ...origin,
    ...(config === undefined ? {} : { definition: { elements: config.elements, roles: config.roles } }),
    files: graph.nodes.length,
    units: {
      items: new Map(units.units.map((unit) => [unit.key, { name: unit.name, fileCount: unit.fileCount, role: unit.role }])),
      fileItem: new Map(assignment.unitOf),
      edges: new Map(units.unitEdges.map((edge) => [edgeKey(edge.from, edge.to), edge.fileEdgeCount])),
      cycles: view.units.cycleUnits,
    },
    groups: {
      items: new Map(view.groups.map((group) => [group.key, { name: group.label, fileCount: group.fileCount, unit: groupUnits[group.id] }])),
      fileItem: new Map(view.graph.nodes.filter((node) => node.communityId !== 0).map((node) => [node.relativePath, node.communityKey])),
      edges: new Map(view.groupEdges.map((edge) => [edgeKey(keyOf.get(edge.from)!, keyOf.get(edge.to)!), edge.fileEdgeCount])),
      cycles: groupCycles(view.units.groupEdgeKinds, keyOf),
    },
  };
}

/** Strongly connected sets (2+ keys) of the group edges classified as cycle edges (`from>to` ids). */
function groupCycles(kinds: Readonly<Record<string, string>>, keyOf: ReadonlyMap<number, string>): string[][] {
  const successors = new Map<string, string[]>();
  for (const ids of Object.keys(kinds).filter((edge) => kinds[edge] === "cycle")) {
    const [from, to] = ids.split(">").map((id) => keyOf.get(Number(id))!);
    successors.set(from, [...(successors.get(from) ?? []), to]);
  }
  return stronglyConnectedComponents([...keyOf.values()], successors).filter((members) => members.length > 1);
}

interface Candidate {
  base: string;
  head: string;
  overlap: number;
  dice: number;
}

/** Highest Dice first, then the largest overlap, the same key, then the keys: independent of Map order. */
function byPreference(left: Candidate, right: Candidate): number {
  return right.dice - left.dice
    || right.overlap - left.overlap
    || Number(right.base === right.head) - Number(left.base === left.head)
    || byCodeUnit(left.base, right.base)
    || byCodeUnit(left.head, right.head);
}

/**
 * Pairs each base item with the head item holding most of its files (Dice >= MATCH_MIN_DICE, one to
 * one, greedy by preference): base key -> head key. `rename` maps a base file to its head path.
 */
export function matchLevel(base: LevelSnapshot, head: LevelSnapshot, rename: ReadonlyMap<string, string>): Map<string, string> {
  const overlap = new Map<string, number>();
  for (const [file, baseKey] of base.fileItem) {
    const headKey = head.fileItem.get(rename.get(file) ?? file);
    if (headKey !== undefined) overlap.set(edgeKey(baseKey, headKey), (overlap.get(edgeKey(baseKey, headKey)) ?? 0) + 1);
  }
  const candidates = [...overlap].map(([pair, shared]): Candidate => {
    const [baseKey, headKey] = pair.split("\0");
    return { base: baseKey, head: headKey, overlap: shared, dice: (2 * shared) / (base.items.get(baseKey)!.fileCount + head.items.get(headKey)!.fileCount) };
  }).filter((candidate) => candidate.dice >= MATCH_MIN_DICE).sort(byPreference);
  const pairs = new Map<string, string>();
  const taken = new Set<string>();
  for (const { base: baseKey, head: headKey } of candidates) {
    if (pairs.has(baseKey) || taken.has(headKey)) continue;
    pairs.set(baseKey, headKey);
    taken.add(headKey);
  }
  return pairs;
}

const count = (before?: number, after?: number): StructureCount => ({
  ...(before === undefined ? {} : { before }),
  ...(after === undefined ? {} : { after }),
});

function itemDiff(status: StructureItemDiff["status"], key: string, before: LevelItem | undefined, after: LevelItem | undefined, extra: Partial<StructureItemDiff> = {}): StructureItemDiff {
  const shown = (after ?? before)!;
  const role = { ...(before?.role === undefined ? {} : { before: before.role }), ...(after?.role === undefined ? {} : { after: after.role }) };
  return {
    status, key, name: shown.name, ...(shown.unit === undefined ? {} : { unit: shown.unit }), ...extra,
    fileCount: count(before?.fileCount, after?.fileCount), ...(shown.role === undefined ? {} : { role }),
  };
}

/** Whether a matched group sits in another unit than its base one (`unitPairs`: base unit -> head unit). */
const movedUnit = (before: LevelItem, after: LevelItem, unitPairs?: ReadonlyMap<string, string>) =>
  unitPairs !== undefined && before.unit !== undefined && unitPairs.get(before.unit) !== after.unit;

/** A matched pair's diff: RENAMED, CHANGED, or undefined when the item is unchanged. */
function matchedDiff(key: string, headKey: string, before: LevelItem, after: LevelItem, unitPairs?: ReadonlyMap<string, string>): StructureItemDiff | undefined {
  const moved = movedUnit(before, after, unitPairs);
  const unit: Partial<StructureItemDiff> = moved ? { previousUnit: before.unit } : {};
  if (headKey !== key) return itemDiff("RENAMED", headKey, before, after, { ...unit, previousKey: key });
  if (moved) return itemDiff("CHANGED", key, before, after, { ...unit, previousKey: key });
  return before.fileCount === after.fileCount && before.role === after.role ? undefined : itemDiff("CHANGED", key, before, after);
}

function diffItems(base: LevelSnapshot, head: LevelSnapshot, pairs: ReadonlyMap<string, string>, unitPairs?: ReadonlyMap<string, string>) {
  const items: StructureItemDiff[] = [];
  let unchanged = 0;
  for (const [key, before] of base.items) {
    const headKey = pairs.get(key);
    const diff = headKey === undefined ? itemDiff("REMOVED", key, before, undefined) : matchedDiff(key, headKey, before, head.items.get(headKey)!, unitPairs);
    if (diff) items.push(diff);
    else unchanged += 1;
  }
  const matched = new Set(pairs.values());
  for (const [key, after] of head.items) if (!matched.has(key)) items.push(itemDiff("ADDED", key, undefined, after));
  return { items: items.sort((left, right) => byCodeUnit(left.key, right.key)), unchanged };
}

/** A base item's identity in the head key space: its head match, else a key no head item has. */
const baseId = (pairs: ReadonlyMap<string, string>) => (key: string) => pairs.get(key) ?? `\u0001${key}`;

interface Edge { from: string; to: string; pairs: number }

function translateEdges(edges: ReadonlyMap<string, number>, id: (key: string) => string, shown: (key: string) => string): Map<string, Edge> {
  return new Map([...edges].map(([pair, pairs]) => {
    const [from, to] = pair.split("\0");
    return [edgeKey(id(from), id(to)), { from: shown(from), to: shown(to), pairs }];
  }));
}

function diffEdges(base: LevelSnapshot, head: LevelSnapshot, pairs: ReadonlyMap<string, string>) {
  const before = translateEdges(base.edges, baseId(pairs), (key) => pairs.get(key) ?? key);
  const after = translateEdges(head.edges, (key) => key, (key) => key);
  const edges: StructureEdgeDiff[] = [];
  let unchanged = 0;
  for (const [key, old] of before) {
    const current = after.get(key);
    if (current === undefined) edges.push({ status: "REMOVED", from: old.from, to: old.to, pairs: count(old.pairs) });
    else if (current.pairs === old.pairs) unchanged += 1;
    else edges.push({ status: "CHANGED", from: current.from, to: current.to, pairs: count(old.pairs, current.pairs) });
  }
  for (const [key, current] of after) if (!before.has(key)) edges.push({ status: "ADDED", from: current.from, to: current.to, pairs: count(undefined, current.pairs) });
  return { edges: edges.sort((left, right) => byCodeUnit(left.from, right.from) || byCodeUnit(left.to, right.to)), unchanged };
}

function diffCycles(base: LevelSnapshot, head: LevelSnapshot, pairs: ReadonlyMap<string, string>): StructureCycleDiff[] {
  const cycles = (level: LevelSnapshot, id: (key: string) => string, shown: (key: string) => string) =>
    new Map(level.cycles.map((members) => [members.map(id).sort(byCodeUnit).join("\0"), members.map(shown).sort(byCodeUnit)]));
  const before = cycles(base, baseId(pairs), (key) => pairs.get(key) ?? key);
  const after = cycles(head, (key) => key, (key) => key);
  const status = (kind: StructureCycleDiff["status"], from: Map<string, string[]>, other: Map<string, string[]>) =>
    [...from].filter(([id]) => !other.has(id)).map(([, members]): StructureCycleDiff => ({ status: kind, members }));
  return [...status("ADDED", after, before), ...status("REMOVED", before, after)].sort((left, right) => byCodeUnit(left.members.join("\0"), right.members.join("\0")));
}

/** A base file now in another item than the one its base item became: `from` and `to` are item keys. */
function movedFiles(base: LevelSnapshot, head: LevelSnapshot, pairs: ReadonlyMap<string, string>, rename: ReadonlyMap<string, string>): StructureMovedFile[] {
  const moved: StructureMovedFile[] = [];
  for (const [file, baseKey] of base.fileItem) {
    const target = rename.get(file) ?? file;
    const headKey = head.fileItem.get(target);
    if (headKey !== undefined && headKey !== pairs.get(baseKey)) moved.push({ file: target, from: baseKey, to: headKey });
  }
  return moved.sort((left, right) => byCodeUnit(left.file, right.file));
}

function compareLevel(base: LevelSnapshot, head: LevelSnapshot, rename: ReadonlyMap<string, string>, unitPairs?: ReadonlyMap<string, string>) {
  const pairs = matchLevel(base, head, rename);
  const { items, unchanged: unchangedItems } = diffItems(base, head, pairs, unitPairs);
  const { edges, unchanged: unchangedEdges } = diffEdges(base, head, pairs);
  const diff: StructureLevelDiff = {
    items, edges,
    cycles: diffCycles(base, head, pairs),
    movedFiles: movedFiles(base, head, pairs, rename),
    compared: { items: count(base.items.size, head.items.size), edges: count(base.edges.size, head.edges.size), unchangedItems, unchangedEdges },
  };
  return { diff, pairs };
}

const levelChanged = (level: StructureLevelDiff) => level.items.length + level.edges.length + level.cycles.length + level.movedFiles.length > 0;

/** The elements and roles a config edit changes (both sides own a config). */
function definitionChanges(base: StructureSnapshot, head: StructureSnapshot): string[] {
  const elements = (side: StructureSnapshot) => new Map(Object.entries(side.definition?.elements ?? {}));
  const changes = namedChanges(elements(base), elements(head));
  const details = (["added", "removed", "changed"] as const).filter((kind) => changes[kind].length > 0).map((kind) => `elements ${kind}: ${changes[kind].join(", ")}`);
  const rolesChanged = JSON.stringify(base.definition?.roles ?? {}) !== JSON.stringify(head.definition?.roles ?? {});
  return rolesChanged ? [...details, "roles changed"] : details;
}

/** How the units were defined at each side, when they differ (warning 1); undefined when they do not. */
function definitionDetail(base: StructureSnapshot, head: StructureSnapshot): string | undefined {
  const built = head.configFrom === "none" ? "detected projects" : "built with the head's";
  let details: string[] = [];
  if (base.configError !== undefined) details = [`base graphit.architecture.json is invalid (${base.configError}): ${built}`];
  else if (base.configFrom === "head") details = ["base has no graphit.architecture.json: built with the head's"];
  else if (base.configFrom === "own") details = head.configFrom === "none" ? ["head has no graphit.architecture.json: detected projects"] : definitionChanges(base, head);
  return details.length === 0 ? undefined : details.join("; ");
}

function renameWarning(renames: RenameInfo | undefined): string | undefined {
  if (renames?.complete) return undefined;
  let state = "is unavailable";
  if (renames !== undefined) state = renames.reason === RENAME_LIMIT_REASON ? "stopped at diff.renameLimit" : `failed (${renames.reason ?? "unknown reason"})`;
  return `Git rename detection ${state}: files Git did not pair count as removed + added.`;
}

export interface CompareStructureOptions {
  renames?: RenameInfo;
  refs: { base: string; head: string };
  /** The head is the working tree: its untracked files are not in Git's diff. */
  workingTree?: boolean;
}

/** A level with both a removed and an added item: where a move Git missed would show (warning 3). */
const removedAndAdded = (level: StructureLevelDiff) =>
  level.items.some((item) => item.status === "REMOVED") && level.items.some((item) => item.status === "ADDED");

function missedMovesWarning(workingTree: boolean): string {
  const untracked = workingTree ? "; untracked working-tree files count as added" : "";
  return `Renames and moved files cover only what Git detects (git diff -M, 50 % similarity)${untracked}: a file moved and heavily edited counts as removed + added.`;
}

function emptySideWarning(baseEmpty: boolean, refs: CompareStructureOptions["refs"]): string {
  const [ref, reads] = baseEmpty ? [refs.base, "added"] : [refs.head, "removed"];
  return `No analyzable file at ${ref}: every unit and group reads as ${reads}.`;
}

function verdictOf(empty: boolean, changed: boolean): ArchitectureStructureDiff["verdict"] {
  if (empty) return "empty";
  return changed ? "changed" : "unchanged";
}

/** What changed in the units and folder groups between two trees; see MATCH_MIN_DICE for the matching rule. */
export function compareStructure(base: StructureSnapshot, head: StructureSnapshot, { renames, refs, workingTree }: CompareStructureOptions): ArchitectureStructureDiff {
  const rename = renames?.moves ?? new Map<string, string>();
  const units = compareLevel(base.units, head.units, rename);
  const groups = compareLevel(base.groups, head.groups, rename, units.pairs);
  const empty = base.files === 0 && head.files === 0;
  const changed = [units.diff, groups.diff].some(levelChanged);
  const verdict = verdictOf(empty, changed);
  const detail = definitionDetail(base, head);
  const oneSided = (base.files === 0) !== (head.files === 0);
  const warnings = [
    detail === undefined ? undefined : `Units differ in definition between base and head (${detail}): units are matched by file overlap, not by name.`,
    renameWarning(renames),
    [units.diff, groups.diff].some(removedAndAdded) ? missedMovesWarning(workingTree === true) : undefined,
    oneSided ? emptySideWarning(base.files === 0, refs) : undefined,
  ].filter((warning): warning is string => warning !== undefined);
  return {
    verdict,
    units: units.diff,
    groups: groups.diff,
    files: count(base.files, head.files),
    renames: { mapped: rename.size, complete: renames?.complete ?? false },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const MAX_MARKDOWN_ITEMS = 20;

/** A titled list of at most 20 lines, then `- … N more`; nothing when empty. */
export function capped(title: string, lines: string[]): string[] {
  return lines.length === 0 ? [] : ["", title, ...lines.slice(0, MAX_MARKDOWN_ITEMS),
    ...(lines.length > MAX_MARKDOWN_ITEMS ? [`- … ${lines.length - MAX_MARKDOWN_ITEMS} more`] : [])];
}

const STATUS_WORDS = { ADDED: "added", REMOVED: "removed", RENAMED: "renamed", CHANGED: "changed" } as const;
const range = (value: StructureCount) => (value.before !== undefined && value.after !== undefined && value.before !== value.after ? `${value.before} -> ${value.after}` : String(value.after ?? value.before));

function itemLine(item: StructureItemDiff, safe: (value: string) => string): string {
  const role = item.role?.before !== undefined && item.role.after !== undefined && item.role.before !== item.role.after ? `, role ${safe(item.role.before)} -> ${safe(item.role.after)}` : "";
  const name = item.status === "RENAMED" ? `${safe(item.previousKey!)} -> ${safe(item.key)}` : safe(item.key);
  return `- ${name} (${range(item.fileCount)} files${role})`;
}

function levelLines(level: StructureLevel, diff: StructureLevelDiff, safe: (value: string) => string): string[] {
  const label = level === "units" ? "Units" : "Groups";
  const edge = (item: StructureEdgeDiff) => `- ${safe(item.from)} -> ${safe(item.to)} (${item.pairs.after ?? item.pairs.before} pairs${item.status === "CHANGED" ? `, was ${item.pairs.before}` : ""})`;
  const cycle = (item: StructureCycleDiff) => `- ${item.members.map(safe).join(", ")}`;
  return [
    ...(["ADDED", "REMOVED", "RENAMED", "CHANGED"] as const).flatMap((status) =>
      capped(`#### ${label} ${STATUS_WORDS[status]}`, diff.items.filter((item) => item.status === status).map((item) => itemLine(item, safe)))),
    ...capped(`#### Files moved between ${level}`, diff.movedFiles.map((moved) => `- ${safe(moved.file)}: ${safe(moved.from)} -> ${safe(moved.to)}`)),
    ...(["ADDED", "REMOVED", "CHANGED"] as const).flatMap((status) =>
      capped(`#### ${label.slice(0, -1)} edges ${STATUS_WORDS[status]}`, diff.edges.filter((item) => item.status === status).map(edge))),
    ...capped(`#### Cycles appeared (${level})`, diff.cycles.filter((item) => item.status === "ADDED").map(cycle)),
    ...capped(`#### Cycles resolved (${level})`, diff.cycles.filter((item) => item.status === "REMOVED").map(cycle)),
  ];
}

/** The structure section of the review-pr markdown report; nothing when unchanged and warning-free. `safe` sanitizes every key and path. */
export function renderStructureMarkdown(structure: ArchitectureStructureDiff, safe: (value: string) => string): string[] {
  if (structure.verdict === "unchanged" && structure.warnings.length === 0) return [];
  const sizes = ({ compared: { items } }: StructureLevelDiff) => `${items.before} -> ${items.after}`;
  return [
    "", `### Architecture structure: ${structure.verdict.toUpperCase()}`,
    "",
    `Units: ${sizes(structure.units)}. Groups: ${sizes(structure.groups)}. Files: ${structure.files.before} -> ${structure.files.after}. Rename detection: ${structure.renames.mapped} file(s)${structure.renames.complete ? "" : ", incomplete"}.`,
    ...structure.warnings.map((warning) => `- warning: ${safe(warning)}`),
    ...levelLines("units", structure.units, safe),
    ...levelLines("groups", structure.groups, safe),
  ];
}
