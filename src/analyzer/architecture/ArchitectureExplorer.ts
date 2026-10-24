/**
 * Progressive views over an architecture graph, shared by explore_architecture and the extension.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { aggregateCommunityGroups } from "../community/groupAggregation";
import type {
  ArchitectureGroupDetail,
  ArchitectureMatrix,
  ArchitectureOverview,
  ArchitectureUnit,
  ArchitectureUnits,
  CommunityGroup,
  CommunityGroupAggregation,
} from "../../shared/architecture-model";
import { normalizePath } from "../../shared/path";
import type { ArchitectureGraph } from "./ArchitectureGraphBuilder";
import type { WorkspaceArchitectureCheck } from "./architectureRules";
import { byCodeUnit } from "./architectureUnits";

const DEFAULT_EXPLORE_LIMIT = 50;

/** Keeps code facts, computed groupings and interpretation apart, as #300 requires. */
const PROVENANCE = {
  facts: "File pairs are static import relations extracted from source code, not observed execution.",
  grouping: "Groups are computed by the communityMode detector; group ids are only valid for the same context.revision.",
  interpretation: "None: labels are folder keys or detector output, not business names or responsibilities.",
};

const NEXT_STEPS =
  "For the symbols and lines behind a file pair, call graphitlive_find_referencing_files on the target, " +
  "then graphitlive_query_call_graph or graphitlive_get_impact_analysis on the symbols involved.";

/** Group id, folder key or label; `0` and `"unassigned"` name the unassigned files. */
export type GroupRef = number | string;

export interface ArchitectureExploreOptions {
  group?: GroupRef;
  from?: GroupRef;
  to?: GroupRef;
  offset?: number;
  limit?: number;
  /** context.revision of the response the group ids or offset come from. */
  revision?: string;
  /** Evidence only: keeps the pairs whose source (or target) is this workspace-relative file. */
  sourceFile?: string;
  targetFile?: string;
}

export interface GroupDetailOptions {
  offset?: number;
  limit?: number;
  revision?: string;
}

const DEFAULT_GROUP_DETAIL_LIMIT = 200;

const byFileCount = (left: CommunityGroup, right: CommunityGroup) => right.fileCount - left.fileCount || left.id - right.id;

/** Adds both group labels to a group edge, so renderers never look groups up. */
function edgeLabeler(aggregation: CommunityGroupAggregation) {
  const labels = new Map<number, string>(aggregation.groups.map(group => [group.id, group.label]));
  const labelOf = (id: number) => (id === 0 ? "unassigned" : labels.get(id) ?? "");
  return (edge: CommunityGroupAggregation["groupEdges"][number]) =>
    ({ ...edge, fromLabel: labelOf(edge.from), toLabel: labelOf(edge.to) });
}

function page<T>(items: T[], offset: number, limit: number) {
  const slice = items.slice(offset, offset + limit);
  const nextOffset = offset + slice.length < items.length ? offset + slice.length : undefined;
  return { items: slice, total: items.length, offset, returned: slice.length, truncated: nextOffset !== undefined, nextOffset };
}

/** Pages a group's files and both sides of its boundary together, heaviest edges first. */
function pageGroup(
  files: string[],
  groupEdges: CommunityGroupAggregation["groupEdges"],
  groupId: number,
  offset: number,
  limit: number,
) {
  const filePage = page(files, offset, limit);
  const incoming = page(groupEdges.filter(edge => edge.to === groupId)
    .toSorted((left, right) => right.fileEdgeCount - left.fileEdgeCount || left.from - right.from), offset, limit);
  const outgoing = page(groupEdges.filter(edge => edge.from === groupId)
    .toSorted((left, right) => right.fileEdgeCount - left.fileEdgeCount || left.to - right.to), offset, limit);
  const truncated = filePage.truncated || incoming.truncated || outgoing.truncated;
  return {
    files: filePage.items,
    incoming: incoming.items,
    outgoing: outgoing.items,
    page: {
      offset,
      limit,
      totalFiles: filePage.total,
      totalIncoming: incoming.total,
      totalOutgoing: outgoing.total,
      truncated,
      nextOffset: truncated ? offset + limit : undefined,
    },
  };
}

function resolveGroup(aggregation: CommunityGroupAggregation, ref: GroupRef): CommunityGroup {
  const groups = aggregation.unassigned.fileCount > 0
    ? [...aggregation.groups, { id: 0, key: "", label: "unassigned", ...aggregation.unassigned }]
    : aggregation.groups;
  // A number is an id from a previous response: a folder key "2" must not shadow group 2.
  const group = typeof ref === "number"
    ? groups.find(candidate => candidate.id === ref)
    : groups.find(candidate => candidate.key !== "" && candidate.key === ref)
      ?? groups.find(candidate => String(candidate.id) === ref || candidate.label === ref);
  if (!group) {
    throw new Error(`Unknown group "${ref}". Call explore_architecture without group, from or to to list the groups.`);
  }
  return group;
}

/** Group ids and offsets from a response built on another graph would silently point elsewhere. */
function assertRevision(current: string, requested: string | undefined): void {
  if (requested !== undefined && requested !== current) {
    throw new Error(
      `Architecture changed (revision ${requested} -> ${current}): group ids and pages from earlier responses no longer apply. ` +
      "Restart from the summary: call explore_architecture without group, from, to, offset or revision.",
    );
  }
}

/**
 * A bounded summary, one group with its boundary, or the file pairs behind one group edge.
 * Counts come from aggregateCommunityGroups on the full graph, before any paging.
 */
export function exploreArchitecture(
  { context, graphData, nodes, edges }: ArchitectureGraph,
  options: ArchitectureExploreOptions = {},
) {
  assertRevision(context.revision, options.revision);
  const aggregation = aggregateCommunityGroups(graphData);
  const offset = options.offset ?? 0;
  const limit = options.limit ?? DEFAULT_EXPLORE_LIMIT;
  const withLabels = edgeLabeler(aggregation);
  const communityOf = (filePath: string) => graphData.nodeMetadata?.[filePath]?.communityId ?? 0;
  const base = { context, provenance: PROVENANCE, totals: aggregation.totals };

  if (options.from !== undefined && options.to !== undefined) {
    const from = resolveGroup(aggregation, options.from);
    const to = resolveGroup(aggregation, options.to);
    const sourceFile = options.sourceFile === undefined ? undefined : normalizePath(options.sourceFile);
    const targetFile = options.targetFile === undefined ? undefined : normalizePath(options.targetFile);
    const pairs = edges
      .filter(edge => communityOf(edge.source) === from.id && communityOf(edge.target) === to.id)
      .filter(edge => (sourceFile === undefined || edge.sourceRelative === sourceFile)
        && (targetFile === undefined || edge.targetRelative === targetFile))
      .map(edge => ({ source: edge.sourceRelative, target: edge.targetRelative }))
      .sort((left, right) => left.source.localeCompare(right.source) || left.target.localeCompare(right.target));
    const { items, ...pageInfo } = page(pairs, offset, limit);
    return { view: "evidence" as const, ...base, from, to, pairs: items, page: pageInfo, nextSteps: NEXT_STEPS };
  }

  if (options.group !== undefined) {
    const group = resolveGroup(aggregation, options.group);
    const files = nodes
      .filter(node => node.communityId === group.id)
      .map(node => node.relativePath)
      .sort((left, right) => left.localeCompare(right));
    const { incoming, outgoing, files: filePage, page: pageInfo } =
      pageGroup(files, aggregation.groupEdges, group.id, offset, limit);
    return {
      view: "group" as const,
      ...base,
      group,
      incoming: incoming.map(withLabels),
      outgoing: outgoing.map(withLabels),
      files: filePage,
      page: pageInfo,
      nextSteps: "Pass from and to to list the file pairs behind an incoming or outgoing edge.",
    };
  }

  const groups = page(aggregation.groups.toSorted(byFileCount), offset, limit);
  const groupEdges = page(aggregation.groupEdges.toSorted((left, right) => right.fileEdgeCount - left.fileEdgeCount), offset, limit);
  const truncated = groups.truncated || groupEdges.truncated;
  return {
    view: "summary" as const,
    ...base,
    unassigned: aggregation.unassigned,
    groups: groups.items,
    groupEdges: groupEdges.items.map(withLabels),
    page: {
      offset,
      limit,
      totalGroups: groups.total,
      totalGroupEdges: groupEdges.total,
      truncated,
      nextOffset: truncated ? offset + limit : undefined,
    },
    nextSteps: "Pass group for one group's files and boundary, or from and to for the file pairs behind a group edge.",
  };
}

/** Units provenance: what a unit and a layer are, so a reader never takes them for responsibilities. */
const UNIT_PROVENANCE = {
  ...PROVENANCE,
  grouping: "Units are package folders (package.json), else top-level folders; layer = rank in the unit graph after collapsing cycles, 0 = depends on no other unit.",
  interpretation: "Roles only: each is inferred from the unit's manifest and files (confidence inferred, with its evidence) unless graphit.architecture.json declares it (confidence declared). Names are package names or folders.",
};

/** The units, heaviest unit edges first, paged like the summary; counts come from every file pair. */
export function exploreUnits(units: ArchitectureUnits, options: Pick<ArchitectureExploreOptions, "offset" | "limit" | "revision"> = {}) {
  assertRevision(units.context.revision, options.revision);
  const offset = options.offset ?? 0;
  const limit = options.limit ?? DEFAULT_EXPLORE_LIMIT;
  const unitPage = page(units.units, offset, limit);
  const edgePage = page(units.unitEdges, offset, limit);
  const truncated = unitPage.truncated || edgePage.truncated;
  return {
    view: "units" as const,
    context: units.context,
    provenance: UNIT_PROVENANCE,
    totals: units.totals,
    upwardEdges: units.upwardEdges,
    cycles: units.cycles,
    layerCount: units.layerCount,
    roleCounts: units.roleCounts,
    units: unitPage.items,
    unitEdges: edgePage.items,
    page: {
      offset,
      limit,
      totalUnits: unitPage.total,
      totalUnitEdges: edgePage.total,
      truncated,
      nextOffset: truncated ? offset + limit : undefined,
    },
    nextSteps: "Call without level for the folder groups, then group, or from and to, for files and file pairs.",
  };
}

export interface UnitEvidenceOptions {
  /** Unit key (e.g. "packages/core", "(root)"), else unit name. */
  from: string;
  to: string;
  offset?: number;
  limit?: number;
  /** context.revision of the units response the offset comes from. */
  revision?: string;
}

function resolveUnit(units: ArchitectureUnits, ref: string): ArchitectureUnit {
  // Keys use "/" on every OS: a Windows user may type packages\core.
  const key = ref.replaceAll("\\", "/");
  const unit = units.units.find(candidate => candidate.key === key) ?? units.units.find(candidate => candidate.name === ref);
  if (!unit) throw new Error(`Unknown unit "${ref}". Call explore_architecture with level units to list the units.`);
  return unit;
}

/**
 * The file pairs behind one unit edge, sorted by target then source so a target's importers sit
 * together. Every graph edge between the two units is listed: the total is the edge's fileEdgeCount.
 */
export function exploreUnitEvidence(
  graph: ArchitectureGraph,
  units: ArchitectureUnits,
  unitOf: ReadonlyMap<string, string>,
  options: UnitEvidenceOptions,
) {
  assertRevision(units.context.revision, options.revision);
  const from = resolveUnit(units, options.from);
  const to = resolveUnit(units, options.to);
  if (from.key === to.key) throw new Error(`"${from.key}" names both ends: a unit edge joins two units.`);
  const pairs = graph.edges
    .filter(edge => unitOf.get(edge.sourceRelative) === from.key && unitOf.get(edge.targetRelative) === to.key)
    .map(edge => ({ source: edge.sourceRelative, target: edge.targetRelative }))
    .sort((left, right) => byCodeUnit(left.target, right.target) || byCodeUnit(left.source, right.source));
  const { items, ...pageInfo } = page(pairs, options.offset ?? 0, options.limit ?? DEFAULT_EXPLORE_LIMIT);
  const kind = units.unitEdges.find(edge => edge.from === from.key && edge.to === to.key)?.kind;
  return {
    view: "evidence" as const,
    context: units.context,
    provenance: UNIT_PROVENANCE,
    from,
    to,
    kind,
    pairs: items,
    page: pageInfo,
    nextSteps: NEXT_STEPS,
  };
}

/**
 * A dependency structure matrix with its cells paged, rows, cycles and totals whole: totals count
 * every cell before the page. `units` names the provenance of unit rows.
 */
export function exploreMatrix(
  matrix: ArchitectureMatrix,
  context: ArchitectureGraph["context"],
  options: Pick<ArchitectureExploreOptions, "offset" | "limit" | "revision"> & { units?: boolean } = {},
) {
  assertRevision(context.revision, options.revision);
  const { items, ...pageInfo } = page(matrix.cells, options.offset ?? 0, options.limit ?? DEFAULT_EXPLORE_LIMIT);
  return {
    view: "matrix" as const,
    context,
    provenance: options.units ? UNIT_PROVENANCE : PROVENANCE,
    ...matrix,
    cells: items,
    page: pageInfo,
    nextSteps: "Pass from and to (two rows' ids, or unit keys with level units) for the file pairs behind a cell.",
  };
}

interface FileGroupCount {
  relativePath: string;
  group: number;
  fileEdgeCount: number;
}

/** Counts one more file pair between `relativePath` and `group`. */
function bump(counts: Map<string, FileGroupCount>, relativePath: string, group: number) {
  const key = `${relativePath}\0${group}`;
  const entry = counts.get(key);
  if (entry) entry.fileEdgeCount += 1;
  else counts.set(key, { relativePath, group, fileEdgeCount: 1 });
}

/**
 * One page of a group's files (most depended-on first), with every file pair whose source is
 * on the page and the per-file counts across the group's boundary. A pair is returned on its
 * source's page only, so the union of all pages holds each pair exactly once, and the counts
 * come from the full graph whatever the page.
 */
export function groupDetail(
  { context, graphData, nodes, edges }: ArchitectureGraph,
  groupRef: GroupRef,
  options: GroupDetailOptions = {},
): ArchitectureGroupDetail {
  assertRevision(context.revision, options.revision);
  const group = resolveGroup(aggregateCommunityGroups(graphData), groupRef);
  const offset = options.offset ?? 0;
  const limit = options.limit ?? DEFAULT_GROUP_DETAIL_LIMIT;
  const groupOf = new Map(nodes.map(node => [node.relativePath, node.communityId]));
  const files = nodes
    .filter(node => node.communityId === group.id)
    .map(({ relativePath, dependencyCount, dependentCount }) => ({ relativePath, dependencyCount, dependentCount }))
    .sort((left, right) => right.dependentCount - left.dependentCount || left.relativePath.localeCompare(right.relativePath));
  const { items, ...pageInfo } = page(files, offset, limit);
  const shown = new Set(items.map(file => file.relativePath));

  const internalPairs: { source: string; target: string }[] = [];
  const outgoingPairs: { source: string; target: string; toGroup: number }[] = [];
  const outgoing = new Map<string, FileGroupCount>();
  const incoming = new Map<string, FileGroupCount>();
  for (const { sourceRelative: source, targetRelative: target } of edges) {
    const toGroup = groupOf.get(target) ?? 0;
    if (shown.has(source) && toGroup === group.id) internalPairs.push({ source, target });
    else if (shown.has(source)) {
      outgoingPairs.push({ source, target, toGroup });
      bump(outgoing, source, toGroup);
    }
    const fromGroup = groupOf.get(source) ?? 0;
    if (shown.has(target) && fromGroup !== group.id) bump(incoming, target, fromGroup);
  }
  const byPair = (left: { source: string; target: string }, right: { source: string; target: string }) =>
    left.source.localeCompare(right.source) || left.target.localeCompare(right.target);
  const byFileAndGroup = (left: FileGroupCount, right: FileGroupCount) =>
    left.relativePath.localeCompare(right.relativePath) || left.group - right.group;

  return {
    context,
    group,
    files: items,
    internalPairs: internalPairs.toSorted(byPair),
    outgoingPairs: outgoingPairs.toSorted(byPair),
    outgoing: [...outgoing.values()].sort(byFileAndGroup)
      .map(({ relativePath, group: toGroup, fileEdgeCount }) => ({ relativePath, toGroup, fileEdgeCount })),
    incoming: [...incoming.values()].sort(byFileAndGroup)
      .map(({ relativePath, group: fromGroup, fileEdgeCount }) => ({ relativePath, fromGroup, fileEdgeCount })),
    page: { ...pageInfo, limit },
  };
}

/**
 * Every group edge between the `maxGroups` largest groups, for a renderer that shows them all.
 * The unassigned files are always kept; counts and hidden totals come from the full aggregation.
 */
export function overviewArchitecture(
  { context, graphData, scannedFiles, analyzedFiles }: ArchitectureGraph,
  maxGroups: number,
): ArchitectureOverview {
  const aggregation = aggregateCommunityGroups(graphData);
  const groups = aggregation.groups.toSorted(byFileCount).slice(0, maxGroups);
  const shown = new Set([0, ...groups.map(group => group.id)]);
  const groupEdges = aggregation.groupEdges
    .filter(edge => shown.has(edge.from) && shown.has(edge.to))
    .map(edgeLabeler(aggregation));
  return {
    context,
    provenance: PROVENANCE,
    scannedFiles,
    analyzedFiles,
    totals: aggregation.totals,
    unassigned: aggregation.unassigned,
    groups,
    groupEdges,
    totalGroups: aggregation.groups.length,
    hiddenGroups: aggregation.groups.length - groups.length,
    hiddenGroupEdges: aggregation.groupEdges.length - groupEdges.length,
  };
}

/**
 * A rules check (check_architecture) with its violations paged, or only one rule's with `rule`;
 * unmatched files and resolved baseline entries capped at the limit, totals whole.
 */
export function exploreArchitectureCheck(
  check: WorkspaceArchitectureCheck,
  options: { rule?: string; offset?: number; limit?: number; revision?: string } = {},
) {
  if (options.revision !== undefined && options.revision !== check.context.revision) {
    throw new Error(
      `Architecture or rules changed (revision ${options.revision} -> ${check.context.revision}): pages from earlier responses no longer apply. ` +
      "Restart: call check_architecture without offset or revision.",
    );
  }
  if (options.rule !== undefined && !check.rules.some(rule => rule.name === options.rule)) {
    throw new Error(`Unknown rule "${options.rule}". Rules: ${check.rules.map(rule => rule.name).join(", ")}`);
  }
  const limit = options.limit ?? DEFAULT_EXPLORE_LIMIT;
  const { violations, unmatchedFiles, resolved, ...rest } = check;
  const shown = options.rule === undefined ? violations : violations.filter(violation => violation.rule === options.rule);
  const { items, ...pageInfo } = page(shown, options.offset ?? 0, limit);
  return { ...rest, violations: items, page: pageInfo, unmatchedFiles: unmatchedFiles.slice(0, limit), resolved: resolved.slice(0, limit) };
}
