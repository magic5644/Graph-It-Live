/**
 * Progressive views over an architecture graph, shared by explore_architecture and the extension.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import {
  aggregateCommunityGroups,
  type CommunityGroup,
  type CommunityGroupAggregation,
} from "../community/groupAggregation";
import type { ArchitectureGraph } from "./ArchitectureGraphBuilder";

const DEFAULT_EXPLORE_LIMIT = 50;

/** Keeps code facts, computed groupings and interpretation apart, as #300 requires. */
const PROVENANCE = {
  facts: "File pairs are static import relations extracted from source code, not observed execution.",
  grouping: "Groups are computed by the communityMode detector; group ids are only valid within the same graph and communityMode.",
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

/**
 * A bounded summary, one group with its boundary, or the file pairs behind one group edge.
 * Counts come from aggregateCommunityGroups on the full graph, before any paging.
 */
export function exploreArchitecture(
  { context, graphData, nodes, edges }: ArchitectureGraph,
  options: ArchitectureExploreOptions = {},
) {
  const aggregation = aggregateCommunityGroups(graphData);
  const offset = options.offset ?? 0;
  const limit = options.limit ?? DEFAULT_EXPLORE_LIMIT;
  const labelOf = (id: number) =>
    id === 0 ? "unassigned" : aggregation.groups.find(group => group.id === id)?.label ?? "";
  const withLabels = (edge: CommunityGroupAggregation["groupEdges"][number]) =>
    ({ ...edge, fromLabel: labelOf(edge.from), toLabel: labelOf(edge.to) });
  const communityOf = (filePath: string) => graphData.nodeMetadata?.[filePath]?.communityId ?? 0;
  const base = { context, provenance: PROVENANCE, totals: aggregation.totals };

  if (options.from !== undefined && options.to !== undefined) {
    const from = resolveGroup(aggregation, options.from);
    const to = resolveGroup(aggregation, options.to);
    const pairs = edges
      .filter(edge => communityOf(edge.source) === from.id && communityOf(edge.target) === to.id)
      .map(edge => ({ source: edge.sourceRelative, target: edge.targetRelative }))
      .sort((left, right) => left.source.localeCompare(right.source) || left.target.localeCompare(right.target));
    const { items, ...pageInfo } = page(pairs, offset, limit);
    return { view: "evidence", ...base, from, to, pairs: items, page: pageInfo, nextSteps: NEXT_STEPS };
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
      view: "group",
      ...base,
      group,
      incoming: incoming.map(withLabels),
      outgoing: outgoing.map(withLabels),
      files: filePage,
      page: pageInfo,
      nextSteps: "Pass from and to to list the file pairs behind an incoming or outgoing edge.",
    };
  }

  const groups = page(aggregation.groups.toSorted((left, right) => right.fileCount - left.fileCount || left.id - right.id), offset, limit);
  const groupEdges = page(aggregation.groupEdges.toSorted((left, right) => right.fileEdgeCount - left.fileEdgeCount), offset, limit);
  const truncated = groups.truncated || groupEdges.truncated;
  return {
    view: "summary",
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
