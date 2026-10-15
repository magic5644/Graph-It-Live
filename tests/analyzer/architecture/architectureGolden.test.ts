import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Parser } from "../../../src/analyzer/Parser";
import { SpiderBuilder } from "../../../src/analyzer/SpiderBuilder";
import { PathResolver } from "../../../src/analyzer/utils/PathResolver";
import { run as runArchitectureCli } from "../../../src/cli/commands/architecture";
import { workerState } from "../../../src/mcp/shared/state";
import { executeExploreArchitecture } from "../../../src/mcp/tools/architecture";
import { normalizePath } from "../../../src/shared/path";
import type { CommunityMode } from "../../../src/shared/graph-types";

// Golden outputs of `graph-it architecture --groups` and explore_architecture on real fixtures,
// so moving the architecture graph between layers cannot change a count, order or field.
const fixtures = ["sample-project", "cyclic-project"];
const modes: CommunityMode[] = ["path", "louvain"];

describe.each(fixtures)("architecture golden output: %s", (fixture) => {
  const rootDir = path.resolve(__dirname, "../../fixtures", fixture);
  const root = normalizePath(rootDir);
  // Absolute paths differ per machine and OS; snapshots keep them relative to the fixture.
  const stable = (value: unknown) =>
    JSON.stringify(value, null, 2).replaceAll(JSON.stringify(root).slice(1, -1), "<root>") + "\n";

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

  it.each(modes)("matches the golden CLI and MCP output in %s mode", async (communityMode) => {
    const runtime = { workspaceRoot: rootDir, ensureIndexed: async () => undefined, loadState: () => null };
    const cli = JSON.parse(await runArchitectureCli(["--groups", "--communityMode", communityMode], runtime as never, "json"));
    const summary = await executeExploreArchitecture({ communityMode });
    const firstPage = await executeExploreArchitecture({ communityMode, limit: 1 });
    const secondPage = await executeExploreArchitecture({ communityMode, limit: 1, offset: 1 });
    const groups = [...summary.groups.map(group => group.id), ...(summary.unassigned.fileCount > 0 ? [0] : [])];
    const groupViews = await Promise.all(groups.map(group => executeExploreArchitecture({ communityMode, group })));
    const evidence = await Promise.all(summary.groupEdges.map(edge =>
      executeExploreArchitecture({ communityMode, from: edge.from, to: edge.to })));
    const evidencePages = await Promise.all(summary.groupEdges.map(edge =>
      executeExploreArchitecture({ communityMode, from: edge.from, to: edge.to, limit: 1, offset: 1 })));

    await expect(stable({ cli, summary, firstPage, secondPage, groupViews, evidence, evidencePages }))
      .toMatchFileSnapshot(`__snapshots__/${fixture}.${communityMode}.json`);
  });
});
