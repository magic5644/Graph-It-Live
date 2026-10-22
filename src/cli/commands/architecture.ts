/**
 * CLI Command: architecture
 *
 * Build a complete workspace dependency architecture graph by aggregating
 * direct dependencies for every source file in the workspace.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { buildArchitectureGraph } from "../../analyzer/architecture/ArchitectureGraphBuilder.js";
import { exploreMatrix, exploreUnitEvidence } from "../../analyzer/architecture/ArchitectureExplorer.js";
import { groupMatrix, matrixToCsv, unitMatrix, type ArchitectureMatrix } from "../../analyzer/architecture/architectureMatrix.js";
import { loadDeclaredRoles } from "../../analyzer/architecture/architectureRules.js";
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

/** One level's matrix, every cell (the CLI does not page): csv for spreadsheets, else as explore_architecture view "matrix" reports it. */
function formatMatrix(
  files: object,
  matrix: ArchitectureMatrix,
  context: Parameters<typeof exploreMatrix>[1],
  format: CliOutputFormat,
  level: object,
): string {
  if (format === "csv") return matrixToCsv(matrix);
  const { page: _page, nextSteps: _nextSteps, ...view } = exploreMatrix(matrix, context, { limit: Number.POSITIVE_INFINITY });
  return formatOutput({ ...files, ...level, ...view }, format, "architecture");
}

/** The flags, rejecting the combinations that name no single view. */
function readFlags(args: string[], format: CliOutputFormat) {
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
  const matrix = args.includes("--matrix");
  if (matrix && from !== undefined) {
    throw new CliError("--matrix lists every cell of the level: drop --from and --to", ExitCode.GENERAL_ERROR);
  }
  if (format === "csv" && !matrix) {
    throw new CliError('Format "csv" is only produced by graph-it architecture --matrix.', ExitCode.UNSUPPORTED_FORMAT);
  }
  return { maxFiles: parseMaxFiles(args), communityMode, level, folder, from, to, matrix };
}

export async function run(
  args: string[],
  runtime: CliRuntime,
  format: CliOutputFormat,
): Promise<string> {
  const { maxFiles, communityMode, level, folder, from, to, matrix } = readFlags(args, format);

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
    const units = buildArchitectureUnits(graph, runtime.workspaceRoot, assignment, await loadDeclaredRoles(runtime.workspaceRoot));
    if (matrix) return formatMatrix(files, unitMatrix(units), units.context, format, { level });
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
    if (matrix) {
      return formatMatrix(files, groupMatrix(aggregateCommunityGroups(folderGraph.graphData)), folderGraph.context, format, { folder, nestedGroups });
    }
    return formatOutput(
      { ...files, context: folderGraph.context, folder, nestedGroups, ...aggregateCommunityGroups(folderGraph.graphData) },
      format,
      "architecture",
    );
  }

  if (matrix) {
    // The groups' matrix: its cells are the group edges of --groups, its diagonal their internal pairs.
    const { nodes: _nodes, edges: _edges, ...files } = architecture;
    return formatMatrix(files, groupMatrix(aggregateCommunityGroups(graphData)), context, format, { level: "groups" });
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
