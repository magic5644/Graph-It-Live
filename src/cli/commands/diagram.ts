/**
 * CLI Command: diagram
 *
 * Writes a static architecture diagram of the workspace (the units, the groups of one unit or
 * folder, or their dependency matrix) as a bare SVG or one self-contained HTML page, optionally
 * with the violations of graphit.architecture.json drawn in the error colour; or its data as a
 * diagram spec (JSON) for an agent diagram skill. `--view flow <file#symbol>` draws the call flow
 * of one entry symbol instead, from the call graph index; `--view sequence <file#symbol>` its calls in
 * order, also as Mermaid text.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ARCHITECTURE_BASELINE_FILE } from "../../analyzer/architecture/architectureRules.js";
import { DIAGRAM_THEMES, DIAGRAM_VIEWS, defaultDiagramFile, diagramLevel, MAX_FLOW_STEPS, MAX_SEQUENCE_MESSAGES, type DiagramRequestView } from "../../analyzer/diagram/diagramStyle.js";
import { cutNote, readDiagramSpec, specFlowRequest, specLevel, specSequenceRequest } from "../../analyzer/diagram/diagramSpecImport.js";
import { renderFlowDiagram, renderSequenceDiagram, renderWorkspaceDiagram, type WorkspaceDiagramOptions } from "../../analyzer/diagram/workspaceDiagram.js";
import { workerFlowSources } from "../../mcp/tools/architecture";
import { workerState } from "../../mcp/shared/state";
import { getRelativePath, normalizePath } from "../../shared/path";
import { validateWorkspacePath } from "../../shared/pathSecurity";
import { CliError, ExitCode } from "../errors";
import type { CliOutputFormat } from "../formatter";
import { readChoiceOption, readIntegerOption, readStringOption } from "../options";
import type { CliRuntime } from "../runtime";
import { parseTargetRef } from "../symbols";
import { resolveInWorkspace, writeWorkspaceFile } from "../workspaceFiles";

/** The options of the architecture levels, refused with --view flow or sequence, and those of one symbol's views. */
const LEVEL_VIEWS = DIAGRAM_VIEWS.filter((view) => view !== "flow" && view !== "sequence");
const LEVEL_FLAGS = ["--folder", "--rules", "--config", "--baseline"];
const FLOW_FLAGS = ["--maxSteps"];
const SEQUENCE_FLAGS = ["--depth", "--maxMessages", "--participants"];
const PARTICIPANTS = ["file", "class"] as const;

/** `<flag>` alone (true) or `<flag> <file>`, or undefined when the flag is absent. */
function readOptionalFile(args: string[], flag: string): string | true | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args.at(index + 1);
  return value === undefined || value.startsWith("--") || value.trim() === "" ? true : value;
}

const OUTPUT_EXTENSIONS: Record<WorkspaceDiagramOptions["format"], string[]> = {
  svg: [".svg"], html: [".html", ".htm"], "diagram-spec": [".json"], mermaid: [".mmd", ".mermaid"],
};

/** The format `--format` names, or without it the one an `--output` file's extension names (svg, mermaid), else html. */
function outputFormat(format: CliOutputFormat, file: string | undefined): WorkspaceDiagramOptions["format"] {
  if (format === "svg" || format === "diagram-spec" || format === "mermaid" || format === "html") return format;
  const lower = file?.toLowerCase() ?? "";
  if (lower.endsWith(".svg")) return "svg";
  return OUTPUT_EXTENSIONS.mermaid.some((extension) => lower.endsWith(extension)) ? "mermaid" : "html";
}

/** svg, html, diagram-spec or (a sequence's) mermaid, and the output file. */
function readOutput(args: string[], format: CliOutputFormat, view?: DiagramRequestView) {
  if (format !== "text" && format !== "html" && format !== "svg" && format !== "diagram-spec" && format !== "mermaid") {
    throw new CliError(`graph-it diagram writes --format svg, html, diagram-spec or mermaid, not "${format}".`, ExitCode.UNSUPPORTED_FORMAT);
  }
  const file = readStringOption(args, "--output", "a file of the workspace, or - for stdout");
  const output = outputFormat(format, file);
  if (output === "mermaid" && view !== "sequence") {
    throw new CliError("--format mermaid writes --view sequence only: use --format svg, html or diagram-spec for this view.", ExitCode.UNSUPPORTED_FORMAT);
  }
  const extensions = OUTPUT_EXTENSIONS[output];
  if (file !== undefined && file !== "-" && !extensions.some((extension) => file.toLowerCase().endsWith(extension))) {
    throw new CliError(`--output ${file} does not match --format ${output}: name it *${extensions[0]}, or pass the format of that file.`, ExitCode.GENERAL_ERROR);
  }
  return { format: output, file: file ?? defaultDiagramFile(output, view) };
}

/** The output and the theme, which only an SVG has. */
function readMarkupOptions(args: string[], format: CliOutputFormat, view?: DiagramRequestView) {
  const output = readOutput(args, format, view);
  const theme = readChoiceOption(args, "--theme", DIAGRAM_THEMES);
  if (theme !== undefined && output.format !== "svg") {
    throw new CliError("--theme sets the colours of --format svg; the HTML page follows the reader's light or dark scheme, and a spec or Mermaid text has none", ExitCode.GENERAL_ERROR);
  }
  return { ...output, theme: theme ?? "light" };
}

/** The first option of `flags` on the command line: an error naming it and the views it applies to. */
function refuseFlags(args: string[], flags: string[], applies: string) {
  const flag = flags.find((candidate) => args.includes(candidate));
  if (flag !== undefined) throw new CliError(`${flag} applies to ${applies}`, ExitCode.GENERAL_ERROR);
}

/** `<file#symbol>` of view flow or sequence: the output, the entry symbol and its `--startLine` selector. */
function readEntryOptions(args: string[], format: CliOutputFormat, workspaceRoot: string, view: "flow" | "sequence") {
  refuseFlags(args, LEVEL_FLAGS, `--view units, folder or matrix, not ${view}`);
  refuseFlags(args, view === "flow" ? SEQUENCE_FLAGS : FLOW_FLAGS, `--view ${view === "flow" ? "sequence" : "flow"}, not ${view}`);
  const ref = args[0];
  if (ref === undefined || ref.startsWith("-") || !ref.includes("#")) {
    throw new CliError(`--view ${view} draws one symbol's ${view === "flow" ? "flow" : "calls"}: pass <file#symbol>`, ExitCode.GENERAL_ERROR);
  }
  const markup = readMarkupOptions(args, format, view);
  const startLine = readIntegerOption(args, "--startLine", { min: 1 });
  // Missing file: closest paths; outside the workspace: a security refusal.
  const { filePath, symbolName } = parseTargetRef(ref, workspaceRoot);
  return { ...markup, entry: { filePath, symbolName: symbolName ?? "", startLine } };
}

/** `--view flow <file#symbol>`: the entry symbol, its selector and step cap, and the output. */
export function readFlowOptions(args: string[], format: CliOutputFormat, workspaceRoot: string) {
  const { entry, ...markup } = readEntryOptions(args, format, workspaceRoot, "flow");
  return { ...markup, request: { ...entry, maxSteps: readIntegerOption(args, "--maxSteps", { min: 1, max: MAX_FLOW_STEPS }) } };
}

/** `--view sequence <file#symbol>`: the entry symbol, its selector, depth, message cap and lifelines, and the output. */
export function readSequenceOptions(args: string[], format: CliOutputFormat, workspaceRoot: string) {
  const { entry, ...markup } = readEntryOptions(args, format, workspaceRoot, "sequence");
  const depth = readIntegerOption(args, "--depth", { min: 1 });
  const maxMessages = readIntegerOption(args, "--maxMessages", { min: 1, max: MAX_SEQUENCE_MESSAGES });
  const participants = readChoiceOption(args, "--participants", PARTICIPANTS);
  return { ...markup, request: { ...entry, depth, maxMessages, participants } };
}

/** The view and its folder key (or directory), rejecting the pairs that name no single level. */
function readView(args: string[], directory: string | undefined) {
  const key = readStringOption(args, "--folder", "a unit or folder key");
  if (key !== undefined && directory !== undefined) {
    throw new CliError("Pass a directory or --folder <key>, not both", ExitCode.GENERAL_ERROR);
  }
  const { view, folder } = diagramLevel(readChoiceOption(args, "--view", LEVEL_VIEWS), key ?? directory);
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
  if (arg.includes("#")) throw new CliError(`a file#symbol positional needs --view flow or sequence: ${arg}`, ExitCode.GENERAL_ERROR);
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
  refuseFlags(args, [...FLOW_FLAGS, "--startLine"], "--view flow or sequence");
  refuseFlags(args, SEQUENCE_FLAGS, "--view sequence");
  const output = readMarkupOptions(args, format);
  const view = readView(args, directory);
  if (output.format === "diagram-spec" && view.view === "matrix") {
    throw new CliError("--format diagram-spec describes --view units or folder; the matrix is written as svg or html.", ExitCode.UNSUPPORTED_FORMAT);
  }
  return { ...view, ...output, rules: readRules(args) };
}

/** What `--spec` replaces: the spec names its own view, level or entry symbol. */
const SPEC_FLAGS = ["--view", "--folder", "--startLine", ...FLOW_FLAGS, ...SEQUENCE_FLAGS];

/** `--spec <file>`: an annotated diagram spec drawn again on the current index (#794). */
async function runSpec(args: string[], runtime: CliRuntime, format: CliOutputFormat, file: string): Promise<string> {
  const { workspaceRoot } = runtime;
  const positional = args[0] !== undefined && !args[0].startsWith("-") ? args[0] : undefined;
  const replaced = SPEC_FLAGS.find((flag) => args.includes(flag)) ?? positional;
  if (replaced !== undefined) {
    throw new CliError(`--spec draws the view, level or symbol written in the spec: drop ${replaced}`, ExitCode.GENERAL_ERROR);
  }
  const spec = await readDiagramSpec(workspaceRoot, file);
  if (spec.kind !== "architecture") refuseFlags(args, ["--rules", "--config", "--baseline"], `an architecture spec, not a ${spec.kind} spec`);
  const options = readMarkupOptions(args, format, spec.kind === "architecture" ? undefined : spec.kind);
  const target = options.file === "-" ? undefined : resolveInWorkspace(workspaceRoot, options.file);
  if (target !== undefined && normalizePath(target) === normalizePath(spec.absolute)) {
    throw new CliError(`--output ${options.file} would replace the spec it reads: pass another file`, ExitCode.GENERAL_ERROR);
  }
  if (spec.kind === "flow") {
    const { db, extractor } = await workerFlowSources();
    const diagram = await renderFlowDiagram(db, { rootDir: workspaceRoot, extractor }, specFlowRequest(spec, workspaceRoot), { ...options, spec });
    return writeDiagram(runtime, options.file, target, diagram);
  }
  if (spec.kind === "sequence") {
    const { db, extractor } = await workerFlowSources();
    const diagram = await renderSequenceDiagram(db, { rootDir: workspaceRoot, extractor }, specSequenceRequest(spec, workspaceRoot), { ...options, spec });
    return writeDiagram(runtime, options.file, target, diagram);
  }
  const level = specLevel(spec);
  const rules = readRules(args);
  await runtime.ensureIndexed();
  const diagram = await renderWorkspaceDiagram(workspaceRoot, (filePath) => workerState.getSpider().analyzeFromIndex(filePath), {
    ...level,
    ...options,
    rules,
    spec,
    indexedAt: runtime.loadState()?.lastScanTimestamp,
  });
  return writeDiagram(runtime, options.file, target, diagram);
}

export async function run(args: string[], runtime: CliRuntime, format: CliOutputFormat): Promise<string> {
  const { workspaceRoot } = runtime;
  const spec = readStringOption(args, "--spec", "an annotated diagram-spec JSON file of the workspace");
  if (spec !== undefined) return runSpec(args, runtime, format, spec);
  const view = readChoiceOption(args, "--view", DIAGRAM_VIEWS);
  if (view === "flow") return runFlow(args, runtime, format);
  if (view === "sequence") return runSequence(args, runtime, format);
  const options = readDiagramOptions(args, format, readDirectory(args, workspaceRoot));
  // Refused before any work: the output stays in the workspace, as --config does.
  const target = options.file === "-" ? undefined : resolveInWorkspace(workspaceRoot, options.file);

  await runtime.ensureIndexed();
  const { markup, counts } = await renderWorkspaceDiagram(workspaceRoot, (filePath) => workerState.getSpider().analyzeFromIndex(filePath), {
    ...options,
    indexedAt: runtime.loadState()?.lastScanTimestamp,
  });
  return writeDiagram(runtime, options.file, target, { markup, counts });
}

/** The flow of one entry symbol: the call graph index alone (restored from the cache when warm), no dependency index. */
async function runFlow(args: string[], runtime: CliRuntime, format: CliOutputFormat): Promise<string> {
  const { workspaceRoot } = runtime;
  const options = readFlowOptions(args, format, workspaceRoot);
  const target = options.file === "-" ? undefined : resolveInWorkspace(workspaceRoot, options.file);
  const { db, extractor } = await workerFlowSources();
  const diagram = await renderFlowDiagram(db, { rootDir: workspaceRoot, extractor }, options.request, options);
  return writeDiagram(runtime, options.file, target, diagram);
}

/** The calls of one entry symbol in order: the call graph index alone, as the flow reads it. */
async function runSequence(args: string[], runtime: CliRuntime, format: CliOutputFormat): Promise<string> {
  const { workspaceRoot } = runtime;
  const options = readSequenceOptions(args, format, workspaceRoot);
  const target = options.file === "-" ? undefined : resolveInWorkspace(workspaceRoot, options.file);
  const { db, extractor } = await workerFlowSources();
  const diagram = await renderSequenceDiagram(db, { rootDir: workspaceRoot, extractor }, options.request, options);
  return writeDiagram(runtime, options.file, target, diagram);
}

async function writeDiagram(runtime: CliRuntime, file: string, target: string | undefined, { markup, counts, cut = [] }: { markup: string; counts: string; cut?: string[] }) {
  const note = cutNote(cut);
  if (target === undefined) {
    // stdout holds the markup alone: the note goes to stderr.
    if (note !== "") process.stderr.write(`${note.trim()}\n`);
    return markup;
  }
  await writeWorkspaceFile(runtime.workspaceRoot, file, markup);
  return `Diagram written to ${getRelativePath(target, runtime.workspaceRoot)}: ${counts}.${note}`;
}
