/**
 * explore_architecture MCP tool: the analyzer's architecture graph and views,
 * analysed through the MCP/CLI Spider.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import * as fs from "node:fs";
import * as nodePath from "node:path";
import { exploreArchitecture, exploreArchitectureCheck, exploreCoupling, exploreMatrix, exploreUnitEvidence, exploreUnits } from "../../analyzer/architecture/ArchitectureExplorer";
import { buildArchitectureGraph, type AnalyzeFile } from "../../analyzer/architecture/ArchitectureGraphBuilder";
import { architectureCoupling } from "../../analyzer/architecture/architectureCoupling";
import { groupLevel, unitLevel, type ArchitectureLevel } from "../../analyzer/architecture/architectureMatrix";
import { checkWorkspaceArchitecture } from "../../analyzer/architecture/architectureRules";
import { folderLevel } from "../../analyzer/architecture/architectureUnits";
import { loadWorkspaceUnits } from "../../analyzer/architecture/workspaceUnits";
import { defaultDiagramFile, diagramLevel } from "../../analyzer/diagram/diagramStyle";
import { renderWorkspaceDiagram } from "../../analyzer/diagram/workspaceDiagram";
import { getRelativePath } from "../../shared/path";
import { validateWorkspacePath } from "../../shared/pathSecurity";
import { workerState } from "../shared/state";
import type { CheckArchitectureParams, ExploreArchitectureParams, ExportArchitectureDiagramParams } from "../types";

/**
 * Progressive exploration of the grouped architecture: a bounded summary, one group with
 * its boundary, the file pairs behind one group edge, the units with their layers or the file
 * pairs behind one unit edge; with `folder`, the same views one level below a unit or folder;
 * with `view: "matrix"`, the level's dependency structure matrix; with `view: "coupling"`, its most
 * coupled pairs and bridging files.
 */
export async function executeExploreArchitecture(
  params: ExploreArchitectureParams,
  signal?: AbortSignal,
) {
  // ponytail: rebuilds the graph on every call (Spider caches each file's analysis); cache by index revision if paging gets slow.
  const graph = await buildArchitectureGraph(
    workerState.getConfig().rootDir,
    (filePath) => workerState.getSpider().analyzeFromIndex(filePath),
    { maxFiles: params.maxFiles, communityMode: params.communityMode, signal },
  );
  const { rootDir } = workerState.getConfig();
  if (params.level === "units") {
    const { units, assignment } = await loadWorkspaceUnits(graph, rootDir);
    if (params.view !== undefined) return exploreLevel(unitLevel(graph, units, assignment.unitOf), params.view, { ...params, units: true });
    if (params.from !== undefined && params.to !== undefined) {
      return exploreUnitEvidence(graph, units, assignment.unitOf, { ...params, from: String(params.from), to: String(params.to) });
    }
    // Where the units come from and the config's verdicts, as graph-it architecture --level units --format json reports them.
    const { unitsFrom, configFile, baselineFile, configWarnings, rules } = units;
    return { ...exploreUnits(units, params), unitsFrom, configFile, baselineFile, configWarnings, rules };
  }
  if (params.folder !== undefined) {
    const { graph: level, nestedGroups } = folderLevel(await loadWorkspaceUnits(graph, rootDir), params.folder);
    if (params.view !== undefined) return { folder: params.folder, nestedGroups, ...exploreLevel(groupLevel(level), params.view, params) };
    return { folder: params.folder, nestedGroups, ...exploreArchitecture(level, params) };
  }
  if (params.view !== undefined) return exploreLevel(groupLevel(graph), params.view, params);
  return exploreArchitecture(graph, params);
}

/** The matrix or coupling view of one level (units, a folder's groups or the groups), paged. */
function exploreLevel(
  level: ArchitectureLevel,
  view: NonNullable<ExploreArchitectureParams["view"]>,
  options: Parameters<typeof exploreMatrix>[2],
) {
  return view === "matrix"
    ? exploreMatrix(level.matrix, level.context, options)
    : exploreCoupling(architectureCoupling(level.matrix.rows, level.edges, level.rowOf), level.context, options);
}

/** The declared architecture rules checked against every import pair, violations paged. */
export async function executeCheckArchitecture(params: CheckArchitectureParams, signal?: AbortSignal) {
  const { rootDir } = workerState.getConfig();
  const graph = await buildArchitectureGraph(rootDir, (filePath) => workerState.getSpider().analyzeFromIndex(filePath), { signal });
  const check = await checkWorkspaceArchitecture(graph, rootDir, { config: params.config, baseline: params.baseline });
  return exploreArchitectureCheck(check, params);
}

/** Markup returned inline up to this many characters (about 15k tokens); a larger diagram is written to a file. */
export const INLINE_DIAGRAM_MAX_CHARS = 60_000;

/**
 * The static architecture diagram, inline when it fits the cap and no output is asked for, else
 * written under the workspace and returned as a workspace-relative path. Shared by the MCP tool
 * and its VS Code language model tool.
 */
export async function exportArchitectureDiagram(
  rootDir: string,
  analyze: AnalyzeFile,
  params: ExportArchitectureDiagramParams,
  signal?: AbortSignal,
) {
  const format = params.diagramFormat ?? "svg";
  // Refused before any work (CWE-22): the output stays in the workspace, as the rules files do.
  // The raw value, so a refusal names the given path and not the workspace's absolute location.
  const target = params.output === undefined ? undefined : validateWorkspacePath(params.output, rootDir);
  const { markup, counts } = await renderWorkspaceDiagram(rootDir, analyze, {
    ...diagramLevel(params.view, params.folder),
    format,
    theme: params.theme ?? "light",
    rules: params.rules ? { config: params.config, baseline: params.baseline } : undefined,
    // The analyses are current at the call (the watchers keep them so): date the diagram today.
    indexedAt: new Date().toISOString(),
    signal,
  });
  if (target === undefined && markup.length <= INLINE_DIAGRAM_MAX_CHARS) return { format, counts, markup };

  // Validated too: a symbolic link at the default name must not lead outside the workspace.
  const file = target ?? validateWorkspacePath(defaultDiagramFile(format), rootDir);
  await fs.promises.mkdir(nodePath.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, markup);
  return { format, counts, path: getRelativePath(file, rootDir), characters: markup.length };
}

export function executeExportArchitectureDiagram(params: ExportArchitectureDiagramParams, signal?: AbortSignal) {
  return exportArchitectureDiagram(
    workerState.getConfig().rootDir,
    (filePath) => workerState.getSpider().analyzeFromIndex(filePath),
    params,
    signal,
  );
}
