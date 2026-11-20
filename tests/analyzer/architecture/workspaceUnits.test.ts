import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildArchitectureGraph, type AnalyzeFile } from "@/analyzer/architecture/ArchitectureGraphBuilder";
import { compareArchitecture, renderArchitectureMarkdown } from "@/analyzer/architecture/architectureReview";
import { ArchitectureRulesFileError, checkGraphArchitecture, parseArchitectureConfig, unitCyclePairs, type ArchitectureConfig } from "@/analyzer/architecture/architectureRules";
import { assignUnits, ROOT_UNIT } from "@/analyzer/architecture/architectureUnits";
import { viewArchitecture } from "@/analyzer/architecture/architectureView";
import { loadWorkspaceUnits, UNMATCHED_UNIT, workspaceUnits } from "@/analyzer/architecture/workspaceUnits";
import type { ArchitectureUnits } from "@/shared/architecture-model";
import { normalizePath } from "@/shared/path";

let root: string;

function write(relative: string, content = ""): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Files with their imports (workspace-relative); imports are resolved by the fake analyzer. */
function analyzer(files: Record<string, string[]>): AnalyzeFile {
  for (const relative of Object.keys(files)) if (!fs.existsSync(path.join(root, relative))) write(relative);
  return async (filePath) =>
    (files[normalizePath(path.relative(root, filePath))] ?? []).map((relative) =>
      ({ path: path.join(root, relative), type: "import" as const, line: 1, module: relative }));
}

const graphOf = (files: Record<string, string[]>) => buildArchitectureGraph(root, analyzer(files));
const config = (value: object): ArchitectureConfig => parseArchitectureConfig(JSON.stringify(value));
const unit = (units: ArchitectureUnits, key: string) => units.units.find((entry) => entry.key === key)!;
const edge = (units: ArchitectureUnits, from: string, to: string) => units.unitEdges.find((entry) => entry.from === from && entry.to === to)!;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-wsunits-")));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("workspaceUnits: element units", () => {
  it("puts each file in the first declared element, warns about the files a later element loses", async () => {
    const graph = await graphOf({ "src/a/x.ts": ["src/b/y.ts"], "src/b/y.ts": [], "src/b/z.ts": [] });
    const { units, assignment } = workspaceUnits(graph, root, config({ elements: { a: { path: "src/a/" }, b: { path: "src/" } } }));
    expect(units.unitsFrom).toBe("elements");
    expect(Object.fromEntries(assignment.unitOf)).toEqual({ "src/a/x.ts": "a", "src/b/y.ts": "b", "src/b/z.ts": "b" });
    expect(units.units.map(({ key, name, folder, fileCount }) => ({ key, name, folder, fileCount })).sort((l, r) => l.key.localeCompare(r.key))).toEqual([
      { key: "a", name: "a", folder: "src/a", fileCount: 1 },
      { key: "b", name: "b", folder: "src/b", fileCount: 2 },
    ]);
    expect(units.configWarnings).toEqual(['$.elements.b: 1 of its files is also in "a", declared first: drawn in unit "a"']);
  });

  it("draws no unit for an element first for no file, and warns about nothing then (init's acyclic-units)", async () => {
    const graph = await graphOf({ "a/x.ts": [], "b/y.ts": [] });
    const { units } = workspaceUnits(graph, root, config({ elements: { a: { path: "a/" }, b: { path: "b/" }, "acyclic-units": { path: ["a/", "b/"] } } }));
    expect(units.units.map((entry) => entry.key).sort()).toEqual(["a", "b"]);
    expect(units.configWarnings).toEqual([]);
  });

  it("gives one unit per instance with each, and a never-dropped (unmatched) unit with its warning", async () => {
    const graph = await graphOf({ "mfe/cart/a.ts": ["mfe/checkout/b.ts"], "mfe/checkout/b.ts": [], "docs/x.ts": [], "y.ts": [] });
    const { units } = workspaceUnits(graph, root, config({ elements: { mfe: { path: "mfe/*", each: true } } }));
    expect(units.units.map(({ key, folder }) => [key, folder]).sort()).toEqual([[UNMATCHED_UNIT, ""], ["mfe (mfe/cart)", "mfe/cart"], ["mfe (mfe/checkout)", "mfe/checkout"]]);
    expect(unit(units, UNMATCHED_UNIT).fileCount).toBe(2);
    expect(units.configWarnings).toEqual([`$.elements: 2 files match no element; drawn in unit "${UNMATCHED_UNIT}"`]);
  });

  it("keeps every file in (unmatched) when no element selects any, never an empty unit list", async () => {
    const graph = await graphOf({ "a/x.ts": [] });
    const { units } = workspaceUnits(graph, root, config({ elements: { b: { path: "b/" } } }));
    expect(units.units.map((entry) => entry.key)).toEqual([UNMATCHED_UNIT]);
    expect(units.configWarnings).toEqual(['$.elements.b.path: "b/" matches no file', `$.elements: 1 file matches no element; drawn in unit "${UNMATCHED_UNIT}"`]);
  });

  it("names an element made of one unit selector that selects one project after that project", async () => {
    write("apps/web/package.json", JSON.stringify({ name: "@acme/web" }));
    write("packages/a/package.json", JSON.stringify({ name: "@acme/a" }));
    write("packages/b/package.json", JSON.stringify({ name: "@acme/b" }));
    const graph = await graphOf({ "apps/web/main.ts": ["packages/a/i.ts"], "packages/a/i.ts": [], "packages/b/i.ts": [] });
    const { units } = workspaceUnits(graph, root, config({ elements: {
      web: { unit: "apps/web" },
      libs: { unit: "packages/*" },
    } }));
    expect(unit(units, "web")).toMatchObject({ name: "@acme/web", folder: "apps/web" });
    expect(unit(units, "libs")).toMatchObject({ name: "libs", folder: "packages" });
  });

  it("infers element roles from their files and folder, applies roles by element name, and reads no manifest across folders", async () => {
    write("package.json", JSON.stringify({ name: "app", bin: "cli.js" }));
    const graph = await graphOf({ "src/cli/a.ts": ["src/core/b.ts"], "src/core/b.ts": [], "tests/a.test.ts": ["src/core/b.ts"], "build.js": [] });
    const { units } = workspaceUnits(graph, root, config({
      elements: { cli: { path: "src/cli/" }, core: { path: "src/core/" }, tooling: { path: ["tests/", "/build.js"] } },
      roles: { core: "library" },
    }));
    expect(unit(units, "cli")).toMatchObject({ role: "application", confidence: "inferred", evidence: [{ role: "application", detail: "`bin` in `package.json` (workspace root manifest)" }] });
    expect(unit(units, "core")).toMatchObject({ role: "library", confidence: "declared" });
    // Folder "": no root manifest evidence; build.js is product code (kind other), so no file-kind evidence either.
    expect(unit(units, "tooling")).toMatchObject({ folder: "", role: "unknown" });
  });

  it("reads `role` selectors from the detected projects, and keeps them for noCycles units", async () => {
    write("lib/package.json", JSON.stringify({ name: "lib", main: "i.js" }));
    write("app/package.json", JSON.stringify({ name: "app" }));
    const graph = await graphOf({ "app/a.ts": ["lib/i.ts"], "lib/i.ts": [] });
    const { units, detected } = workspaceUnits(graph, root, config({ elements: { libs: { role: "library" }, rest: { path: "*" } } }));
    expect(units.units.map((entry) => entry.key).sort()).toEqual(["libs", "rest"]);
    expect([...detected.names.keys()].sort()).toEqual(["app", "lib"]);
  });
});

describe("workspaceUnits: rules on unit edges", () => {
  const files = {
    "ui/a.ts": ["core/b.ts", "db/c.ts"],
    "core/b.ts": ["db/c.ts"],
    "db/c.ts": [],
    "shared/s.ts": [],
  };
  const elements = { ui: { path: "ui/" }, core: { path: "core/" }, db: { path: "db/" }, shared: { path: "shared/" } };

  it("attaches each rule to the edges it checks, with its verdict, and leaf rules to their unit", async () => {
    const graph = await graphOf(files);
    const { units } = workspaceUnits(graph, root, config({
      elements,
      rules: [
        { name: "ui-no-db", from: "ui", forbid: "db" },
        { name: "core-only-db", from: "core", allowOnly: ["db"] },
        { name: "shared-leaf", from: "shared", allowOnly: [] },
        { name: "skipped", from: "ui", forbid: "core", severity: "off" },
      ],
    }));
    expect(edge(units, "ui", "db")).toMatchObject({
      ruleVerdict: "violated",
      rules: [{ name: "ui-no-db", kind: "forbid", severity: "error", checkedPairs: 1, violations: 1, newViolations: 1, verdict: "violated" }],
    });
    // ui-no-db checks every pair leaving ui: it passes on ui → core; the rule switched off is never attached.
    expect(edge(units, "ui", "core")).toMatchObject({ ruleVerdict: "pass", rules: [{ name: "ui-no-db", checkedPairs: 1, violations: 0, verdict: "pass" }] });
    expect(edge(units, "core", "db").rules).toEqual([
      { name: "core-only-db", kind: "allowOnly", severity: "error", checkedPairs: 1, violations: 0, newViolations: 0, verdict: "pass" },
    ]);
    expect(unit(units, "shared").rules).toEqual([
      { name: "shared-leaf", kind: "allowOnly", severity: "error", checkedPairs: 0, violations: 0, newViolations: 0, verdict: "pass" },
    ]);
    expect(unit(units, "ui").rules?.map((rule) => [rule.name, rule.checkedPairs, rule.verdict])).toEqual([["ui-no-db", 2, "violated"]]);
    expect(unit(units, "db").rules).toBeUndefined();
    expect(units.rules?.map((rule) => rule.name)).toEqual(["ui-no-db", "core-only-db", "shared-leaf", "skipped"]);
  });

  it("says accepted when the baseline holds every violation of the edge", async () => {
    const graph = await graphOf(files);
    const rules = config({ elements, rules: [{ name: "ui-no-db", from: "ui", forbid: "db" }] });
    const { units } = workspaceUnits(graph, root, rules, [{ rule: "ui-no-db", source: "ui/a.ts", target: "db/c.ts" }], { configFile: "graphit.architecture.json", baselineFile: "base.json" });
    expect(edge(units, "ui", "db")).toMatchObject({ ruleVerdict: "accepted", rules: [{ violations: 1, newViolations: 0, verdict: "accepted" }] });
    expect(units.baselineFile).toBe("base.json");
  });

  it("projects a violation from a second membership onto the unit edge of the first", async () => {
    const graph = await graphOf({ "app/x.ts": ["db/c.ts"], "db/c.ts": [] });
    const { units } = workspaceUnits(graph, root, config({
      elements: { app: { path: "app/" }, legacy: { path: "app/x.ts" }, db: { path: "db/" } },
      rules: [{ name: "legacy-no-db", from: "legacy", forbid: "db" }],
    }));
    expect(units.units.map((entry) => entry.key).sort()).toEqual(["app", "db"]);
    expect(edge(units, "app", "db")).toMatchObject({ ruleVerdict: "violated", rules: [{ name: "legacy-no-db", checkedPairs: 1, newViolations: 1 }] });
  });

  it("checks noCycles units across detected projects and noCycles <each> across instances", async () => {
    write("p/package.json", "{}");
    write("q/package.json", "{}");
    const graph = await graphOf({ "p/a.ts": ["q/b.ts"], "q/b.ts": ["p/a.ts"], "p/c.ts": ["p/a.ts"] });
    const { units } = workspaceUnits(graph, root, config({
      elements: { all: { path: ["p/", "q/"], each: true } },
      rules: [{ name: "no-project-cycles", noCycles: "units" }, { name: "no-instance-cycles", noCycles: "all" }],
    }));
    expect(edge(units, "all (p)", "all (q)").rules?.map((rule) => [rule.name, rule.checkedPairs, rule.verdict])).toEqual([
      ["no-project-cycles", 1, "violated"],
      ["no-instance-cycles", 1, "violated"],
    ]);
  });

  it("attaches rules to the detected projects when the config declares rules but no element", async () => {
    write("p/package.json", "{}");
    write("q/package.json", "{}");
    const graph = await graphOf({ "p/a.ts": ["q/b.ts"], "q/b.ts": [] });
    const { units, check } = workspaceUnits(graph, root, config({ rules: [{ name: "no-cycles", noCycles: "units" }] }));
    expect(units.unitsFrom).toBe("manifests");
    expect(edge(units, "p", "q")).toMatchObject({ ruleVerdict: "pass", rules: [{ name: "no-cycles", kind: "noCycles", checkedPairs: 1 }] });
    expect(check?.totals.rules).toBe(1);
  });

  it("draws cycles between element units, not between the detected projects", async () => {
    write("p/package.json", "{}");
    const graph = await graphOf({ "p/a/x.ts": ["p/b/y.ts"], "p/b/y.ts": ["p/a/x.ts"] });
    const { units, detected } = workspaceUnits(graph, root, config({ elements: { a: { path: "p/a/" }, b: { path: "p/b/" } } }));
    expect(units.cycles).toBe(1);
    expect(unitCyclePairs(graph, detected)).toEqual([]);
  });
});

describe("workspaceUnits: revision, files and failures", () => {
  it("changes its revision when only the config changes, and keeps the plain one without a config", async () => {
    const graph = await graphOf({ "a/x.ts": [], "b/y.ts": [] });
    const plain = workspaceUnits(graph, root);
    expect(plain.units.unitsFrom).toBe("manifests");
    expect(plain.units.configWarnings).toBeUndefined();
    expect(plain.check).toBeUndefined();
    const one = workspaceUnits(graph, root, config({ elements: { a: { path: "a/" }, b: { path: "b/" } } }));
    const other = workspaceUnits(graph, root, config({ elements: { a: { path: "a/" }, b: { path: "b/" } }, rules: [{ name: "r", from: "a", forbid: "b" }] }));
    expect(new Set([plain, one, other].map((source) => source.units.context.revision)).size).toBe(3);
  });

  it("loads the default config when it exists, none when it is missing or turned off, and refuses an invalid one", async () => {
    const graph = await graphOf({ "a/x.ts": [], "b/y.ts": [] });
    expect((await loadWorkspaceUnits(graph, root)).units.unitsFrom).toBe("manifests");
    write("graphit.architecture.json", JSON.stringify({ elements: { a: { path: "a/" } } }));
    const loaded = await loadWorkspaceUnits(graph, root);
    expect(loaded.units).toMatchObject({ unitsFrom: "elements", configFile: "graphit.architecture.json" });
    expect((await loadWorkspaceUnits(graph, root, { config: false })).units.unitsFrom).toBe("manifests");
    await expect(loadWorkspaceUnits(graph, root, { config: "other.json" })).rejects.toThrow("No other.json in the workspace");
    write("graphit.architecture.json", JSON.stringify({ roles: { x: "nope" } }));
    const refused = loadWorkspaceUnits(graph, root);
    await expect(refused).rejects.toBeInstanceOf(ArchitectureRulesFileError);
    await expect(loadWorkspaceUnits(graph, root)).rejects.toThrow(/^graphit\.architecture\.json: \$\.roles\.x: /);
  });

  it("reads a named baseline next to a named config", async () => {
    const graph = await graphOf({ "a/x.ts": ["b/y.ts"], "b/y.ts": [] });
    write("conf/rules.json", JSON.stringify({ elements: { a: { path: "a/" }, b: { path: "b/" } }, rules: [{ name: "r", from: "a", forbid: "b" }] }));
    write("conf/base.json", JSON.stringify({ version: 1, violations: [{ rule: "r", source: "a/x.ts", target: "b/y.ts" }] }));
    const { units } = await loadWorkspaceUnits(graph, root, { config: "conf\\rules.json", baseline: "conf/base.json" });
    expect(units).toMatchObject({ configFile: "conf/rules.json", baselineFile: "conf/base.json" });
    expect(edge(units, "a", "b").ruleVerdict).toBe("accepted");
  });

  it("feeds viewArchitecture: the source is the WorkspaceUnits, legacy declared roles still apply", async () => {
    const graph = await graphOf({ "a/x.ts": ["b/y.ts"], "b/y.ts": [] });
    const source = workspaceUnits(graph, root, config({ elements: { a: { path: "a/" }, b: { path: "b/" } } }));
    const view = viewArchitecture(graph, root, 10, source);
    expect(view.source).toBe(source);
    expect(view.units?.unitsFrom).toBe("elements");
    const legacy = viewArchitecture(graph, root, 10, { b: "library", nothing: undefined });
    expect(legacy.units?.units.find((entry) => entry.key === "b")).toMatchObject({ role: "library", confidence: "declared" });
    expect(viewArchitecture(graph, root, 10).units?.unitsFrom).toBe("manifests");
  });
});

describe("checkGraphArchitecture and the review keep the detected projects (#776)", () => {
  it("returns the detected-project assignment, never the element one", async () => {
    write("p/package.json", "{}");
    const graph = await graphOf({ "p/a/x.ts": ["p/b/y.ts"], "p/b/y.ts": ["p/a/x.ts"], "z.ts": [] });
    const rules = config({ elements: { a: { path: "p/a/" }, b: { path: "p/b/" } }, rules: [{ name: "no-cycles", noCycles: "units" }] });
    const { assignment, check } = checkGraphArchitecture(graph, root, rules);
    expect(Object.fromEntries(assignment.unitOf)).toEqual(Object.fromEntries(assignUnits(root, graph.nodes.map((node) => node.relativePath)).unitOf));
    expect(new Set(assignment.unitOf.values())).toEqual(new Set(["p", ROOT_UNIT]));
    // The elements form a cycle; the detected projects do not.
    expect(unitCyclePairs(graph, assignment)).toEqual([]);
    expect(check.violations).toEqual([]);
    expect(workspaceUnits(graph, root, rules).units.cycles).toBe(1);
  });

  it("reports a cycle between two detected projects inside one element as a detected-project cycle", async () => {
    write("p/package.json", "{}");
    write("q/package.json", "{}");
    const graph = await graphOf({ "p/a.ts": ["q/b.ts"], "q/b.ts": ["p/a.ts"] });
    const rules = config({ elements: { all: { path: ["p/", "q/"] } }, rules: [{ name: "no-cycles", noCycles: "units" }] });
    const { assignment } = checkGraphArchitecture(graph, root, rules);
    const unitCycles = unitCyclePairs(graph, assignment);
    expect(unitCycles.map(({ from, to }) => `${from}>${to}`).sort()).toEqual(["p>q", "q>p"]);
    expect(workspaceUnits(graph, root, rules).units.cycles).toBe(0);
    const review = compareArchitecture({ check: { rules: [], violations: [], unitCycles: [] } }, { check: { rules: [], violations: [], unitCycles } }, false);
    const markdown = renderArchitectureMarkdown(review, (value) => value).join("\n");
    expect(markdown).toContain("cycle between detected projects p, q: p/a.ts:1 -> q/b.ts");
    expect(markdown).toContain("Detected-project cycles: 2 new, 0 resolved, 0 unchanged.");
  });
});
