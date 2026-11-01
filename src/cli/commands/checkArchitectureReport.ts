/**
 * Human reports of `graph-it check-architecture`: `text` for a terminal, `markdown` for a PR
 * comment. Pure functions of the check result; json, toon and sarif are rendered elsewhere.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import type { WorkspaceArchitectureCheck } from "../../analyzer/architecture/architectureRules.js";
import { normalizePath } from "../../shared/path.js";

type Check = WorkspaceArchitectureCheck;

/** A file (with its import line and target) or a free sentence of the config. */
type Item = { file: string; line?: number; target?: string; rule?: string } | { text: string };

interface Group {
  /** Rule name: a markdown code span, so config text never renders as markdown. */
  heading?: string;
  severity?: string;
  note?: string;
  items: Item[];
}

interface Section {
  title: string;
  note?: string;
  groups: Group[];
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const status = (check: Check) => (check.passed ? "PASSED" : "FAILED");

function verdict(check: Check): string {
  const baseline = check.baselineFile === undefined ? "no baseline" : `baseline ${check.baselineFile}`;
  return `${plural(check.totals.newErrors, "new error violation")} (config ${check.configFile}, ${baseline})`;
}

function summary(check: Check): string[] {
  const { totals } = check;
  const accepted = totals.violations - totals.newViolations;
  const lines = [
    `${plural(totals.files, "file")}, ${totals.unmatchedFiles} unmatched; ${plural(totals.violations, "violation")} (${totals.newViolations} new, ${accepted} accepted): ${plural(totals.errors, "error")}, ${plural(totals.warnings, "warning")}; ${totals.resolved} resolved`,
  ];
  // A partial graph may hide violations: the verdict alone would overstate it.
  if (check.context.truncated || check.context.failedFiles > 0) {
    lines.push(`Partial analysis: ${check.context.truncated ? "file limit reached, " : ""}${plural(check.context.failedFiles, "file")} failed to parse`);
  }
  return lines;
}

/** One group per rule with matching violations, in config order. */
function violationGroups(check: Check, isNew: boolean): Group[] {
  return check.rules.flatMap((rule) => {
    const items = check.violations
      .filter((violation) => violation.rule === rule.name && violation.new === isNew)
      .map(({ source, line, target }) => ({ file: source, line, target }));
    return items.length === 0 ? [] : [{ heading: rule.name, severity: rule.severity, note: rule.reason, items }];
  });
}

function acceptedSection(check: Check, verbose: boolean): Section[] {
  const accepted = check.totals.violations - check.totals.newViolations;
  if (accepted === 0) return [];
  const note = `${plural(accepted, "violation")} in the baseline${verbose ? "." : " (--verbose lists them)."}`;
  return [{ title: "Accepted violations", note, groups: verbose ? violationGroups(check, false) : [] }];
}

/** A section listing items, left out when there is none. */
function listSection(title: string, note: string, items: Item[]): Section[] {
  return items.length === 0 ? [] : [{ title, note, groups: [{ items }] }];
}

function contextSection(check: Check): Section {
  const items = Object.entries(check.context)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ text: `${key}: ${String(value)}` }));
  return { title: "Context", groups: [{ items }] };
}

function sections(check: Check, verbose: boolean): Section[] {
  const newGroups = violationGroups(check, true);
  return [
    ...(newGroups.length === 0 ? [] : [{ title: "New violations", groups: newGroups }]),
    ...acceptedSection(check, verbose),
    ...listSection("Resolved violations", "In the baseline but no longer found: run --update-baseline to drop them.",
      check.resolved.map(({ rule, source, target }) => ({ file: source, target, rule }))),
    ...listSection("Unmatched files", "No element selects them: no rule checks them.", check.unmatchedFiles.map((file) => ({ file }))),
    ...listSection("Config warnings", "", check.configWarnings.map((text) => ({ text }))),
    ...(verbose ? [contextSection(check)] : []),
  ];
}

/** One line of config or file text: a line break would end the list item, table row or indent. */
const oneLine = (value: string) => value.replaceAll(/[\r\n]+/g, " ");

const RULE_COLUMNS = ["Rule", "Kind", "Severity", "Violations", "New"];

function ruleRows(check: Check): string[][] {
  return check.rules.map((rule) => [rule.name, rule.kind, rule.severity, String(rule.violations), String(rule.newViolations)]);
}

/** `file:line → target (rule)`, each path through `path` (plain, or a markdown code span). */
function itemText(item: Item, path: (value: string) => string): string {
  if ("text" in item) return item.text;
  const location = path(item.line === undefined ? normalizePath(item.file) : `${normalizePath(item.file)}:${item.line}`);
  const target = item.target === undefined ? "" : ` → ${path(normalizePath(item.target))}`;
  const rule = item.rule === undefined ? "" : ` (${path(item.rule)})`;
  return `${location}${target}${rule}`;
}

function textTable(rows: string[][]): string[] {
  const all = [RULE_COLUMNS, ...rows];
  const widths = RULE_COLUMNS.map((_, column) => Math.max(...all.map((row) => row[column].length)));
  return all.map((row) => `  ${row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd()}`);
}

function textSection(section: Section): string[] {
  const lines = ["", section.title];
  if (section.note) lines.push(`  ${section.note}`);
  for (const group of section.groups) {
    const indent = group.heading === undefined ? "  " : "    ";
    const note = group.note ? `: ${oneLine(group.note)}` : "";
    if (group.heading !== undefined) lines.push(`  ${oneLine(group.heading)} (${group.severity})${note}`);
    lines.push(...group.items.map((item) => `${indent}${itemText(item, (value) => value)}`));
  }
  return lines;
}

/** Plain-text report: verdict, rules table, then the violations to act on. */
export function renderCheckArchitectureText(check: Check, verbose = false): string {
  const rows = ruleRows(check);
  return [
    `${status(check)}: ${verdict(check)}`,
    ...summary(check),
    "",
    "Rules",
    ...(rows.length === 0 ? ["  No rules."] : textTable(rows)),
    ...sections(check, verbose).flatMap(textSection),
  ].join("\n");
}

/** Table cell: `|` would split it into two columns. */
const cell = (value: string) => oneLine(value).replaceAll("|", String.raw`\|`);

/** Code span, fenced by one backtick more than the longest run the text holds. */
function code(value: string): string {
  const text = oneLine(value);
  const fence = "`".repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length)) + 1);
  return fence.length === 1 ? `${fence}${text}${fence}` : `${fence} ${text} ${fence}`;
}

function markdownSection(section: Section): string[] {
  const lines = ["", `### ${section.title}`];
  if (section.note) lines.push("", oneLine(section.note));
  for (const group of section.groups) {
    if (group.heading !== undefined) lines.push("", `#### ${code(group.heading)} (${group.severity})`);
    if (group.note) lines.push("", oneLine(group.note));
    lines.push("", ...group.items.map((item) => `- ${"text" in item ? oneLine(item.text) : itemText(item, code)}`));
  }
  return lines;
}

/** GitHub-flavored markdown report for a PR comment: same content as text, no diagram. */
export function renderCheckArchitectureMarkdown(check: Check, verbose = false): string {
  const rows = ruleRows(check);
  return [
    `## Architecture check: ${status(check)}`,
    "",
    `${oneLine(verdict(check))}.`,
    "",
    ...summary(check).map((line) => `${line}.`),
    "",
    ...(rows.length === 0
      ? ["No rules."]
      : [
        `| ${RULE_COLUMNS.join(" | ")} |`,
        "| --- | --- | --- | ---: | ---: |",
        ...rows.map(([name, ...counts]) => `| ${[code(name), ...counts].map(cell).join(" | ")} |`),
      ]),
    ...sections(check, verbose).flatMap(markdownSection),
  ].join("\n");
}
