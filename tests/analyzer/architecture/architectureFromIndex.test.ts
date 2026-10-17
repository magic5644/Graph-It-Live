import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { overviewArchitecture } from "../../../src/analyzer/architecture/ArchitectureExplorer";
import { buildArchitectureGraph, type ArchitectureGraph } from "../../../src/analyzer/architecture/ArchitectureGraphBuilder";
import { SpiderDependencyAnalyzer } from "../../../src/analyzer/spider/SpiderDependencyAnalyzer";
import { SpiderBuilder } from "../../../src/analyzer/SpiderBuilder";
import type { CommunityMode } from "../../../src/shared/graph-types";

// The architecture view reads indexed files from the reverse index (#383): on the golden
// fixtures it must report what a full re-analysis reports, without parsing indexed files.
const fixtures = ["sample-project", "cyclic-project"];
const modes: CommunityMode[] = ["path", "louvain"];

const spiderFor = (rootDir: string) =>
  new SpiderBuilder().withRootDir(rootDir).withExcludeNodeModules(true).withReverseIndex(true).build();

/** Everything the view shows, in the order it was built: the index keeps import order. */
function shown(graph: ArchitectureGraph) {
  return {
    revision: graph.context.revision,
    overview: overviewArchitecture(graph, Number.POSITIVE_INFINITY),
    nodes: graph.nodes,
    edges: graph.edges,
    failedFiles: graph.failedFiles,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(fixtures)("architecture graph from the reverse index: %s", (fixture) => {
  const rootDir = path.resolve(__dirname, "../../fixtures", fixture);

  it.each(modes)("matches a full analysis without parsing indexed files in %s mode", async (communityMode) => {
    const reference = await buildArchitectureGraph(rootDir, (filePath) => spiderFor(rootDir).analyze(filePath), { communityMode });

    const indexer = spiderFor(rootDir);
    await indexer.buildFullIndex();
    // A restored index, as on a restart: its dependency order is rebuilt target by target.
    const spider = spiderFor(rootDir);
    spider.enableReverseIndex(indexer.getSerializedReverseIndex() ?? undefined);
    const analyze = vi.spyOn(SpiderDependencyAnalyzer.prototype, "analyze");

    const fromIndex = await buildArchitectureGraph(rootDir, (filePath) => spider.analyzeFromIndex(filePath), { communityMode });

    expect(shown(fromIndex)).toEqual(shown(reference));
    // Only files the index could not record (parse failures) are analysed again.
    expect(analyze).toHaveBeenCalledTimes(reference.failedFiles.length);
    expect(fromIndex.analyzedFiles).toBeGreaterThan(0);
  });

  it("analyses every file when the reverse index is off", async () => {
    const spider = new SpiderBuilder().withRootDir(rootDir).withExcludeNodeModules(true).withReverseIndex(false).build();
    const analyze = vi.spyOn(SpiderDependencyAnalyzer.prototype, "analyze");

    const graph = await buildArchitectureGraph(rootDir, (filePath) => spider.analyzeFromIndex(filePath));

    expect(analyze).toHaveBeenCalledTimes(graph.analyzedFiles);
  });
});
