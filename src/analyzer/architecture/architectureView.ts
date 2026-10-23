/**
 * The levels the extension's Architecture view draws, with every count it shows: the groups
 * each level keeps under the display cap and what the cap hides, the matrix and the rule
 * violations of a level, the hidden groups a find matches, and the dependents of a selection.
 * The extension only validates requests and posts these results; the webview only renders them.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { aggregateCommunityGroups } from "../community/groupAggregation";
import { overviewArchitecture, type ArchitectureOverview } from "./ArchitectureExplorer";
import type { ArchitectureGraph } from "./ArchitectureGraphBuilder";
import { groupMatrix, unitMatrix, type ArchitectureMatrix } from "./architectureMatrix";
import { rulesByEdge, type ArchitectureViolation } from "./architectureRules";
import {
  assignUnits,
  buildArchitectureUnits,
  groupByUnit,
  layerGroupsWithinUnits,
  type ArchitectureUnits,
  type UnitAssignment,
} from "./architectureUnits";
import { computeGroupDependents } from "./groupDependents";
import { stronglyConnectedComponents } from "./stronglyConnectedComponents";
import type { DeclaredRoles } from "./unitRoles";

/** What a path-mode build keeps to answer a folder level later. */
export interface UnitSource {
  graph: ArchitectureGraph;
  units: ArchitectureUnits;
  assignment: UnitAssignment;
}

/** A group the cap leaves out: named for the find only. */
export interface HiddenGroup {
  key: string;
  label: string;
  /** Unit key in path mode, else "". */
  unit: string;
}

/** Groups left out by the cap, per unit key ("" without units). */
export interface UnitGroupCounts {
  totalGroups: number;
  hiddenGroups: number;
  hiddenGroupEdges: number;
}

type OverviewGroup = ArchitectureOverview["groups"][number];
type OverviewEdge = ArchitectureOverview["groupEdges"][number];

/** Inside a unit or folder, a group is named by its sub-folder; the parent's own files by the parent. */
export function groupLabel(group: { key: string }, parent: string, parentName: string): string {
  return group.key === parent ? parentName : group.key.slice(parent.length + 1);
}

/**
 * Keeps the `maxGroups` largest groups of each unit ("" for every group without units) and the
 * edges between kept groups, the unassigned files (id 0) always kept. A kept group with no kept
 * edge to a group of its unit is isolated (drawn apart); the others are hidden. Counts per unit.
 */
export function capGroups<G extends OverviewGroup>(
  groups: readonly G[],
  edges: readonly OverviewEdge[],
  maxGroups: number,
  unitOf: (id: number) => string,
  unassigned: boolean,
) {
  // Groups come largest first.
  const perUnit = new Map<string, number>();
  const kept = groups.filter((group) => {
    const count = (perUnit.get(unitOf(group.id)) ?? 0) + 1;
    perUnit.set(unitOf(group.id), count);
    return count <= maxGroups;
  });
  const keptIds = new Set([0, ...kept.map((group) => group.id)]);
  const isKept = (edge: OverviewEdge) => keptIds.has(edge.from) && keptIds.has(edge.to);
  const groupEdges = edges.filter(isKept);
  const linked = new Set(groupEdges.filter((edge) => unitOf(edge.from) === unitOf(edge.to)).flatMap((edge) => [edge.from, edge.to]));
  const drawn = unassigned ? [...kept.map((group) => group.id), 0] : kept.map((group) => group.id);
  const hidden: HiddenGroup[] = groups.filter((group) => !keptIds.has(group.id)).map(({ id, key, label }) => ({ key, label, unit: unitOf(id) }));
  const groupsByUnit: Record<string, UnitGroupCounts> = {};
  const unitEntry = (unit: string) => (groupsByUnit[unit] ??= { totalGroups: 0, hiddenGroups: 0, hiddenGroupEdges: 0 });
  for (const group of groups) unitEntry(unitOf(group.id)).totalGroups += 1;
  for (const { unit } of hidden) unitEntry(unit).hiddenGroups += 1;
  for (const edge of edges) if (!isKept(edge) && unitOf(edge.from) === unitOf(edge.to)) unitEntry(unitOf(edge.from)).hiddenGroupEdges += 1;
  return { groups: kept, groupEdges, isolatedGroups: drawn.filter((id) => !linked.has(id)), hidden, groupsByUnit };
}

/** Unit keys of each cycle: the strongly connected components, of two units or more, that the cycle edges form. */
function cycleUnits({ units, unitEdges }: ArchitectureUnits): string[][] {
  const successors = new Map<string, string[]>();
  for (const { from, to } of unitEdges.filter((edge) => edge.kind === "cycle")) successors.set(from, [...(successors.get(from) ?? []), to]);
  return stronglyConnectedComponents(units.map((unit) => unit.key), successors).filter((members) => members.length > 1);
}

/**
 * In path mode, the units on top and their unit-scoped folder groups below: the groups (and
 * the graph group detail and evidence read) never mix files of two units. Each unit keeps its
 * `maxGroups` largest groups (hiddenGroups counts the others), with their layers.
 * With a folder: that folder's sub-folders and own files, the level below.
 */
export function viewUnitLevel({ graph, units, assignment }: UnitSource, maxGroups: number, folder?: string) {
  const { graph: grouped, groupUnits, nestedGroups } = groupByUnit(graph, units, assignment, folder);
  const { context: _context, ...unitLevel } = units;
  const overview = overviewArchitecture(grouped, Number.POSITIVE_INFINITY);
  const names = new Map(units.units.map((unit) => [unit.key, unit.name]));
  const labelled = overview.groups.map((group) => {
    const unit = groupUnits[group.id];
    const parent = folder ?? unit;
    return { ...group, label: groupLabel(group, parent, folder === undefined ? names.get(unit) ?? unit : parent.slice(parent.lastIndexOf("/") + 1)) };
  });
  const capped = capGroups(labelled, overview.groupEdges, maxGroups, (id) => groupUnits[id] ?? "", false);
  const labels = new Map(capped.groups.map((group) => [group.id, group.label]));
  const groupEdges = capped.groupEdges.map((edge) => ({ ...edge, fromLabel: labels.get(edge.from) ?? "", toLabel: labels.get(edge.to) ?? "" }));
  const shownUnits = Object.fromEntries(capped.groups.map((group) => [group.id, groupUnits[group.id]]));
  return {
    graph: grouped,
    revision: grouped.context.revision,
    ...overview,
    groups: capped.groups,
    groupEdges,
    hiddenGroups: capped.hidden.length,
    hiddenGroupEdges: overview.groupEdges.length - groupEdges.length,
    maxGroups,
    isolatedGroups: capped.isolatedGroups,
    hidden: capped.hidden,
    units: {
      ...unitLevel,
      groupUnits: shownUnits,
      ...layerGroupsWithinUnits(groupEdges, shownUnits),
      nestedGroups: nestedGroups.filter((id) => labels.has(id)),
      groupsByUnit: capped.groupsByUnit,
      cycleUnits: cycleUnits(units),
    },
  };
}

/** Louvain groups: the `maxGroups` largest are drawn. */
export function viewGroups(graph: ArchitectureGraph, maxGroups: number) {
  const overview = overviewArchitecture(graph, Number.POSITIVE_INFINITY);
  const capped = capGroups(overview.groups, overview.groupEdges, maxGroups, () => "", overview.unassigned.fileCount > 0);
  return {
    graph,
    revision: graph.context.revision,
    ...overview,
    groups: capped.groups,
    groupEdges: capped.groupEdges,
    hiddenGroups: capped.hidden.length,
    hiddenGroupEdges: overview.groupEdges.length - capped.groupEdges.length,
    maxGroups,
    isolatedGroups: capped.isolatedGroups,
    hidden: capped.hidden,
  };
}

/** The summary level of a build: the units and their groups in path mode (with what a folder level needs later), else the Louvain groups. */
export function viewArchitecture(graph: ArchitectureGraph, workspaceRoot: string, maxGroups: number, declaredRoles?: DeclaredRoles):
  ReturnType<typeof viewGroups> & Partial<Pick<ReturnType<typeof viewUnitLevel>, "units">> & { source?: UnitSource } {
  if (graph.context.communityMode !== "path") return viewGroups(graph, maxGroups);
  const assignment = assignUnits(workspaceRoot, graph.nodes.map((node) => node.relativePath));
  const source = { graph, units: buildArchitectureUnits(graph, workspaceRoot, assignment, declaredRoles), assignment };
  return { ...viewUnitLevel(source, maxGroups), source };
}

/** The level again with a new cap, as the summary was built (Show more groups). */
export function viewLevel(graph: ArchitectureGraph, source: UnitSource | undefined, maxGroups: number) {
  return source ? viewUnitLevel(source, maxGroups) : viewGroups(graph, maxGroups);
}

/** Rule names of the violating edges of a level: unit edges by unit key (path mode), group edges by the level's group ids. */
export function levelViolations(
  violations: readonly Pick<ArchitectureViolation, "rule" | "source" | "target">[],
  graph: ArchitectureGraph,
  unitOf?: ReadonlyMap<string, string>,
) {
  const groupOf = new Map(graph.nodes.map((node) => [node.relativePath, node.communityId]));
  return {
    unitEdges: unitOf ? rulesByEdge(violations, (file) => unitOf.get(file)) : {},
    groupEdges: rulesByEdge(violations, (file) => groupOf.get(file)),
  };
}

/**
 * The matrix of a level, read from that level's graph: the units (path mode, nothing entered),
 * an entered unit's groups (group ids of the summary), else every group of the graph (an entered
 * folder, or Louvain). Unit groups are regrouped as the summary was, so their ids match it.
 */
export function levelMatrix(graph: ArchitectureGraph, source: UnitSource | undefined, folder?: string, unit?: string):
  { matrix: ArchitectureMatrix<string> | ArchitectureMatrix<number>; nestedGroups: number[]; unitsLevel: boolean } {
  const unitsLevel = source !== undefined && folder === undefined && unit === undefined;
  if (source && unitsLevel) return { matrix: unitMatrix(source.units), nestedGroups: [], unitsLevel };
  const aggregation = aggregateCommunityGroups(graph.graphData);
  if (!source) return { matrix: groupMatrix(aggregation), nestedGroups: [], unitsLevel };
  const { groupUnits, nestedGroups } = groupByUnit(source.graph, source.units, source.assignment, folder);
  const inLevel = folder === undefined ? (id: number) => groupUnits[id] === unit : () => true;
  const matrix = groupMatrix(aggregation, inLevel);
  // Named as the graph names them, once ordered: the order stays the CLI's.
  const parent = folder ?? unit ?? "";
  const parentName = folder === undefined ? source.units.units.find((entry) => entry.key === unit)?.name ?? parent : parent.slice(parent.lastIndexOf("/") + 1);
  const rows = matrix.rows.map((row) => ({ ...row, label: groupLabel(row, parent, parentName) }));
  return { matrix: { ...matrix, rows }, nestedGroups: nestedGroups.filter(inLevel), unitsLevel };
}

/** The hidden groups (of `unit`, if set) whose label or key holds the query (its first 256 characters once trimmed), case-insensitive: the first labels and how many match. */
export function findHiddenGroups(hidden: readonly HiddenGroup[], query: string, unit?: string, limit = 10) {
  const needle = query.trim().toLowerCase().slice(0, 256);
  const matches = needle === "" ? [] : hidden.filter((group) =>
    (unit === undefined || group.unit === unit) && `${group.label}\n${group.key}`.toLowerCase().includes(needle));
  return { matches: matches.slice(0, limit).map((group) => group.label), total: matches.length };
}

/** A dependents seed; a file's path must already be checked to be a file of the summary's graph. */
export type DependentsSeed = { kind: "file"; relativePath: string } | { kind: "group"; groupId: number } | { kind: "unit"; key: string };

/** Group key of every file of a graph, "" for the unassigned files (id 0). */
const groupKeys = (graph: ArchitectureGraph) =>
  new Map(graph.nodes.map((node) => [node.relativePath, node.communityId === 0 ? "" : node.communityKey]));

/** The files of a dependents seed and its name: a file, a group of the level, or a unit (path mode); anything else is refused. */
function seedFilesOf(summary: ArchitectureGraph, level: ArchitectureGraph, source: UnitSource | undefined, seed: DependentsSeed | undefined) {
  if (seed?.kind === "file") return { files: [seed.relativePath], label: seed.relativePath };
  if (seed?.kind === "group") {
    const nodes = level.nodes.filter((node) => node.communityId === seed.groupId);
    const label = nodes[0]?.communityId === 0 ? "unassigned" : nodes[0]?.communityKey ?? `group ${String(seed.groupId)}`;
    return { files: nodes.map((node) => node.relativePath), label };
  }
  if (seed?.kind === "unit" && source) {
    const key = String(seed.key);
    const files = summary.nodes.map((node) => node.relativePath).filter((file) => source.assignment.unitOf.get(file) === key);
    return { files, label: source.assignment.names.get(key) ?? key };
  }
  throw new Error("unknown dependents seed");
}

/**
 * The dependents of a seed, walked over every file pair of the summary's graph and grouped as
 * the level draws them: by unit at the units level (`unitsLevel`, path mode), else by the
 * level's groups, the files outside an entered folder by the summary's groups. Units are named
 * as the view names them; groups by their key.
 */
export function viewDependents(
  summary: ArchitectureGraph,
  level: ArchitectureGraph,
  source: UnitSource | undefined,
  seed: DependentsSeed | undefined,
  unitsLevel: boolean,
) {
  // A seed without files (an unknown group or unit) has no dependents: the panel says so instead of waiting.
  const seedFiles = seedFilesOf(summary, level, source, seed);
  const unitOf = unitsLevel && source !== undefined ? source.assignment : undefined;
  const summaryKeys = groupKeys(summary);
  const levelKeys = groupKeys(level);
  // Keys are folder paths: a file whose summary key is the entered folder (or below) lies in the level, so both key sets never clash.
  const groupOf = unitOf
    ? (file: string) => unitOf.unitOf.get(file) ?? ""
    : (file: string) => levelKeys.get(file) ?? summaryKeys.get(file) ?? "";
  const dependents = computeGroupDependents(summary, seedFiles.files, { groupOf });
  return {
    ...dependents,
    seedLabel: seedFiles.label,
    groups: dependents.groups.map((group) => ({ ...group, label: unitOf?.names.get(group.key) ?? group.label })),
  };
}
