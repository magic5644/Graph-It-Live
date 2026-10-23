import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Parser } from "../../../src/analyzer/Parser";
import { SpiderBuilder } from "../../../src/analyzer/SpiderBuilder";
import { PathResolver } from "../../../src/analyzer/utils/PathResolver";
import { run as runArchitectureCli } from "../../../src/cli/commands/architecture";
import { workerState } from "../../../src/mcp/shared/state";
import { executeExploreArchitecture } from "../../../src/mcp/tools/architecture";
import type {
  ArchitectureDependentsResultMessage,
  ArchitectureDependentsSeed,
  ArchitectureExtensionMessage,
} from "../../../src/shared/architecture-types";
import type { CommunityMode } from "../../../src/shared/graph-types";
import { buildView } from "./viewHarness";

// Characterization of the counts the Architecture view shows (#424): the layer count, the
// per-unit group caps and the dependents totals, recorded as the webview derived them before
// they moved to the analyzer. The snapshots must not change when the code computing them moves.
const fixtures = ["sample-project", "cyclic-project"];
const modes: CommunityMode[] = ["path", "louvain"];

describe.each(fixtures)("architecture view counts: %s", (fixture) => {
  const rootDir = path.resolve(__dirname, "../../fixtures", fixture);

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

  it.each(modes)("keeps the counts the view shows in %s mode", async (communityMode) => {
    const posted: ArchitectureExtensionMessage[] = [];
    const { service, summary } = await buildView(rootDir, posted, communityMode);
    const { revision } = summary;

    /** The Dependents panel's numbers for one seed, as the panel's header and rows show them. */
    const dependents = async (seed: ArchitectureDependentsSeed, unit?: string) => {
      await service.handleWebviewMessage({ command: "architectureDependents", revision, unit, seed });
      const result = posted.at(-1) as ArchitectureDependentsResultMessage;
      const files = result.groups.reduce((total, group) => total + group.transitiveFiles, 0);
      // Since #424 the analyzer sends these totals: they equal what the panel derived.
      expect(result.totals).toEqual({ files, groups: result.groups.length });
      return {
        seed: result.seedLabel,
        files,
        groups: result.groups.length,
        reachedFiles: result.reachedFiles,
        insideSeedGroup: result.insideSeedGroup,
      };
    };

    const level = summary.units;
    const seeds = level
      ? [
          ...level.units.map((entry) => ({ seed: { kind: "unit", key: entry.key } as const })),
          ...summary.groups.map((group) => ({ seed: { kind: "group", groupId: group.id } as const, unit: level.groupUnits[group.id] })),
        ]
      : summary.groups.map((group) => ({ seed: { kind: "group", groupId: group.id } as const }));
    const dependentsTotals = [];
    for (const { seed, unit } of seeds as { seed: ArchitectureDependentsSeed; unit?: string }[]) dependentsTotals.push(await dependents(seed, unit));

    if (level) expect(level.layerCount).toBe(new Set(level.units.map((unit) => unit.layer)).size);
    const counts = {
      totalGroups: summary.totalGroups,
      hiddenGroups: summary.hiddenGroups,
      hiddenGroupEdges: summary.hiddenGroupEdges,
      maxGroups: summary.maxGroups,
      keptGroups: summary.groups.map((group) => group.id),
      keptGroupEdges: summary.groupEdges.length,
      isolatedGroups: summary.isolatedGroups,
      layerCount: level ? new Set(level.units.map((unit) => unit.layer)).size : undefined,
      groupsByUnit: level?.groupsByUnit,
      dependents: dependentsTotals,
    };
    await expect(JSON.stringify(counts, null, 2) + "\n").toMatchFileSnapshot(`__snapshots__/${fixture}.${communityMode}.view-counts.json`);
  });

  // The view's summary, `graph-it architecture` JSON and explore_architecture report the same totals.
  it.each(modes)("reports the same totals in the view, the CLI and explore_architecture in %s mode", async (communityMode) => {
    const runtime = { workspaceRoot: rootDir, ensureIndexed: async () => undefined, loadState: () => null };
    const { summary } = await buildView(rootDir, [], communityMode);
    if (communityMode === "path") {
      const cli = JSON.parse(await runArchitectureCli(["--level", "units"], runtime as never, "json"));
      const mcp = await executeExploreArchitecture({ level: "units", limit: 500 });
      const view = summary.units!;
      expect(view.units).toHaveLength(cli.units.length);
      expect(mcp.page).toMatchObject({ totalUnits: cli.units.length, totalUnitEdges: cli.unitEdges.length });
      for (const field of ["layerCount", "upwardEdges", "cycles", "totals"] as const) {
        expect(mcp[field], field).toEqual(cli[field]);
        expect(view[field], field).toEqual(cli[field]);
      }
      return;
    }
    const cli = JSON.parse(await runArchitectureCli(["--groups", "--communities", "louvain"], runtime as never, "json"));
    const mcp = await executeExploreArchitecture({ communityMode, limit: 500 });
    expect(summary.revision).toBe(cli.context.revision);
    expect(summary.totalGroups).toBe(cli.groups.length);
    expect(summary.groupEdges.length + summary.hiddenGroupEdges).toBe(cli.groupEdges.length);
    expect(mcp.page).toMatchObject({ totalGroups: cli.groups.length, totalGroupEdges: cli.groupEdges.length });
    for (const field of ["totals", "unassigned"] as const) {
      expect(mcp[field as keyof typeof mcp], field).toEqual(cli[field]);
      expect(summary[field], field).toEqual(cli[field]);
    }
  });
});
