/**
 * What a diff does to the declared architecture (#443): the rules of graphit.architecture.json
 * checked on the base and on the head of a review, then compared, so review-pr can say whether
 * the change degrades or improves the architecture.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import type { ArchitectureRuleSummary } from "../../shared/architecture-model";
import { normalizePath } from "../../shared/path";
import { LanguageService } from "../LanguageService";
import { PathResolver } from "../utils/PathResolver";
import { resolveFileImports } from "../utils/resolveFileImports";
import { buildArchitectureGraph, type AnalyzeFile } from "./ArchitectureGraphBuilder";
import {
  ARCHITECTURE_BASELINE_FILE,
  ARCHITECTURE_CONFIG_FILE,
  checkGraphArchitecture,
  MAX_BASELINE_BYTES,
  MAX_CONFIG_BYTES,
  parseArchitectureConfig,
  parseBaseline,
  readWorkspaceFile,
  unitCyclePairs,
  type ArchitectureConfig,
  type ArchitectureViolation,
  type BaselineEntry,
} from "./architectureRules";
import { byCodeUnit } from "./architectureUnits";

/** One import between two files, as a violation or a unit cycle reports it. */
export type ArchitecturePair = Pick<ArchitectureViolation, "source" | "target" | "line" | "from" | "to">;

export interface ArchitecturePairDiff<T extends ArchitecturePair = ArchitecturePair> {
  /** File pairs found at the head, not at the base. */
  newViolations: T[];
  /** File pairs found at the base, no longer at the head. */
  resolvedViolations: ArchitecturePair[];
  /** File pairs found at both. */
  unchanged: number;
}

/** A new violation, and whether the head baseline accepts it (graph-it check-architecture then passes). */
export type NewArchitectureViolation = ArchitecturePair & { accepted: boolean };

/** One rule the head checks: its new, resolved and unchanged violations against the base. */
export interface ArchitectureRuleReview extends Pick<ArchitectureRuleSummary, "name" | "kind" | "severity" | "reason">, ArchitecturePairDiff<NewArchitectureViolation> {}

/** Names (of rules or elements) the diff adds, removes or changes. */
export interface NamedChanges {
  added: string[];
  removed: string[];
  changed: string[];
}

/** What the diff changes in graphit.architecture.json and its baseline. */
export interface ArchitectureConfigChange {
  rules: NamedChanges;
  elements: NamedChanges;
  /** The declared unit roles changed. */
  roles: boolean;
  /** Violations the diff adds to the baseline (accepts), and baseline entries it removes. */
  baseline: { added: BaselineEntry[]; removed: BaselineEntry[] };
}

export interface ArchitectureReview {
  /** degraded: a new violation or unit cycle; improved: resolved ones and none new; else unchanged. */
  verdict: "degraded" | "improved" | "unchanged";
  configFile: string;
  /** New error violations the head baseline does not accept: they raise the review risk and fail the Review Gate. */
  newErrors: number;
  rules: ArchitectureRuleReview[];
  /** Import cycles between units (graph-it architecture --level units), whatever the rules. */
  unitCycles: ArchitecturePairDiff;
  /** Present when the diff edits the config or its baseline. */
  configChange?: ArchitectureConfigChange;
}

/** The rules files of one tree, and its check when a config applies to it. */
export interface ArchitectureSide {
  config?: ArchitectureConfig;
  baseline?: BaselineEntry[];
  check?: {
    violations: ArchitectureViolation[];
    rules: ArchitectureRuleSummary[];
    unitCycles: ArchitecturePair[];
  };
}

/** What reviewArchitecture reads: the workspace, its warmed imports, and copies of Git refs. */
export interface ArchitectureReviewHost {
  workspaceRoot: string;
  /** Imports of a workspace file, e.g. `(file) => spider.analyze(file)`. */
  analyzeFile: AnalyzeFile;
  /** Runs `read` on a private copy of the tracked files of a Git ref. */
  withRefTree<T>(ref: string, read: (directory: string, limitations: string[]) => Promise<T>): Promise<T>;
  /** The commit `git diff base...head` compares `head` with. */
  mergeBase(base: string, head: string): Promise<string>;
  /** Locates the WASM parsers of the non-TypeScript languages. */
  extensionPath?: string;
}

const pairKey = (pair: ArchitecturePair) => `${normalizePath(pair.source)}\0${normalizePath(pair.target)}`;
const entryKey = (entry: BaselineEntry) => `${entry.rule}\0${normalizePath(entry.source)}\0${normalizePath(entry.target)}`;
const toPair = ({ source, target, line, from, to }: ArchitecturePair): ArchitecturePair =>
  ({ source, target, ...(line === undefined ? {} : { line }), from, to });

/** `renewed`: a head pair also at the base that still counts as new (its baseline acceptance was dropped). */
function diffPairs<T extends ArchitecturePair>(base: readonly ArchitecturePair[], head: readonly T[], renewed: (pair: T) => boolean = () => false): ArchitecturePairDiff<T> {
  const before = new Set(base.map(pairKey));
  const after = new Set(head.map(pairKey));
  const newViolations = head.filter((pair) => !before.has(pairKey(pair)) || renewed(pair));
  return {
    newViolations,
    resolvedViolations: base.filter((pair) => !after.has(pairKey(pair))).map(toPair),
    unchanged: head.length - newViolations.length,
  };
}

function namedChanges(before: ReadonlyMap<string, unknown>, after: ReadonlyMap<string, unknown>): NamedChanges {
  const names = (map: ReadonlyMap<string, unknown>, keep: (name: string) => boolean) => [...map.keys()].filter(keep).sort(byCodeUnit);
  return {
    added: names(after, (name) => !before.has(name)),
    removed: names(before, (name) => !after.has(name)),
    changed: names(after, (name) => before.has(name) && JSON.stringify(before.get(name)) !== JSON.stringify(after.get(name))),
  };
}

function configChange(base: ArchitectureSide, head: ArchitectureSide): ArchitectureConfigChange {
  const rules = (side: ArchitectureSide) => new Map((side.config?.rules ?? []).map((rule) => [rule.name, rule]));
  const elements = (side: ArchitectureSide) => new Map(Object.entries(side.config?.elements ?? {}));
  const accepted = (side: ArchitectureSide) => new Set((side.baseline ?? []).map(entryKey));
  const [before, after] = [accepted(base), accepted(head)];
  return {
    rules: namedChanges(rules(base), rules(head)),
    elements: namedChanges(elements(base), elements(head)),
    roles: JSON.stringify(base.config?.roles ?? {}) !== JSON.stringify(head.config?.roles ?? {}),
    baseline: {
      added: (head.baseline ?? []).filter((entry) => !before.has(entryKey(entry))),
      removed: (base.baseline ?? []).filter((entry) => !after.has(entryKey(entry))),
    },
  };
}

/**
 * Compares the checks of the base and the head, rule by rule (by name). Only the rules the
 * head checks are compared: a rule the diff removes or switches off resolves nothing.
 */
export function compareArchitecture(base: ArchitectureSide, head: ArchitectureSide, rulesFilesChanged: boolean): ArchitectureReview {
  const violationsOf = (side: ArchitectureSide, rule: string) => (side.check?.violations ?? []).filter((violation) => violation.rule === rule);
  const rules = (head.check?.rules ?? []).filter((rule) => rule.severity !== "off").map((rule): ArchitectureRuleReview => {
    const headViolations = violationsOf(head, rule.name).map((violation) => ({ ...toPair(violation), accepted: !violation.new }));
    // Accepted by the base baseline, no longer by the head's: check-architecture fails on it again.
    const acceptedAtBase = new Set(violationsOf(base, rule.name).filter((violation) => !violation.new).map(pairKey));
    return {
      name: rule.name,
      kind: rule.kind,
      severity: rule.severity,
      ...(rule.reason === undefined ? {} : { reason: rule.reason }),
      ...diffPairs(violationsOf(base, rule.name), headViolations, (violation) => !violation.accepted && acceptedAtBase.has(pairKey(violation))),
    };
  });
  const unitCycles = diffPairs(base.check?.unitCycles ?? [], (head.check?.unitCycles ?? []).map(toPair));
  const newErrors = rules
    .filter((rule) => rule.severity === "error")
    .reduce((total, rule) => total + rule.newViolations.filter((violation) => !violation.accepted).length, 0);
  const diffs = [...rules, unitCycles];
  let verdict: ArchitectureReview["verdict"] = "unchanged";
  if (diffs.some((diff) => diff.newViolations.length > 0)) verdict = "degraded";
  else if (diffs.some((diff) => diff.resolvedViolations.length > 0)) verdict = "improved";
  return {
    verdict,
    configFile: ARCHITECTURE_CONFIG_FILE,
    newErrors,
    rules,
    unitCycles,
    ...(rulesFilesChanged ? { configChange: configChange(base, head) } : {}),
  };
}

/** Imports of a file of a tree copied from Git, read as Spider.analyze reads the workspace. */
export function treeAnalyzer(root: string, extensionPath?: string): AnalyzeFile {
  const language = new LanguageService(root, undefined, extensionPath);
  const resolver = new PathResolver(undefined, true, root);
  return async (filePath) => {
    const analyzer = language.getAnalyzer(filePath);
    const parsed = await analyzer.parseImports(filePath);
    return (await resolveFileImports(analyzer, filePath, parsed, (resolved) => resolver.isWithinWorkspace(resolved))).dependencies;
  };
}

/**
 * The rules files of the tree at `root`, checked against its import graph with its own config,
 * or `fallback` when it has none. No graph is built without `analyzeFile` or rules.
 */
async function readSide(root: string, ref: string, analyzeFile: AnalyzeFile | undefined, fallback: ArchitectureConfig | undefined, limitations: string[]): Promise<ArchitectureSide> {
  try {
    const configText = await readWorkspaceFile(root, ARCHITECTURE_CONFIG_FILE, MAX_CONFIG_BYTES);
    const baselineText = await readWorkspaceFile(root, ARCHITECTURE_BASELINE_FILE, MAX_BASELINE_BYTES);
    const config = configText === undefined ? undefined : parseArchitectureConfig(configText);
    const baseline = baselineText === undefined ? undefined : parseBaseline(baselineText);
    const rules = config ?? fallback;
    if (analyzeFile === undefined || rules === undefined) return { config, baseline };
    const graph = await buildArchitectureGraph(root, analyzeFile);
    if (graph.failedFiles.length > 0) limitations.push(`Architecture rules at ${ref}: ${graph.failedFiles.length} file(s) could not be analyzed.`);
    const { assignment, check } = checkGraphArchitecture(graph, root, rules, baseline);
    return { config, baseline, check: { violations: check.violations, rules: check.rules, unitCycles: unitCyclePairs(graph, assignment) } };
  } catch (error) {
    throw new Error(`${ref}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * Checks the rules on the head (the working tree at "HEAD", else a copy of the ref) and on the
 * base (a copy of `baseRef`, or of its merge base with an explicit head, as `git diff` compares),
 * with the head config when the base has none, and compares them. Undefined when neither has a config.
 *
 * ponytail: the base graph is built from scratch (every file parsed again); build it from the head
 * graph and the changed files only if review-pr gets slow on large repositories.
 */
export async function reviewArchitecture(
  host: ArchitectureReviewHost,
  changedFiles: readonly string[],
  baseRef: string,
  headRef: string,
): Promise<{ review?: ArchitectureReview; limitations: string[] }> {
  const limitations: string[] = [];
  const head = headRef === "HEAD"
    ? await readSide(host.workspaceRoot, headRef, host.analyzeFile, undefined, limitations)
    : await host.withRefTree(headRef, (directory, copyLimitations) => {
      limitations.push(...copyLimitations);
      return readSide(directory, headRef, treeAnalyzer(directory, host.extensionPath), undefined, limitations);
    });
  const base = await host.withRefTree(headRef === "HEAD" ? baseRef : await host.mergeBase(baseRef, headRef), (directory, copyLimitations) => {
    // Without a head config there is nothing to compare: only the rules files of the base are read.
    if (head.config === undefined) return readSide(directory, baseRef, undefined, undefined, limitations);
    limitations.push(...copyLimitations);
    return readSide(directory, baseRef, treeAnalyzer(directory, host.extensionPath), head.config, limitations);
  });
  if (head.config === undefined && base.config === undefined) return { limitations };
  const rulesFilesChanged = changedFiles.some((file) => [ARCHITECTURE_CONFIG_FILE, ARCHITECTURE_BASELINE_FILE].includes(normalizePath(file)));
  return { review: compareArchitecture(base, head, rulesFilesChanged), limitations };
}

const MAX_MARKDOWN_ITEMS = 20;

/** The architecture section of the review-pr markdown report; `safe` sanitizes table cells and list items. */
export function renderArchitectureMarkdown(review: ArchitectureReview, safe: (value: string) => string): string[] {
  const pair = (rule: string, { source, target, line, from, to }: ArchitecturePair) =>
    `- ${safe(rule)}: ${safe(source)}${line === undefined ? "" : ":" + line} -> ${safe(target)} (${safe(from)} -> ${safe(to)})`;
  const rows = review.rules.map((rule) =>
    `| ${safe(rule.name)} | ${rule.severity} | ${rule.newViolations.length} | ${rule.resolvedViolations.length} | ${rule.unchanged} |`);
  const added = review.rules.flatMap((rule) => rule.newViolations.map((violation) =>
    `${pair(rule.name, violation)}${violation.accepted ? " — accepted by the baseline" : ""}`));
  const resolved = review.rules.flatMap((rule) => rule.resolvedViolations.map((violation) => pair(rule.name, violation)));
  const { unitCycles, configChange } = review;
  const names = (what: string, changes: NamedChanges) => (["added", "removed", "changed"] as const)
    .filter((kind) => changes[kind].length > 0)
    .map((kind) => `- ${what} ${kind}: ${changes[kind].map(safe).join(", ")}`);
  const config = configChange === undefined ? [] : [
    "", `#### ${safe(review.configFile)} or its baseline changed`,
    ...names("Rules", configChange.rules),
    ...names("Elements", configChange.elements),
    ...(configChange.roles ? ["- Unit roles changed"] : []),
    ...(configChange.baseline.added.length + configChange.baseline.removed.length > 0
      ? [`- Baseline: ${configChange.baseline.added.length} violation(s) accepted, ${configChange.baseline.removed.length} entry(ies) removed`]
      : []),
  ];
  const capped = (title: string, lines: string[]) => lines.length === 0 ? [] : ["", title, ...lines.slice(0, MAX_MARKDOWN_ITEMS),
    ...(lines.length > MAX_MARKDOWN_ITEMS ? [`- … ${lines.length - MAX_MARKDOWN_ITEMS} more`] : [])];
  return [
    "", `### Architecture rules: ${review.verdict.toUpperCase()}`,
    "",
    `New error violations: ${review.newErrors}. Unit cycles: ${unitCycles.newViolations.length} new, ${unitCycles.resolvedViolations.length} resolved, ${unitCycles.unchanged} unchanged.`,
    ...(rows.length > 0 ? ["", "| Rule | Severity | New | Resolved | Unchanged |", "| --- | --- | ---: | ---: | ---: |", ...rows] : []),
    ...capped("#### New violations", added),
    ...capped("#### Resolved violations", resolved),
    ...capped("#### New unit cycles", unitCycles.newViolations.map((violation) => pair("units", violation))),
    ...capped("#### Resolved unit cycles", unitCycles.resolvedViolations.map((violation) => pair("units", violation))),
    ...config,
  ];
}
