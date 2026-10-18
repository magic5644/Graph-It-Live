/**
 * explore_architecture MCP tool: the analyzer's architecture graph and views,
 * analysed through the MCP/CLI Spider.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { exploreArchitecture, exploreUnitEvidence, exploreUnits } from "../../analyzer/architecture/ArchitectureExplorer";
import { buildArchitectureGraph } from "../../analyzer/architecture/ArchitectureGraphBuilder";
import { assignUnits, buildArchitectureUnits, folderLevel } from "../../analyzer/architecture/architectureUnits";
import { workerState } from "../shared/state";
import type { ExploreArchitectureParams } from "../types";

/**
 * Progressive exploration of the grouped architecture: a bounded summary, one group with
 * its boundary, the file pairs behind one group edge, the units with their layers or the file
 * pairs behind one unit edge; with `folder`, the same views one level below a unit or folder.
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
    const units = buildArchitectureUnits(graph, rootDir, assignment);
    if (params.from === undefined || params.to === undefined) return exploreUnits(units, params);
    return exploreUnitEvidence(graph, units, assignment.unitOf, { ...params, from: String(params.from), to: String(params.to) });
  }
  if (params.folder !== undefined) {
    const { graph: level, nestedGroups } = folderLevel(graph, workerState.getConfig().rootDir, params.folder);
    return { folder: params.folder, nestedGroups, ...exploreArchitecture(level, params) };
  }
  return exploreArchitecture(graph, params);
}
