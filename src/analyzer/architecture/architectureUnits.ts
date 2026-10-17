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
import { domainFromDirParts } from "../community/PathCommunityDetector";
import type { ArchitectureGraph } from "./ArchitectureGraphBuilder";
import { layerGraph } from "./stronglyConnectedComponents";

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
export function assignUnits(workspaceRoot: string, relativePaths: readonly string[]): UnitAssignment {
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
const byCodeUnit = (left: string, right: string) => (left < right ? -1 : Number(left > right));

/**
 * Units, layers and unit → unit edges of an architecture graph, aggregated from every file
 * pair before any paging. `context.revision` also covers the units and their names.
 */
export function buildArchitectureUnits(graph: ArchitectureGraph, workspaceRoot: string, assignment?: UnitAssignment) {
  const { unitOf, names } = assignment ?? assignUnits(workspaceRoot, graph.nodes.map((node) => node.relativePath));
  const unitKeys = [...names.keys()].sort(byCodeUnit);
  const fileCount = new Map<string, number>(unitKeys.map((key) => [key, 0]));
  const internal = new Map<string, number>(unitKeys.map((key) => [key, 0]));
  for (const node of graph.nodes) {
    const unit = unitOf.get(node.relativePath)!;
    fileCount.set(unit, fileCount.get(unit)! + 1);
  }

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

  const units: ArchitectureUnit[] = unitKeys
    .map((key) => ({
      key,
      name: names.get(key)!,
      fileCount: fileCount.get(key)!,
      internalEdgeCount: internal.get(key)!,
      layer: layerOf.get(key)!,
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
    .update(JSON.stringify([graph.context.revision, units.map((unit) => `${unit.key}\t${unit.name}`).sort(byCodeUnit)]))
    .digest("hex");
  return {
    context: { ...graph.context, revision },
    units,
    unitEdges,
    upwardEdges: unitEdges.filter((edge) => edge.kind === "upward").length,
    /** Groups of two or more units that depend on each other. */
    cycles: components.filter((members) => members.length > 1).length,
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
 * The graph regrouped by unit-scoped folder groups (`<unit>/<domain>`, or the unit itself for
 * its files outside any domain folder), so a unit's groups never mix files of other units.
 * Group ids follow the units' order; `context.revision` is the units' revision.
 */
export function groupByUnit(
  graph: ArchitectureGraph,
  units: ArchitectureUnits,
  assignment: UnitAssignment,
): { graph: ArchitectureGraph; groupUnits: Record<number, string> } {
  const unitOrder = new Map(units.units.map((unit, index) => [unit.key, index]));
  const keyOf = (relativePath: string) => {
    const unit = assignment.unitOf.get(relativePath)!;
    const inside = unit === ROOT_UNIT ? relativePath : relativePath.slice(unit.length + 1);
    const domain = domainFromDirParts(inside.split("/").slice(0, -1), 0);
    return { unit, key: domain ? `${unit}/${domain}` : unit };
  };
  const keys = graph.nodes.map((node) => ({ path: node.path, ...keyOf(node.relativePath) }));
  const ordered = [...new Map(keys.map((entry) => [entry.key, entry.unit])).entries()]
    .sort(([leftKey, leftUnit], [rightKey, rightUnit]) =>
      unitOrder.get(leftUnit)! - unitOrder.get(rightUnit)! || byCodeUnit(leftKey, rightKey));
  const idOf = new Map(ordered.map(([key], index) => [key, index + 1]));
  const groupUnits: Record<number, string> = Object.fromEntries(ordered.map(([key, unit]) => [idOf.get(key)!, unit]));

  const nodeMetadata = { ...graph.graphData.nodeMetadata };
  const nodes = graph.nodes.map((node, index) => {
    const { key } = keys[index];
    const communityId = idOf.get(key)!;
    nodeMetadata[node.path] = { ...nodeMetadata[node.path], communityId, communityKey: key };
    return { ...node, communityId, communityKey: key };
  });
  return {
    graph: { ...graph, nodes, graphData: { ...graph.graphData, nodeMetadata }, context: units.context },
    groupUnits,
  };
}
