import * as fs from "node:fs";
import * as path from "node:path";
import Ajv from "ajv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Parser } from "@/analyzer/Parser";
import { SpiderBuilder } from "@/analyzer/SpiderBuilder";
import { PathResolver } from "@/analyzer/utils/PathResolver";
import { run as runCheckArchitecture } from "@/cli/commands/checkArchitecture";
import { CliError, ExitCode } from "@/cli/errors";
import { workerState } from "@/mcp/shared/state";
import { executeCheckArchitecture } from "@/mcp/tools/architecture";
import { CheckArchitectureParamsSchema } from "@/mcp/types";
import type { ArchitectureExtensionMessage } from "@/shared/architecture-types";
import { createRulesWorkspace } from "./rulesWorkspace";
import { buildView } from "./viewHarness";

// `graph-it check-architecture` and check_architecture on the generated workspace: same
// violations, exit code 1 on a new error, SARIF valid against the SARIF 2.1.0 schema.
let rootDir: string;
const runtime = () => ({ workspaceRoot: rootDir, ensureIndexed: async () => undefined, loadState: () => null }) as never;

/** The command's output and exit code, as the CLI entry point prints them. */
async function cli(args: string[], format: "json" | "sarif" | "toon" | "csv" | "text" | "markdown" = "json") {
  try {
    return { exitCode: ExitCode.SUCCESS, output: await runCheckArchitecture(args, runtime(), format) };
  } catch (error) {
    if (!(error instanceof CliError) || error.output === undefined) throw error;
    return { exitCode: error.exitCode, output: error.output, message: error.message };
  }
}

describe("architecture rules golden output: generated workspace", () => {
  beforeAll(() => {
    rootDir = createRulesWorkspace();
    workerState.parser = new Parser();
    workerState.resolver = new PathResolver(undefined, true, rootDir);
    workerState.spider = new SpiderBuilder().withRootDir(rootDir).withExcludeNodeModules(true).build();
    workerState.config = { rootDir, excludeNodeModules: true, maxDepth: 50 };
    workerState.isReady = true;
  });

  afterAll(() => {
    workerState.reset();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("exits with 1 on new error violations, and check_architecture returns the same violations", async () => {
    const { exitCode, output, message } = await cli([]);
    expect(exitCode).toBe(1);
    expect(message).toBe("5 error violation(s) of the architecture rules not in the baseline");
    const report = JSON.parse(output);
    const mcp = await executeCheckArchitecture({ limit: 500 });
    expect(mcp.violations).toEqual(report.violations);
    expect(mcp.rules).toEqual(report.rules);
    expect(mcp.totals).toEqual(report.totals);
    expect(mcp.context.revision).toBe(report.context.revision);
    expect(mcp.page).toMatchObject({ total: 6, truncated: false });
    await expect(JSON.stringify(report, null, 2) + "\n").toMatchFileSnapshot("__snapshots__/rules-project.check.json");
  });

  it("pages and filters check_architecture by rule and revision", async () => {
    const first = await executeCheckArchitecture({ limit: 2 });
    expect(first.violations).toHaveLength(2);
    expect(first.page).toMatchObject({ total: 6, nextOffset: 2, truncated: true });
    const next = await executeCheckArchitecture({ limit: 2, offset: 2, revision: first.context.revision });
    expect(next.violations[0]).not.toEqual(first.violations[0]);
    const one = await executeCheckArchitecture({ rule: "no-unit-cycles" });
    expect(one.violations.map((violation) => violation.rule)).toEqual(["no-unit-cycles", "no-unit-cycles"]);
    await expect(executeCheckArchitecture({ revision: "0".repeat(64) })).rejects.toThrow("Architecture or rules changed");
    await expect(executeCheckArchitecture({ rule: "nope" })).rejects.toThrow('Unknown rule "nope"');
    expect(CheckArchitectureParamsSchema.safeParse({ config: "/etc/rules.json" }).success).toBe(false);
    expect(CheckArchitectureParamsSchema.safeParse({ config: String.raw`C:\rules.json` }).success).toBe(false);
  });

  it("writes SARIF 2.1.0 locating each new violation on its importing line", async () => {
    const { exitCode, output } = await cli([], "sarif");
    expect(exitCode).toBe(1);
    const sarif = JSON.parse(output);
    const schema = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../cli/sarif-schema-2.1.0.json"), "utf8"));
    const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);
    expect(validate(sarif), JSON.stringify(validate.errors)).toBe(true);
    const results = sarif.runs[0].results;
    expect(results).toHaveLength(6);
    expect(results[0]).toMatchObject({
      ruleId: "frontend-not-backend",
      level: "error",
      locations: [{ physicalLocation: { artifactLocation: { uri: "frontend/src/app.ts" }, region: { startLine: 2 } } }],
    });
    expect(sarif.runs[0].tool.driver.rules.map((rule: { id: string }) => rule.id)).toEqual(
      ["functions-only-shared", "frontend-not-backend", "mfe-isolated", "no-unit-cycles"]);
  });

  it("passes once the baseline holds every violation, then fails on a new one and lists a resolved one", async () => {
    const update = await cli(["--update-baseline"]);
    expect(update.exitCode).toBe(0);
    expect(JSON.parse(update.output)).toMatchObject({ baselineFile: "graphit.architecture.baseline.json", violations: 6 });
    const baselinePath = path.join(rootDir, "graphit.architecture.baseline.json");
    const written = fs.readFileSync(baselinePath, "utf8");
    expect(written).not.toContain("\\\\");

    const accepted = await cli([]);
    expect(accepted.exitCode).toBe(0);
    expect((await cli([], "text")).output).toMatch(/^PASSED: 0 new error violations \(config graphit\.architecture\.json, baseline graphit\.architecture\.baseline\.json\)\n/);
    expect((await cli(["--update-baseline"], "markdown")).output).toBe("Baseline graphit.architecture.baseline.json written: 6 violation(s) accepted.");
    expect(JSON.parse(accepted.output)).toMatchObject({ passed: true, baselineFile: "graphit.architecture.baseline.json", totals: { newViolations: 0 } });
    expect(JSON.parse((await cli([], "sarif")).output).runs[0].results).toEqual([]);

    // Drop one accepted error, add one no longer found.
    const entries = JSON.parse(written).violations.filter((entry: { rule: string }) => entry.rule !== "frontend-not-backend");
    fs.writeFileSync(baselinePath, JSON.stringify({ version: 1, violations: [...entries, { rule: "gone", source: "a.ts", target: "b.ts" }] }));
    const partial = await cli([]);
    expect(partial.exitCode).toBe(1);
    const report = JSON.parse(partial.output);
    expect(report.violations.filter((violation: { new: boolean }) => violation.new).map((violation: { rule: string }) => violation.rule)).toEqual(["frontend-not-backend"]);
    expect(report.resolved).toEqual([{ rule: "gone", source: "a.ts", target: "b.ts" }]);

    // Text and markdown reports: new, accepted and resolved violations, unmatched files.
    const reports = await Promise.all((["text", "markdown"] as const).flatMap((format) => [cli([], format), cli(["--verbose"], format)]));
    const [text, textVerbose, markdown, markdownVerbose] = reports.map(({ output }) => output.replace(/(revision|indexedAt): .*/g, "$1: <stable>") + "\n");
    await expect(text).toMatchFileSnapshot("__snapshots__/rules-project.check.baseline.txt");
    await expect(textVerbose).toMatchFileSnapshot("__snapshots__/rules-project.check.baseline.verbose.txt");
    await expect(markdown).toMatchFileSnapshot("__snapshots__/rules-project.check.baseline.md");
    await expect(markdownVerbose).toMatchFileSnapshot("__snapshots__/rules-project.check.baseline.verbose.md");

    // Rewriting it drops the resolved entry, whatever the previous baseline held.
    await cli(["--update-baseline"]);
    expect(fs.readFileSync(baselinePath, "utf8")).toBe(written);

    // A rule switched off keeps its accepted entries: it was not checked.
    const configPath = path.join(rootDir, "graphit.architecture.json");
    const original = fs.readFileSync(configPath, "utf8");
    const off = JSON.parse(original);
    off.rules = off.rules.map((rule: { name: string }) => (rule.name === "no-unit-cycles" ? { ...rule, severity: "off" } : rule));
    fs.writeFileSync(configPath, JSON.stringify(off));
    try {
      await cli(["--update-baseline"]);
      expect(fs.readFileSync(baselinePath, "utf8")).toBe(written);
    } finally {
      fs.writeFileSync(configPath, original);
    }
    fs.rmSync(baselinePath);
  });

  it("reads --config and --baseline inside the workspace only", async () => {
    fs.copyFileSync(path.join(rootDir, "graphit.architecture.json"), path.join(rootDir, "rules.json"));
    expect((await cli(["--config", "rules.json"])).exitCode).toBe(1);
    await expect(runCheckArchitecture(["--config", "../rules.json"], runtime(), "json")).rejects.toThrow("outside workspace");
    await expect(runCheckArchitecture(["--baseline", "none.json"], runtime(), "json")).rejects.toThrow("Baseline none.json not found");
    await expect(runCheckArchitecture(["--config"], runtime(), "json")).rejects.toThrow("--config must be a file of the workspace");
    await expect(runCheckArchitecture([], runtime(), "csv")).rejects.toThrow('Format "csv"');
    fs.writeFileSync(path.join(rootDir, "bad.json"), JSON.stringify({ elements: {}, rules: [{ name: "r", from: "x", forbid: "y" }] }));
    await expect(runCheckArchitecture(["--config", "bad.json"], runtime(), "json")).rejects.toThrow('bad.json: $.rules[0].from: unknown element "x"');
  });

  it("prints text and markdown reports without a baseline: verdict, rules table, new violations by rule", async () => {
    const text = await cli([], "text");
    expect(text.exitCode).toBe(1);
    await expect(text.output + "\n").toMatchFileSnapshot("__snapshots__/rules-project.check.txt");
    const markdown = await cli([], "markdown");
    expect(markdown.exitCode).toBe(1);
    expect(markdown.output).not.toContain("graph TD");
    await expect(markdown.output + "\n").toMatchFileSnapshot("__snapshots__/rules-project.check.md");
  });

  it("prints toon output too", async () => {
    const { output } = await cli([], "toon");
    expect(output).toContain("frontend-not-backend");
  });

  it("shows the same rules in the view: counts, red unit edges and cells, a rule's pairs, folder levels", async () => {
    const report = JSON.parse((await cli([])).output);
    const posted: ArchitectureExtensionMessage[] = [];
    const { service, summary } = await buildView(rootDir, posted);
    const rules = summary.rules!;
    expect(rules.totals).toEqual(report.totals);
    expect(rules.rules).toEqual(report.rules);
    expect(rules.unitEdges).toEqual({
      "frontend>backend": ["frontend-not-backend"],
      "functions/billing>backend": ["functions-only-shared"],
      "functions/mail>functions/billing": ["functions-only-shared"],
      "mfe/cart>mfe/checkout": ["mfe-isolated"],
      "shared/ui>shared/utils": ["no-unit-cycles"],
      "shared/utils>shared/ui": ["no-unit-cycles"],
    });

    for (const rule of report.rules) {
      await service.handleWebviewMessage({ command: "architectureRuleEvidence", revision: summary.revision, rule: rule.name });
      const page = posted.at(-1);
      const expected = report.violations.filter((violation: { rule: string }) => violation.rule === rule.name)
        .map(({ source, target }: { source: string; target: string }) => ({ source, target }));
      expect(page, rule.name).toMatchObject({ type: "architectureEvidencePage", rule: rule.name, pairs: expected, page: { total: rule.violations } });
    }

    await service.handleWebviewMessage({ command: "architectureMatrix", revision: summary.revision });
    expect(posted.at(-1)).toMatchObject({ type: "architectureMatrix", violations: rules.unitEdges });

    // Inside the frontend unit: its groups' edges carry the rules of their pairs.
    await service.handleWebviewMessage({ command: "architectureMatrix", revision: summary.revision, unit: "frontend" });
    expect(posted.at(-1)).toMatchObject({ type: "architectureMatrix", violations: rules.groupEdges });
    await service.handleWebviewMessage({ command: "architectureEnterFolder", revision: summary.revision, folder: "functions/billing" });
    const level = posted.at(-1);
    expect(level?.type === "architectureFolderLevel" && level.level.rules?.totals).toEqual(report.totals);
  });

  it("marks the view stale when a rule file changes, and reports a refused config with its JSON path", async () => {
    const posted: ArchitectureExtensionMessage[] = [];
    const { service } = await buildView(rootDir, posted);
    const configPath = path.join(rootDir, "graphit.architecture.json");
    service.markStale(path.join(rootDir, "graphit.architecture.baseline.json"), "change");
    expect(posted.at(-1)).toMatchObject({ type: "architectureSummary", stale: true });

    const config = fs.readFileSync(configPath, "utf8");
    try {
      fs.writeFileSync(configPath, JSON.stringify({ elements: {}, rules: [{ name: "r", noCycles: "ghost" }] }));
      const refused = await buildView(rootDir);
      expect(refused.summary.rules).toEqual({
        configFile: "graphit.architecture.json",
        error: 'graphit.architecture.json: $.rules[0].noCycles: unknown element "ghost"',
        rules: [], configWarnings: [], unitEdges: {}, groupEdges: {},
      });
      await refused.service.handleWebviewMessage({ command: "architectureRuleEvidence", revision: refused.summary.revision, rule: "r" });
      fs.rmSync(configPath);
      const none = await buildView(rootDir);
      expect(none.summary).not.toHaveProperty("rules");
    } finally {
      fs.writeFileSync(configPath, config);
    }
  });
});
