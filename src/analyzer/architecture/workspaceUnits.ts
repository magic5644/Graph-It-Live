/**
 * The units of a workspace, as every surface draws them (#776): the declared elements of
 * graphit.architecture.json when it declares any, else the detected projects, with the rules
 * attached to the unit edges they check. The only code that builds units.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { createHash } from "node:crypto";
import type { ArchitectureUnit, ArchitectureUnitEdge, ArchitectureUnits, UnitRuleCheck } from "../../shared/architecture-model";
import { normalizePath } from "../../shared/path";
import type { ArchitectureGraph } from "./ArchitectureGraphBuilder";
import {
  ARCHITECTURE_CONFIG_FILE,
  checkArchitecture,
  declaredUnitPatterns,
  jsonPath,
  label,
  loadArchitectureRules,
  MAX_CONFIG_BYTES,
  readWorkspaceFile,
  resolveElements,
  type ArchitectureConfig,
  type BaselineEntry,
  type Membership,
  type ResolvedElements,
  type WorkspaceArchitectureCheck,
} from "./architectureRules";
import { assignUnits, buildArchitectureUnits, type UnitAssignment } from "./architectureUnits";
import { matchesWildcard } from "./unitRoles";

/** Element unit of the files no element selects: never dropped, always warned about. */
export const UNMATCHED_UNIT = "(unmatched)";

/** What a path-mode build keeps to answer a folder level later. */
export interface UnitSource {
  graph: ArchitectureGraph;
  units: ArchitectureUnits;
  assignment: UnitAssignment;
}

export interface WorkspaceUnitsOptions {
  /** Workspace-relative config; false reads none (detected projects only). Default graphit.architecture.json; a missing default file means no config. */
  config?: string | false;
  /** As ArchitectureRulesFileNames.baseline. */
  baseline?: string | false;
}

export interface WorkspaceUnits extends UnitSource {
  /** The detected (manifest) assignment: `unit`/`role` selectors and noCycles "units" read it. */
  detected: UnitAssignment;
  /** The rule check when a config was read (also with no elements: its configWarnings still apply). */
  check?: WorkspaceArchitectureCheck;
}

type Rule = ArchitectureConfig["rules"][number];
type Edge = ArchitectureGraph["edges"][number];

const asList = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : [value].flat() as T[]);

/** Reads the config and baseline, then calls workspaceUnits. Throws ArchitectureRulesFileError on a refused config. */
export async function loadWorkspaceUnits(graph: ArchitectureGraph, workspaceRoot: string, options: WorkspaceUnitsOptions = {}): Promise<WorkspaceUnits> {
  if (options.config === false) return workspaceUnits(graph, workspaceRoot);
  const configFile = normalizePath(options.config ?? ARCHITECTURE_CONFIG_FILE);
  // Only the default file may be missing: a named one must exist (loadArchitectureRules says so).
  if (options.config === undefined && await readWorkspaceFile(workspaceRoot, configFile, MAX_CONFIG_BYTES) === undefined) {
    return workspaceUnits(graph, workspaceRoot);
  }
  const { config, baseline, baselineFile } = await loadArchitectureRules(workspaceRoot, { config: configFile, baseline: options.baseline });
  return workspaceUnits(graph, workspaceRoot, config, baseline, { configFile, baselineFile });
}

/** The deepest folder holding every file, "" when they share none. */
function commonFolder(files: readonly string[]): string {
  let shared = files[0]?.split("/").slice(0, -1) ?? [];
  for (const file of files) {
    const folders = file.split("/");
    const same = shared.findIndex((folder, index) => folders[index] !== folder || index >= folders.length - 1);
    if (same >= 0) shared = shared.slice(0, same);
  }
  return shared.join("/");
}

/** The detected projects an element made of one `unit` selector selects: its unit then keeps that project's name (#774). */
function singleUnitName(element: ArchitectureConfig["elements"][string], detected: UnitAssignment): string | undefined {
  const patterns = asList(element.unit);
  if (patterns.length !== 1 || element.path !== undefined || element.role !== undefined) return undefined;
  const selected = [...detected.names].filter(([key, name]) => matchesWildcard(patterns[0], key) || matchesWildcard(patterns[0], name));
  return selected.length === 1 ? selected[0][1] : undefined;
}

/**
 * Each file goes to the first declared element selecting it (one unit per instance with each),
 * else to `(unmatched)`. An element first for no file is no unit (init's acyclic-units). Warns
 * about unmatched files and about an element unit that loses files to an earlier element.
 */
function elementAssignment(config: ArchitectureConfig, files: readonly string[], detected: UnitAssignment, elements: ResolvedElements) {
  const unitOf = new Map<string, string>();
  const elementOf = new Map<string, string>();
  const filesOf = new Map<string, string[]>();
  const lost = new Map<string, number>();
  for (const file of files) {
    const [first, ...others] = elements.membership.get(file)!;
    const key = first === undefined ? UNMATCHED_UNIT : label(first[0], first[1]);
    unitOf.set(file, key);
    if (first !== undefined) elementOf.set(key, first[0]);
    filesOf.set(key, [...filesOf.get(key) ?? [], file]);
    for (const [element] of others) lost.set(`${element}\0${first[0]}`, (lost.get(`${element}\0${first[0]}`) ?? 0) + 1);
  }
  const names = new Map<string, string>();
  const folders = new Map<string, string>();
  for (const [key, unitFiles] of filesOf) {
    const element = elementOf.get(key);
    names.set(key, (element === undefined ? undefined : singleUnitName(config.elements[element], detected)) ?? key);
    folders.set(key, key === UNMATCHED_UNIT ? "" : commonFolder(unitFiles));
  }
  const unitElements = new Set(elementOf.values());
  const warnings = [
    ...[...lost].filter(([pair]) => unitElements.has(pair.split("\0")[0])).map(([pair, count]) => {
      const [element, first] = pair.split("\0");
      return `$.elements${jsonPath([element]).slice(1)}: ${count} of its ${count === 1 ? "files is" : "files are"} also in "${first}", declared first: drawn in unit "${first}"`;
    }),
    ...(filesOf.has(UNMATCHED_UNIT)
      ? [`$.elements: ${filesOf.get(UNMATCHED_UNIT)!.length} ${filesOf.get(UNMATCHED_UNIT)!.length === 1 ? "file matches" : "files match"} no element; drawn in unit "${UNMATCHED_UNIT}"`]
      : []),
  ];
  return { assignment: { unitOf, names, folders, kinds: detected.kinds }, elementOf, warnings };
}

/** Whether a rule checks a file pair: forbid/allowOnly by source membership, noCycles across detected projects or instances. */
function pairChecker(rule: Rule, membership: ReadonlyMap<string, Membership>, detected: UnitAssignment): (edge: Edge) => boolean {
  const between = typeof rule.noCycles === "string" ? rule.noCycles : rule.noCycles?.between;
  if (between === "units") return (edge) => detected.unitOf.get(edge.sourceRelative) !== detected.unitOf.get(edge.targetRelative);
  if (between !== undefined) {
    return (edge) => {
      const from = membership.get(edge.sourceRelative)?.get(between);
      const to = membership.get(edge.targetRelative)?.get(between);
      return from !== undefined && to !== undefined && from !== to;
    };
  }
  const from = asList(rule.from);
  return (edge) => from.some((element) => membership.get(edge.sourceRelative)?.has(element) === true);
}

interface Tally { checkedPairs: number; violations: number; newViolations: number }

const emptyTally = (): Tally => ({ checkedPairs: 0, violations: 0, newViolations: 0 });

/** One file pair: checked by the rule, and a violation (new or in the baseline) when `isNew` is set. */
function count(tally: Tally, checked: boolean, isNew: boolean | undefined): void {
  if (checked) tally.checkedPairs += 1;
  if (isNew !== undefined) tally.violations += 1;
  if (isNew === true) tally.newViolations += 1;
}

const verdictOf = ({ violations, newViolations }: Tally): UnitRuleCheck["verdict"] => {
  if (newViolations > 0) return "violated";
  return violations > 0 ? "accepted" : "pass";
};

const VERDICT_ORDER: UnitRuleCheck["verdict"][] = ["pass", "accepted", "violated"];

/**
 * Every rule (severity off aside) on the unit edges it checks or a violation of it falls on, and
 * forbid/allowOnly rules on every unit of an element in their `from`, over the pairs leaving it.
 * The verdict comes from the check's violations: violated when one is new, accepted when the
 * baseline holds all of them, else pass.
 */
function attachRules(
  built: ArchitectureUnits,
  graph: ArchitectureGraph,
  config: ArchitectureConfig,
  check: WorkspaceArchitectureCheck,
  context: { membership: ReadonlyMap<string, Membership>; detected: UnitAssignment; assignment: UnitAssignment; elementOf: ReadonlyMap<string, string> },
): Pick<ArchitectureUnits, "units" | "unitEdges"> {
  const { membership, detected, assignment, elementOf } = context;
  const edgeRules = new Map<string, UnitRuleCheck[]>();
  const unitRules = new Map<string, UnitRuleCheck[]>();
  for (const [index, rule] of config.rules.entries()) {
    const summary = check.rules[index];
    if (summary.severity === "off") continue;
    const checks = pairChecker(rule, membership, detected);
    const found = new Map(check.violations.filter((violation) => violation.rule === rule.name).map((violation) => [`${violation.source}\0${violation.target}`, violation.new]));
    const byEdge = new Map<string, Tally>();
    const fromUnits = rule.noCycles === undefined
      ? new Map([...elementOf].filter(([, element]) => asList(rule.from).includes(element)).map(([key]): [string, Tally] => [key, emptyTally()]))
      : new Map<string, Tally>();
    for (const edge of graph.edges) {
      const from = assignment.unitOf.get(edge.sourceRelative)!;
      const to = assignment.unitOf.get(edge.targetRelative)!;
      if (from === to) continue;
      const checked = checks(edge);
      const isNew = found.get(`${edge.sourceRelative}\0${edge.targetRelative}`);
      if (!checked && isNew === undefined) continue;
      const key = `${from}\0${to}`;
      if (!byEdge.has(key)) byEdge.set(key, emptyTally());
      for (const tally of [byEdge.get(key), fromUnits.get(from)]) if (tally) count(tally, checked, isNew);
    }
    const result = (tally: Tally): UnitRuleCheck => ({ name: rule.name, kind: summary.kind, severity: summary.severity as UnitRuleCheck["severity"], ...tally, verdict: verdictOf(tally) });
    for (const [key, tally] of byEdge) edgeRules.set(key, [...edgeRules.get(key) ?? [], result(tally)]);
    for (const [key, tally] of fromUnits) unitRules.set(key, [...unitRules.get(key) ?? [], result(tally)]);
  }
  const units: ArchitectureUnit[] = built.units.map((unit) => (unitRules.has(unit.key) ? { ...unit, rules: unitRules.get(unit.key) } : unit));
  const unitEdges: ArchitectureUnitEdge[] = built.unitEdges.map((edge) => {
    const rules = edgeRules.get(`${edge.from}\0${edge.to}`);
    if (rules === undefined) return edge;
    const ruleVerdict = VERDICT_ORDER[Math.max(...rules.map((rule) => VERDICT_ORDER.indexOf(rule.verdict)))];
    return { ...edge, rules, ruleVerdict };
  });
  return { units, unitEdges };
}

/** With a config, the revision also covers where the units come from, the config and the baseline. */
function revised(units: ArchitectureUnits, check: WorkspaceArchitectureCheck): ArchitectureUnits {
  const revision = createHash("sha256").update(JSON.stringify([units.context.revision, units.unitsFrom, check.context.revision])).digest("hex");
  return { ...units, context: { ...units.context, revision } };
}

/** The same from a config held in memory (init's merged config, review's config). */
export function workspaceUnits(
  graph: ArchitectureGraph,
  workspaceRoot: string,
  config?: ArchitectureConfig,
  baseline?: readonly BaselineEntry[],
  files?: { configFile: string; baselineFile?: string },
): WorkspaceUnits {
  const paths = graph.nodes.map((node) => node.relativePath);
  const detected = assignUnits(workspaceRoot, paths, config === undefined ? [] : declaredUnitPatterns(config));
  const detectedUnits = buildArchitectureUnits(graph, workspaceRoot, detected, config?.roles);
  if (config === undefined) return { graph, units: detectedUnits, assignment: detected, detected };

  const roleOf = new Map(detectedUnits.units.map((unit) => [unit.key, unit.role]));
  const elements = resolveElements(config, paths, detected, roleOf);
  const check: WorkspaceArchitectureCheck = {
    configFile: files?.configFile ?? ARCHITECTURE_CONFIG_FILE,
    baselineFile: files?.baselineFile,
    ...checkArchitecture(graph, detected, config, baseline, roleOf, elements),
  };
  const fromElements = Object.keys(config.elements).length > 0;
  const declared = fromElements ? elementAssignment(config, paths, detected, elements) : { assignment: detected, elementOf: new Map<string, string>(), warnings: [] };
  const built = fromElements ? buildArchitectureUnits(graph, workspaceRoot, declared.assignment, config.roles, "elements") : detectedUnits;
  const attached = attachRules(built, graph, config, check, { membership: elements.membership, detected, assignment: declared.assignment, elementOf: declared.elementOf });
  const units: ArchitectureUnits = {
    ...built,
    ...attached,
    configFile: check.configFile,
    ...(check.baselineFile === undefined ? {} : { baselineFile: check.baselineFile }),
    configWarnings: [...check.configWarnings, ...declared.warnings],
    ...(check.rules.length > 0 ? { rules: check.rules } : {}),
  };
  return { graph, units: revised(units, check), assignment: declared.assignment, detected, check };
}
