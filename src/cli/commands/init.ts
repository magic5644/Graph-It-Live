/**
 * CLI Command: init
 *
 * Generates graphit.architecture.json from the code as it is today (one element and one
 * allowOnly rule per unit, noCycles over the acyclic units, every current violation in the
 * baseline), so that `graph-it check-architecture` only fails on new drift. An existing config
 * or baseline is never overwritten without a confirmation. Then prints the guard snippets, the
 * quick wins and the reading of the dependency matrix, with diagrams under `--output <dir>` (#664).
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { buildArchitectureGraph } from "../../analyzer/architecture/ArchitectureGraphBuilder.js";
import { assessArchitecture, type ArchitectureAssessment } from "../../analyzer/architecture/architectureAssessment.js";
import { elementName, describeConfigChanges, generateArchitectureConfig } from "../../analyzer/architecture/architectureInit.js";
import { unitMatrix } from "../../analyzer/architecture/architectureMatrix.js";
import {
  acceptAllViolations,
  ARCHITECTURE_BASELINE_FILE,
  ARCHITECTURE_CONFIG_FILE,
  checkGraphArchitecture,
  formatBaseline,
  MAX_BASELINE_BYTES,
  MAX_CONFIG_BYTES,
  parseArchitectureConfig,
  parseBaseline,
  readWorkspaceFile,
  type ArchitectureCheck,
} from "../../analyzer/architecture/architectureRules.js";
import { assignUnits, buildArchitectureUnits } from "../../analyzer/architecture/architectureUnits.js";
import type { UnitSource } from "../../analyzer/architecture/architectureView.js";
import { renderSourceDiagram } from "../../analyzer/diagram/workspaceDiagram.js";
import { executeScanDeadCode } from "../../mcp/tools";
import { workerState } from "../../mcp/shared/state";
import { normalizePath } from "../../shared/path";
import { validateWorkspacePath } from "../../shared/pathSecurity";
import { CliError, ExitCode } from "../errors";
import type { CliOutputFormat } from "../formatter";
import { formatOutput } from "../formatter";
import { readStringOption } from "../options";
import type { CliRuntime } from "../runtime";
import { writeBackup, writeWorkspaceFile } from "../workspaceFiles";
import { renderInitMarkdown, renderInitText, type InitDiagram, type InitResult, type InitStatus } from "./initReport";

/** The commands that keep the guard on, printed as they are (checked against `check-architecture --help`). */
export const GUARD_SNIPPETS = {
  preCommit: "graph-it check-architecture",
  ci: "- run: npx @magic5644/graph-it-live check-architecture",
  sarif: [
    "- run: npx @magic5644/graph-it-live check-architecture --format sarif > architecture.sarif",
    "- uses: github/codeql-action/upload-sarif@v3",
    "  if: always()",
    "  with:",
    "    sarif_file: architecture.sarif",
  ].join("\n"),
} as const;

/** The terminal, replaced in tests. */
export interface InitIo {
  /** A person can answer a question: stdin and stderr are terminals. */
  interactive: boolean;
  /** Shows `changes` and asks to overwrite; false unless the answer is yes. */
  confirm(changes: readonly string[]): Promise<boolean>;
}

const terminalIo: InitIo = {
  interactive: process.stdin.isTTY === true && process.stderr.isTTY === true,
  async confirm(changes) {
    process.stderr.write(`${changes.join("\n")}\n`);
    const prompt = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      return /^y(es)?$/i.test((await prompt.question(`Overwrite ${ARCHITECTURE_CONFIG_FILE} and its baseline (copies kept as *.bak)? [y/N] `)).trim());
    } finally {
      prompt.close();
    }
  },
};

const FORMATS: readonly CliOutputFormat[] = ["text", "markdown", "json", "toon"];
/** Folder diagrams drawn for the units the findings rank first. */
const MAX_FOLDER_DIAGRAMS = 3;

/** `--output` as a workspace-relative `/` path ("." for the root), refused outside the workspace before any work. */
function readOutputDir(workspaceRoot: string, output: string): string {
  let absolute: string;
  try {
    absolute = validateWorkspacePath(path.resolve(workspaceRoot, output), workspaceRoot);
  } catch {
    throw new CliError(`--output must be a directory inside the workspace: ${output}`, ExitCode.SECURITY_VIOLATION);
  }
  if (fs.statSync(absolute, { throwIfNoEntry: false })?.isDirectory() === false) {
    throw new CliError(`--output must be a directory, not a file: ${output}`, ExitCode.GENERAL_ERROR);
  }
  return normalizePath(path.relative(workspaceRoot, absolute)) || ".";
}

function readFlags(args: string[], format: CliOutputFormat) {
  if (!FORMATS.includes(format)) {
    throw new CliError(`graph-it init prints --format ${FORMATS.join(", ")}, not "${format}".`, ExitCode.UNSUPPORTED_FORMAT);
  }
  const output = readStringOption(args, "--output", "a directory of the workspace")?.replaceAll("\\", "/");
  return { yes: args.includes("--yes"), dryRun: args.includes("--dry-run"), output };
}

/** The current config and baseline, or undefined where a file does not exist; an invalid one is an error. */
async function readCurrentFiles(workspaceRoot: string) {
  const configText = await readWorkspaceFile(workspaceRoot, ARCHITECTURE_CONFIG_FILE, MAX_CONFIG_BYTES);
  const baselineText = await readWorkspaceFile(workspaceRoot, ARCHITECTURE_BASELINE_FILE, MAX_BASELINE_BYTES);
  return {
    configText,
    baselineText,
    config: configText === undefined ? undefined : parseArchitectureConfig(configText),
    baseline: baselineText === undefined ? undefined : parseBaseline(baselineText),
  };
}

type CurrentFiles = Awaited<ReturnType<typeof readCurrentFiles>>;

/** Writes the config and the baseline (when it accepts a violation or replaces one), `*.bak` copies first. */
async function writeRulesFiles(workspaceRoot: string, current: CurrentFiles, configText: string, baselineText: string, empty: boolean): Promise<string[]> {
  const written: string[] = [];
  const write = async (file: string, content: string) => {
    await writeWorkspaceFile(workspaceRoot, file, content);
    written.push(file);
  };
  // Numbered copies: a second confirmed run never replaces the first run's backup.
  if (current.configText !== undefined) written.push(await writeBackup(workspaceRoot, ARCHITECTURE_CONFIG_FILE, current.configText));
  if (current.baselineText !== undefined) written.push(await writeBackup(workspaceRoot, ARCHITECTURE_BASELINE_FILE, current.baselineText));
  await write(ARCHITECTURE_CONFIG_FILE, configText);
  if (!empty || current.baselineText !== undefined) await write(ARCHITECTURE_BASELINE_FILE, baselineText);
  return written;
}

/** Whether to write: never on a dry run; an existing file only after a confirmation (`--yes` or the terminal). */
async function decide(current: CurrentFiles, changes: readonly string[], flags: ReturnType<typeof readFlags>, io: InitIo): Promise<InitStatus> {
  if (flags.dryRun) return "dry-run";
  const exists = current.configText !== undefined || current.baselineText !== undefined;
  if (!exists) return "created";
  if (changes.length === 0) return "unchanged";
  if (flags.yes) return "updated";
  return io.interactive && (await io.confirm(changes)) ? "updated" : "kept";
}

/** The units of the cycle blocks, then the hubs at risk: the few that get a folder diagram. */
function hotSpots(assessment: ArchitectureAssessment): string[] {
  const ranked = [
    ...assessment.matrixFindings.filter((finding) => finding.kind === "cycle-block"),
    ...assessment.matrixFindings.filter((finding) => finding.kind === "hub-at-risk"),
  ].flatMap((finding) => finding.rows);
  return [...new Set(ranked)].slice(0, MAX_FOLDER_DIAGRAMS);
}

/** The units, matrix and hot-spot diagrams as SVG files in `outputDir`. */
async function writeDiagrams(source: UnitSource, workspaceRoot: string, outputDir: string, check: ArchitectureCheck, assessment: ArchitectureAssessment): Promise<InitDiagram[]> {
  // Every violation is in the proposed baseline: drawn as accepted.
  const violations = check.violations.map((violation) => ({ ...violation, new: false }));
  const diagrams: InitDiagram[] = [
    { file: path.posix.join(outputDir, "units.svg"), view: "units" },
    { file: path.posix.join(outputDir, "matrix.svg"), view: "matrix" },
    // Index suffix: two unit keys may give one element name ("a/b", "a-b").
    ...hotSpots(assessment).map((unit, index) => ({ file: path.posix.join(outputDir, `folder-${index + 1}-${elementName(unit)}.svg`), view: "folder" as const, unit })),
  ];
  // At most 2 + MAX_FOLDER_DIAGRAMS independent files.
  await Promise.all(diagrams.map(async (diagram) => {
    const { markup } = await renderSourceDiagram(source, workspaceRoot, { view: diagram.view, folder: diagram.unit, format: "svg", theme: "light", violations });
    await writeWorkspaceFile(workspaceRoot, diagram.file, markup);
  }));
  return diagrams;
}

async function deadCodeFiles() {
  const scan = await executeScanDeadCode({});
  return scan.entries.map((entry) => ({ relativePath: entry.relativePath, unusedSymbols: entry.unusedSymbols.map(({ name, line }) => ({ name, line })) }));
}

export async function run(args: string[], runtime: CliRuntime, format: CliOutputFormat, io: InitIo = terminalIo): Promise<string> {
  const flags = readFlags(args, format);
  const { workspaceRoot } = runtime;
  const outputDir = flags.output === undefined || flags.dryRun ? undefined : readOutputDir(workspaceRoot, flags.output);
  const current = await readCurrentFiles(workspaceRoot);

  await runtime.ensureIndexed();
  const graph = await buildArchitectureGraph(workspaceRoot, (filePath) => workerState.getSpider().analyze(filePath), {
    communityMode: "path",
    indexedAt: runtime.loadState()?.lastScanTimestamp,
  });
  const assignment = assignUnits(workspaceRoot, graph.nodes.map((node) => node.relativePath));
  const units = buildArchitectureUnits(graph, workspaceRoot, assignment, current.config?.roles);
  const config = generateArchitectureConfig(units, current.config);
  const { check } = checkGraphArchitecture(graph, workspaceRoot, config);
  const baseline = acceptAllViolations(check, current.baseline);
  const changes = describeConfigChanges(current, { config, baseline });

  const status = await decide(current, changes, flags, io);
  const written = status === "created" || status === "updated"
    ? await writeRulesFiles(workspaceRoot, current, `${JSON.stringify(config, null, 2)}\n`, formatBaseline(baseline), baseline.length === 0)
    : [];

  const assessment = assessArchitecture({
    graph,
    units,
    unitOf: assignment.unitOf,
    matrix: unitMatrix(units),
    deadCode: await deadCodeFiles(),
    acceptedViolations: baseline.length,
  });
  const diagrams = outputDir === undefined ? [] : await writeDiagrams({ graph, units, assignment }, workspaceRoot, outputDir, check, assessment);

  const result: InitResult = {
    configFile: ARCHITECTURE_CONFIG_FILE,
    baselineFile: ARCHITECTURE_BASELINE_FILE,
    status,
    written,
    changes,
    acceptedViolations: baseline.length,
    guard: GUARD_SNIPPETS,
    assessment,
    diagrams,
  };
  if (outputDir !== undefined) {
    const reportFile = path.posix.join(outputDir, "report.md");
    result.written.push(...diagrams.map((diagram) => diagram.file), reportFile);
    await writeWorkspaceFile(workspaceRoot, reportFile, renderInitMarkdown(result, outputDir));
  }
  if (format === "text") return renderInitText(result);
  if (format === "markdown") return renderInitMarkdown(result);
  return formatOutput(result, format, "init");
}
