/**
 * `graph-it init`: a graphit.architecture.json that captures the code as it is today, so that
 * only new drift fails `graph-it check-architecture` (#664). One element and one `allowOnly`
 * rule per unit (the units it imports today), and one `noCycles` rule over the units outside
 * every cycle. An existing config is kept: its elements and rules are never changed or removed,
 * the generated ones are only added where the config has none for that unit.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import type { ArchitectureUnits } from "../../shared/architecture-model";
import type { ArchitectureConfig, BaselineEntry } from "./architectureRules";
import { byCodeUnit, ROOT_UNIT } from "./architectureUnits";
import { matchesWildcard } from "./unitRoles";

export const ARCHITECTURE_SCHEMA_URL = "https://raw.githubusercontent.com/magic5644/Graph-It-Live/main/schemas/architecture.schema.json";
/** Element of the units outside every cycle, and its noCycles rule. */
export const ACYCLIC_ELEMENT = "acyclic-units";
const NO_CYCLES_RULE = "no-new-unit-cycles";
/** Same limits as the config schema: element names, and `units`, reserved for noCycles. */
const MAX_NAME = 64;
const RESERVED = "units";

type Element = ArchitectureConfig["elements"][string];
type Rule = ArchitectureConfig["rules"][number];

const asList = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : [value].flat() as T[]);

/** An element name of the config schema (1-64 of `[\w.-]`) for a unit key. */
export function elementName(unitKey: string): string {
  if (unitKey === ROOT_UNIT) return "root";
  const name = unitKey.replaceAll(/[^\w.-]+/g, "-").replaceAll(/^-+|-+$/g, "").slice(0, MAX_NAME);
  return name === "" || name === RESERVED ? `unit-${name}`.slice(0, MAX_NAME).replace(/-$/, "") : name;
}

/** `wanted`, or `wanted-2`, `-3`... cut to the length limit, the first that `taken` refuses. */
function freeName(wanted: string, taken: (name: string) => boolean, maxLength = MAX_NAME): string {
  if (!taken(wanted)) return wanted;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const name = `${wanted.slice(0, maxLength - suffix.length)}${suffix}`;
    if (!taken(name)) return name;
  }
}

/** The name of an element equal to `element` (an earlier init), or a new one added under a free name. */
function addElement(elements: Record<string, Element>, wanted: string, element: Element): string {
  const json = JSON.stringify(element);
  const same = Object.entries(elements).find(([, existing]) => JSON.stringify(existing) === json);
  if (same) return same[0];
  const name = freeName(wanted, (candidate) => candidate in elements || candidate === RESERVED);
  elements[name] = element;
  return name;
}

function addRule(rules: Rule[], rule: Rule): void {
  const names = new Set(rules.map((existing) => existing.name));
  rules.push({ ...rule, name: freeName(rule.name, (candidate) => names.has(candidate), 128) });
}

/**
 * The `unit` selector of each unit: its key, else its package name, the first that selects no
 * other unit (a `unit` pattern matches keys and package names, and `*` is a wildcard).
 * shortcut: falls back to the key when both are ambiguous (a key equal to another unit's package name
 * and a package name equal to another key); use `path` selectors if such a workspace shows up.
 */
function unitSelectors(units: readonly { key: string; name: string }[]): Map<string, string> {
  const selects = (pattern: string, unit: { key: string; name: string }) => matchesWildcard(pattern, unit.key) || matchesWildcard(pattern, unit.name);
  const unique = (pattern: string) => units.filter((unit) => selects(pattern, unit)).length === 1;
  return new Map(units.map((unit) => [unit.key, [unit.key, unit.name].find(unique) ?? unit.key]));
}

/**
 * The config of the code today, merged into `existing` (kept as is): an element per unit
 * (`unit: <key>`), an `allowOnly` rule per unit whose element is the `from` of no allowOnly
 * rule yet, and a `noCycles` rule over the acyclic units when the config has none.
 */
export function generateArchitectureConfig(units: Pick<ArchitectureUnits, "units" | "unitEdges">, existing?: ArchitectureConfig): ArchitectureConfig {
  const config: ArchitectureConfig = {
    $schema: existing?.$schema ?? ARCHITECTURE_SCHEMA_URL,
    elements: { ...existing?.elements },
    rules: [...(existing?.rules ?? [])],
    ...(existing?.roles === undefined ? {} : { roles: existing.roles }),
  };
  const keys = units.units.map((unit) => unit.key).sort(byCodeUnit);
  const selectorOf = unitSelectors(units.units);
  const elementOf = new Map(keys.map((key) => [key, addElement(config.elements, elementName(key), { unit: selectorOf.get(key)! })]));
  const imports = new Map<string, Set<string>>();
  for (const edge of units.unitEdges) imports.set(edge.from, (imports.get(edge.from) ?? new Set()).add(edge.to));

  const constrained = new Set(config.rules.filter((rule) => rule.allowOnly !== undefined).flatMap((rule) => asList(rule.from)));
  for (const key of keys) {
    const from = elementOf.get(key)!;
    if (constrained.has(from)) continue;
    addRule(config.rules, {
      name: `${from}-imports`,
      from,
      allowOnly: [...(imports.get(key) ?? [])].map((target) => elementOf.get(target)!).sort(byCodeUnit),
      reason: `graph-it init: the units that "${key}" imported when this rule was generated. Remove an entry once its imports are gone; never add one to pass a check.`,
    });
  }

  const inCycle = new Set(units.unitEdges.filter((edge) => edge.kind === "cycle").flatMap((edge) => [edge.from, edge.to]));
  const acyclic = keys.filter((key) => !inCycle.has(key));
  if (acyclic.length >= 2 && !config.rules.some((rule) => rule.noCycles !== undefined)) {
    const element = addElement(config.elements, ACYCLIC_ELEMENT, { unit: acyclic.map((key) => selectorOf.get(key)!), each: true });
    addRule(config.rules, {
      name: NO_CYCLES_RULE,
      noCycles: element,
      reason: "graph-it init: these units were in no import cycle when this rule was generated; keep it that way.",
    });
  }
  return config;
}

/** One line per element, rule or baseline entry that differs between two configs and baselines. */
export function describeConfigChanges(
  before: { config?: ArchitectureConfig; baseline?: readonly BaselineEntry[] },
  after: { config: ArchitectureConfig; baseline: readonly BaselineEntry[] },
): string[] {
  const keyed = <T>(entries: readonly [string, T][]) => new Map(entries.map(([key, value]) => [key, JSON.stringify(value)]));
  const sections: [string, Map<string, string>, Map<string, string>][] = [
    ["element", keyed(Object.entries(before.config?.elements ?? {})), keyed(Object.entries(after.config.elements))],
    ["rule", keyed((before.config?.rules ?? []).map((rule) => [rule.name, rule])), keyed(after.config.rules.map((rule) => [rule.name, rule]))],
  ];
  const lines = sections.flatMap(([what, old, next]) => [
    ...[...next].filter(([key]) => !old.has(key)).map(([key, value]) => `+ ${what} "${key}": ${value}`),
    ...[...next].filter(([key, value]) => old.has(key) && old.get(key) !== value).map(([key, value]) => `~ ${what} "${key}": ${old.get(key)} -> ${value}`),
    ...[...old].filter(([key]) => !next.has(key)).map(([key, value]) => `- ${what} "${key}": ${value}`),
  ]);
  for (const key of ["$schema", "roles"] as const) {
    const old = JSON.stringify(before.config?.[key]);
    const next = JSON.stringify(after.config[key]);
    if (before.config !== undefined && old !== next) lines.push(`~ ${key}: ${old} -> ${next}`);
  }
  const entry = (violation: BaselineEntry) => `${violation.rule}: ${violation.source} -> ${violation.target}`;
  const oldEntries = new Set((before.baseline ?? []).map(entry));
  const newEntries = new Set(after.baseline.map(entry));
  lines.push(
    ...[...newEntries].filter((text) => !oldEntries.has(text)).map((text) => `+ accepted violation ${text}`),
    ...[...oldEntries].filter((text) => !newEntries.has(text)).map((text) => `- accepted violation ${text}`),
  );
  return lines;
}
