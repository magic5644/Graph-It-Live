import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Parser } from "../../../src/analyzer/Parser";
import { SpiderBuilder } from "../../../src/analyzer/SpiderBuilder";
import { PathResolver } from "../../../src/analyzer/utils/PathResolver";
import { workerState } from "../../../src/mcp/shared/state";
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
      return {
        seed: result.seedLabel,
        files: result.groups.reduce((total, group) => total + group.transitiveFiles, 0),
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
});
