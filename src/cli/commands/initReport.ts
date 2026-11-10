/**
 * Human reports of `graph-it init`: `text` for a terminal, `markdown` for a PR, an issue or the
 * report.md written next to the diagrams. Pure functions of the init result; json and toon carry
 * every field and item.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import * as path from "node:path";
import type { ArchitectureAssessment, MatrixFinding, QuickWin } from "../../analyzer/architecture/architectureAssessment.js";

/** What happened to the config and baseline files. */
export type InitStatus = "created" | "updated" | "unchanged" | "kept" | "dry-run";

export interface InitDiagram {
  file: string;
  view: "units" | "matrix" | "folder";
  /** The unit a folder diagram draws. */
  unit?: string;
}

export interface InitResult {
  configFile: string;
  baselineFile: string;
  status: InitStatus;
  /** Workspace-relative files written, `*.bak` copies included. */
  written: string[];
  /** One line per element, rule or accepted violation the proposal adds, changes or removes. */
  changes: string[];
  acceptedViolations: number;
  guard: { preCommit: string; ci: string; sarif: string };
  assessment: ArchitectureAssessment;
  diagrams: InitDiagram[];
}

/** Items listed per section; the json and toon formats list them all. */
export const REPORT_LIMIT = 20;

const STATUS: Record<InitResult["status"], string> = {
  created: "written",
  updated: "updated after confirmation (previous files kept as *.bak)",
  unchanged: "already up to date: nothing written",
  kept: "existing config kept: nothing written (confirm in a terminal, or pass --yes, to apply the changes below)",
  "dry-run": "dry run: nothing written",
};

/** A code span: backticks and line breaks of a path or symbol cannot break out of it. */
const code = (text: string) => `\`${text.replaceAll(/[`\r\n]/g, "'")}\``;

function totalsLines(result: InitResult): string[] {
  const t = result.assessment.totals;
  return [
    `${t.units} units, ${t.unitEdges} unit edges, ${t.unitCycles} unit cycle(s), ${t.mutualImports} mutual file import(s)`,
    `${t.acceptedViolations} accepted violation(s), ${t.deadCodeFiles} file(s) with ${t.unusedExports} unused export(s)`,
  ];
}

function more(total: number): string[] {
  return total > REPORT_LIMIT ? [`... ${total - REPORT_LIMIT} more (--format json lists them all)`] : [];
}

/** The diagram that shows an item: a hot-spot folder diagram of one of its units, else the units or matrix diagram. */
function diagramFor(diagrams: readonly InitDiagram[], units: readonly string[], fallback: "units" | "matrix" | undefined): InitDiagram | undefined {
  return diagrams.find((diagram) => diagram.view === "folder" && units.includes(diagram.unit ?? ""))
    ?? diagrams.find((diagram) => diagram.view === fallback);
}

const QUICK_WIN_VIEW: Record<QuickWin["kind"], "units" | undefined> = {
  "cycle-break": "units",
  "mutual-import": undefined,
  "weak-dependency": "units",
  "dead-code": undefined,
};

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export function renderInitText(result: InitResult): string {
  const { quickWins, matrixFindings } = result.assessment;
  const lines = [
    `${result.configFile}: ${STATUS[result.status]}`,
    ...result.written.map((file) => `  wrote ${file}`),
    ...(result.changes.length === 0 ? [] : ["", `Changes (${result.changes.length}):`, ...result.changes.slice(0, REPORT_LIMIT).map((change) => `  ${change}`), ...more(result.changes.length)]),
    "",
    "Guard:",
    `  pre-commit: ${result.guard.preCommit}`,
    `  CI:         ${result.guard.ci}`,
    "  Code scanning (SARIF):",
    ...result.guard.sarif.split("\n").map((line) => `    ${line}`),
    "",
    "Totals:",
    ...totalsLines(result).map((line) => `  ${line}`),
    "",
    `Quick wins (${quickWins.length}, by effort):`,
    ...quickWins.slice(0, REPORT_LIMIT).flatMap((win) => [
      `  [${win.kind}, effort ${win.effort}] ${win.subject}`,
      ...win.evidence.map((item) => `      ${item}`),
      ...(win.totalEvidence > win.evidence.length ? [`      ... ${win.totalEvidence - win.evidence.length} more`] : []),
      `      next: ${win.next}`,
    ]),
    ...more(quickWins.length),
    "",
    `Matrix reading (${matrixFindings.length}):`,
    ...matrixFindings.slice(0, REPORT_LIMIT).flatMap((finding) => [
      `  [${finding.kind}] ${finding.rows.join(", ")}${finding.cells.length === 0 ? "" : " (" + finding.cells.join(", ") + ")"}: ${finding.action}`,
      ...finding.evidence.map((item) => `      ${item}`),
      `      formula: ${finding.formula}`,
    ]),
    ...more(matrixFindings.length),
  ];
  if (result.diagrams.length > 0) lines.push("", "Diagrams:", ...result.diagrams.map((diagram) => `  ${diagram.file}`));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function link(diagram: InitDiagram | undefined, base: string | undefined): string {
  if (diagram === undefined) return "";
  const target = base === undefined ? diagram.file : path.posix.relative(base, diagram.file);
  return ` ([diagram](${encodeURI(target)}))`;
}

function quickWinMarkdown(win: QuickWin, diagrams: readonly InitDiagram[], base: string | undefined): string[] {
  return [
    `- **${win.kind}**, effort ${win.effort}: ${code(win.subject)}${link(diagramFor(diagrams, win.units, QUICK_WIN_VIEW[win.kind]), base)}`,
    ...win.evidence.map((item) => `  - ${code(item)}`),
    ...(win.totalEvidence > win.evidence.length ? [`  - ... ${win.totalEvidence - win.evidence.length} more`] : []),
    `  - next: ${code(win.next)}`,
  ];
}

function findingMarkdown(finding: MatrixFinding, diagrams: readonly InitDiagram[], base: string | undefined): string[] {
  const cells = finding.cells.length === 0 ? "" : ` cells ${finding.cells.map(code).join(", ")}`;
  return [
    `- **${finding.kind}** ${finding.rows.map(code).join(", ")}${cells}: ${finding.action}${link(diagramFor(diagrams, finding.rows, "matrix"), base)}`,
    ...finding.evidence.map((item) => `  - ${code(item)}`),
    `  - formula: ${finding.formula}`,
  ];
}

/** `base`: the folder the report is written to, so its diagram links are relative to it. */
export function renderInitMarkdown(result: InitResult, base?: string): string {
  const { quickWins, matrixFindings } = result.assessment;
  const lines = [
    "# Architecture guard (graph-it init)",
    "",
    `${code(result.configFile)}: ${STATUS[result.status]}.`,
    ...result.written.map((file) => `- wrote ${code(file)}`),
  ];
  if (result.changes.length > 0) {
    const shown = result.changes.slice(0, REPORT_LIMIT);
    // Longer than any backtick run of the config text (rule reasons), so it cannot close early.
    const fence = "`".repeat(Math.max(3, ...shown.flatMap((change) => change.match(/`+/g) ?? []).map((run) => run.length + 1)));
    lines.push("", "## Changes", "", `${fence}text`, ...shown, ...more(result.changes.length), fence);
  }
  lines.push(
    "", "## Guard", "",
    "Pre-commit hook:", "", "```sh", result.guard.preCommit, "```", "",
    "CI step:", "", "```yaml", result.guard.ci, "```", "",
    "Code scanning (SARIF):", "", "```yaml", result.guard.sarif, "```",
    "", "## Totals", "", ...totalsLines(result).map((line) => `- ${line}`),
    "", `## Quick wins (${quickWins.length}, by effort)`, "",
    ...quickWins.slice(0, REPORT_LIMIT).flatMap((win) => quickWinMarkdown(win, result.diagrams, base)),
    ...more(quickWins.length),
    "", `## Matrix reading (${matrixFindings.length})`, "",
    "Each finding is a lead for the architect, never a verdict.", "",
    ...matrixFindings.slice(0, REPORT_LIMIT).flatMap((finding) => findingMarkdown(finding, result.diagrams, base)),
    ...more(matrixFindings.length),
  );
  if (result.diagrams.length > 0) {
    lines.push("", "## Diagrams", "", ...result.diagrams.map((diagram) => `- ${diagram.view}${diagram.unit === undefined ? "" : " " + code(diagram.unit)}${link(diagram, base)}`));
  }
  return `${lines.join("\n")}\n`;
}
