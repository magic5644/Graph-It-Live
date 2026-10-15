/**
 * Workspace architecture graph shared by `graph-it architecture` and the
 * explore_architecture MCP tool, so both report the same groups and counts.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import * as path from "node:path";
import { computeNodeMetadata } from "../../analyzer/NodeMetadataBuilder";
import { SourceFileCollector } from "../../analyzer/SourceFileCollector";
import { DEFAULT_IGNORE_PATTERNS } from "../../analyzer/SourceFileFilters";
import {
  aggregateCommunityGroups,
  type CommunityGroup,
  type CommunityGroupAggregation,
} from "../../analyzer/community/groupAggregation";
import { IGNORED_DIRECTORIES } from "../../shared/constants";
import type { CommunityMode, GraphData } from "../../shared/graph-types";
import { normalizePath } from "../../shared/path";
import { workerState } from "../shared/state";
import { validateFilePath, type ExploreArchitectureParams } from "../types";
import { executeAnalyzeDependencies } from "./analysis";

interface ArchitectureNode {
  id: string;
  path: string;
  relativePath: string;
  extension: string;
  dependencyCount: number;
  dependentCount: number;
}

interface ArchitectureEdge {
  source: string;
  target: string;
  sourceRelative: string;
  targetRelative: string;
}

interface ArchitectureAccumulator {
  nodesByPath: Map<string, ArchitectureNode>;
  edgesByKey: Map<string, ArchitectureEdge>;
  dependencyCount: Map<string, number>;
  dependentCount: Map<string, number>;
}

interface FailedArchitectureFile {
  filePath: string;
  relativePath: string;
  reason: string;
}

export interface ArchitectureGraphOptions {
  maxFiles?: number;
  communityMode?: CommunityMode;
  /** Last scan timestamp, when the caller knows it. */
  indexedAt?: string;
  signal?: AbortSignal;
}

function isWithinWorkspace(filePath: string, workspaceRoot: string): boolean {
  const rel = path.relative(workspaceRoot, normalizePath(filePath));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function initializeAccumulator(): ArchitectureAccumulator {
  return {
    nodesByPath: new Map<string, ArchitectureNode>(),
    edgesByKey: new Map<string, ArchitectureEdge>(),
    dependencyCount: new Map<string, number>(),
    dependentCount: new Map<string, number>(),
  };
}

function registerNode(
  acc: ArchitectureAccumulator,
  workspaceRoot: string,
  filePath: string,
): void {
  const normalizedPath = normalizePath(filePath);
  const relativePath = normalizePath(path.relative(workspaceRoot, normalizedPath));
  acc.nodesByPath.set(normalizedPath, {
    id: normalizedPath,
    path: normalizedPath,
    relativePath,
    extension: path.extname(normalizedPath).slice(1),
    dependencyCount: 0,
    dependentCount: 0,
  });
}

function registerEdge(
  acc: ArchitectureAccumulator,
  sourcePath: string,
  targetPath: string,
  workspaceRoot: string,
): void {
  const normalizedSource = normalizePath(sourcePath);
  const normalizedTarget = normalizePath(targetPath);
  const edgeKey = `${normalizedSource}=>${normalizedTarget}`;
  if (acc.edgesByKey.has(edgeKey)) {
    return;
  }

  acc.edgesByKey.set(edgeKey, {
    source: normalizedSource,
    target: normalizedTarget,
    sourceRelative: normalizePath(path.relative(workspaceRoot, normalizedSource)),
    targetRelative: normalizePath(path.relative(workspaceRoot, normalizedTarget)),
  });
  acc.dependencyCount.set(normalizedSource, (acc.dependencyCount.get(normalizedSource) ?? 0) + 1);
  acc.dependentCount.set(normalizedTarget, (acc.dependentCount.get(normalizedTarget) ?? 0) + 1);
}

async function collectArchitectureForFile(
  acc: ArchitectureAccumulator,
  workspaceRoot: string,
  filePath: string,
): Promise<FailedArchitectureFile | null> {
  const normalizedPath = normalizePath(filePath);
  registerNode(acc, workspaceRoot, normalizedPath);
  try {
    validateFilePath(normalizedPath, workspaceRoot);
    const analysis = await executeAnalyzeDependencies({ filePath: normalizedPath });
    for (const dep of analysis.dependencies) {
      if (!isWithinWorkspace(dep.path, workspaceRoot)) {
        continue;
      }
      const normalizedDependencyPath = normalizePath(dep.path);
      registerNode(acc, workspaceRoot, normalizedDependencyPath);
      registerEdge(acc, normalizedPath, normalizedDependencyPath, workspaceRoot);
    }
    return null;
  } catch (err) {
    return {
      filePath: normalizedPath,
      relativePath: normalizePath(path.relative(workspaceRoot, normalizedPath)),
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Builds the workspace imports graph with community metadata, plus what was analysed. */
export async function buildArchitectureGraph(
  workspaceRoot: string,
  options: ArchitectureGraphOptions = {},
) {
  const maxFiles = options.maxFiles ?? Number.POSITIVE_INFINITY;
  const collector = new SourceFileCollector({ excludeNodeModules: true });
  const allFiles = await collector.collectAllSourceFiles(workspaceRoot);
  const files = Number.isFinite(maxFiles) ? allFiles.slice(0, maxFiles) : allFiles;

  const acc = initializeAccumulator();
  const failedFiles: FailedArchitectureFile[] = [];
  for (const filePath of files) {
    options.signal?.throwIfAborted();
    const failure = await collectArchitectureForFile(acc, workspaceRoot, filePath);
    if (failure) failedFiles.push(failure);
  }

  const edges = [...acc.edgesByKey.values()];
  const graphData: GraphData = { nodes: [...acc.nodesByPath.keys()], edges };
  computeNodeMetadata(graphData, workspaceRoot, options.communityMode);

  const nodes = [...acc.nodesByPath.values()].map((node) => ({
    ...node,
    dependencyCount: acc.dependencyCount.get(node.path) ?? 0,
    dependentCount: acc.dependentCount.get(node.path) ?? 0,
    communityId: graphData.nodeMetadata?.[node.path]?.communityId ?? 0,
    communityKey: graphData.nodeMetadata?.[node.path]?.communityKey ?? "",
  }));

  const context = {
    communityMode: options.communityMode ?? "path",
    graphKind: "imports",
    scope: "workspace",
    exclusions: [...IGNORED_DIRECTORIES, ".*/", ".gitignore", ".graphitignore", ...DEFAULT_IGNORE_PATTERNS].join(", "),
    indexedAt: options.indexedAt,
    maxFiles: Number.isFinite(maxFiles) ? maxFiles : undefined,
    truncated: files.length < allFiles.length,
    failedFiles: failedFiles.length,
  };

  return {
    graphData,
    nodes,
    edges,
    scannedFiles: allFiles.length,
    analyzedFiles: files.length,
    failedFiles,
    context,
  };
}

const DEFAULT_EXPLORE_LIMIT = 50;

/** Keeps code facts, computed groupings and interpretation apart, as #300 requires. */
const PROVENANCE = {
  facts: "File pairs are static import relations extracted from source code, not observed execution.",
  grouping: "Groups are computed by the communityMode detector; group ids are only valid within the same graph and communityMode.",
  interpretation: "None: labels are folder keys or detector output, not business names or responsibilities.",
};

const NEXT_STEPS =
  "For the symbols and lines behind a file pair, call graphitlive_find_referencing_files on the target, " +
  "then graphitlive_get_symbol_callers or graphitlive_get_impact_analysis on the symbols involved.";

type GroupRef = number | string;

function page<T>(items: T[], offset: number, limit: number) {
  const slice = items.slice(offset, offset + limit);
  const nextOffset = offset + slice.length < items.length ? offset + slice.length : undefined;
  return { items: slice, total: items.length, offset, returned: slice.length, truncated: nextOffset !== undefined, nextOffset };
}

function resolveGroup(aggregation: CommunityGroupAggregation, ref: GroupRef): CommunityGroup {
  const groups = aggregation.unassigned.fileCount > 0
    ? [...aggregation.groups, { id: 0, key: "", label: "unassigned", ...aggregation.unassigned }]
    : aggregation.groups;
  const text = String(ref);
  const group = groups.find(candidate => candidate.key !== "" && candidate.key === text)
    ?? groups.find(candidate => String(candidate.id) === text || candidate.label === text);
  if (!group) {
    throw new Error(`Unknown group "${text}". Call explore_architecture without group, from or to to list the groups.`);
  }
  return group;
}

/**
 * Progressive exploration of the grouped architecture: a bounded summary, one group with
 * its boundary, or the file pairs behind one group edge. Counts come from
 * aggregateCommunityGroups on the full graph, before any paging.
 */
export async function executeExploreArchitecture(
  params: ExploreArchitectureParams,
  signal?: AbortSignal,
) {
  // ponytail: rebuilds the graph on every call (Spider caches each file's analysis); cache by index revision if paging gets slow.
  const { context, graphData, nodes, edges } = await buildArchitectureGraph(workerState.getConfig().rootDir, {
    maxFiles: params.maxFiles,
    communityMode: params.communityMode,
    signal,
  });
  const aggregation = aggregateCommunityGroups(graphData);
  const offset = params.offset ?? 0;
  const limit = params.limit ?? DEFAULT_EXPLORE_LIMIT;
  const labelOf = (id: number) =>
    id === 0 ? "unassigned" : aggregation.groups.find(group => group.id === id)?.label ?? "";
  const withLabels = (edge: CommunityGroupAggregation["groupEdges"][number]) =>
    ({ ...edge, fromLabel: labelOf(edge.from), toLabel: labelOf(edge.to) });
  const communityOf = (filePath: string) => graphData.nodeMetadata?.[filePath]?.communityId ?? 0;
  const base = { context, provenance: PROVENANCE, totals: aggregation.totals };

  if (params.from !== undefined && params.to !== undefined) {
    const from = resolveGroup(aggregation, params.from);
    const to = resolveGroup(aggregation, params.to);
    const pairs = edges
      .filter(edge => communityOf(edge.source) === from.id && communityOf(edge.target) === to.id)
      .map(edge => ({ source: edge.sourceRelative, target: edge.targetRelative }))
      .sort((left, right) => left.source.localeCompare(right.source) || left.target.localeCompare(right.target));
    const { items, ...pageInfo } = page(pairs, offset, limit);
    return { view: "evidence", ...base, from, to, pairs: items, page: pageInfo, nextSteps: NEXT_STEPS };
  }

  if (params.group !== undefined) {
    const group = resolveGroup(aggregation, params.group);
    const files = nodes
      .filter(node => node.communityId === group.id)
      .map(node => node.relativePath)
      .sort((left, right) => left.localeCompare(right));
    const { items, ...pageInfo } = page(files, offset, limit);
    return {
      view: "group",
      ...base,
      group,
      incoming: aggregation.groupEdges.filter(edge => edge.to === group.id).map(withLabels),
      outgoing: aggregation.groupEdges.filter(edge => edge.from === group.id).map(withLabels),
      files: items,
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
