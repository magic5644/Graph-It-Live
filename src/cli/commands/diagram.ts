/**
 * CLI Command: diagram
 *
 * Writes a static architecture diagram of the workspace (the units, the groups of one unit or
 * folder, or their dependency matrix) as a bare SVG or one self-contained HTML page, optionally
 * with the violations of graphit.architecture.json drawn in the error colour.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { buildArchitectureGraph } from "../../analyzer/architecture/ArchitectureGraphBuilder.js";
import {
  ARCHITECTURE_BASELINE_FILE,
  checkWorkspaceArchitecture,
  loadDeclaredRoles,
} from "../../analyzer/architecture/architectureRules.js";
import { assignUnits, buildArchitectureUnits } from "../../analyzer/architecture/architectureUnits.js";
import { architectureDiagramInput, layoutDiagram } from "../../analyzer/diagram/architectureDiagram.js";
import { layoutMatrix } from "../../analyzer/diagram/diagramMatrix.js";
import { renderDiagramHtml, renderDiagramSvg } from "../../analyzer/diagram/diagramSvg.js";
import { workerState } from "../../mcp/shared/state";
import { getRelativePath } from "../../shared/path";
import { validateWorkspacePath } from "../../shared/pathSecurity";
import { CliError, ExitCode } from "../errors";
import type { CliOutputFormat } from "../formatter";
import { readStringOption } from "../options";
import type { CliRuntime } from "../runtime";

const VIEWS = ["units", "folder", "matrix"] as const;
const THEMES = ["light", "dark"] as const;

/** `<flag>` alone (true) or `<flag> <file>`, or undefined when the flag is absent. */
function readOptionalFile(args: string[], flag: string): string | true | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args.at(index + 1);
  return value === undefined || value.startsWith("--") || value.trim() === "" ? true : value;
}

function readChoice<T extends string>(args: string[], flag: string, choices: readonly T[]): T | undefined {
  const value = readStringOption(args, flag, choices.join(" or "));
  if (value === undefined) return undefined;
  const choice = choices.find((candidate) => candidate === value);
  if (!choice) throw new CliError(`${flag} must be ${choices.join(" or ")}`, ExitCode.GENERAL_ERROR);
  return choice;
}

/** svg or html, and the output file; without `--format`, an `--output` ending in .svg writes SVG. */
function readOutput(args: string[], format: CliOutputFormat) {
  if (format !== "text" && format !== "html" && format !== "svg") {
    throw new CliError(`graph-it diagram writes --format svg or html, not "${format}".`, ExitCode.UNSUPPORTED_FORMAT);
  }
  const file = readStringOption(args, "--output", "a file of the workspace, or - for stdout");
  const svg = format === "svg" || (format === "text" && file?.toLowerCase().endsWith(".svg") === true);
  const output = svg ? "svg" : "html";
  return { format: output, file: file ?? `architecture.${output}` };
}

/** The view and its folder key, rejecting the pairs that name no single level. */
function readView(args: string[]) {
  // Keys use "/" on every OS: a Windows user may type app\core.
  const folder = readStringOption(args, "--folder", "a unit or folder key")?.replaceAll("\\", "/");
  const view = readChoice(args, "--view", VIEWS) ?? (folder === undefined ? "units" : "folder");
  if (view === "folder" && folder === undefined) {
    throw new CliError("--view folder draws the groups of one unit or folder: pass --folder <key>", ExitCode.GENERAL_ERROR);
  }
  if (view === "units" && folder !== undefined) {
    throw new CliError("--view units draws every unit: drop --folder, or use --view folder", ExitCode.GENERAL_ERROR);
  }
  return { view, folder };
}

/** The rules files of `--rules`, or undefined without it; a bare `--baseline` names the default file, which must exist. */
function readRules(args: string[]) {
  const rules = args.includes("--rules");
  const config = readStringOption(args, "--config", "a file of the workspace");
  const baseline = readOptionalFile(args, "--baseline");
  if (!rules) {
    if (config !== undefined || baseline !== undefined) {
      throw new CliError("--config and --baseline apply to the rules overlay: add --rules", ExitCode.GENERAL_ERROR);
    }
    return undefined;
  }
  if (baseline === undefined) return { config, baseline: false as const };
  return { config, baseline: baseline === true ? ARCHITECTURE_BASELINE_FILE : baseline };
}

/** The flags, rejecting the combinations that name no single diagram. */
export function readDiagramOptions(args: string[], format: CliOutputFormat) {
  const output = readOutput(args, format);
  const theme = readChoice(args, "--theme", THEMES);
  if (theme !== undefined && output.format === "html") {
    throw new CliError("--theme sets the colours of --format svg; the HTML page follows the reader's light or dark scheme", ExitCode.GENERAL_ERROR);
  }
  return { ...readView(args), theme: theme ?? "light", ...output, rules: readRules(args) };
}

export async function run(args: string[], runtime: CliRuntime, format: CliOutputFormat): Promise<string> {
  const options = readDiagramOptions(args, format);
  const { workspaceRoot } = runtime;
  // Refused before any work: the output stays in the workspace, as --config does.
  const target = options.file === "-" ? undefined : validateWorkspacePath(path.resolve(workspaceRoot, options.file), workspaceRoot);

  await runtime.ensureIndexed();
  const graph = await buildArchitectureGraph(workspaceRoot, (filePath) => workerState.getSpider().analyze(filePath), {
    communityMode: "path",
    indexedAt: runtime.loadState()?.lastScanTimestamp,
  });
  const assignment = assignUnits(workspaceRoot, graph.nodes.map((node) => node.relativePath));
  const source = { graph, units: buildArchitectureUnits(graph, workspaceRoot, assignment, await loadDeclaredRoles(workspaceRoot)), assignment };
  const violations = options.rules ? (await checkWorkspaceArchitecture(graph, workspaceRoot, options.rules)).violations : [];
  const input = architectureDiagramInput(source, workspaceRoot, { folder: options.folder, violations });
  const layout = options.view === "matrix" ? layoutMatrix(input) : await layoutDiagram(input);
  const markup = options.format === "svg" ? renderDiagramSvg(layout, options.theme) : renderDiagramHtml(layout);

  if (target === undefined) return markup;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, markup);
  return `Diagram written to ${getRelativePath(target, workspaceRoot)}: ${layout.text.counts}.`;
}
