import { describe, expect, it } from "vitest";
import { ACYCLIC_ELEMENT, describeConfigChanges, elementName, generateArchitectureConfig } from "@/analyzer/architecture/architectureInit";
import { ArchitectureConfigSchema, type ArchitectureConfig } from "@/analyzer/architecture/architectureRules";
import type { ArchitectureUnitEdge, ArchitectureUnits } from "@/shared/architecture-model";

type Units = Pick<ArchitectureUnits, "units" | "unitEdges">;

/** Units from their keys and `from>to` edges; `cycle` marks the edges between units of one cycle. */
function units(keys: string[], edges: string[] = [], cycle: string[] = []): Units {
  return {
    units: keys.map((key) => ({ key, name: key, fileCount: 1, internalEdgeCount: 0, layer: 0, role: "library", confidence: "inferred", evidence: [] })),
    unitEdges: edges.map((edge): ArchitectureUnitEdge => {
      const [from, to] = edge.split(">");
      return { from, to, fileEdgeCount: 1, kind: cycle.includes(from) && cycle.includes(to) ? "cycle" : "down" };
    }),
  } as Units;
}

describe("elementName", () => {
  it.each([
    ["(root)", "root"],
    ["packages/core", "packages-core"],
    ["packages/platform-socket.io", "packages-platform-socket.io"],
    ["@scope/a b", "scope-a-b"],
    ["units", "unit-units"],
    ["///", "unit"],
    ["a".repeat(80), "a".repeat(64)],
  ])("%s → %s", (key, name) => {
    expect(elementName(key)).toBe(name);
    expect(name).toMatch(/^[\w.-]{1,64}$/);
  });
});

describe("generateArchitectureConfig", () => {
  it("writes one element and one allowOnly rule per unit, and noCycles over the acyclic units", () => {
    const config = generateArchitectureConfig(units(["app", "core", "ui", "util"], ["app>core", "app>ui", "ui>util", "util>ui"], ["ui", "util"]));
    expect(ArchitectureConfigSchema.parse(config)).toEqual(config);
    expect(config.elements).toEqual({
      app: { unit: "app" },
      core: { unit: "core" },
      ui: { unit: "ui" },
      util: { unit: "util" },
      [ACYCLIC_ELEMENT]: { unit: ["app", "core"], each: true },
    });
    expect(config.rules.map(({ name, from, allowOnly, noCycles }) => ({ name, from, allowOnly, noCycles }))).toEqual([
      { name: "app-imports", from: "app", allowOnly: ["core", "ui"], noCycles: undefined },
      { name: "core-imports", from: "core", allowOnly: [], noCycles: undefined },
      { name: "ui-imports", from: "ui", allowOnly: ["util"], noCycles: undefined },
      { name: "util-imports", from: "util", allowOnly: ["ui"], noCycles: undefined },
      { name: "no-new-unit-cycles", from: undefined, allowOnly: undefined, noCycles: ACYCLIC_ELEMENT },
    ]);
    expect(config.rules.every((rule) => rule.reason?.startsWith("graph-it init:"))).toBe(true);
  });

  it("adds no noCycles rule with fewer than two acyclic units, and handles an empty workspace", () => {
    expect(generateArchitectureConfig(units(["a", "b", "c"], ["a>b", "b>a"], ["a", "b"])).rules.some((rule) => rule.noCycles)).toBe(false);
    const empty = generateArchitectureConfig(units([]));
    expect(empty).toMatchObject({ elements: {}, rules: [] });
    expect(ArchitectureConfigSchema.parse(empty)).toEqual(empty);
  });

  it("keeps every element and rule of an existing config and only adds the missing ones", () => {
    const existing: ArchitectureConfig = {
      $schema: "custom.json",
      elements: { core: { path: "core/" }, web: { unit: "app" } },
      rules: [{ name: "web-only-core", from: "web", allowOnly: [] }, { name: "app-imports", from: "core", forbid: "web" }, { name: "layers", noCycles: "units" }],
      roles: { app: "frontend" },
    };
    const config = generateArchitectureConfig(units(["app", "core"], ["app>core"]), existing);
    expect(ArchitectureConfigSchema.parse(config)).toEqual(config);
    expect(config.$schema).toBe("custom.json");
    expect(config.roles).toEqual({ app: "frontend" });
    // "app" is already selected by "web", which already has an allowOnly rule; "core" is taken by a path element.
    expect(config.elements).toEqual({ core: { path: "core/" }, web: { unit: "app" }, "core-2": { unit: "core" } });
    expect(config.rules.slice(0, 3)).toEqual(existing.rules);
    expect(config.rules.slice(3)).toEqual([expect.objectContaining({ name: "core-2-imports", from: "core-2", allowOnly: [] })]);
  });

  it("is idempotent: a second run on its own output changes nothing", () => {
    const input = units(["a", "b", "c"], ["a>b", "b>c"]);
    const first = generateArchitectureConfig(input);
    expect(generateArchitectureConfig(input, first)).toEqual(first);
    expect(describeConfigChanges({ config: first, baseline: [] }, { config: generateArchitectureConfig(input, first), baseline: [] })).toEqual([]);
  });

  it("selects a unit by its package name when its key also matches another unit", () => {
    const input = units(["core", "packages/core", "a*", "ab"]);
    // "core" is also the package name of packages/core; "a*" is a wildcard that also matches "ab".
    input.units[0].name = "@acme/root-core";
    input.units[1].name = "core";
    input.units[2].name = "lib-a";
    const config = generateArchitectureConfig(input);
    expect(config.elements).toMatchObject({
      core: { unit: "@acme/root-core" },
      "packages-core": { unit: "packages/core" },
      a: { unit: "lib-a" },
      ab: { unit: "ab" },
      [ACYCLIC_ELEMENT]: { unit: expect.arrayContaining(["@acme/root-core", "packages/core", "lib-a", "ab"]) },
    });
  });

  it("dedupes names that collide and keeps them within the schema limits", () => {
    const config = generateArchitectureConfig(units(["a/b", "a-b", "x".repeat(70), `${"x".repeat(64)}y`]));
    expect(Object.keys(config.elements)).toEqual(expect.arrayContaining(["a-b", "a-b-2", "x".repeat(64), `${"x".repeat(62)}-2`]));
    expect(ArchitectureConfigSchema.parse(config)).toEqual(config);
  });
});

describe("describeConfigChanges", () => {
  const before: ArchitectureConfig = { elements: { a: { unit: "a" }, gone: { unit: "g" } }, rules: [{ name: "r", from: "a", allowOnly: [] }], roles: { a: "library" } };
  const after: ArchitectureConfig = { $schema: "s.json", elements: { a: { unit: "a" }, b: { unit: "b" } }, rules: [{ name: "r", from: "a", allowOnly: ["b"] }] };

  it("lists added, changed and removed elements, rules, keys and accepted violations", () => {
    const changes = describeConfigChanges(
      { config: before, baseline: [{ rule: "r", source: "a/x.ts", target: "b/y.ts" }, { rule: "r", source: "a/old.ts", target: "b/y.ts" }] },
      { config: after, baseline: [{ rule: "r", source: "a/x.ts", target: "b/y.ts" }, { rule: "r", source: "a/new.ts", target: "b/y.ts" }] },
    );
    expect(changes).toEqual([
      '+ element "b": {"unit":"b"}',
      '- element "gone": {"unit":"g"}',
      '~ rule "r": {"name":"r","from":"a","allowOnly":[]} -> {"name":"r","from":"a","allowOnly":["b"]}',
      '~ $schema: undefined -> "s.json"',
      '~ roles: {"a":"library"} -> undefined',
      "+ accepted violation r: a/new.ts -> b/y.ts",
      "- accepted violation r: a/old.ts -> b/y.ts",
    ]);
  });

  it("lists everything as added without a previous config", () => {
    expect(describeConfigChanges({}, { config: after, baseline: [] })).toEqual([
      '+ element "a": {"unit":"a"}',
      '+ element "b": {"unit":"b"}',
      '+ rule "r": {"name":"r","from":"a","allowOnly":["b"]}',
    ]);
  });
});
