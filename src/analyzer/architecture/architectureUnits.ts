/**
 * Architecture units: the packages of a workspace (every folder holding a package.json),
 * else its top-level folders, with their layers and the file pairs between them. Shared by
 * `graph-it architecture --level units`, explore_architecture and the extension's view.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { domainIndex } from "../community/PathCommunityDetector";
import { normalizePath } from "../../shared/path";
import type { ArchitectureGraph } from "./ArchitectureGraphBuilder";
import { layerGraph } from "./stronglyConnectedComponents";
import { UNIT_ROLES, unitRole, type DeclaredRoles, type UnitRole, type UnitRoleInfo } from "./unitRoles";

/** Unit of the files outside every package (or at the root of a workspace without packages). */
export const ROOT_UNIT = "(root)";

export interface ArchitectureUnit {
  /** Workspace-relative folder, or ROOT_UNIT. */
  key: string;
  /** package.json `name`, else the folder. */
  name: string;
  fileCount: number;
  /** Distinct directed file pairs with both ends in this unit. */
  internalEdgeCount: number;
  /** 0 = depends on no other unit; units in one cycle share a layer. */
  layer: number;
  role: UnitRole;
  confidence: UnitRoleInfo["confidence"];
  evidence: UnitRoleInfo["evidence"];
}

/** `upward`: to a unit at the same or a higher layer; `cycle`: both units in one cycle. */
export type ArchitectureUnitEdgeKind = "down" | "upward" | "cycle";

export interface ArchitectureUnitEdge {
  from: string;
  to: string;
  /** Distinct directed file pairs from a file of `from` to a file of `to`. */
  fileEdgeCount: number;
  kind: ArchitectureUnitEdgeKind;
}

export interface UnitAssignment {
  /** Unit key of every workspace-relative file. */
  unitOf: Map<string, string>;
  /** Display name of every unit key. */
  names: Map<string, string>;
}

function packageName(packageJsonPath: string): string | undefined {
  try {
    const manifest: unknown = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const name = typeof manifest === "object" && manifest !== null ? (manifest as { name?: unknown }).name : undefined;
    return typeof name === "string" && name.trim() ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Parent folders of a workspace-relative file, deepest first ("a/b/c.ts" → "a/b", "a"). */
function foldersOf(relativePath: string): string[] {
  const parts = relativePath.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, parts.length - index).join("/"));
}

/**
 * Each file goes to its deepest package folder (a folder holding a package.json, workspace
 * member or not), else to ROOT_UNIT. Without any package below the root, units are the
 * top-level folders. Files come from SourceFileCollector, so node_modules is never read.
 */
export function assignUnits(workspaceRoot: string, files: readonly string[]): UnitAssignment {
  const relativePaths = files.map(normalizePath);
  const isPackage = new Map<string, boolean>();
  for (const folder of new Set(relativePaths.flatMap(foldersOf))) {
    isPackage.set(folder, fs.existsSync(path.join(workspaceRoot, folder, "package.json")));
  }
  const hasPackages = [...isPackage.values()].some(Boolean);
  const unitOf = new Map<string, string>();
  const names = new Map<string, string>();
  for (const relativePath of relativePaths) {
    const folders = foldersOf(relativePath);
    const unit = (hasPackages ? folders.find((folder) => isPackage.get(folder)) : folders.at(-1)) ?? ROOT_UNIT;
    unitOf.set(relativePath, unit);
    if (!names.has(unit)) {
      const name = unit !== ROOT_UNIT && hasPackages ? packageName(path.join(workspaceRoot, unit, "package.json")) : undefined;
      names.set(unit, name ?? unit);
    }
  }
  return { unitOf, names };
}

/** Same-component edges are cycles; any other edge not going down a layer goes upward. */
export function classifyUnitEdge(fromLayer: number, toLayer: number, sameComponent: boolean): ArchitectureUnitEdgeKind {
  if (sameComponent) return "cycle";
  return toLayer >= fromLayer ? "upward" : "down";
}

// Code-unit order, not localeCompare: collation varies with the machine's locale.
export const byCodeUnit = (left: string, right: string) => (left < right ? -1 : Number(left > right));

/**
 * Units, layers and unit → unit edges of an architecture graph, aggregated from every file
 * pair before any paging, with the role of every unit (`roles` of graphit.architecture.json
 * win). `context.revision` also covers the units, their names and roles.
 */
export function buildArchitectureUnits(graph: ArchitectureGraph, workspaceRoot: string, assignment?: UnitAssignment, declaredRoles?: DeclaredRoles) {
  const { unitOf, names } = assignment ?? assignUnits(workspaceRoot, graph.nodes.map((node) => node.relativePath));
  const unitKeys = [...names.keys()].sort(byCodeUnit);
  const files = new Map<string, string[]>(unitKeys.map((key) => [key, []]));
  const internal = new Map<string, number>(unitKeys.map((key) => [key, 0]));
  for (const node of graph.nodes) files.get(unitOf.get(node.relativePath)!)!.push(node.relativePath);

  const pairs = new Map<string, { from: string; to: string; fileEdgeCount: number }>();
  for (const edge of graph.edges) {
    const from = unitOf.get(edge.sourceRelative)!;
    const to = unitOf.get(edge.targetRelative)!;
    if (from === to) {
      internal.set(from, internal.get(from)! + 1);
      continue;
    }
    const key = `${from}\0${to}`;
    const pair = pairs.get(key) ?? { from, to, fileEdgeCount: 0 };
    pair.fileEdgeCount += 1;
    pairs.set(key, pair);
  }

  const successors = new Map<string, string[]>();
  for (const { from, to } of pairs.values()) successors.set(from, [...(successors.get(from) ?? []), to]);
  for (const targets of successors.values()) targets.sort(byCodeUnit);
  const { components, componentOf, layerOf } = layerGraph(unitKeys, successors);

  const importers = (key: string) => [...pairs.values()].filter((pair) => pair.to === key).map((pair) => names.get(pair.from)!).sort(byCodeUnit);
  const units: ArchitectureUnit[] = unitKeys
    .map((key) => ({
      key,
      name: names.get(key)!,
      fileCount: files.get(key)!.length,
      internalEdgeCount: internal.get(key)!,
      layer: layerOf.get(key)!,
      ...unitRole(workspaceRoot, { key, name: names.get(key)!, folder: key === ROOT_UNIT ? "" : key, files: files.get(key)!, importers: importers(key) }, declaredRoles),
    }))
    .sort((left, right) => right.layer - left.layer || right.fileCount - left.fileCount || byCodeUnit(left.key, right.key));
  const unitEdges: ArchitectureUnitEdge[] = [...pairs.values()]
    .map((pair) => ({
      ...pair,
      kind: classifyUnitEdge(layerOf.get(pair.from)!, layerOf.get(pair.to)!, componentOf.get(pair.from) === componentOf.get(pair.to)),
    }))
    .sort((left, right) => right.fileEdgeCount - left.fileEdgeCount || byCodeUnit(left.from, right.from) || byCodeUnit(left.to, right.to));
  const interUnitEdges = unitEdges.reduce((total, edge) => total + edge.fileEdgeCount, 0);

  const revision = createHash("sha256")
    .update(JSON.stringify([graph.context.revision, units.map((unit) => `${unit.key}\t${unit.name}\t${unit.role}\t${unit.confidence}`).sort(byCodeUnit)]))
    .digest("hex");
  return {
    context: { ...graph.context, revision },
    units,
    unitEdges,
    upwardEdges: unitEdges.filter((edge) => edge.kind === "upward").length,
    /** Groups of two or more units that depend on each other. */
    cycles: components.filter((members) => members.length > 1).length,
    /** Units per role, in role priority order; roles no unit has are left out. */
    roleCounts: Object.fromEntries(UNIT_ROLES.flatMap((role) => {
      const count = units.filter((unit) => unit.role === role).length;
      return count === 0 ? [] : [[role, count]];
    })) as Partial<Record<UnitRole, number>>,
    totals: {
      files: graph.nodes.length,
      fileEdges: graph.edges.length,
      intraUnitEdges: graph.edges.length - interUnitEdges,
      interUnitEdges,
    },
  };
}

export type ArchitectureUnits = ReturnType<typeof buildArchitectureUnits>;

/**
 * Folder keys of a file, from its unit down to its own folder: the unit, then `<unit>/<domain>`
 * (umbrella folders such as src or tests skipped, as for the path groups), then each sub-folder.
 */
export function folderKeys(relativePath: string, unit: string): string[] {
  const normalized = normalizePath(relativePath);
  const inside = unit === ROOT_UNIT ? normalized : normalized.slice(unit.length + 1);
  const dirs = inside.split("/").slice(0, -1);
  const chain = dirs.slice(domainIndex(dirs, 0));
  return [unit, ...chain.map((_, index) => `${unit}/${chain.slice(0, index + 1).join("/")}`)];
}

/**
 * The graph regrouped by unit-scoped folder groups, so a unit's groups never mix files of other
 * units. Without `folder`: every unit's top folders (`<unit>/<domain>`), plus the unit itself for
 * its files outside any domain folder; group ids follow the units' order and `context.revision`
 * is the units' revision. With a unit or folder key: only the files below it, grouped by its
 * sub-folders, plus the folder itself for its own files; the revision then covers the folder.
 * `nestedGroups` are the groups holding sub-folders: the next level down.
 */
export function groupByUnit(
  graph: ArchitectureGraph,
  units: ArchitectureUnits,
  assignment: UnitAssignment,
  folder?: string,
): { graph: ArchitectureGraph; groupUnits: Record<number, string>; nestedGroups: number[] } {
  const unitOrder = new Map(units.units.map((unit, index) => [unit.key, index]));
  const keys = graph.nodes.flatMap((node) => {
    const unit = assignment.unitOf.get(node.relativePath)!;
    const chain = folderKeys(node.relativePath, unit);
    const level = folder === undefined ? 0 : chain.indexOf(folder);
    return level < 0 ? [] : [{ node, unit, key: chain[level + 1] ?? chain[level], nested: chain.length > level + 2 }];
  });
  const ordered = [...new Map(keys.map((entry) => [entry.key, entry.unit])).entries()]
    .sort(([leftKey, leftUnit], [rightKey, rightUnit]) =>
      unitOrder.get(leftUnit)! - unitOrder.get(rightUnit)! || byCodeUnit(leftKey, rightKey));
  const idOf = new Map(ordered.map(([key], index) => [key, index + 1]));
  const groupUnits: Record<number, string> = Object.fromEntries(ordered.map(([key, unit]) => [idOf.get(key)!, unit]));

  const nodeMetadata = { ...graph.graphData.nodeMetadata };
  const nodes = keys.map(({ node, key }) => {
    const communityId = idOf.get(key)!;
    nodeMetadata[node.path] = { ...nodeMetadata[node.path], communityId, communityKey: key };
    return { ...node, communityId, communityKey: key };
  });
  // A folder level keeps the pairs between its own files: the counts add up level by level.
  const inside = new Set(nodes.map((node) => node.path));
  const edges = graph.edges.filter((edge) => inside.has(edge.source) && inside.has(edge.target));
  const revision = folder === undefined
    ? units.context.revision
    : createHash("sha256").update(JSON.stringify([units.context.revision, folder])).digest("hex");
  return {
    graph: {
      ...graph,
      nodes,
      edges,
      graphData: { ...graph.graphData, nodes: graph.graphData.nodes.filter((filePath) => inside.has(filePath)), edges, nodeMetadata },
      context: { ...units.context, revision },
    },
    groupUnits,
    nestedGroups: [...new Set(keys.filter((entry) => entry.nested).map((entry) => idOf.get(entry.key)!))].sort((left, right) => left - right),
  };
}

/**
 * Layer of every folder group within its unit (cycles collapsed, as for the units), and the kind
 * of every group edge whose ends share a unit, keyed `from>to`. Edges across units are left out:
 * a unit's groups are drawn on their own.
 */
export function layerGroupsWithinUnits(
  groupEdges: readonly { from: number; to: number }[],
  groupUnits: Readonly<Record<number, string>>,
): { groupLayers: Record<number, number>; groupEdgeKinds: Record<string, ArchitectureUnitEdgeKind> } {
  const ids = Object.keys(groupUnits);
  const inside = groupEdges.filter((edge) => groupUnits[edge.from] === groupUnits[edge.to]);
  const successors = new Map<string, string[]>();
  for (const { from, to } of inside) successors.set(String(from), [...(successors.get(String(from)) ?? []), String(to)]);
  const { componentOf, layerOf } = layerGraph(ids, successors);
  const layer = (id: number) => layerOf.get(String(id)) ?? 0;
  return {
    groupLayers: Object.fromEntries(ids.map((id) => [id, layerOf.get(id) ?? 0])),
    groupEdgeKinds: Object.fromEntries(inside.map(({ from, to }) =>
      [`${from}>${to}`, classifyUnitEdge(layer(from), layer(to), componentOf.get(String(from)) === componentOf.get(String(to)))])),
  };
}

/**
 * The level below a unit or folder key (path mode), as `graph-it architecture --folder` and
 * explore_architecture `folder` report it: the files below it, grouped by its sub-folders.
 */
export function folderLevel(graph: ArchitectureGraph, workspaceRoot: string, folder: string) {
  if (graph.context.communityMode !== "path") {
    throw new Error("folder levels exist in communityMode 'path' only: Louvain groups have no folders.");
  }
  const assignment = assignUnits(workspaceRoot, graph.nodes.map((node) => node.relativePath));
  const level = groupByUnit(graph, buildArchitectureUnits(graph, workspaceRoot, assignment), assignment, folder);
  if (level.graph.nodes.length === 0) {
    throw new Error(`No file below folder "${folder}". Pass a unit key (level units) or a group key of a folder level.`);
  }
  return level;
}
