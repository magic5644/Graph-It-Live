import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { buildArchitectureGraph, type ArchitectureGraph } from "@/analyzer/architecture/ArchitectureGraphBuilder";
import {
  ArchitectureConfigSchema,
  ArchitectureRulesFileError,
  checkArchitecture,
  checkWorkspaceArchitecture,
  formatBaseline,
  jsonPath,
  loadArchitectureRules,
  loadDeclaredRoles,
  matchesWildcard,
  MAX_CONFIG_BYTES,
  parseArchitectureConfig,
  parseBaseline,
  readWorkspaceFile,
  rulesByEdge,
  type ArchitectureConfig,
} from "@/analyzer/architecture/architectureRules";
import { assignUnits, type UnitAssignment } from "@/analyzer/architecture/architectureUnits";
import { Parser } from "@/analyzer/Parser";
import { SpiderBuilder } from "@/analyzer/SpiderBuilder";
import { PathResolver } from "@/analyzer/utils/PathResolver";
import { workerState } from "@/mcp/shared/state";
import { createRulesWorkspace, RULES_CONFIG } from "./rulesWorkspace";

const issuesOf = (text: string) => {
  try {
    parseArchitectureConfig(text);
  } catch (error) {
    return (error as ArchitectureRulesFileError).issues;
  }
  throw new Error("expected the config to be rejected");
};
const withRules = (rules: unknown[], elements: object = RULES_CONFIG.elements) => JSON.stringify({ elements, rules });

describe("parseArchitectureConfig", () => {
  it("accepts the documented example", () => {
    const config = parseArchitectureConfig(JSON.stringify(RULES_CONFIG));
    expect(config.rules.map((rule) => rule.name)).toEqual(["functions-only-shared", "frontend-not-backend", "mfe-isolated", "no-unit-cycles"]);
  });

  it("rejects unknown keys with their JSON path", () => {
    expect(issuesOf(JSON.stringify({ ...RULES_CONFIG, extra: 1 }))).toEqual([{ path: "$", message: expect.stringContaining('"extra"') }]);
    expect(issuesOf(withRules([], { a: { path: "a/", depth: 2 } }))).toEqual([{ path: "$.elements.a", message: expect.stringContaining('"depth"') }]);
    expect(issuesOf(withRules([{ name: "r", noCycles: "units", when: "always" }]))[0]).toMatchObject({ path: "$.rules[0]" });
  });

  it("rejects unknown element names in rules", () => {
    expect(issuesOf(withRules([{ name: "r", from: ["frontend", "web"], forbid: "api" }]))).toEqual([
      { path: "$.rules[0].from[1]", message: 'unknown element "web"' },
      { path: "$.rules[0].forbid", message: 'unknown element "api"' },
    ]);
    expect(issuesOf(withRules([{ name: "r", noCycles: "web" }]))).toEqual([{ path: "$.rules[0].noCycles", message: 'unknown element "web"' }]);
  });

  it("rejects empty and escaping patterns", () => {
    expect(issuesOf(withRules([], { a: { path: "" } }))).toEqual([{ path: "$.elements.a.path", message: "empty pattern" }]);
    expect(issuesOf(withRules([], { a: { path: ["a/", "  "] } }))).toEqual([{ path: "$.elements.a.path[1]", message: "empty pattern" }]);
    expect(issuesOf(withRules([], { a: { unit: [] } }))[0]).toMatchObject({ path: "$.elements.a.unit" });
    for (const pattern of ["../outside", "a/../../b", String.raw`C:\repo`, "c:/repo", String.raw`a\b`]) {
      expect(issuesOf(withRules([], { a: { path: pattern } }))[0], pattern).toMatchObject({ path: "$.elements.a.path", message: expect.stringContaining("inside the workspace") });
    }
    expect(issuesOf(withRules([], { a: {} }))).toEqual([{ path: "$.elements.a", message: "an element needs path, unit or role" }]);
  });

  it("rejects rules without exactly one kind, misplaced from, duplicate names and the reserved element name", () => {
    expect(issuesOf(withRules([{ name: "r", from: "frontend" }]))).toEqual([{ path: "$.rules[0]", message: expect.stringContaining("exactly one") }]);
    expect(issuesOf(withRules([{ name: "r", forbid: "backend" }]))).toEqual([{ path: "$.rules[0].from", message: "forbid and allowOnly need from" }]);
    expect(issuesOf(withRules([{ name: "r", from: "mfe", noCycles: "mfe" }]))).toEqual([{ path: "$.rules[0].from", message: "noCycles takes no from" }]);
    expect(issuesOf(withRules([{ name: "r", noCycles: "units" }, { name: "r", noCycles: "units" }]))).toEqual([{ path: "$.rules[1].name", message: 'duplicate rule name "r"' }]);
    expect(issuesOf(withRules([], { units: { path: "a/" } }))).toEqual([{ path: "$.elements.units", message: expect.stringContaining("reserved") }]);
    expect(issuesOf(withRules([], { "a b": { path: "a/" } }))[0]).toMatchObject({ path: '$.elements["a b"]' });
  });

  it("rejects rules that could never report: against an element's single instance", () => {
    expect(issuesOf(withRules([{ name: "r", noCycles: "frontend" }]))).toEqual([
      { path: "$.rules[0].noCycles", message: expect.stringContaining('noCycles on "frontend" needs each: true') },
    ]);
    expect(issuesOf(withRules([{ name: "r", from: ["frontend", "mfe"], forbid: ["backend", "frontend"] }]))).toEqual([
      { path: "$.rules[0].forbid", message: expect.stringContaining('forbidding "frontend" from itself needs each: true') },
    ]);
    // With each, another instance is meant: accepted.
    expect(() => parseArchitectureConfig(withRules([{ name: "r", from: "mfe", forbid: "mfe" }, { name: "c", noCycles: "mfe" }]))).not.toThrow();
  });

  it("rejects invalid JSON and oversized files before parsing", () => {
    expect(issuesOf("{")).toEqual([{ path: "$", message: expect.stringContaining("not valid JSON") }]);
    expect(issuesOf(" ".repeat(MAX_CONFIG_BYTES + 1))).toEqual([{ path: "$", message: `larger than ${MAX_CONFIG_BYTES} bytes` }]);
    expect(() => parseArchitectureConfig("{", "custom.json")).toThrow(/^custom\.json: \$: not valid JSON/);
  });

  it("accepts a config declaring roles only, and rejects unknown roles", () => {
    expect(parseArchitectureConfig(JSON.stringify({ roles: { "functions/*": "function" } }))).toEqual({
      elements: {}, rules: [], roles: { "functions/*": "function" },
    });
    expect(issuesOf(JSON.stringify({ roles: { api: "backend" } }))).toEqual([{ path: "$.roles.api", message: expect.stringContaining("function") }]);
    expect(issuesOf(withRules([], { a: { role: "lambda" } }))[0]).toMatchObject({ path: "$.elements.a.role" });
  });

  it("publishes the JSON schema generated from the Zod schema", () => {
    const published = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../schemas/architecture.schema.json"), "utf8"));
    expect(published).toEqual(z.toJSONSchema(ArchitectureConfigSchema, { io: "input" }));
  });
});

describe("jsonPath and matchesWildcard", () => {
  it("writes paths as JSON paths", () => {
    expect(jsonPath([])).toBe("$");
    expect(jsonPath(["rules", 2, "from", 0])).toBe("$.rules[2].from[0]");
    expect(jsonPath(["elements", "my-app"])).toBe('$.elements["my-app"]');
  });

  it("matches * against any characters and nothing else", () => {
    expect(matchesWildcard("@acme/shared-*", "@acme/shared-ui")).toBe(true);
    expect(matchesWildcard("@acme/shared-*", "@acme/shared-")).toBe(true);
    expect(matchesWildcard("@acme/shared-*", "@acme/ui")).toBe(false);
    expect(matchesWildcard("*/ui", "shared/ui")).toBe(true);
    expect(matchesWildcard("a*b*c", "aXbYbZc")).toBe(true);
    expect(matchesWildcard("a*b*c", "aXbYbZ")).toBe(false);
    expect(matchesWildcard("a.c", "abc")).toBe(false);
    expect(matchesWildcard("**", "")).toBe(true);
  });
});

describe("checkArchitecture on the generated workspace", () => {
  let rootDir: string;
  let graph: ArchitectureGraph;
  let assignment: UnitAssignment;
  const config = () => parseArchitectureConfig(JSON.stringify(RULES_CONFIG));
  const pairs = (result: ReturnType<typeof checkArchitecture>, rule: string) =>
    result.violations.filter((violation) => violation.rule === rule).map(({ source, target, from, to, line }) => ({ source, target, from, to, line }));

  beforeAll(async () => {
    rootDir = createRulesWorkspace();
    workerState.parser = new Parser();
    workerState.resolver = new PathResolver(undefined, true, rootDir);
    const spider = new SpiderBuilder().withRootDir(rootDir).withExcludeNodeModules(true).build();
    graph = await buildArchitectureGraph(rootDir, (file) => spider.analyze(file));
    assignment = assignUnits(rootDir, graph.nodes.map((node) => node.relativePath));
  });

  afterAll(() => {
    workerState.reset();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("forbid: frontend and micro-frontends never import the backend", () => {
    expect(pairs(checkArchitecture(graph, assignment, config()), "frontend-not-backend")).toEqual([
      { source: "frontend/src/app.ts", target: "backend/src/api.ts", from: "frontend", to: "backend", line: 2 },
    ]);
  });

  it("allowOnly: a function imports shared libraries and its own files only", () => {
    expect(pairs(checkArchitecture(graph, assignment, config()), "functions-only-shared")).toEqual([
      { source: "functions/billing/index.ts", target: "backend/src/db.ts", from: "functions (functions/billing)", to: "backend", line: 2 },
      { source: "functions/mail/index.ts", target: "functions/billing/index.ts", from: "functions (functions/mail)", to: "functions (functions/billing)", line: 1 },
    ]);
  });

  it("each: another micro-frontend violates, the same one does not", () => {
    const result = checkArchitecture(graph, assignment, config());
    expect(pairs(result, "mfe-isolated")).toEqual([
      { source: "mfe/cart/src/index.ts", target: "mfe/checkout/src/index.ts", from: "mfe (mfe/cart)", to: "mfe (mfe/checkout)", line: 2 },
    ]);
    expect(result.rules.find((rule) => rule.name === "mfe-isolated")).toMatchObject({ severity: "warning", violations: 1 });
  });

  it("noCycles units: both imports of the shared libraries' cycle", () => {
    expect(pairs(checkArchitecture(graph, assignment, config()), "no-unit-cycles")).toEqual([
      { source: "shared/ui/src/index.ts", target: "shared/utils/src/index.ts", from: "shared/ui", to: "shared/utils", line: 1 },
      { source: "shared/utils/src/index.ts", target: "shared/ui/src/index.ts", from: "shared/utils", to: "shared/ui", line: 1 },
    ]);
  });

  it("noCycles on an each element: cycles between its instances only", () => {
    const cyclic: ArchitectureConfig = { elements: { lib: { unit: "shared/*", each: true }, top: { path: "*", each: true } }, rules: [
      { name: "lib-cycles", noCycles: "lib" },
      { name: "top-cycles", noCycles: "top" },
    ] };
    const result = checkArchitecture(graph, assignment, cyclic);
    expect(pairs(result, "lib-cycles").map(({ from, to }) => `${from} → ${to}`)).toEqual([
      "lib (shared/ui) → lib (shared/utils)",
      "lib (shared/utils) → lib (shared/ui)",
    ]);
    // Top-level folders: shared holds both libraries, so their cycle is inside one instance.
    expect(pairs(result, "top-cycles")).toEqual([]);
  });

  it("sums totals per severity, lists unmatched files and fails on a new error", () => {
    const result = checkArchitecture(graph, assignment, config());
    expect(result.totals).toEqual({
      files: graph.nodes.length,
      unmatchedFiles: 1,
      rules: 4,
      brokenRules: 4,
      violations: 6,
      newViolations: 6,
      errors: 5,
      newErrors: 5,
      warnings: 1,
      resolved: 0,
    });
    expect(result.unmatchedFiles).toEqual(["scripts/seed.ts"]);
    expect(result.passed).toBe(false);
    expect(result.configWarnings).toEqual([]);
    expect(result.context.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(result.context.revision).not.toBe(graph.context.revision);
  });

  it("skips rules with severity off and passes on warnings only", () => {
    const quiet = config();
    quiet.rules = quiet.rules.map((rule) => ({ ...rule, severity: rule.severity === "warning" ? "warning" : "off" }));
    const result = checkArchitecture(graph, assignment, quiet);
    expect(result.rules.map((rule) => rule.violations)).toEqual([0, 0, 1, 0]);
    expect(result.passed).toBe(true);
  });

  it("reports patterns that match nothing as config warnings", () => {
    const result = checkArchitecture(graph, assignment, {
      elements: { ghost: { path: ["nowhere/", "!frontend/", "frontend/"] }, lib: { unit: "@acme/none-*" } },
      rules: [],
    });
    expect(result.configWarnings).toEqual([
      '$.elements.ghost.path[0]: "nowhere/" matches no file',
      '$.elements.lib.unit: "@acme/none-*" matches no unit',
    ]);
    expect(result.totals.unmatchedFiles).toBe(graph.nodes.length - 1);
  });

  it("role: selects the units of a role, one instance per unit with each, and warns about a role no unit has", () => {
    const roleOf = new Map([["functions/billing", "function"], ["functions/mail", "function"], ["backend", "service"]]);
    const byRole: ArchitectureConfig = {
      elements: { fn: { role: "function", each: true }, api: { role: ["service"] }, mfe: { role: "micro-frontend" } },
      rules: [{ name: "fn-isolated", from: "fn", forbid: ["fn", "api"] }],
    };
    const result = checkArchitecture(graph, assignment, byRole, undefined, roleOf);
    expect(pairs(result, "fn-isolated").map(({ from, to }) => `${from} → ${to}`)).toEqual([
      "fn (functions/billing) → api",
      "fn (functions/mail) → fn (functions/billing)",
    ]);
    expect(result.configWarnings).toEqual(['$.elements.mfe.role: "micro-frontend" matches no unit']);
    // The roles are part of the revision.
    expect(checkArchitecture(graph, assignment, byRole).context.revision).not.toBe(result.context.revision);
  });

  it("baseline: accepted violations pass, a new one fails, a resolved one is listed", () => {
    const first = checkArchitecture(graph, assignment, config());
    const errors = first.violations.filter((violation) => violation.severity === "error");
    const baseline = parseBaseline(formatBaseline([...errors, { rule: "gone", source: "old/a.ts", target: "old/b.ts" }]));
    const accepted = checkArchitecture(graph, assignment, config(), baseline);
    expect(accepted.passed).toBe(true);
    expect(accepted.totals).toMatchObject({ violations: 6, newViolations: 1, newErrors: 0, resolved: 1 });
    expect(accepted.resolved).toEqual([{ rule: "gone", source: "old/a.ts", target: "old/b.ts" }]);
    expect(accepted.context.revision).not.toBe(first.context.revision);

    // A rule switched off is not checked: its accepted entries are not resolved.
    const switchedOff = config();
    switchedOff.rules = switchedOff.rules.map((rule) => ({ ...rule, severity: rule.name === "no-unit-cycles" ? "off" : rule.severity }));
    expect(checkArchitecture(graph, assignment, switchedOff, baseline).resolved).toEqual([{ rule: "gone", source: "old/a.ts", target: "old/b.ts" }]);

    const partial = checkArchitecture(graph, assignment, config(), baseline.filter((entry) => entry.rule !== "frontend-not-backend"));
    expect(partial.passed).toBe(false);
    expect(partial.violations.filter((violation) => violation.new && violation.severity === "error").map((violation) => violation.rule)).toEqual(["frontend-not-backend"]);
    expect(partial.rules.find((rule) => rule.name === "frontend-not-backend")?.newViolations).toBe(1);
  });
});

describe("baseline file", () => {
  it("is sorted and identical whatever the path separators and order", () => {
    const posix = formatBaseline([
      { rule: "b", source: "mfe/cart/src/index.ts", target: "mfe/checkout/src/index.ts" },
      { rule: "a", source: "frontend/src/app.ts", target: "backend/src/api.ts" },
      { rule: "a", source: "frontend/src/a.ts", target: "backend/src/api.ts" },
    ]);
    const windows = formatBaseline([
      { rule: "a", source: String.raw`frontend\src\a.ts`, target: String.raw`backend\src\api.ts` },
      { rule: "b", source: String.raw`mfe\cart\src\index.ts`, target: String.raw`mfe\checkout\src\index.ts` },
      { rule: "a", source: String.raw`frontend\src\app.ts`, target: String.raw`backend\src\api.ts` },
    ]);
    expect(windows).toBe(posix);
    expect(JSON.parse(posix).violations.map((entry: { rule: string; source: string }) => `${entry.rule}:${entry.source}`)).toEqual([
      "a:frontend/src/a.ts",
      "a:frontend/src/app.ts",
      "b:mfe/cart/src/index.ts",
    ]);
    expect(posix.endsWith("}\n")).toBe(true);
    expect(parseBaseline(JSON.stringify({ version: 1, violations: [{ rule: "a", source: String.raw`x\y.ts`, target: "z.ts" }] })))
      .toEqual([{ rule: "a", source: "x/y.ts", target: "z.ts" }]);
  });

  it("rejects an invalid baseline with the JSON path", () => {
    expect(() => parseBaseline(JSON.stringify({ version: 2, violations: [] }))).toThrow(/\$\.version/);
    expect(() => parseBaseline(JSON.stringify({ version: 1, violations: [{ rule: "a" }] }))).toThrow(/\$\.violations\[0\]\.source/);
  });
});

describe("rule files in the workspace", () => {
  let rootDir: string;

  beforeAll(() => {
    rootDir = createRulesWorkspace();
  });

  afterAll(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("loads the config, and the default baseline only when it exists", async () => {
    expect(await loadArchitectureRules(rootDir)).not.toHaveProperty("baselineFile");
    fs.writeFileSync(path.join(rootDir, "graphit.architecture.baseline.json"), formatBaseline([{ rule: "a", source: "x.ts", target: "y.ts" }]));
    expect(await loadArchitectureRules(rootDir)).toMatchObject({ baselineFile: "graphit.architecture.baseline.json", baseline: [{ rule: "a" }] });
    fs.rmSync(path.join(rootDir, "graphit.architecture.baseline.json"));
  });

  it("loads the declared roles, none without a config, and applies them to role elements", async () => {
    const configFile = path.join(rootDir, "graphit.architecture.json");
    const original = fs.readFileSync(configFile, "utf8");
    try {
      expect(await loadDeclaredRoles(rootDir)).toBeUndefined();
      fs.writeFileSync(configFile, JSON.stringify({
        elements: { fn: { role: "function" }, backend: { path: "backend/" } },
        rules: [{ name: "fn-not-backend", from: "fn", forbid: "backend" }],
        roles: { "@acme/fn-*": "function" },
      }));
      expect(await loadDeclaredRoles(rootDir)).toEqual({ "@acme/fn-*": "function" });
      workerState.parser = new Parser();
      workerState.resolver = new PathResolver(undefined, true, rootDir);
      const spider = new SpiderBuilder().withRootDir(rootDir).withExcludeNodeModules(true).build();
      const graph = await buildArchitectureGraph(rootDir, (file) => spider.analyze(file));
      const check = await checkWorkspaceArchitecture(graph, rootDir);
      expect(check.violations.map(({ source, target }) => `${source} → ${target}`)).toEqual(["functions/billing/index.ts → backend/src/db.ts"]);
      // A config declaring roles only checks nothing and passes.
      fs.writeFileSync(configFile, JSON.stringify({ roles: { "@acme/fn-*": "function" } }));
      expect(await checkWorkspaceArchitecture(graph, rootDir)).toMatchObject({ passed: true, rules: [], violations: [], totals: { rules: 0, violations: 0 } });
      fs.rmSync(configFile);
      expect(await loadDeclaredRoles(rootDir)).toBeUndefined();
      fs.writeFileSync(configFile, "{");
      await expect(loadDeclaredRoles(rootDir)).rejects.toThrow("not valid JSON");
    } finally {
      workerState.reset();
      fs.writeFileSync(configFile, original);
    }
  });

  it("requires a named baseline and the config to exist", async () => {
    await expect(loadArchitectureRules(rootDir, { baseline: "missing.json" })).rejects.toThrow("Baseline missing.json not found");
    await expect(loadArchitectureRules(rootDir, { config: "other.json" })).rejects.toThrow("No other.json in the workspace");
  });

  it("refuses files outside the workspace and oversized ones without reading them", async () => {
    await expect(readWorkspaceFile(rootDir, "../outside.json", 10)).rejects.toThrow("outside workspace");
    await expect(readWorkspaceFile(rootDir, "graphit.architecture.json", 10)).rejects.toThrow("larger than 10 bytes");
    expect(await readWorkspaceFile(rootDir, "absent.json", 10)).toBeUndefined();
    await expect(readWorkspaceFile(rootDir, "frontend", 10 ** 6)).rejects.toThrow();
  });
});

describe("rulesByEdge", () => {
  it("maps violations to the edges of a level, rule names sorted and pairs inside one key left out", () => {
    const unitOf = (file: string) => (file.startsWith("x/") ? undefined : file.split("/")[0]);
    expect(rulesByEdge([
      { rule: "b", source: "web/a.ts", target: "api/b.ts" },
      { rule: "a", source: "web/c.ts", target: "api/d.ts" },
      { rule: "a", source: "web/e.ts", target: "api/b.ts" },
      { rule: "c", source: "web/a.ts", target: "web/b.ts" },
      { rule: "d", source: "x/a.ts", target: "api/b.ts" },
    ], unitOf)).toEqual({ "web>api": ["a", "b"] });
  });
});
