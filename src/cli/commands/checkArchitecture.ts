/**
 * CLI Command: check-architecture
 *
 * Checks the workspace imports against the rules of graphit.architecture.json, exiting with 1
 * when an error-severity violation is not in the baseline, so it can gate CI.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildArchitectureGraph } from "../../analyzer/architecture/ArchitectureGraphBuilder.js";
import {
  ARCHITECTURE_BASELINE_FILE,
  checkWorkspaceArchitecture,
  formatBaseline,
  MAX_BASELINE_BYTES,
  parseBaseline,
  readWorkspaceFile,
  type ArchitectureViolation,
  type WorkspaceArchitectureCheck,
} from "../../analyzer/architecture/architectureRules.js";
import { workerState } from "../../mcp/shared/state";
import { validateWorkspacePath } from "../../shared/pathSecurity";
import { CliError, ExitCode } from "../errors";
import type { CliOutputFormat } from "../formatter";
import { formatOutput } from "../formatter";
import type { CliRuntime } from "../runtime";
import { renderCheckArchitectureMarkdown, renderCheckArchitectureText } from "./checkArchitectureReport";

/** `<flag> <workspace file>`, or undefined when the flag is absent. */
function readFile(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const file = args.at(index + 1);
  if (file === undefined || file.startsWith("--") || file.trim() === "") {
    throw new CliError(`${flag} must be a file of the workspace`, ExitCode.GENERAL_ERROR);
  }
  return file;
}

/** The report in the requested format: text and markdown read as a report, the others carry every field. */
function renderCheck(check: WorkspaceArchitectureCheck, format: CliOutputFormat, verbose: boolean): string {
  if (format === "sarif") return toSarif(check);
  if (format === "text") return renderCheckArchitectureText(check, verbose);
  if (format === "markdown") return renderCheckArchitectureMarkdown(check, verbose);
  return formatOutput(check, format, "check-architecture");
}

const SARIF_LEVEL = { error: "error", warning: "warning", off: "none" } as const;

/** One violation on the importing line; the fingerprint keeps an alert stable when lines move. */
function sarifResult(violation: ArchitectureViolation, ruleIndex: number, reason: string | undefined) {
  return {
    ruleId: violation.rule,
    ruleIndex,
    level: violation.severity,
    message: { text: `${violation.from} imports ${violation.to} (${violation.target}): rule "${violation.rule}"${reason ? ". " + reason : ""}` },
    locations: [{
      physicalLocation: {
        artifactLocation: { uri: violation.source, uriBaseId: "%SRCROOT%" },
        region: { startLine: violation.line ?? 1 },
      },
    }],
    partialFingerprints: {
      architectureViolation: createHash("sha256").update(`${violation.rule}\0${violation.source}\0${violation.target}`).digest("hex"),
    },
  };
}

/**
 * SARIF 2.1.0 for GitHub code scanning: one result per new violation (baseline ones are
 * accepted), located on the importing line.
 */
export function toSarif(check: WorkspaceArchitectureCheck): string {
  const ruleIndex = new Map(check.rules.map((rule, index) => [rule.name, index]));
  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: {
        driver: {
          name: "graph-it check-architecture",
          informationUri: "https://github.com/magic5644/Graph-It-Live",
          rules: check.rules.map((rule) => ({
            id: rule.name,
            shortDescription: { text: `${rule.kind} rule "${rule.name}" of ${check.configFile}` },
            ...(rule.reason ? { fullDescription: { text: rule.reason } } : {}),
            defaultConfiguration: { level: SARIF_LEVEL[rule.severity] },
          })),
        },
      },
      results: check.violations.filter((violation) => violation.new).map((violation) => {
        const index = ruleIndex.get(violation.rule)!;
        return sarifResult(violation, index, check.rules[index].reason);
      }),
    }],
  };
  return JSON.stringify(sarif, null, 2);
}

export async function run(args: string[], runtime: CliRuntime, format: CliOutputFormat): Promise<string> {
  const config = readFile(args, "--config");
  const baseline = readFile(args, "--baseline");
  const updateBaseline = args.includes("--update-baseline");
  const verbose = args.includes("--verbose");
  if (format === "csv") {
    throw new CliError('Format "csv" is only produced by graph-it architecture --matrix.', ExitCode.UNSUPPORTED_FORMAT);
  }

  await runtime.ensureIndexed();
  const { workspaceRoot } = runtime;
  const graph = await buildArchitectureGraph(workspaceRoot, (filePath) => workerState.getSpider().analyze(filePath), {
    indexedAt: runtime.loadState()?.lastScanTimestamp,
  });

  if (updateBaseline) {
    // Every current violation, the old baseline ignored (resolved ones drop out), except the
    // entries of rules switched off: they were not checked, so they stay accepted.
    const check = await checkWorkspaceArchitecture(graph, workspaceRoot, { config, baseline: false });
    const file = baseline ?? ARCHITECTURE_BASELINE_FILE;
    const previousText = await readWorkspaceFile(workspaceRoot, file, MAX_BASELINE_BYTES);
    const off = new Set(check.rules.filter((rule) => rule.severity === "off").map((rule) => rule.name));
    const kept = previousText === undefined ? [] : parseBaseline(previousText, file).filter((entry) => off.has(entry.rule));
    await fs.promises.writeFile(validateWorkspacePath(path.resolve(workspaceRoot, file), workspaceRoot), formatBaseline([...check.violations, ...kept]));
    if (format === "text" || format === "markdown") {
      return `Baseline ${file} written: ${check.violations.length} violation(s) accepted.`;
    }
    return formatOutput({ baselineFile: file, violations: check.violations.length, rules: check.rules.map(({ name, violations }) => ({ name, violations })) }, format === "sarif" ? "json" : format, "check-architecture");
  }

  const check = await checkWorkspaceArchitecture(graph, workspaceRoot, { config, baseline });
  const output = renderCheck(check, format, verbose);
  if (!check.passed) {
    throw new CliError(
      `${check.totals.newErrors} error violation(s) of the architecture rules not in the baseline`,
      ExitCode.GENERAL_ERROR,
      output,
    );
  }
  return output;
}
