/**
 * CLI Command: architecture
 *
 * Build a complete workspace dependency architecture graph by aggregating
 * direct dependencies for every source file in the workspace.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { buildArchitectureGraph } from "../../analyzer/architecture/ArchitectureGraphBuilder.js";
import { aggregateCommunityGroups } from "../../analyzer/community/groupAggregation.js";
import { workerState } from "../../mcp/shared/state";
import type { CliOutputFormat } from "../formatter";
import { formatOutput } from "../formatter";
import { readCommunityMode, readIntegerOption } from "../options";
import type { CliRuntime } from "../runtime";

function parseMaxFiles(args: string[]): number | undefined {
  return readIntegerOption(args, "--maxFiles", { min: 1 });
}

export async function run(
  args: string[],
  runtime: CliRuntime,
  format: CliOutputFormat,
): Promise<string> {
  const maxFiles = parseMaxFiles(args);
  const communityMode = readCommunityMode(args);

  await runtime.ensureIndexed();

  const { graphData, nodes, edges, scannedFiles, analyzedFiles, failedFiles, context } =
    await buildArchitectureGraph(runtime.workspaceRoot, (filePath) => workerState.getSpider().analyze(filePath), {
      maxFiles,
      communityMode,
      indexedAt: runtime.loadState()?.lastScanTimestamp,
    });

  const architecture = {
    workspaceRoot: runtime.workspaceRoot,
    scannedFiles,
    analyzedFiles,
    skippedFiles: failedFiles.length,
    failedFiles,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes,
    edges,
  };

  if (!args.includes("--groups")) {
    return formatOutput(architecture, format, "architecture");
  }

  // Aggregated from the full graph here, so later display caps never change the counts.
  return formatOutput(
    { ...architecture, context, ...aggregateCommunityGroups(graphData) },
    format,
    "architecture",
  );
}
