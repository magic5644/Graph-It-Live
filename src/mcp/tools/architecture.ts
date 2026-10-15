/**
 * explore_architecture MCP tool: the analyzer's architecture graph and views,
 * analysed through the MCP/CLI Spider.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { exploreArchitecture } from "../../analyzer/architecture/ArchitectureExplorer";
import { buildArchitectureGraph } from "../../analyzer/architecture/ArchitectureGraphBuilder";
import { workerState } from "../shared/state";
import type { ExploreArchitectureParams } from "../types";

/**
 * Progressive exploration of the grouped architecture: a bounded summary, one group with
 * its boundary, or the file pairs behind one group edge.
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
  return exploreArchitecture(graph, params);
}
