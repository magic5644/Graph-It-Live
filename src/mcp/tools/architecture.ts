/**
 * explore_architecture MCP tool: the analyzer's architecture graph and views,
 * analysed through the MCP/CLI Spider.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import * as fs from "node:fs";
import * as nodePath from "node:path";
import { exploreArchitecture, exploreArchitectureCheck, exploreMatrix, exploreUnitEvidence, exploreUnits } from "../../analyzer/architecture/ArchitectureExplorer";
import { buildArchitectureGraph, type AnalyzeFile } from "../../analyzer/architecture/ArchitectureGraphBuilder";
import { groupMatrix, unitMatrix } from "../../analyzer/architecture/architectureMatrix";
import { checkWorkspaceArchitecture, loadDeclaredRoles } from "../../analyzer/architecture/architectureRules";
import { assignUnits, buildArchitectureUnits, folderLevel } from "../../analyzer/architecture/architectureUnits";
import { aggregateCommunityGroups } from "../../analyzer/community/groupAggregation";
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
 * with `view: "matrix"`, the level's dependency structure matrix.
 */
export async function executeExploreArchitecture(
  params: ExploreArchitectureParams,
  signal?: AbortSignal,
) {
  // ponytail: rebuilds the graph on every call (Spider caches each file's analysis); cache by index revision if paging gets slow.
  const graph = await buildArchitectureGraph(
    workerState.getConfig().rootDir,
    (filePath) => workerState.getSpider().analyze(filePath),
    { maxFiles: params.maxFiles, communityMode: params.communityMode, signal },
  );
  if (params.level === "units") {
    const { rootDir } = workerState.getConfig();
    const assignment = assignUnits(rootDir, graph.nodes.map((node) => node.relativePath));
    const units = buildArchitectureUnits(graph, rootDir, assignment, await loadDeclaredRoles(rootDir));
    if (params.view === "matrix") return exploreMatrix(unitMatrix(units), units.context, { ...params, units: true });
    if (params.from === undefined || params.to === undefined) return exploreUnits(units, params);
    return exploreUnitEvidence(graph, units, assignment.unitOf, { ...params, from: String(params.from), to: String(params.to) });
  }
  if (params.folder !== undefined) {
    const { graph: level, nestedGroups } = folderLevel(graph, workerState.getConfig().rootDir, params.folder);
    if (params.view === "matrix") {
      return { folder: params.folder, nestedGroups, ...exploreMatrix(groupMatrix(aggregateCommunityGroups(level.graphData)), level.context, params) };
    }
    return { folder: params.folder, nestedGroups, ...exploreArchitecture(level, params) };
  }
  if (params.view === "matrix") return exploreMatrix(groupMatrix(aggregateCommunityGroups(graph.graphData)), graph.context, params);
  return exploreArchitecture(graph, params);
}

/** The declared architecture rules checked against every import pair, violations paged. */
export async function executeCheckArchitecture(params: CheckArchitectureParams, signal?: AbortSignal) {
  const { rootDir } = workerState.getConfig();
  const graph = await buildArchitectureGraph(rootDir, (filePath) => workerState.getSpider().analyze(filePath), { signal });
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
    (filePath) => workerState.getSpider().analyze(filePath),
    params,
    signal,
  );
}
