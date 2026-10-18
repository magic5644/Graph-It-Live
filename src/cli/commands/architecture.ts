/**
 * CLI Command: architecture
 *
 * Build a complete workspace dependency architecture graph by aggregating
 * direct dependencies for every source file in the workspace.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { buildArchitectureGraph } from "../../analyzer/architecture/ArchitectureGraphBuilder.js";
import { buildArchitectureUnits, folderLevel } from "../../analyzer/architecture/architectureUnits.js";
import { aggregateCommunityGroups } from "../../analyzer/community/groupAggregation.js";
import { CliError, ExitCode } from "../errors";
import { workerState } from "../../mcp/shared/state";
import type { CliOutputFormat } from "../formatter";
import { formatOutput } from "../formatter";
import { readCommunityMode, readIntegerOption } from "../options";
import type { CliRuntime } from "../runtime";

function parseMaxFiles(args: string[]): number | undefined {
  return readIntegerOption(args, "--maxFiles", { min: 1 });
}

const LEVELS = ["groups", "units"] as const;

/** `--level groups|units` (groups = `--groups`), or undefined when the flag is absent. */
function readLevel(args: string[]): (typeof LEVELS)[number] | undefined {
  const index = args.indexOf("--level");
  if (index < 0) return undefined;
  const level = LEVELS.find((candidate) => candidate === args[index + 1]);
  if (!level) throw new CliError(`--level must be ${LEVELS.join(" or ")}`, ExitCode.GENERAL_ERROR);
  return level;
}

/** `--folder <unit or folder key>`, or undefined when the flag is absent. */
function readFolder(args: string[]): string | undefined {
  const index = args.indexOf("--folder");
  if (index < 0) return undefined;
  const folder = args[index + 1];
  if (folder === undefined || folder.startsWith("--") || folder.trim() === "") {
    throw new CliError("--folder must be a unit or folder key", ExitCode.GENERAL_ERROR);
  }
  // Keys use "/" on every OS: a Windows user may type app\core.
  return folder.replaceAll("\\", "/");
}

export async function run(
  args: string[],
  runtime: CliRuntime,
  format: CliOutputFormat,
): Promise<string> {
  const maxFiles = parseMaxFiles(args);
  const communityMode = readCommunityMode(args);
  const level = readLevel(args);
  const folder = readFolder(args);
  if (folder !== undefined && (level === "units" || communityMode === "louvain")) {
    throw new CliError("--folder lists one folder level in path mode: drop --level units and --communities louvain", ExitCode.GENERAL_ERROR);
  }

  await runtime.ensureIndexed();

  const graph = await buildArchitectureGraph(runtime.workspaceRoot, (filePath) => workerState.getSpider().analyze(filePath), {
      maxFiles,
      communityMode,
      indexedAt: runtime.loadState()?.lastScanTimestamp,
    });
  const { graphData, nodes, edges, scannedFiles, analyzedFiles, failedFiles, context } = graph;

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

  if (level === "units") {
    // Units replace the file graph: the units, layers and unit edges the view draws.
    const { nodes: _nodes, edges: _edges, ...files } = architecture;
    return formatOutput({ ...files, ...buildArchitectureUnits(graph, runtime.workspaceRoot) }, format, "architecture");
  }

  if (folder !== undefined) {
    // The level the view draws below this unit or folder: its sub-folders, then its own files.
    const { graph: folderGraph, nestedGroups } = folderLevel(graph, runtime.workspaceRoot, folder);
    const { nodes: _nodes, edges: _edges, ...files } = architecture;
    return formatOutput(
      { ...files, context: folderGraph.context, folder, nestedGroups, ...aggregateCommunityGroups(folderGraph.graphData) },
      format,
      "architecture",
    );
  }

  if (!args.includes("--groups") && level !== "groups") {
    return formatOutput(architecture, format, "architecture");
  }

  // Aggregated from the full graph here, so later display caps never change the counts.
  return formatOutput(
    { ...architecture, context, ...aggregateCommunityGroups(graphData) },
    format,
    "architecture",
  );
}
