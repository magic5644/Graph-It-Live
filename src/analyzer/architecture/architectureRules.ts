/**
 * Declared architecture rules: `graphit.architecture.json` names elements (files selected by
 * path patterns or units) and rules on the imports between them. Shared by
 * `graph-it check-architecture`, the check_architecture MCP tool and the extension's view.
 * Rules are human annotation: the check only compares static import pairs with them (#300).
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import ignore from "ignore";
import { z } from "zod/v4";
import { normalizePath } from "../../shared/path";
import { validateWorkspacePath } from "../../shared/pathSecurity";
import type { ArchitectureGraph } from "./ArchitectureGraphBuilder";
import { assignUnits, byCodeUnit, type UnitAssignment } from "./architectureUnits";
import { layerGraph } from "./stronglyConnectedComponents";

export const ARCHITECTURE_CONFIG_FILE = "graphit.architecture.json";
export const ARCHITECTURE_BASELINE_FILE = "graphit.architecture.baseline.json";
/** Files larger than these are refused before they are read. */
export const MAX_CONFIG_BYTES = 256 * 1024;
export const MAX_BASELINE_BYTES = 32 * 1024 * 1024;
const MAX_ELEMENTS = 256;
const MAX_PATTERNS = 128;
const MAX_RULES = 256;
/** `noCycles: "units"` checks the units; no element may take that name. */
const UNITS = "units";

const NameSchema = z.string().regex(/^[\w.-]{1,64}$/, "use 1-64 letters, digits, _, . or -");
const PatternSchema = z
  .string()
  .max(512)
  .refine((pattern) => pattern.trim() !== "", "empty pattern")
  .refine((pattern) => !/\\|^[A-Za-z]:|(^|\/)\.\.(\/|$)/.test(pattern), "patterns stay inside the workspace: no backslash, drive letter or ..");
const UnitPatternSchema = z.string().max(214).refine((pattern) => pattern.trim() !== "", "empty pattern");
const oneOrMany = <T extends z.ZodType>(item: T) => z.union([item, z.array(item).min(1).max(MAX_PATTERNS)]);

const ElementSchema = z
  .strictObject({
    path: oneOrMany(PatternSchema).optional()
      .describe("Workspace-relative gitignore-style patterns, as in .graphitignore (e.g. 'frontend/', 'mfe/*')"),
    unit: oneOrMany(UnitPatternSchema).optional()
      .describe("Unit keys or package names (graph-it architecture --level units); * matches any characters"),
    each: z.boolean().optional()
      .describe("Every matched folder or unit is an instance of its own: a rule from this element to itself means another instance"),
  })
  .refine((element) => element.path !== undefined || element.unit !== undefined, "an element needs path or unit");

const RuleSchema = z.strictObject({
  name: z.string().min(1).max(128).describe("Shown with every violation; unique"),
  from: oneOrMany(NameSchema).optional().describe("Elements whose imports the rule checks (forbid, allowOnly)"),
  forbid: oneOrMany(NameSchema).optional().describe("Elements the files of from must not import"),
  allowOnly: z.array(NameSchema).max(MAX_ELEMENTS).optional()
    .describe("The only elements the files of from may import, besides their own element instance"),
  noCycles: NameSchema.optional().describe("'units', or an element with each: no import cycle between them"),
  severity: z.enum(["error", "warning", "off"]).optional().describe("error (default) fails graph-it check-architecture; off skips the rule"),
  reason: z.string().max(1000).optional().describe("Why the rule exists, shown with every violation"),
});

type RawRule = z.infer<typeof RuleSchema>;
type ArchitectureConfigElements = Record<string, z.infer<typeof ElementSchema>>;
const KINDS = ["forbid", "allowOnly", "noCycles"] as const;
export type ArchitectureRuleKind = (typeof KINDS)[number];

const asList = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : [value].flat() as T[]);

/** Every element name a rule refers to, with its path in the rule. */
function elementRefs(rule: RawRule): { name: string; at: (string | number)[] }[] {
  const refs = (["from", "forbid", "allowOnly"] as const).flatMap((key) => {
    const value = rule[key];
    return asList(value).map((name, index) => ({ name, at: Array.isArray(value) ? [key, index] : [key] }));
  });
  return rule.noCycles === undefined || rule.noCycles === UNITS ? refs : [...refs, { name: rule.noCycles, at: ["noCycles"] }];
}

/**
 * An element without `each` is one instance, which never breaks a rule against itself: such a
 * rule could never report, so it is refused rather than silently passing.
 */
function selfRuleIssue(rule: RawRule, each: (name: string) => boolean): { message: string; at: string } | undefined {
  if (rule.noCycles !== undefined && rule.noCycles !== UNITS && !each(rule.noCycles)) {
    return { message: `noCycles on "${rule.noCycles}" needs each: true (one instance has no cycle with itself)`, at: "noCycles" };
  }
  const self = asList(rule.forbid).find((name) => asList(rule.from).includes(name) && !each(name));
  return self === undefined ? undefined : { message: `forbidding "${self}" from itself needs each: true (a file never breaks a rule against its own instance)`, at: "forbid" };
}

/** Every rule names one kind and only elements of the config; rule names are unique. */
function checkRule(rule: RawRule, index: number, elements: ArchitectureConfigElements, names: Set<string>, context: z.RefinementCtx) {
  const issue = (message: string, ...at: (string | number)[]) => context.addIssue({ code: "custom", message, path: ["rules", index, ...at] });
  const kinds = KINDS.filter((kind) => rule[kind] !== undefined);
  if (kinds.length !== 1) issue("a rule needs exactly one of forbid, allowOnly or noCycles");
  if (kinds.includes("noCycles") === (rule.from !== undefined)) issue(rule.from === undefined ? "forbid and allowOnly need from" : "noCycles takes no from", "from");
  if (names.has(rule.name)) issue(`duplicate rule name "${rule.name}"`, "name");
  names.add(rule.name);
  const refs = elementRefs(rule);
  for (const { name, at } of refs) {
    if (!(name in elements)) issue(`unknown element "${name}"`, ...at);
  }
  if (refs.some(({ name }) => !(name in elements))) return;
  const self = selfRuleIssue(rule, (name) => elements[name].each === true);
  if (self) issue(self.message, self.at);
}

export const ArchitectureConfigSchema = z
  .strictObject({
    $schema: z.string().optional(),
    elements: z.record(NameSchema, ElementSchema).describe("Named sets of files the rules refer to"),
    rules: z.array(RuleSchema).max(MAX_RULES),
  })
  .superRefine((config, context) => {
    const elements = new Set(Object.keys(config.elements));
    if (elements.size > MAX_ELEMENTS) context.addIssue({ code: "custom", message: `at most ${MAX_ELEMENTS} elements`, path: ["elements"] });
    if (elements.has(UNITS)) context.addIssue({ code: "custom", message: `"${UNITS}" is reserved for noCycles: rename the element`, path: ["elements", UNITS] });
    const names = new Set<string>();
    config.rules.forEach((rule, index) => checkRule(rule, index, config.elements, names, context));
  });

export type ArchitectureConfig = z.infer<typeof ArchitectureConfigSchema>;

function pathSegment(segment: PropertyKey): string {
  if (typeof segment === "number") return `[${segment}]`;
  const key = String(segment);
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

/** `$.rules[0].from`, the JSON path of a config or baseline issue. */
export function jsonPath(segments: readonly PropertyKey[]): string {
  return `$${segments.map(pathSegment).join("")}`;
}

const describeIssues = (file: string, issues: readonly { path: string; message: string }[]) =>
  `${file}: ${issues.map((issue) => issue.path + ": " + issue.message).join("; ")}`;

/** An invalid config or baseline file, with the JSON path of every issue. */
export class ArchitectureRulesFileError extends Error {
  constructor(
    readonly file: string,
    readonly issues: { path: string; message: string }[],
  ) {
    super(describeIssues(file, issues));
    this.name = "ArchitectureRulesFileError";
  }
}

function parseJsonFile<T>(text: string, file: string, maxBytes: number, schema: z.ZodType<T>): T {
  if (Buffer.byteLength(text) > maxBytes) throw new ArchitectureRulesFileError(file, [{ path: "$", message: `larger than ${maxBytes} bytes` }]);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ArchitectureRulesFileError(file, [{ path: "$", message: `not valid JSON (${error instanceof Error ? error.message : String(error)})` }]);
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new ArchitectureRulesFileError(file, result.error.issues.map((issue) => ({ path: jsonPath(issue.path), message: issue.message })));
  }
  return result.data;
}

export function parseArchitectureConfig(text: string, file = ARCHITECTURE_CONFIG_FILE): ArchitectureConfig {
  return parseJsonFile(text, file, MAX_CONFIG_BYTES, ArchitectureConfigSchema);
}

/** One violation a baseline accepts: rule name and workspace-relative file pair. */
export interface BaselineEntry {
  rule: string;
  source: string;
  target: string;
}

const BaselineSchema = z.strictObject({
  version: z.literal(1),
  violations: z.array(z.strictObject({ rule: z.string().max(128), source: z.string().max(4096), target: z.string().max(4096) })),
});

const byEntry = (left: BaselineEntry, right: BaselineEntry) =>
  byCodeUnit(left.rule, right.rule) || byCodeUnit(left.source, right.source) || byCodeUnit(left.target, right.target);

export function parseBaseline(text: string, file = ARCHITECTURE_BASELINE_FILE): BaselineEntry[] {
  // Written on any OS: a baseline edited on Windows may hold backslashes.
  return parseJsonFile(text, file, MAX_BASELINE_BYTES, BaselineSchema).violations.map(({ rule, source, target }) =>
    ({ rule, source: normalizePath(source), target: normalizePath(target) }));
}

/** Baseline file text: every violation, sorted, so it is identical on every OS. */
export function formatBaseline(violations: readonly BaselineEntry[]): string {
  const entries = violations.map(({ rule, source, target }) => ({ rule, source: normalizePath(source), target: normalizePath(target) })).sort(byEntry);
  return `${JSON.stringify({ version: 1, violations: entries }, null, 2)}\n`;
}

/**
 * A config or baseline file in the workspace (relative to its root, or absolute inside it), or
 * undefined when it does not exist. Refused when it leaves the workspace or is too large.
 */
export async function readWorkspaceFile(workspaceRoot: string, file: string, maxBytes: number): Promise<string | undefined> {
  const absolute = validateWorkspacePath(path.resolve(workspaceRoot, file), workspaceRoot);
  let size: number;
  try {
    size = (await fs.promises.stat(absolute)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (size > maxBytes) throw new ArchitectureRulesFileError(file, [{ path: "$", message: `larger than ${maxBytes} bytes` }]);
  return fs.promises.readFile(absolute, "utf8");
}

export interface ArchitectureRulesFiles {
  configFile: string;
  config: ArchitectureConfig;
  baselineFile?: string;
  baseline?: BaselineEntry[];
}

/** Config and baseline files, workspace-relative; `baseline: false` reads no baseline. */
export interface ArchitectureRulesFileNames {
  config?: string;
  baseline?: string | false;
}

/**
 * The config (required) and the baseline (optional: the default file is read when it exists;
 * a named one must exist), each a workspace-relative path.
 */
export async function loadArchitectureRules(workspaceRoot: string, files: ArchitectureRulesFileNames = {}): Promise<ArchitectureRulesFiles> {
  const configFile = normalizePath(files.config ?? ARCHITECTURE_CONFIG_FILE);
  const configText = await readWorkspaceFile(workspaceRoot, configFile, MAX_CONFIG_BYTES);
  if (configText === undefined) throw new Error(`No ${configFile} in the workspace: declare elements and rules there (see "Architecture rules" in the docs).`);
  const config = parseArchitectureConfig(configText, configFile);
  if (files.baseline === false) return { configFile, config };
  const baselineFile = normalizePath(files.baseline ?? ARCHITECTURE_BASELINE_FILE);
  const baselineText = await readWorkspaceFile(workspaceRoot, baselineFile, MAX_BASELINE_BYTES);
  if (baselineText === undefined) {
    if (files.baseline !== undefined) throw new Error(`Baseline ${baselineFile} not found.`);
    return { configFile, config };
  }
  return { configFile, config, baselineFile, baseline: parseBaseline(baselineText, baselineFile) };
}

/** `*` matches any characters, everything else itself (no regular expression from the config). */
export function matchesWildcard(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== "*" && pattern[p] === text[t]) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;
      mark = t;
      p += 1;
    } else if (star >= 0) {
      p = star + 1;
      mark += 1;
      t = mark;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/** Element name → instance, for one file. An element without `each` has one instance: its name. */
type Membership = Map<string, string>;

interface ResolvedElements {
  membership: Map<string, Membership>;
  warnings: string[];
}

/** The shallowest folder (or the file itself) a path matcher selects: the instance of an `each` element. */
function matchedPrefix(matcher: ReturnType<typeof ignore>, file: string): string | undefined {
  if (!matcher.ignores(file)) return undefined;
  const segments = file.split("/");
  for (let depth = 1; depth < segments.length; depth += 1) {
    const folder = segments.slice(0, depth).join("/");
    if (matcher.ignores(`${folder}/`)) return folder;
  }
  return file;
}

function patternWarnings(at: string, value: string | string[] | undefined, matches: (pattern: string) => boolean): string[] {
  const what = at.endsWith("unit") ? "unit" : "file";
  return asList(value).flatMap((pattern, index) => {
    if (pattern.startsWith("!") || matches(pattern)) return [];
    const where = Array.isArray(value) ? `${at}[${index}]` : at;
    return [`${where}: "${pattern}" matches no ${what}`];
  });
}

/** Instance of `file` in one element (path first, then unit), or undefined outside it. */
type InstanceOf = (file: string) => string | undefined;

function elementInstance(name: string, element: ArchitectureConfig["elements"][string], assignment: UnitAssignment): InstanceOf {
  const matcher = element.path === undefined ? undefined : ignore().add(asList(element.path));
  const units = new Set(
    [...assignment.names].filter(([key, unitName]) =>
      asList(element.unit).some((pattern) => matchesWildcard(pattern, key) || matchesWildcard(pattern, unitName))).map(([key]) => key),
  );
  return (file) => {
    const byPath = matcher === undefined ? undefined : matchedPrefix(matcher, file);
    const unit = assignment.unitOf.get(file);
    const byUnit = unit !== undefined && units.has(unit) ? unit : undefined;
    const instance = byPath ?? byUnit;
    if (instance === undefined) return undefined;
    return element.each ? instance : name;
  };
}

/**
 * ponytail: elements × files × folder depth `ignore` calls, then rules × edges; fine for tens of
 * thousands of files and tens of rules, index the files by folder if a large config gets slow.
 */
function resolveElements(config: ArchitectureConfig, files: readonly string[], assignment: UnitAssignment): ResolvedElements {
  const membership = new Map<string, Membership>(files.map((file) => [file, new Map()]));
  const warnings: string[] = [];
  for (const [name, element] of Object.entries(config.elements)) {
    const instanceOf = elementInstance(name, element, assignment);
    for (const file of files) {
      const instance = instanceOf(file);
      if (instance !== undefined) membership.get(file)!.set(name, instance);
    }
    const at = `$.elements${jsonPath([name]).slice(1)}`;
    warnings.push(
      ...patternWarnings(`${at}.path`, element.path, (pattern) => {
        const matcher = ignore().add(pattern);
        return files.some((file) => matcher.ignores(file));
      }),
      ...patternWarnings(`${at}.unit`, element.unit, (pattern) =>
        [...assignment.names].some(([key, unitName]) => matchesWildcard(pattern, key) || matchesWildcard(pattern, unitName))),
    );
  }
  return { membership, warnings };
}

export interface ArchitectureViolation {
  rule: string;
  severity: "error" | "warning";
  /** Workspace-relative importing and imported files. */
  source: string;
  target: string;
  /** Line of the import in `source`, when the analysis knows it. */
  line?: number;
  /** Element instances (`element` or `element (instance)` with each), or unit keys for noCycles units. */
  from: string;
  to: string;
  /** Not in the baseline (every violation without one). */
  new: boolean;
}

type Edge = ArchitectureGraph["edges"][number];
type Found = Pick<ArchitectureViolation, "from" | "to">;

const label = (element: string, instance: string) => (instance === element ? element : `${element} (${instance})`);

function elementLabels(member: Membership | undefined): string {
  return member === undefined || member.size === 0 ? "(no element)" : [...member].map(([element, instance]) => label(element, instance)).join(", ");
}

/** A file of `from` importing a file of a forbidden element, its own instance excepted. */
function forbidViolation(rule: RawRule, source: Membership, target: Membership): Found | undefined {
  for (const from of asList(rule.from)) {
    const fromInstance = source.get(from);
    if (fromInstance === undefined) continue;
    const to = asList(rule.forbid).find((element) => target.has(element) && !(element === from && target.get(element) === fromInstance));
    if (to !== undefined) return { from: label(from, fromInstance), to: label(to, target.get(to)!) };
  }
  return undefined;
}

/** A file of `from` importing a file outside its own instance and the allowed elements. */
function allowOnlyViolation(rule: RawRule, source: Membership, target: Membership): Found | undefined {
  for (const from of asList(rule.from)) {
    const fromInstance = source.get(from);
    if (fromInstance === undefined) continue;
    const allowed = target.get(from) === fromInstance || asList(rule.allowOnly).some((element) => target.has(element));
    if (!allowed) return { from: label(from, fromInstance), to: elementLabels(target) };
  }
  return undefined;
}

/** File pairs between two keys of one import cycle (keys: units, or an element's instances). */
function cycleViolations(edges: readonly Edge[], keyOf: (file: string) => string | undefined): Map<Edge, Found> {
  const across = edges.flatMap((edge) => {
    const from = keyOf(edge.sourceRelative);
    const to = keyOf(edge.targetRelative);
    return from === undefined || to === undefined || from === to ? [] : [{ edge, from, to }];
  });
  const successors = new Map<string, string[]>();
  for (const { from, to } of across) successors.set(from, [...(successors.get(from) ?? []), to]);
  const keys = [...new Set(across.flatMap(({ from, to }) => [from, to]))].sort(byCodeUnit);
  for (const targets of successors.values()) targets.sort(byCodeUnit);
  const { componentOf } = layerGraph(keys, successors);
  return new Map(across.filter(({ from, to }) => componentOf.get(from) === componentOf.get(to)).map(({ edge, from, to }) => [edge, { from, to }]));
}

function ruleViolations(rule: RawRule, graph: ArchitectureGraph, assignment: UnitAssignment, elements: ResolvedElements): Map<Edge, Found> {
  if (rule.noCycles === UNITS) return cycleViolations(graph.edges, (file) => assignment.unitOf.get(file));
  if (rule.noCycles !== undefined) {
    const element = rule.noCycles;
    const found = cycleViolations(graph.edges, (file) => elements.membership.get(file)?.get(element));
    return new Map([...found].map(([edge, { from, to }]) => [edge, { from: label(element, from), to: label(element, to) }]));
  }
  const check = rule.forbid === undefined ? allowOnlyViolation : forbidViolation;
  const found = new Map<Edge, Found>();
  for (const edge of graph.edges) {
    const source = elements.membership.get(edge.sourceRelative);
    if (source === undefined || source.size === 0) continue;
    const violation = check(rule, source, elements.membership.get(edge.targetRelative) ?? new Map());
    if (violation) found.set(edge, violation);
  }
  return found;
}

export interface ArchitectureRuleSummary {
  name: string;
  kind: ArchitectureRuleKind;
  severity: "error" | "warning" | "off";
  reason?: string;
  /** Violating file pairs, and those absent from the baseline. */
  violations: number;
  newViolations: number;
  /** Distinct element (or unit) pairs of the violations, most pairs first. */
  elementPairs: { from: string; to: string; count: number }[];
}

/** Distinct element (or unit) pairs of a rule's violations, most pairs first. */
function elementPairs(violations: readonly Found[]): ArchitectureRuleSummary["elementPairs"] {
  const pairs = new Map<string, { from: string; to: string; count: number }>();
  for (const { from, to } of violations) {
    const pair = pairs.get(`${from}\0${to}`) ?? { from, to, count: 0 };
    pair.count += 1;
    pairs.set(`${from}\0${to}`, pair);
  }
  return [...pairs.values()].sort((left, right) => right.count - left.count || byCodeUnit(left.from, right.from) || byCodeUnit(left.to, right.to));
}

/**
 * Checks every rule against the file pairs of the graph. Element `unit` selectors and noCycles
 * "units" read the unit assignment of `graph-it architecture --level units`. With a baseline,
 * only violations absent from it are new; `resolved` lists its entries no longer found.
 */
export function checkArchitecture(
  graph: ArchitectureGraph,
  assignment: UnitAssignment,
  config: ArchitectureConfig,
  baseline?: readonly BaselineEntry[],
) {
  const files = graph.nodes.map((node) => node.relativePath);
  const elements = resolveElements(config, files, assignment);
  const accepted = new Set((baseline ?? []).map((entry) => `${entry.rule}\0${entry.source}\0${entry.target}`));
  const found = new Set<string>();
  const violations: ArchitectureViolation[] = [];
  const rules: ArchitectureRuleSummary[] = config.rules.map((rule) => {
    const severity = rule.severity ?? "error";
    const kind = KINDS.find((candidate) => rule[candidate] !== undefined)!;
    const own = severity === "off" ? [] : [...ruleViolations(rule, graph, assignment, elements)].map(([edge, pair]) => {
      const key = `${rule.name}\0${edge.sourceRelative}\0${edge.targetRelative}`;
      found.add(key);
      return { rule: rule.name, severity, source: edge.sourceRelative, target: edge.targetRelative, line: edge.line, ...pair, new: !accepted.has(key) };
    });
    violations.push(...own);
    return {
      name: rule.name,
      kind,
      severity,
      reason: rule.reason,
      violations: own.length,
      newViolations: own.filter((violation) => violation.new).length,
      elementPairs: elementPairs(own),
    };
  });
  violations.sort(byEntry);
  const unmatchedFiles = files.filter((file) => elements.membership.get(file)!.size === 0).sort(byCodeUnit);
  // A rule switched off is not checked: its accepted entries are neither found nor resolved.
  const off = new Set(rules.filter((rule) => rule.severity === "off").map((rule) => rule.name));
  const resolved = (baseline ?? [])
    .filter((entry) => !off.has(entry.rule) && !found.has(`${entry.rule}\0${entry.source}\0${entry.target}`))
    .sort(byEntry);
  const count = (severity: "error" | "warning", onlyNew: boolean) =>
    violations.filter((violation) => violation.severity === severity && (!onlyNew || violation.new)).length;
  const revision = createHash("sha256")
    .update(JSON.stringify([graph.context.revision, [...assignment.names].map((entry) => entry.join("\t")).sort(byCodeUnit), config, [...accepted].sort(byCodeUnit)]))
    .digest("hex");
  return {
    context: { ...graph.context, revision, baseline: baseline !== undefined },
    /** False when an error-severity violation is new: graph-it check-architecture exits with 1. */
    passed: count("error", true) === 0,
    totals: {
      files: files.length,
      unmatchedFiles: unmatchedFiles.length,
      rules: rules.length,
      brokenRules: rules.filter((rule) => rule.violations > 0).length,
      violations: violations.length,
      newViolations: violations.filter((violation) => violation.new).length,
      errors: count("error", false),
      newErrors: count("error", true),
      warnings: count("warning", false),
      resolved: resolved.length,
    },
    rules,
    violations,
    resolved,
    unmatchedFiles,
    configWarnings: elements.warnings,
  };
}

export type ArchitectureCheck = ReturnType<typeof checkArchitecture>;

/** Loads the rule files and checks the graph against them: what the CLI, MCP and view report. */
export async function checkWorkspaceArchitecture(
  graph: ArchitectureGraph,
  workspaceRoot: string,
  files: ArchitectureRulesFileNames = {},
) {
  const { configFile, config, baselineFile, baseline } = await loadArchitectureRules(workspaceRoot, files);
  const assignment = assignUnits(workspaceRoot, graph.nodes.map((node) => node.relativePath));
  return { configFile, baselineFile, ...checkArchitecture(graph, assignment, config, baseline) };
}

export type WorkspaceArchitectureCheck = Awaited<ReturnType<typeof checkWorkspaceArchitecture>>;

/**
 * Rule names of every violation, keyed `from>to` by the keys of its two files (units, group
 * ids), for the view's edges and matrix cells; pairs within one key are left out.
 */
export function rulesByEdge(
  violations: readonly Pick<ArchitectureViolation, "rule" | "source" | "target">[],
  keyOf: (file: string) => string | number | undefined,
): Record<string, string[]> {
  const rules = new Map<string, Set<string>>();
  for (const { rule, source, target } of violations) {
    const from = keyOf(source);
    const to = keyOf(target);
    if (from === undefined || to === undefined || from === to) continue;
    rules.set(`${from}>${to}`, (rules.get(`${from}>${to}`) ?? new Set()).add(rule));
  }
  return Object.fromEntries([...rules].map(([key, names]) => [key, [...names].sort(byCodeUnit)]));
}
