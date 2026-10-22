import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Parser } from "../../../src/analyzer/Parser";
import { SpiderBuilder } from "../../../src/analyzer/SpiderBuilder";
import { PathResolver } from "../../../src/analyzer/utils/PathResolver";
import { run as runArchitectureCli } from "../../../src/cli/commands/architecture";
import { workerState } from "../../../src/mcp/shared/state";
import { executeExploreArchitecture } from "../../../src/mcp/tools/architecture";
import type { ArchitectureExtensionMessage, ArchitectureSummaryMessage } from "../../../src/shared/architecture-types";
import { normalizePath } from "../../../src/shared/path";
import { buildView } from "./viewHarness";

// Golden output of `graph-it architecture --level units` on an npm-workspaces fixture: the CLI,
// explore_architecture and the extension's view must report the same units, layers and edges.
const rootDir = path.resolve(__dirname, "../../fixtures/workspaces-project");
const root = normalizePath(rootDir);
const stable = (value: unknown) =>
  [rootDir, root].reduce(
    (json, absolute) => json.replaceAll(JSON.stringify(absolute).slice(1, -1), "<root>"),
    JSON.stringify(value, null, 2),
  ) + "\n";

async function viewSummary(posted: ArchitectureExtensionMessage[] = []): Promise<ArchitectureSummaryMessage> {
  return (await buildView(rootDir, posted)).summary;
}

describe("architecture units golden output: workspaces-project", () => {
  beforeEach(() => {
    workerState.parser = new Parser();
    workerState.resolver = new PathResolver(undefined, true, rootDir);
    workerState.spider = new SpiderBuilder().withRootDir(rootDir).withExcludeNodeModules(true).build();
    workerState.config = { rootDir, excludeNodeModules: true, maxDepth: 50 };
    workerState.isReady = true;
  });

  afterEach(() => {
    workerState.reset();
  });

  it("matches the golden CLI, MCP and view units", async () => {
    const runtime = { workspaceRoot: rootDir, ensureIndexed: async () => undefined, loadState: () => null };
    const cli = JSON.parse(await runArchitectureCli(["--level", "units"], runtime as never, "json"));
    const mcp = await executeExploreArchitecture({ level: "units", limit: 500 });
    const firstPage = await executeExploreArchitecture({ level: "units", limit: 2 });
    const view = await viewSummary();

    expect(mcp.context.revision).toBe(cli.context.revision);
    expect(view.revision).toBe(cli.context.revision);
    for (const field of ["units", "unitEdges", "upwardEdges", "cycles", "totals"] as const) {
      expect(mcp[field as keyof typeof mcp], field).toEqual(cli[field]);
      expect(view.units?.[field], field).toEqual(cli[field]);
    }
    // Every group of the view belongs to one unit, and the units' files are the groups' files.
    const filesPerUnit = new Map<string, number>();
    for (const group of view.groups) {
      const unit = view.units!.groupUnits[group.id];
      filesPerUnit.set(unit, (filesPerUnit.get(unit) ?? 0) + group.fileCount);
    }
    expect(view.unassigned.fileCount).toBe(0);
    expect(Object.fromEntries(filesPerUnit)).toEqual(Object.fromEntries(cli.units.map((unit: { key: string; fileCount: number }) => [unit.key, unit.fileCount])));

    await expect(stable({ cli, firstPage, groups: view.groups, groupUnits: view.units?.groupUnits }))
      .toMatchFileSnapshot("__snapshots__/workspaces-project.units.json");
  });

  it("lists the same file pairs behind every unit edge in the CLI, explore_architecture and the view", async () => {
    const runtime = { workspaceRoot: rootDir, ensureIndexed: async () => undefined, loadState: () => null };
    const posted: ArchitectureExtensionMessage[] = [];
    const { service, summary } = await buildView(rootDir, posted);
    const packages = summary.units!.units.map((unit) => unit.key).filter((key) => key !== "(root)");
    // A file is in a package unit below its folder, else in (root).
    const inUnit = (file: string, unit: string) =>
      (unit === "(root)" ? !packages.some((key) => file.startsWith(`${key}/`)) : file.startsWith(`${unit}/`));
    const evidence = [];
    for (const edge of summary.units!.unitEdges) {
      const cli = JSON.parse(await runArchitectureCli(["--level", "units", "--from", edge.from, "--to", edge.to], runtime as never, "json"));
      const mcp = await executeExploreArchitecture({ level: "units", from: edge.from, to: edge.to, limit: 500 });
      await service.handleWebviewMessage({ command: "architectureUnitEvidence", revision: summary.revision, from: edge.from, to: edge.to });
      const view = posted.at(-1);
      expect(view).toMatchObject({ type: "architectureEvidencePage", from: edge.from, to: edge.to });
      expect(mcp).toMatchObject({ view: "evidence", kind: edge.kind, page: { total: edge.fileEdgeCount } });
      expect(cli.pairs, `${edge.from} → ${edge.to}`).toEqual(mcp.pairs);
      for (const pair of mcp.pairs) {
        expect(inUnit(pair.source, edge.from), pair.source).toBe(true);
        expect(inUnit(pair.target, edge.to), pair.target).toBe(true);
      }
      expect(view?.type === "architectureEvidencePage" && view.pairs).toEqual(mcp.pairs);
      evidence.push({ from: edge.from, to: edge.to, kind: mcp.kind, total: mcp.page.total, pairs: mcp.pairs });
    }
    await expect(stable(evidence)).toMatchFileSnapshot("__snapshots__/workspaces-project.unit-evidence.json");
  });

  it("rejects --from without --to or --level units", async () => {
    const runtime = { workspaceRoot: rootDir, ensureIndexed: async () => undefined, loadState: () => null };
    await expect(runArchitectureCli(["--level", "units", "--from", "apps/web"], runtime as never, "json")).rejects.toThrow("--from and --to");
    await expect(runArchitectureCli(["--from", "apps/web", "--to", "packages/core"], runtime as never, "json")).rejects.toThrow("with --level units");
    await expect(runArchitectureCli(["--level", "units", "--from", "--to", "x"], runtime as never, "json")).rejects.toThrow("--from must be a unit key");
  });

  it("rejects an unknown --level", async () => {
    const runtime = { workspaceRoot: rootDir, ensureIndexed: async () => undefined, loadState: () => null };
    await expect(runArchitectureCli(["--level", "files"], runtime as never, "json")).rejects.toThrow("--level must be groups or units");
  });

  it("--level groups is the --groups output", async () => {
    const runtime = { workspaceRoot: rootDir, ensureIndexed: async () => undefined, loadState: () => null };
    const groups = await runArchitectureCli(["--groups"], runtime as never, "json");
    expect(await runArchitectureCli(["--level", "groups"], runtime as never, "json")).toBe(groups);
  });
});
