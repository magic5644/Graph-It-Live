/**
 * CLI Command: architecture
 *
 * Build a complete workspace dependency architecture graph by aggregating
 * direct dependencies for every source file in the workspace.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { buildArchitectureGraph } from "../../analyzer/architecture/ArchitectureGraphBuilder.js";
import { exploreUnitEvidence } from "../../analyzer/architecture/ArchitectureExplorer.js";
import { assignUnits, buildArchitectureUnits, folderLevel } from "../../analyzer/architecture/architectureUnits.js";
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

/** `<flag> <unit or folder key>` (`--folder`, `--from`, `--to`), or undefined when the flag is absent. */
function readKey(args: string[], flag: string, what: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const key = args[index + 1];
  if (key === undefined || key.startsWith("--") || key.trim() === "") {
    throw new CliError(`${flag} must be ${what}`, ExitCode.GENERAL_ERROR);
  }
  // Keys use "/" on every OS: a Windows user may type app\core.
  return key.replaceAll("\\", "/");
}

export async function run(
  args: string[],
  runtime: CliRuntime,
  format: CliOutputFormat,
): Promise<string> {
  const maxFiles = parseMaxFiles(args);
  const communityMode = readCommunityMode(args);
  const level = readLevel(args);
  const folder = readKey(args, "--folder", "a unit or folder key");
  if (folder !== undefined && (level === "units" || communityMode === "louvain")) {
    throw new CliError("--folder lists one folder level in path mode: drop --level units and --communities louvain", ExitCode.GENERAL_ERROR);
  }
  const from = readKey(args, "--from", "a unit key");
  const to = readKey(args, "--to", "a unit key");
  if ((from === undefined) !== (to === undefined) || (from !== undefined && level !== "units")) {
    throw new CliError("--from and --to name the two units of a unit edge: pass both, with --level units", ExitCode.GENERAL_ERROR);
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
    const assignment = assignUnits(runtime.workspaceRoot, nodes.map((node) => node.relativePath));
    const units = buildArchitectureUnits(graph, runtime.workspaceRoot, assignment);
    if (from !== undefined && to !== undefined) {
      // Every file pair of the unit edge: the CLI does not page.
      const evidence = exploreUnitEvidence(graph, units, assignment.unitOf, { from, to, limit: Number.POSITIVE_INFINITY });
      return formatOutput({ ...files, ...evidence }, format, "architecture");
    }
    return formatOutput({ ...files, ...units }, format, "architecture");
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
