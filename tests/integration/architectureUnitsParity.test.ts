/**
 * Units parity (ADR-776): the CLI binary, the explore_architecture MCP tool and the VS Code
 * Architecture view report the same units, unit edges with their rule verdicts, and config
 * warnings, on a workspace with declared elements and on one without a config.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Parser } from "@/analyzer/Parser";
import { SpiderBuilder } from "@/analyzer/SpiderBuilder";
import { PathResolver } from "@/analyzer/utils/PathResolver";
import { workerState } from "@/mcp/shared/state";
import { executeExploreArchitecture } from "@/mcp/tools/architecture";
import type { ArchitectureUnits } from "@/shared/architecture-model";
import { createRulesWorkspace } from "../analyzer/architecture/rulesWorkspace";
import { buildView } from "../analyzer/architecture/viewHarness";

const REPO_ROOT = path.resolve(__dirname, "../..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist/graph-it.js");

/** 3 elements (one with each), 2 rules (one violated, one baselined), a (root) roles key and a declared role; the other roles inferred. */
const CONFIG = {
  elements: {
    functions: { path: "functions/*", each: true },
    frontend: { path: "frontend/" },
    backend: { path: "backend/" },
  },
  rules: [
    { name: "frontend-not-backend", from: "frontend", forbid: ["backend"], severity: "error" },
    { name: "functions-not-backend", from: "functions", forbid: ["backend"], severity: "warning" },
  ],
  roles: { "(root)": "tooling", backend: "service" },
};
const BASELINE = { version: 1, violations: [{ rule: "functions-not-backend", source: "functions/billing/index.ts", target: "backend/src/db.ts" }] };

type Units = Pick<ArchitectureUnits, "units" | "unitEdges" | "configWarnings">;

/** The facts every surface must agree on. */
function facts({ units, unitEdges, configWarnings }: Units) {
  return {
    units: units.map(({ key, name, folder, role, confidence, fileCount }) => [key, name, folder, role, confidence, fileCount]),
    edges: unitEdges.map(({ from, to, ruleVerdict, rules }) => [from, to, ruleVerdict, (rules ?? []).map((rule) => `${rule.name} ${rule.verdict}`)]),
    configWarnings,
  };
}

function useWorkspace(root: string): void {
  workerState.reset();
  workerState.parser = new Parser();
  workerState.resolver = new PathResolver(undefined, true, root);
  workerState.spider = new SpiderBuilder().withRootDir(root).withExcludeNodeModules(true).build();
  workerState.config = { rootDir: root, excludeNodeModules: true, maxDepth: 50 };
  workerState.isReady = true;
}

const cliUnits = (root: string): Units => {
  const result = spawnSync(process.execPath, [DIST_ENTRY, "architecture", "--level", "units", "--format", "json"], { cwd: root, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
};

describe.skipIf(!fs.existsSync(DIST_ENTRY))("architecture units parity: CLI, MCP and VS Code (#776)", { timeout: 120_000 }, () => {
  const roots: string[] = [];
  afterAll(() => {
    workerState.reset();
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const workspace = (withConfig: boolean) => {
    const root = createRulesWorkspace(false);
    roots.push(root);
    if (withConfig) {
      fs.writeFileSync(path.join(root, "graphit.architecture.json"), JSON.stringify(CONFIG));
      fs.writeFileSync(path.join(root, "graphit.architecture.baseline.json"), JSON.stringify(BASELINE));
    }
    useWorkspace(root);
    return root;
  };

  it.each([
    ["declared elements", true],
    ["no config", false],
  ])("reports the same units, edges, verdicts and warnings with %s", async (_name, withConfig) => {
    const root = workspace(withConfig);
    const cli = facts(cliUnits(root));
    const mcp = facts((await executeExploreArchitecture({ level: "units", limit: 500 })) as unknown as Units);
    expect(mcp).toEqual(cli);

    if (withConfig) {
      // The workspace holds what the test claims to compare.
      expect(cli.units.map(([key]) => key)).toEqual(expect.arrayContaining(["frontend", "backend", "functions (functions/billing)", "(unmatched)"]));
      expect(cli.units.find(([key]) => key === "backend")?.[4]).toBe("declared");
      expect(cli.units.some(([, , , , confidence]) => confidence === "inferred")).toBe(true);
      expect(cli.edges).toContainEqual(["frontend", "backend", "violated", ["frontend-not-backend violated"]]);
      expect(cli.edges).toContainEqual(["functions (functions/billing)", "backend", "accepted", ["functions-not-backend accepted"]]);
      expect(cli.configWarnings?.some((warning) => warning.startsWith('$.roles["(root)"]'))).toBe(true);
    } else {
      expect(cli.configWarnings).toBeUndefined();
      expect(cli.units.map(([key]) => key)).toContain("scripts");
    }

  });

  // The VS Code leg: red until set C builds the view with loadWorkspaceUnits (ADR-776 merge order A, B, C).
  it.each([
    ["declared elements", true],
    ["no config", false],
  ])("the VS Code view reports the CLI's units, edges, verdicts and warnings with %s", async (_name, withConfig) => {
    const root = workspace(withConfig);
    const cli = facts(cliUnits(root));
    const { summary } = await buildView(root);
    expect(summary.units, "architectureSummary.units").toBeDefined();
    expect(facts(summary.units!)).toEqual(cli);
  });
});
