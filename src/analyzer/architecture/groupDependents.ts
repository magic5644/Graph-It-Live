/**
 * Dependents by group: the files that import a selection directly or through other files
 * (reverse transitive closure over the static import pairs), counted per group. Shared by the
 * extension's Architecture view; symbol-level impact stays get_impact_analysis.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { normalizePath } from "../../shared/path";
import type { ArchitectureGraph } from "./ArchitectureGraphBuilder";
import { byCodeUnit } from "./architectureUnits";

export const DEPENDENTS_PROVENANCE =
  "Static import relations only; dynamic imports resolved by the analyzer are included, runtime-only use is not.";

const DEFAULT_FILES_LIMIT = 50;

export interface GroupDependentsOptions {
  /** Bounds the walk (1 = direct importers only); none by default, since the graph is finite. */
  maxDepth?: number;
  /** Group key of a workspace-relative file; defaults to its communityKey, "" for the unassigned files (id 0). */
  groupOf?: (relativePath: string) => string;
}

export interface DependentGroup {
  /** Group key ("" for the unassigned files). */
  key: string;
  label: string;
  /** Files importing a seed file directly (depth 1). */
  directFiles: number;
  /** Every reached file of the group. */
  transitiveFiles: number;
  minDepth: number;
}

export interface DependentFile {
  relativePath: string;
  /** 1 = imports a seed file directly. */
  depth: number;
}

/** Importers of each file: the graph's static import pairs reversed (target → sources). */
function importersOf(graph: ArchitectureGraph): Map<string, string[]> {
  const importers = new Map<string, string[]>();
  for (const { sourceRelative, targetRelative } of graph.edges) {
    const list = importers.get(targetRelative);
    if (list) list.push(sourceRelative);
    else importers.set(targetRelative, [sourceRelative]);
  }
  return importers;
}

/** Minimum depth of every file reached from the seeds by a breadth-first walk up the imports; a file is reached once, so cycles end. */
function walkImporters(importers: ReadonlyMap<string, string[]>, seeds: ReadonlySet<string>, maxDepth: number) {
  const depthOf = new Map<string, number>();
  const visited = new Set(seeds);
  const unvisitedImporters = (file: string) => (importers.get(file) ?? []).filter((importer) => !visited.has(importer));
  let frontier = [...seeds];
  let depth = 0;
  while (frontier.length > 0) {
    depth += 1;
    if (depth > maxDepth) return { depthOf, maxDepthReached: frontier.some((file) => unvisitedImporters(file).length > 0) };
    const next: string[] = [];
    for (const file of frontier) {
      for (const importer of unvisitedImporters(file)) {
        visited.add(importer);
        depthOf.set(importer, depth);
        next.push(importer);
      }
    }
    frontier = next;
  }
  return { depthOf, maxDepthReached: false };
}

/**
 * The files that depend on `seedFiles` (workspace-relative; files outside the graph are ignored)
 * through static imports, each at its minimum depth, grouped by `groupOf`. Seed files are left
 * out, and the reached files of the seeds' own groups are counted apart (`insideSeedGroup`).
 * Groups come by minimum depth, then most files, then key.
 */
export function computeGroupDependents(graph: ArchitectureGraph, seedFiles: readonly string[], options: GroupDependentsOptions = {}) {
  const keyOf = new Map(graph.nodes.map((node) => [node.relativePath, node.communityId === 0 ? "" : node.communityKey]));
  const groupOf = options.groupOf ?? ((relativePath: string) => keyOf.get(relativePath) ?? "");
  const seeds = new Set(seedFiles.map(normalizePath).filter((file) => keyOf.has(file)));
  const seedGroups = new Set([...seeds].map(groupOf));
  const { depthOf, maxDepthReached } = walkImporters(importersOf(graph), seeds, options.maxDepth ?? Number.POSITIVE_INFINITY);

  const filesByGroup = new Map<string, DependentFile[]>();
  for (const [relativePath, depth] of depthOf) {
    const key = groupOf(relativePath);
    const files = filesByGroup.get(key);
    if (files) files.push({ relativePath, depth });
    else filesByGroup.set(key, [{ relativePath, depth }]);
  }
  const summarize = (key: string, files: readonly DependentFile[]): DependentGroup => ({
    key,
    label: key === "" ? "unassigned" : key,
    directFiles: files.filter((file) => file.depth === 1).length,
    transitiveFiles: files.length,
    minDepth: Math.min(...files.map((file) => file.depth)),
  });
  const groups = [...filesByGroup]
    .filter(([key]) => !seedGroups.has(key))
    .map(([key, files]) => summarize(key, files))
    .sort((left, right) => left.minDepth - right.minDepth || right.transitiveFiles - left.transitiveFiles || byCodeUnit(left.key, right.key));
  const inside = [...seedGroups].flatMap((key) => filesByGroup.get(key) ?? []);

  return {
    seed: { files: seeds.size, groups: [...seedGroups].sort(byCodeUnit) },
    groups,
    insideSeedGroup: { directFiles: inside.filter((file) => file.depth === 1).length, transitiveFiles: inside.length },
    reachedFiles: depthOf.size,
    /** Reached files and groups outside the seeds' own groups. */
    totals: { files: depthOf.size - inside.length, groups: groups.length },
    maxDepthReached,
    provenance: DEPENDENTS_PROVENANCE,
    /** One page of a group's reached files, by depth then path. */
    filesOf(key: string, { offset = 0, limit = DEFAULT_FILES_LIMIT }: { offset?: number; limit?: number } = {}) {
      const files = (filesByGroup.get(key) ?? [])
        .toSorted((left, right) => left.depth - right.depth || byCodeUnit(left.relativePath, right.relativePath));
      const items = files.slice(offset, offset + limit);
      const nextOffset = offset + items.length < files.length ? offset + items.length : undefined;
      return { files: items, page: { total: files.length, offset, returned: items.length, truncated: nextOffset !== undefined, nextOffset } };
    },
  };
}

export type GroupDependents = ReturnType<typeof computeGroupDependents>;
