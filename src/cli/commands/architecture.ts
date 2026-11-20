/**
 * CLI Command: architecture
 *
 * Build a complete workspace dependency architecture graph by aggregating
 * direct dependencies for every source file in the workspace.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { buildArchitectureGraph } from "../../analyzer/architecture/ArchitectureGraphBuilder.js";
import { exploreCoupling, exploreMatrix, exploreUnitEvidence } from "../../analyzer/architecture/ArchitectureExplorer.js";
import { architectureCoupling } from "../../analyzer/architecture/architectureCoupling.js";
import { groupLevel, matrixToCsv, unitLevel, type ArchitectureLevel } from "../../analyzer/architecture/architectureMatrix.js";
import { folderLevel } from "../../analyzer/architecture/architectureUnits.js";
import { loadWorkspaceUnits } from "../../analyzer/architecture/workspaceUnits.js";
import { aggregateCommunityGroups } from "../../analyzer/community/groupAggregation.js";
import { CliError, ExitCode } from "../errors";
import { workerState } from "../../mcp/shared/state";
import type { CliOutputFormat } from "../formatter";
import { formatOutput } from "../formatter";
import { couplingView, evidenceView, folderView, matrixView, renderArchitectureView, unitsView, type ArchitectureView } from "./architectureTables";
import { readChoiceOption, readCommunityMode, readIntegerOption, readStringOption } from "../options";
import type { CliRuntime } from "../runtime";

function parseMaxFiles(args: string[]): number | undefined {
  return readIntegerOption(args, "--maxFiles", { min: 1 });
}

const LEVELS = ["groups", "units"] as const;

/** `--level groups|units` (groups = `--groups`), or undefined when the flag is absent. */
function readLevel(args: string[]): (typeof LEVELS)[number] | undefined {
  return readChoiceOption(args, "--level", LEVELS);
}

/** `<flag> <unit or folder key>` (`--folder`, `--from`, `--to`), or undefined when the flag is absent. */
function readKey(args: string[], flag: string, what: string): string | undefined {
  // Keys use "/" on every OS: a Windows user may type app\core.
  return readStringOption(args, flag, what)?.replaceAll("\\", "/");
}

/** A view's tables for text and markdown; json and toon carry `data`, the view's full result. */
function formatView(view: () => ArchitectureView, data: object, format: CliOutputFormat): string {
  return format === "text" || format === "markdown" ? renderArchitectureView(view(), format) : formatOutput(data, format, "architecture");
}

/** The views of a whole level: `--matrix` and `--coupling`. */
const LEVEL_VIEWS = ["matrix", "coupling"] as const;
type LevelView = (typeof LEVEL_VIEWS)[number];

/**
 * One level's matrix or coupling, every item (the CLI does not page): csv for the matrix in a
 * spreadsheet, else as explore_architecture view "matrix" or "coupling" reports it.
 */
function formatLevel(
  files: object,
  { matrix, context, edges, rowOf }: ArchitectureLevel,
  view: LevelView,
  format: CliOutputFormat,
  level: { level?: string; folder?: string; nestedGroups?: number[] },
): string {
  if (format === "csv") return matrixToCsv(matrix);
  const name = level.folder ?? level.level ?? "groups";
  const tables = format === "text" || format === "markdown";
  const all = { limit: Number.POSITIVE_INFINITY };
  if (view === "coupling") {
    const coupling = architectureCoupling(matrix.rows, edges, rowOf);
    if (tables) return renderArchitectureView(couplingView(name, coupling), format);
    const { page: _page, nextSteps: _nextSteps, ...data } = exploreCoupling(coupling, context, all);
    return formatOutput({ ...files, ...level, ...data }, format, "architecture");
  }
  if (tables) return renderArchitectureView(matrixView(name, matrix), format);
  const { page: _page, nextSteps: _nextSteps, ...data } = exploreMatrix(matrix, context, all);
  return formatOutput({ ...files, ...level, ...data }, format, "architecture");
}

/** `--matrix` or `--coupling`: one view of the whole level, so never with an edge's `--from`. */
function readView(args: string[], from: string | undefined): LevelView | undefined {
  const views = LEVEL_VIEWS.filter((name) => args.includes(`--${name}`));
  if (views.length > 1) throw new CliError("--matrix and --coupling are two views of the level: pass one", ExitCode.GENERAL_ERROR);
  if (views.length === 1 && from !== undefined) {
    throw new CliError(`--${views[0]} covers the whole level: drop --from and --to`, ExitCode.GENERAL_ERROR);
  }
  return views[0];
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
  const view = readView(args, from);
  if (args.includes("--groups") && (level === "units" || folder !== undefined)) {
    throw new CliError("--groups is the folder groups of the workspace: drop it with --level units or --folder", ExitCode.GENERAL_ERROR);
  }
  if (format === "csv" && view !== "matrix") {
    throw new CliError('Format "csv" is only produced by graph-it architecture --matrix.', ExitCode.UNSUPPORTED_FORMAT);
  }
  const tableView = view !== undefined || level === "units" || folder !== undefined;
  if (format === "mermaid" && tableView) {
    throw new CliError(
      "--format mermaid draws the file graph or --groups; --matrix, --coupling, --level units and --folder write text, markdown, json or toon (and csv with --matrix).",
      ExitCode.UNSUPPORTED_FORMAT,
    );
  }
  return { maxFiles: parseMaxFiles(args), communityMode, level, folder, from, to, view };
}

export async function run(
  args: string[],
  runtime: CliRuntime,
  format: CliOutputFormat,
): Promise<string> {
  const { maxFiles, communityMode, level, folder, from, to, view } = readFlags(args, format);

  await runtime.ensureIndexed();

  const graph = await runtime.progress.phase("Analyzing architecture", (onProgress) =>
    buildArchitectureGraph(runtime.workspaceRoot, (filePath) => workerState.getSpider().analyzeFromIndex(filePath), {
      maxFiles,
      communityMode,
      indexedAt: runtime.loadState()?.lastScanTimestamp,
      onProgress,
    }));
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
    const { units, assignment } = await loadWorkspaceUnits(graph, runtime.workspaceRoot);
    if (view) return formatLevel(files, unitLevel(graph, units, assignment.unitOf), view, format, { level });
    if (from !== undefined && to !== undefined) {
      // Every file pair of the unit edge: the CLI does not page.
      const evidence = exploreUnitEvidence(graph, units, assignment.unitOf, { from, to, limit: Number.POSITIVE_INFINITY });
      return formatView(() => evidenceView(evidence), { ...files, ...evidence }, format);
    }
    return formatView(() => unitsView(units), { ...files, ...units }, format);
  }

  if (folder !== undefined) {
    // The level the view draws below this unit or folder: its sub-folders, then its own files.
    const { graph: folderGraph, nestedGroups } = folderLevel(await loadWorkspaceUnits(graph, runtime.workspaceRoot), folder);
    const { nodes: _nodes, edges: _edges, ...files } = architecture;
    if (view) return formatLevel(files, groupLevel(folderGraph), view, format, { folder, nestedGroups });
    const groups = aggregateCommunityGroups(folderGraph.graphData);
    return formatView(() => folderView(folder, nestedGroups, groups), { ...files, context: folderGraph.context, folder, nestedGroups, ...groups }, format);
  }

  if (view) {
    // The groups' matrix: its cells are the group edges of --groups, its diagonal their internal pairs.
    const { nodes: _nodes, edges: _edges, ...files } = architecture;
    return formatLevel(files, groupLevel(graph), view, format, { level: "groups" });
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
