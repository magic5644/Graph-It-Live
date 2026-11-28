import { ARCHITECTURE_CONFIG_FILE } from "../../analyzer/architecture/architectureRules";
import { ReviewGateAnalyzer, renderReviewMarkdown, type ReviewGateResult } from "../../analyzer/ReviewGateAnalyzer";
import { deltaChanged, deltaUnchangedLine, renderArchitectureDelta } from "../../analyzer/diagram/deltaSvg";
import { createSpiderDependentsProvider } from "../../mcp/tools/impact";
import { workerState } from "../../mcp/shared/state";
import { CliError, ExitCode } from "../errors";
import { readIntegerOption, readStringOption } from "../options";
import type { CliOutputFormat } from "../formatter";
import { formatOutput } from "../formatter";
import type { CliRuntime } from "../runtime";
import { resolveInWorkspace, writeWorkspaceFile } from "../workspaceFiles";
import { toSarif } from "./checkArchitecture";

/** The review analyzer over the indexed workspace (shared with `diagram --delta`). */
export function createReviewAnalyzer(runtime: CliRuntime): ReviewGateAnalyzer {
  return new ReviewGateAnalyzer(runtime.workspaceRoot, createSpiderDependentsProvider(workerState.getSpider(), runtime.workspaceRoot, workerState.getConfig().extensionPath));
}

/** `--deltaSvg <file.svg>`: the workspace file, refused before any work when it is not a .svg inside the workspace. */
function readDeltaSvg(args: string[], workspaceRoot: string): string | undefined {
  const file = readStringOption(args, "--deltaSvg", "a .svg file of the workspace");
  if (file === undefined) return undefined;
  if (file === "-" || !file.toLowerCase().endsWith(".svg")) {
    throw new CliError("--deltaSvg writes a .svg file of the workspace", ExitCode.GENERAL_ERROR);
  }
  resolveInWorkspace(workspaceRoot, file);
  return file;
}

/** The delta SVG of a review it already holds; a stderr line, no file, when there is nothing to draw. */
async function writeDeltaSvg(runtime: CliRuntime, file: string, result: ReviewGateResult, headUnitEdges?: ReadonlyMap<string, number>): Promise<void> {
  if (result.structure === undefined) {
    process.stderr.write("No architecture delta written: the review holds no structure comparison (see limitations).\n");
  } else if (result.structure.verdict === "empty") {
    process.stderr.write(`No architecture delta written: no analyzable file at ${result.baseRef} or ${result.headRef}.\n`);
  } else if (deltaChanged(result)) {
    const { markup, cut, warnings } = await renderArchitectureDelta({ ...result, ...(headUnitEdges ? { headUnitEdges } : {}) });
    await writeWorkspaceFile(runtime.workspaceRoot, file, markup);
    for (const line of [...warnings, ...cut]) process.stderr.write(`${line}\n`);
  } else {
    process.stderr.write(`${deltaUnchangedLine(result)}\n`);
  }
}

/** Analyze the checked-out diff against a Git base ref. */
export async function run(args: string[], runtime: CliRuntime, format: CliOutputFormat): Promise<string> {
  const baseRef = readOption(args, "base");
  if (!baseRef) {
    throw new CliError("review-pr requires --base <git-ref>", ExitCode.GENERAL_ERROR);
  }
  const headRef = readOption(args, "head");
  const maxDepth = readIntegerOption(args, "--depth", { min: 1, max: 10 });
  // --max-files: the 1.25.4 spelling, still passed by the review gate action.
  const maxFiles = readIntegerOption(args, "--maxFiles", { min: 1 }) ?? readIntegerOption(args, "--max-files", { min: 1 });
  const deltaSvg = readDeltaSvg(args, runtime.workspaceRoot);
  // Silent off the progress TTY: a CI gate log keeps only the review.
  await runtime.ensureIndexed({ silent: !runtime.progress.enabled });
  const analyzer = createReviewAnalyzer(runtime);
  const options = { baseRef, headRef, maxDepth, maxFiles };
  const { result, headUnitEdges } = await runtime.progress.phase("Reviewing the diff", async (): Promise<Awaited<ReturnType<typeof analyzer.analyzeWithDelta>>> =>
    deltaSvg === undefined ? { result: await analyzer.analyze(options) } : analyzer.analyzeWithDelta(options));
  if (deltaSvg !== undefined) await writeDeltaSvg(runtime, deltaSvg, result, headUnitEdges);
  if (format === "sarif") return reviewSarif(result);
  return format === "markdown" ? renderReviewMarkdown(result) : formatOutput(result, format, "review-pr");
}

/** The new violations of the architecture rules the head baseline does not accept, as check-architecture reports them. */
function reviewSarif({ architecture }: ReviewGateResult): string {
  const rules = architecture?.rules ?? [];
  const violations = rules.flatMap((rule) => rule.newViolations
    .filter((violation) => !violation.accepted)
    .map(({ accepted: _accepted, ...violation }) => ({ ...violation, rule: rule.name, severity: rule.severity as "error" | "warning", new: true })));
  return toSarif({ configFile: architecture?.configFile ?? ARCHITECTURE_CONFIG_FILE, rules, violations }, "graph-it review-pr");
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

