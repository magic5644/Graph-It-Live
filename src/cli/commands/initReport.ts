/**
 * Human reports of `graph-it init`: `text` for a terminal, `markdown` for a PR, an issue or the
 * report.md written next to the diagrams. Pure functions of the init result; json and toon carry
 * every field and item.
 *
 * Order (#716): what was written, a summary, then the findings from the cheapest to act on (dead
 * files, cycles to cut, hubs, other leads), the glossary, the diagrams, and the guard last.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import * as path from "node:path";
import { ASSESSMENT_THRESHOLDS, matrixAction, type ArchitectureAssessment, type DeadFileGroup, type MatrixFinding, type GroupedCycles, type QuickWin } from "../../analyzer/architecture/architectureAssessment.js";
import { ROOT_UNIT } from "../../analyzer/architecture/architectureUnits.js";

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
  /** The unit or folder key of `--focus`: the assessment and the diagrams cover it and its direct neighbours only. */
  focus?: string;
  /** Workspace-relative rules files written, `*.bak` copies included. */
  written: string[];
  /** Workspace-relative report files written with `--output`: diagrams, index.html and report.md. */
  reportFiles: string[];
  /** The explorable page written with `--output` (#718), linked from report.md. */
  page?: string;
  /** One line per element, rule or accepted violation the proposal adds, changes or removes. */
  changes: string[];
  acceptedViolations: number;
  guard: { preCommit: string; ci: string; sarif: string };
  assessment: ArchitectureAssessment;
  diagrams: InitDiagram[];
}

/** Items listed per section in a terminal; report.md, the page, json and toon list them all. */
export const REPORT_LIMIT = 20;
/** Files listed per dead-file group, and units named on the entry line, as many as evidence lines. */
const ITEM_LIMIT = ASSESSMENT_THRESHOLDS.evidence;

const STATUS: Record<InitResult["status"], string> = {
  created: "written",
  updated: "updated after confirmation (previous files kept as *.bak)",
  unchanged: "already up to date, not rewritten",
  kept: "existing config kept, not rewritten (confirm in a terminal, or pass --yes, to apply the config changes listed below)",
  "dry-run": "dry run: nothing written",
};

/** A code span: backticks and line breaks of a path or symbol cannot break out of it. */
const code = (text: string) => `\`${text.replaceAll(/[`\r\n]/g, "'")}\``;

/** One entry of a section; `subject` comes from the code (paths, unit keys) and goes in a code span. */
interface ReportItem {
  label: string;
  subject: string;
  note?: string;
  details: string[];
  next?: string;
  /** The diagram that shows it: a folder diagram of one of these units, else the fallback view. */
  units: readonly string[];
  fallback?: "units" | "matrix";
}

interface ReportSection {
  title: string;
  /** What the heading counts when it is not the items: "235 files in 22 units". */
  count?: string;
  /** What an item is when the heading counts something else: "unit". */
  noun?: string;
  intro?: string;
  items: ReportItem[];
}

function moreLine(shown: number, total: number, hint: string): string[] {
  return total > shown ? [`... ${total - shown} more${hint}`] : [];
}

const more = (total: number) => moreLine(REPORT_LIMIT, total, " (--format json lists them all)");

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The sub-lines left out of an item: the item's next: command lists them, or the page shows them. */
const NEXT_LISTS = " (next: lists them all)";
/** A cut spans several unit edges; next: lists the first one's file pairs. */
const CUT_EDGES_LIST = " (graph-it architecture --level units --from <unit> --to <unit> lists each cut edge's pairs)";
const pageShows = (page: string | undefined) =>
  ` (${page === undefined ? "the index.html of graph-it init --output" : path.posix.basename(page)} shows them all)`;

/** A unit as the report names it (unitDisplayName, #774); `next:` commands keep the key. */
type UnitName = (key: string) => string;

function unitNamer(assessment: Pick<ArchitectureAssessment, "unitNames">): UnitName {
  const names = new Map(assessment.unitNames.map((unit) => [unit.key, unit.name]));
  return (key) => names.get(key) ?? key;
}

function deadFileItem(group: DeadFileGroup, page: string | undefined, name: UnitName): ReportItem {
  const files = group.files.slice(0, ITEM_LIMIT).map((file) =>
    `${file.relativePath}: ${file.lines === undefined ? "lines unknown" : plural(file.lines, "line")}, ${plural(file.exports, "export")}, ${file.confidence} ${file.reasons.join(", ")}` +
    (file.via ? ` via ${file.via.join(", ")}` : "") +
    (file.tests ? `; delete with ${file.tests.map((test) => test.relativePath).join(", ")}` : ""));
  return {
    label: `${plural(group.files.length, "file")}, ${plural(group.lines, "line")}`,
    subject: name(group.unit),
    details: [...files, ...moreLine(ITEM_LIMIT, group.files.length, page === undefined ? NEXT_LISTS : pageShows(page))],
    next: `graph-it check${group.unit === ROOT_UNIT ? "" : " " + JSON.stringify(group.unit)} --unreferencedFiles`,
    units: [group.unit],
  };
}

const QUICK_WIN_VIEW: Record<QuickWin["kind"], "units" | undefined> = {
  "cycle-break": "units",
  "mutual-import": undefined,
  "weak-dependency": "units",
  "dead-code": undefined,
};

function quickWinItem(win: QuickWin): ReportItem {
  return {
    label: `${win.kind}, gain ${win.gain} / effort ${win.effort}`,
    subject: win.subject,
    details: [...win.evidence, ...moreLine(win.evidence.length, win.totalEvidence, win.kind === "cycle-break" ? CUT_EDGES_LIST : NEXT_LISTS)],
    next: win.next,
    units: win.units,
    fallback: QUICK_WIN_VIEW[win.kind],
  };
}

/** Labels of the grouped cycle items: listed after the runtime cycles, never the top action. */
const GROUPED = { "type-only": "whose every import is type-only: design coupling", lazy: "that close through lazy import(s): loaded on demand" };

function groupedItem(label: keyof typeof GROUPED, cycles: GroupedCycles, page: string | undefined, name: UnitName): ReportItem[] {
  if (cycles.unitCycles + cycles.mutualImports === 0) return [];
  return [{
    label,
    subject: [...cycles.units.slice(0, ITEM_LIMIT).map(name), ...moreLine(ITEM_LIMIT, cycles.units.length, "")].join(", "),
    note: `${plural(cycles.unitCycles, "unit cycle")} and ${plural(cycles.mutualImports, "mutual file import")} ${GROUPED[label]}, no init-order risk.`,
    details: [...cycles.evidence, ...moreLine(cycles.evidence.length, cycles.totalEvidence, pageShows(page))],
    units: cycles.units,
    fallback: "units",
  }];
}

function findingItem(finding: MatrixFinding, name: UnitName): ReportItem {
  return { label: finding.kind, subject: finding.rows.map(name).join(", "), note: finding.action, details: finding.evidence, next: finding.next, units: finding.rows, fallback: "matrix" };
}

/** Every entry row in one item: on a serverless or multi-app workspace they are expected and many. */
function entryItem(entries: readonly MatrixFinding[], deadFiles: readonly DeadFileGroup[], name: UnitName): ReportItem[] {
  if (entries.length === 0) return [];
  const rows = entries.flatMap((finding) => finding.rows);
  const withDead = new Set(deadFiles.map((group) => group.unit));
  const dead = rows.filter((row) => withDead.has(row)).length;
  return [{
    label: "entry-row",
    subject: [...rows.slice(0, ITEM_LIMIT).map(name), ...moreLine(ITEM_LIMIT, rows.length, "")].join(", "),
    note: `${plural(rows.length, "unit")} no other unit imports, ${dead} of them with dead files. ${matrixAction("entry-row")}`,
    details: [],
    next: entries.length === 1 ? entries[0].next : "graph-it check --unreferencedFiles",
    units: [],
  }];
}

/** `page`: the page written with the report, which shows every dead file and cycle pair. */
function sections(assessment: ArchitectureAssessment, page?: string): ReportSection[] {
  const { deadFiles, quickWins, matrixFindings, typeOnlyCycles, lazyCycles } = assessment;
  const wins = (...kinds: QuickWin["kind"][]) => quickWins.filter((win) => kinds.includes(win.kind)).map(quickWinItem);
  const findings = (...kinds: MatrixFinding["kind"][]) => matrixFindings.filter((finding) => kinds.includes(finding.kind));
  const name = unitNamer(assessment);
  return [
    {
      title: "Dead files",
      count: `${plural(deadFiles.reduce((total, group) => total + group.files.length, 0), "file")} in ${plural(deadFiles.length, "unit")}`,
      noun: "unit",
      intro: "Files no production file imports, by unit, most lines first: the cheapest deletions. An entry point by convention (script, handler) is listed too: check before deleting.",
      items: deadFiles.map((group) => deadFileItem(group, page, name)),
    },
    {
      title: "Cycles to cut",
      intro: "Runtime cycles ranked by gain / effort, then the type-only and the lazy ones, one item each (see Glossary).",
      items: [...wins("cycle-break", "mutual-import"), ...groupedItem("type-only", typeOnlyCycles, page, name), ...groupedItem("lazy", lazyCycles, page, name)],
    },
    { title: "Hubs", items: findings("hub-at-risk", "wide-row").map((finding) => findingItem(finding, name)) },
    {
      title: "Other leads",
      intro: "Each lead is for the architect, never a verdict.",
      items: [...wins("weak-dependency", "dead-code"), ...findings("cohesion").map((finding) => findingItem(finding, name)), ...entryItem(findings("entry-row"), deadFiles, name)],
    },
  ];
}

/** " (20 shown)" when fewer items are shown than there are; `noun` names what is counted. */
function shownSuffix(shown: number, total: number, noun?: string): string {
  if (shown >= total) return "";
  const count = noun === undefined ? String(shown) : plural(shown, noun);
  return ` (${count} shown)`;
}

/**
 * The sections a report lists: non-empty ones, their first `limit` items (all by default: report.md
 * and the page) and the line counting the rest. The heading says what it counts and how many are
 * shown: "Dead files: 235 files in 22 units", "Cycles to cut: 50 (20 shown)".
 */
export function reportSections(result: Pick<InitResult, "assessment" | "page">, limit = Infinity) {
  return sections(result.assessment, result.page).filter((section) => section.items.length > 0).map(({ count, noun, ...section }) => {
    const shown = Math.min(limit, section.items.length);
    return {
      ...section,
      title: `${section.title}: ${count ?? section.items.length}${shownSuffix(shown, section.items.length, noun)}`,
      items: section.items.slice(0, shown),
      more: moreLine(shown, section.items.length, " (--format json lists them all)"),
    };
  });
}

function summaryLines(result: InitResult, all: readonly ReportSection[]): string[] {
  const t = result.assessment.totals;
  const hotSpot = t.mutualHotSpot;
  const testOnly = result.assessment.deadFiles.flatMap((group) => group.files).filter((file) => file.confidence === "medium").length;
  const hotSpotText = hotSpot === undefined ? "" : ` (hot spot: ${hotSpot.file} in ${hotSpot.pairs})`;
  const cascade = result.assessment.deadFiles.flatMap((group) => group.files).filter((file) => file.via !== undefined).length;
  const importedBy = [testOnly === 0 ? "" : `${testOnly} only imported by tests`, cascade === 0 ? "" : `${cascade} only imported by dead files`]
    .filter(Boolean).join(", ");
  const testOnlyText = importedBy === "" ? "" : ` (${importedBy})`;
  const topText = topAction(result.assessment, all);
  const byReason = Object.entries(t.unusedExportsMediumByReason)
    .sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))
    .map(([reason, count]) => `${reason} ${count}`).join(", ");
  const mediumText = byReason === "" ? "" : ` (by reason: ${byReason})`;
  const { focus } = result;
  return [
    ...(focus === undefined ? [] : [
      `Focus: ${focus} and its direct neighbours only (the files importing it or imported by it); the rules files cover the whole workspace`,
    ]),
    focus === undefined
      ? `Size: ${plural(t.files, "file")} in ${plural(t.units, "unit")}, ${plural(t.unitEdges, "unit edge")}`
      : `Size: ${plural(t.files, "file")} in ${focus}, ${plural(t.units, "unit")} with its neighbours, ${plural(t.unitEdges, "unit edge")} through it`,
    `Cycles: ${plural(t.unitCycles, "runtime unit cycle")}, ${plural(t.mutualImports, "runtime mutual file import")}${hotSpotText}; type-only: ${plural(t.typeOnlyUnitCycles, "unit cycle")}, ${plural(t.typeOnlyMutualImports, "mutual file import")}; lazy: ${plural(t.lazyUnitCycles, "unit cycle")}, ${plural(t.lazyMutualImports, "mutual file import")}`,
    `Dead files: ${plural(t.deadFiles, "file")} no production file imports, ${plural(t.deadFileLines, "line")} with their tests${testOnlyText}`,
    `Unused exports: ${t.unusedExports} high-confidence in ${plural(t.deadCodeFiles, "file")} listed; not listed: ${t.unusedExportsMedium} medium${mediumText}, graph-it check --minConfidence medium; ${t.unusedExportsLow} low, graph-it check --minConfidence low`,
    `Top action: ${topText}`,
  ];
}

/**
 * A dead file with exports first: an export-less unreferenced file is most often an entry point
 * (main.ts, a script), never the first thing to delete. Else the first item of the other sections.
 */
function topAction(assessment: ArchitectureAssessment, all: readonly ReportSection[]): string {
  const file = assessment.deadFiles.flatMap((group) => group.files).find((dead) => dead.exports > 0);
  if (file !== undefined) {
    // low: nothing imports it, an entry point by convention as often as dead code.
    const verb = file.confidence === "low" ? "check, then delete" : "delete";
    return `${verb} ${file.relativePath} (dead file: ${file.lines === undefined ? "lines unknown" : plural(file.lines, "line")}, ${plural(file.exports, "export")}, ${file.confidence})`;
  }
  const actionable = (item: ReportItem) => !Object.hasOwn(GROUPED, item.label);
  const section = [...all.slice(1), all[0]].find((candidate) => candidate.items.some(actionable));
  const top = section?.items.find(actionable);
  return top === undefined ? "none, nothing to clean up" : `${top.subject} (${section!.title.toLowerCase()}: ${top.label})`;
}

/** `configFile`: the file name as the format shows it (a code span in markdown). */
function rulesLine(result: InitResult, configFile: string): string {
  return `Rules: ${configFile}: ${STATUS[result.status]}; the proposed baseline accepts ${plural(result.acceptedViolations, "current violation")}.`;
}

/** The diagram that shows an item: a hot-spot folder diagram of one of its units, else the units or matrix diagram. */
function diagramFor(diagrams: readonly InitDiagram[], item: ReportItem): InitDiagram | undefined {
  return diagrams.find((diagram) => diagram.view === "folder" && item.units.includes(diagram.unit ?? ""))
    ?? diagrams.find((diagram) => diagram.view === item.fallback);
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function textItem(item: ReportItem): string[] {
  return [
    `  [${item.label}] ${item.subject}${item.note === undefined ? "" : ": " + item.note}`,
    ...item.details.map((detail) => `      ${detail}`),
    ...(item.next === undefined ? [] : [`      next: ${item.next}`]),
  ];
}

export function renderInitText(result: InitResult): string {
  const all = sections(result.assessment);
  const lines = [
    rulesLine(result, result.configFile),
    ...result.written.map((file) => `  wrote ${file}`),
    ...(result.reportFiles.length === 0 ? [] : [`Report: wrote ${result.reportFiles.join(", ")}`]),
    "",
    "Summary:",
    ...summaryLines(result, all).map((line) => `  ${line}`),
  ];
  for (const section of reportSections(result, REPORT_LIMIT)) {
    lines.push("", section.title, ...(section.intro === undefined ? [] : [`  ${section.intro}`]),
      ...section.items.flatMap(textItem), ...section.more);
  }
  const guide = result.assessment.matrixGuide;
  lines.push("", "How to read the matrix:", ...guide.reading.map((line) => `  ${line}`),
    ...guide.patterns.map(({ pattern, meaning, action }) => `  ${pattern}: ${meaning} ${action}`),
    "", "Glossary:", ...Object.entries(result.assessment.glossary).map(([term, meaning]) => `  ${term}: ${meaning}`));
  if (result.diagrams.length > 0) lines.push("", "Diagrams:", ...result.diagrams.map((diagram) => `  ${diagram.file}`));
  if (result.changes.length > 0) {
    const shown = Math.min(REPORT_LIMIT, result.changes.length);
    lines.push("", `Config changes: ${result.changes.length}${shownSuffix(shown, result.changes.length)}`,
      ...result.changes.slice(0, shown).map((change) => `  ${change}`), ...more(result.changes.length));
  }
  lines.push(
    "",
    "Guard:",
    `  pre-commit: ${result.guard.preCommit}`,
    `  CI:         ${result.guard.ci}`,
    "  Code scanning (SARIF):",
    ...result.guard.sarif.split("\n").map((line) => `    ${line}`),
  );
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

function markdownItem(item: ReportItem, diagrams: readonly InitDiagram[], base: string | undefined): string[] {
  return [
    `- **${item.label}**: ${code(item.subject)}${item.note === undefined ? "" : " " + item.note}${link(diagramFor(diagrams, item), base)}`,
    ...item.details.map((detail) => `  - ${code(detail)}`),
    ...(item.next === undefined ? [] : [`  - next: ${code(item.next)}`]),
  ];
}

/** `base`: the folder the report is written to, so its diagram links are relative to it. */
export function renderInitMarkdown(result: InitResult, base?: string): string {
  const all = sections(result.assessment);
  const lines = [
    "# Architecture report (graph-it init)",
    "",
    rulesLine(result, code(result.configFile)),
    ...result.written.map((file) => `- wrote ${code(file)}`),
  ];
  if (result.reportFiles.length > 0) lines.push("", `Report: wrote ${result.reportFiles.map(code).join(", ")}.`);
  if (result.page !== undefined) {
    lines.push("", `Explore: [${path.posix.basename(result.page)}](${encodeURI(base === undefined ? result.page : path.posix.relative(base, result.page))}): units as groups, findings, cycles, violations and dead files, offline.`);
  }
  lines.push("", "## Summary", "", ...summaryLines(result, all).map((line) => `- ${line}`));
  for (const section of reportSections(result)) {
    lines.push("", `## ${section.title}`, "", ...(section.intro === undefined ? [] : [section.intro, ""]),
      ...section.items.flatMap((item) => markdownItem(item, result.diagrams, base)), ...section.more);
  }
  const guide = result.assessment.matrixGuide;
  const matrixDiagram = result.diagrams.find((diagram) => diagram.view === "matrix");
  lines.push("", "## How to read the matrix", "", ...guide.reading.map((line) => `- ${line}`), "",
    "| Pattern | What it means | What to do |", "| --- | --- | --- |",
    ...guide.patterns.map(({ pattern, meaning, action }) => `| ${pattern} | ${meaning} | ${action} |`),
    ...(matrixDiagram === undefined ? [] : ["", `The matrix:${link(matrixDiagram, base)}; on the page, the Dependency matrix panel lists the file pairs of a clicked cell.`]),
    "", "## Glossary", "", ...Object.entries(result.assessment.glossary).map(([term, meaning]) => `- **${term}**: ${meaning}`));
  if (result.diagrams.length > 0) {
    lines.push("", "## Diagrams", "", ...result.diagrams.map((diagram) => `- ${diagram.view}${diagram.unit === undefined ? "" : " " + code(unitNamer(result.assessment)(diagram.unit))}${link(diagram, base)}`));
  }
  if (result.changes.length > 0) {
    // Longer than any backtick run of the config text (rule reasons), so it cannot close early.
    const fence = "`".repeat(Math.max(3, ...result.changes.flatMap((change) => change.match(/`+/g) ?? []).map((run) => run.length + 1)));
    lines.push("", `## Config changes: ${result.changes.length}`, "", `${fence}text`, ...result.changes, fence);
  }
  lines.push(
    "", "## Guard", "",
    "Pre-commit hook:", "", "```sh", result.guard.preCommit, "```", "",
    "CI step:", "", "```yaml", result.guard.ci, "```", "",
    "Code scanning (SARIF):", "", "```yaml", result.guard.sarif, "```",
  );
  return `${lines.join("\n")}\n`;
}
