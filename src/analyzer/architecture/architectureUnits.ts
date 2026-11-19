/**
 * Architecture units: the projects of a workspace (every folder holding a project manifest of
 * PROJECT_MARKERS: package.json, pyproject.toml, go.mod...), else its top-level folders, with their layers and the file pairs between them. Shared by
 * `graph-it architecture --level units`, explore_architecture and the extension's view.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { domainIndex } from "../community/PathCommunityDetector";
import {
  UNIT_ROLES,
  type ArchitectureUnit,
  type ArchitectureUnitEdge,
  type ArchitectureUnitEdgeKind,
  type ArchitectureUnits,
  type UnitCycleKind,
  type UnitRole,
} from "../../shared/architecture-model";
import { normalizePath } from "../../shared/path";
import { hasProjectMarker } from "../utils/workspaceBoundary";
import type { ArchitectureGraph } from "./ArchitectureGraphBuilder";
import { layerGraph } from "./stronglyConnectedComponents";
import { unitRole, type DeclaredRoles } from "./unitRoles";

/** Unit of the files outside every project (or at the root of a workspace without projects). */
export const ROOT_UNIT = "(root)";

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

/** The text of `file`, undefined when it cannot be read. */
function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** The `name = "..."` of a TOML `[section]` (Cargo.toml `[package]`, pyproject.toml `[project]`). */
function tomlName(text: string | undefined, section: string): string | undefined {
  const body = text?.split(/^\[/m).find((part) => part.startsWith(`${section}]`));
  return body === undefined ? undefined : /^[ \t]*name[ \t]*=[ \t]*["']([^"'\n]+)["']/m.exec(body)?.[1];
}

/**
 * The name a project folder's manifest gives it, as a reader of the project knows it: package.json `name`, the
 * Maven `artifactId`, Cargo.toml `[package]` and pyproject.toml `[project]` (or Poetry) `name`, the Go module path,
 * the .csproj file name. Text is only searched, nothing is executed. Undefined: the unit keeps its folder key.
 * shortcut: Gradle names live in settings.gradle (`include`), not in the module; upgrade if Gradle units need names.
 */
function manifestName(folder: string): string | undefined {
  const at = (file: string) => path.join(folder, file);
  const pom = readText(at("pom.xml"))?.replaceAll(/<parent>[\s\S]*?<\/parent>|<!--[\s\S]*?-->/g, "");
  const pyproject = readText(at("pyproject.toml"));
  let csproj: string[] = [];
  try {
    csproj = fs.readdirSync(folder).filter((file) => file.endsWith(".csproj"));
  } catch {
    // Unreadable folder: no .csproj name.
  }
  const name = packageName(at("package.json"))
    ?? (pom === undefined ? undefined : /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(pom)?.[1])
    ?? tomlName(readText(at("Cargo.toml")), "package")
    ?? tomlName(pyproject, "project") ?? tomlName(pyproject, "tool.poetry")
    ?? /^module[ \t]+(\S+)/m.exec(readText(at("go.mod")) ?? "")?.[1]
    ?? (csproj.length === 1 ? path.basename(csproj[0], ".csproj") : undefined);
  return name?.trim() || undefined;
}

/** Parent folders of a workspace-relative file, deepest first ("a/b/c.ts" → "a/b", "a"). */
function foldersOf(relativePath: string): string[] {
  const parts = relativePath.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, parts.length - index).join("/"));
}

/**
 * Each file goes to its deepest project folder (a folder holding a PROJECT_MARKERS manifest:
 * package.json, pyproject.toml, go.mod, Cargo.toml, *.csproj, pom.xml..., workspace member or
 * not), else to ROOT_UNIT. Without any project below the root, units are the top-level folders. Files come from SourceFileCollector, so node_modules is never read.
 */
export function assignUnits(workspaceRoot: string, files: readonly string[]): UnitAssignment {
  const relativePaths = files.map(normalizePath);
  const isProject = new Map<string, boolean>();
  for (const folder of new Set(relativePaths.flatMap(foldersOf))) {
    isProject.set(folder, hasProjectMarker(path.join(workspaceRoot, folder)));
  }
  const hasProjects = [...isProject.values()].some(Boolean);
  const unitOf = new Map<string, string>();
  const names = new Map<string, string>();
  for (const relativePath of relativePaths) {
    const folders = foldersOf(relativePath);
    const unit = (hasProjects ? folders.find((folder) => isProject.get(folder)) : folders.at(-1)) ?? ROOT_UNIT;
    unitOf.set(relativePath, unit);
    if (!names.has(unit)) {
      const name = unit !== ROOT_UNIT && hasProjects ? manifestName(path.join(workspaceRoot, unit)) : undefined;
      names.set(unit, name ?? unit);
    }
  }
  return { unitOf, names };
}

/** One unit (or group) pair: its file pairs, those whose every import is type-only, those loaded only through import(). */
export interface UnitPair {
  from: string;
  to: string;
  fileEdgeCount: number;
  typeOnlyEdgeCount: number;
  dynamicEdgeCount: number;
}

/** Adds one file pair (`from` and `to` its unit or group keys, distinct) to `pairs`. */
export function countPair(pairs: Map<string, UnitPair>, from: string, to: string, edge: { typeOnly?: boolean; dynamic?: boolean }): void {
  const key = `${from}\0${to}`;
  const pair = pairs.get(key) ?? { from, to, fileEdgeCount: 0, typeOnlyEdgeCount: 0, dynamicEdgeCount: 0 };
  pair.fileEdgeCount += 1;
  if (edge.typeOnly) pair.typeOnlyEdgeCount += 1;
  if (edge.dynamic) pair.dynamicEdgeCount += 1;
  pairs.set(key, pair);
}

/**
 * How the cycle of `members` (one strongly connected component) runs: type-only when every pair
 * between them is (#740), lazy when it no longer cycles without its import() pairs (#741).
 */
export function cycleKind(members: readonly string[], pairs: ReadonlyMap<string, UnitPair>): UnitCycleKind {
  const inside = members.flatMap((from) => members.flatMap((to) => (from === to ? [] : pairs.get(`${from}\0${to}`) ?? [])));
  if (inside.every((pair) => pair.typeOnlyEdgeCount === pair.fileEdgeCount)) return "type-only";
  if (!inside.some((pair) => pair.dynamicEdgeCount > 0)) return "runtime";
  // Peel the units no eager pair (a static or type-only import) enters: the cycle is what can never be peeled.
  const eager = (from: string, to: string) => {
    const pair = from === to ? undefined : pairs.get(`${from}\0${to}`);
    return pair !== undefined && pair.dynamicEdgeCount < pair.fileEdgeCount;
  };
  let left: readonly string[] = members;
  let before: number;
  do {
    before = left.length;
    const kept = left;
    left = kept.filter((to) => kept.some((from) => eager(from, to)));
  } while (left.length < before);
  return left.length === 0 ? "lazy" : "runtime";
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
export function buildArchitectureUnits(
  graph: ArchitectureGraph,
  workspaceRoot: string,
  assignment?: UnitAssignment,
  declaredRoles?: DeclaredRoles,
): ArchitectureUnits {
  const { unitOf, names } = assignment ?? assignUnits(workspaceRoot, graph.nodes.map((node) => node.relativePath));
  const unitKeys = [...names.keys()].sort(byCodeUnit);
  const files = new Map<string, string[]>(unitKeys.map((key) => [key, []]));
  const internal = new Map<string, number>(unitKeys.map((key) => [key, 0]));
  for (const node of graph.nodes) files.get(unitOf.get(node.relativePath)!)!.push(node.relativePath);

  const pairs = new Map<string, UnitPair>();
  for (const edge of graph.edges) {
    const from = unitOf.get(edge.sourceRelative)!;
    const to = unitOf.get(edge.targetRelative)!;
    if (from === to) {
      internal.set(from, internal.get(from)! + 1);
      continue;
    }
    countPair(pairs, from, to, edge);
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
  const cycleKinds = components.filter((members) => members.length > 1).map((members) => cycleKind(members, pairs));
  const cycleKindOf = new Map(components.filter((members) => members.length > 1).flatMap((members, index) => members.map((key) => [key, cycleKinds[index]] as const)));
  const unitEdges: ArchitectureUnitEdge[] = [...pairs.values()]
    .map(({ from, to, fileEdgeCount, typeOnlyEdgeCount }) => {
      const kind = classifyUnitEdge(layerOf.get(from)!, layerOf.get(to)!, componentOf.get(from) === componentOf.get(to));
      return {
        from, to, fileEdgeCount, kind,
        ...(typeOnlyEdgeCount > 0 ? { typeOnlyEdgeCount } : {}),
        ...(kind === "cycle" ? { cycleKind: cycleKindOf.get(from)! } : {}),
      };
    })
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
    /** Distinct layers of the units. */
    layerCount: new Set(units.map((unit) => unit.layer)).size,
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
 * The unit or folder key that draws a workspace directory (relative, "/"-separated, not the
 * root): the deepest key every indexed file below it shares among the keys whose folder is that
 * directory or one above it, the unit always. A unit root, or a folder above one unit only,
 * gives the unit; `src/cli` in the root unit gives
 * `(root)/cli`, since umbrella folders such as src have no key of their own.
 */
export function directoryFolderKey(assignment: UnitAssignment, directory: string): string {
  let shared: string[] | undefined;
  for (const [file, unit] of assignment.unitOf) {
    if (!file.startsWith(`${directory}/`)) continue;
    const keys = folderKeys(file, unit);
    const dirs = file.split("/").slice(0, -1);
    // Folder of each key below the unit: the file's folders down to the last one of the chain.
    const folderOf = (index: number) => dirs.slice(0, dirs.length - keys.length + 1 + index).join("/");
    // The unit always counts: a directory above it (packages/ with one package) draws it too.
    const above = keys.filter((_, index) => {
      const folder = folderOf(index);
      return index === 0 || folder === directory || directory.startsWith(`${folder}/`);
    });
    shared = shared === undefined ? above : shared.filter((key, index) => above[index] === key);
  }
  if (shared === undefined) throw new Error(`No indexed file below "${directory}".`);
  const key = shared.at(-1);
  if (key === undefined) {
    throw new Error(`"${directory}" holds several units: pass the folder of one of them; the units are drawn without a directory (in a narrowed REPL /scope, with --view units).`);
  }
  return key;
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
