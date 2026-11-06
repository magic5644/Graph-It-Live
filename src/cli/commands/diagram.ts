/**
 * CLI Command: diagram
 *
 * Writes a static architecture diagram of the workspace (the units, the groups of one unit or
 * folder, or their dependency matrix) as a bare SVG or one self-contained HTML page, optionally
 * with the violations of graphit.architecture.json drawn in the error colour; or its data as a
 * diagram spec (JSON) for an agent diagram skill.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ARCHITECTURE_BASELINE_FILE } from "../../analyzer/architecture/architectureRules.js";
import { DIAGRAM_THEMES, DIAGRAM_VIEWS, defaultDiagramFile, diagramLevel } from "../../analyzer/diagram/diagramStyle.js";
import { renderWorkspaceDiagram, type WorkspaceDiagramOptions } from "../../analyzer/diagram/workspaceDiagram.js";
import { workerState } from "../../mcp/shared/state";
import { getRelativePath, normalizePath } from "../../shared/path";
import { validateWorkspacePath } from "../../shared/pathSecurity";
import { CliError, ExitCode } from "../errors";
import type { CliOutputFormat } from "../formatter";
import { readStringOption } from "../options";
import type { CliRuntime } from "../runtime";

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

/** svg, html or diagram-spec, and the output file; without `--format`, an `--output` ending in .svg writes SVG. */
function readOutput(args: string[], format: CliOutputFormat) {
  if (format !== "text" && format !== "html" && format !== "svg" && format !== "diagram-spec") {
    throw new CliError(`graph-it diagram writes --format svg, html or diagram-spec, not "${format}".`, ExitCode.UNSUPPORTED_FORMAT);
  }
  const file = readStringOption(args, "--output", "a file of the workspace, or - for stdout");
  const svg = format === "svg" || (format === "text" && file?.toLowerCase().endsWith(".svg") === true);
  let output: WorkspaceDiagramOptions["format"] = svg ? "svg" : "html";
  if (format === "diagram-spec") output = format;
  return { format: output, file: file ?? defaultDiagramFile(output) };
}

/** The view and its folder key (or directory), rejecting the pairs that name no single level. */
function readView(args: string[], directory: string | undefined) {
  const key = readStringOption(args, "--folder", "a unit or folder key");
  if (key !== undefined && directory !== undefined) {
    throw new CliError("Pass a directory or --folder <key>, not both", ExitCode.GENERAL_ERROR);
  }
  const { view, folder } = diagramLevel(readChoice(args, "--view", DIAGRAM_VIEWS), key ?? directory);
  if (view === "folder" && folder === undefined) {
    throw new CliError("--view folder draws the groups of one unit or folder: pass a directory or --folder <key>", ExitCode.GENERAL_ERROR);
  }
  if (view === "units" && folder !== undefined) {
    throw new CliError("--view units draws every unit: drop the directory or --folder, or use --view folder", ExitCode.GENERAL_ERROR);
  }
  return directory === undefined ? { view, folder } : { view, directory: folder };
}

/**
 * The workspace-relative directory of the leading positional argument (`\` accepted), or undefined
 * without one or for the workspace root. Missing, outside the workspace or not a directory: refused.
 */
export function readDirectory(args: string[], workspaceRoot: string): string | undefined {
  const arg = args[0];
  if (arg === undefined || arg.startsWith("-")) return undefined;
  const absolute = path.resolve(workspaceRoot, arg.replaceAll("\\", "/"));
  try {
    validateWorkspacePath(absolute, workspaceRoot);
  } catch {
    throw new CliError(`Directory outside the workspace: ${arg}`, ExitCode.SECURITY_VIOLATION);
  }
  if (!fs.statSync(absolute, { throwIfNoEntry: false })?.isDirectory()) {
    throw new CliError(`Directory not found: ${arg}`, ExitCode.GENERAL_ERROR);
  }
  return normalizePath(path.relative(workspaceRoot, absolute)) || undefined;
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
export function readDiagramOptions(args: string[], format: CliOutputFormat, directory?: string) {
  const output = readOutput(args, format);
  const theme = readChoice(args, "--theme", DIAGRAM_THEMES);
  if (theme !== undefined && output.format !== "svg") {
    throw new CliError("--theme sets the colours of --format svg; the HTML page follows the reader's light or dark scheme and a spec has none", ExitCode.GENERAL_ERROR);
  }
  return { ...readView(args, directory), theme: theme ?? "light", ...output, rules: readRules(args) };
}

export async function run(args: string[], runtime: CliRuntime, format: CliOutputFormat): Promise<string> {
  const { workspaceRoot } = runtime;
  const options = readDiagramOptions(args, format, readDirectory(args, workspaceRoot));
  // Refused before any work: the output stays in the workspace, as --config does.
  const target = options.file === "-" ? undefined : validateWorkspacePath(path.resolve(workspaceRoot, options.file), workspaceRoot);

  await runtime.ensureIndexed();
  const { markup, counts } = await renderWorkspaceDiagram(workspaceRoot, (filePath) => workerState.getSpider().analyze(filePath), {
    ...options,
    indexedAt: runtime.loadState()?.lastScanTimestamp,
  });

  if (target === undefined) return markup;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, markup);
  return `Diagram written to ${getRelativePath(target, workspaceRoot)}: ${counts}.`;
}
