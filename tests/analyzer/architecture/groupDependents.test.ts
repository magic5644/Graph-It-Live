import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildArchitectureGraph, type ArchitectureGraph } from "@/analyzer/architecture/ArchitectureGraphBuilder";
import { computeGroupDependents, DEPENDENTS_PROVENANCE } from "@/analyzer/architecture/groupDependents";
import { SpiderBuilder } from "@/analyzer/SpiderBuilder";

/**
 * A synthetic graph: each file's group key ("" = unassigned, id 0) and what it imports. Only the
 * nodes and edges are read by computeGroupDependents.
 */
function graphOf(files: Record<string, { group: string; imports?: string[] }>): ArchitectureGraph {
  const ids = new Map([...new Set(Object.values(files).map((file) => file.group).filter(Boolean))].map((key, index) => [key, index + 1]));
  const nodes = Object.entries(files).map(([relativePath, { group }]) => ({ relativePath, communityKey: group, communityId: ids.get(group) ?? 0 }));
  const edges = Object.entries(files).flatMap(([source, { imports = [] }]) =>
    imports.map((target) => ({ source, target, sourceRelative: source, targetRelative: target })));
  return { nodes, edges } as unknown as ArchitectureGraph;
}

const summary = (graph: ArchitectureGraph, seeds: string[], options?: Parameters<typeof computeGroupDependents>[2]) => {
  const { filesOf: _filesOf, ...rest } = computeGroupDependents(graph, seeds, options);
  return rest;
};

describe("computeGroupDependents", () => {
  it("walks a chain: each importer one level deeper, one group per level", () => {
    // d imports c imports b imports a: depths 1, 2, 3 from a.
    const graph = graphOf({
      "a/a.ts": { group: "a" },
      "b/b.ts": { group: "b", imports: ["a/a.ts"] },
      "c/c.ts": { group: "c", imports: ["b/b.ts"] },
      "d/d.ts": { group: "d", imports: ["c/c.ts"] },
    });
    expect(summary(graph, ["a/a.ts"])).toEqual({
      seed: { files: 1, groups: ["a"] },
      groups: [
        { key: "b", label: "b", directFiles: 1, transitiveFiles: 1, minDepth: 1 },
        { key: "c", label: "c", directFiles: 0, transitiveFiles: 1, minDepth: 2 },
        { key: "d", label: "d", directFiles: 0, transitiveFiles: 1, minDepth: 3 },
      ],
      insideSeedGroup: { directFiles: 0, transitiveFiles: 0 },
      reachedFiles: 3,
      maxDepthReached: false,
      provenance: DEPENDENTS_PROVENANCE,
    });
  });

  it("keeps the minimum depth of a diamond and counts the shared importer once", () => {
    // top imports left and right, both import seed; top also imports the seed directly.
    const graph = graphOf({
      "s/seed.ts": { group: "s" },
      "l/left.ts": { group: "l", imports: ["s/seed.ts"] },
      "r/right.ts": { group: "r", imports: ["s/seed.ts"] },
      "t/top.ts": { group: "t", imports: ["l/left.ts", "r/right.ts", "s/seed.ts"] },
      "t/far.ts": { group: "t", imports: ["t/top.ts"] },
    });
    const dependents = computeGroupDependents(graph, ["s/seed.ts"]);
    expect(dependents.reachedFiles).toBe(4);
    // Sorted by minimum depth, then most files, then key.
    expect(dependents.groups).toEqual([
      { key: "t", label: "t", directFiles: 1, transitiveFiles: 2, minDepth: 1 },
      { key: "l", label: "l", directFiles: 1, transitiveFiles: 1, minDepth: 1 },
      { key: "r", label: "r", directFiles: 1, transitiveFiles: 1, minDepth: 1 },
    ]);
    expect(dependents.filesOf("t")).toEqual({
      files: [{ relativePath: "t/top.ts", depth: 1 }, { relativePath: "t/far.ts", depth: 2 }],
      page: { total: 2, offset: 0, returned: 2, truncated: false, nextOffset: undefined },
    });
  });

  it("ends on a cycle and counts every file of it once", () => {
    // x → y → z → x, and x imports the seed.
    const graph = graphOf({
      "seed.ts": { group: "s" },
      "x.ts": { group: "loop", imports: ["seed.ts", "y.ts"] },
      "y.ts": { group: "loop", imports: ["z.ts"] },
      "z.ts": { group: "loop", imports: ["x.ts"] },
    });
    expect(summary(graph, ["seed.ts"]).groups).toEqual([{ key: "loop", label: "loop", directFiles: 1, transitiveFiles: 3, minDepth: 1 }]);
    expect(computeGroupDependents(graph, ["seed.ts"]).filesOf("loop").files.map((file) => `${file.relativePath}@${file.depth}`))
      .toEqual(["x.ts@1", "z.ts@2", "y.ts@3"]);
  });

  it("reports the seed group's own importers apart, and a seed importing another seed is no dependent", () => {
    const graph = graphOf({
      "core/a.ts": { group: "core" },
      "core/b.ts": { group: "core", imports: ["core/a.ts"] },
      "core/c.ts": { group: "core", imports: ["core/b.ts"] },
      "app/main.ts": { group: "app", imports: ["core/c.ts"] },
    });
    expect(summary(graph, ["core/a.ts"])).toMatchObject({
      groups: [{ key: "app", directFiles: 0, transitiveFiles: 1, minDepth: 3 }],
      insideSeedGroup: { directFiles: 1, transitiveFiles: 2 },
    });
    // A group seed: every file of core, so only app depends on it.
    expect(summary(graph, ["core/a.ts", "core/b.ts", "core/c.ts"])).toMatchObject({
      seed: { files: 3, groups: ["core"] },
      groups: [{ key: "app", directFiles: 1, transitiveFiles: 1, minDepth: 1 }],
      insideSeedGroup: { directFiles: 0, transitiveFiles: 0 },
      reachedFiles: 1,
    });
  });

  it("reports the unassigned files as their own group", () => {
    const graph = graphOf({
      "lib/util.ts": { group: "lib" },
      "main.ts": { group: "", imports: ["lib/util.ts"] },
    });
    expect(summary(graph, ["lib/util.ts"]).groups).toEqual([
      { key: "", label: "unassigned", directFiles: 1, transitiveFiles: 1, minDepth: 1 },
    ]);
  });

  it("stops at maxDepth and says whether it cut anything", () => {
    const graph = graphOf({
      "a.ts": { group: "a" },
      "b.ts": { group: "b", imports: ["a.ts"] },
      "c.ts": { group: "c", imports: ["b.ts"] },
    });
    expect(summary(graph, ["a.ts"], { maxDepth: 1 })).toMatchObject({ reachedFiles: 1, maxDepthReached: true });
    expect(summary(graph, ["a.ts"], { maxDepth: 2 })).toMatchObject({ reachedFiles: 2, maxDepthReached: false });
    expect(summary(graph, ["a.ts"], { maxDepth: 0 })).toMatchObject({ reachedFiles: 0, maxDepthReached: true });
  });

  it("groups by the given key, normalises seeds and ignores files outside the graph", () => {
    const graph = graphOf({
      "pkg/a/x.ts": { group: "a" },
      "pkg/b/y.ts": { group: "b", imports: ["pkg/a/x.ts"] },
    });
    const byPackage = summary(graph, [String.raw`pkg\a\x.ts`, "missing.ts"], { groupOf: (file) => file.split("/")[0] });
    expect(byPackage.seed).toEqual({ files: 1, groups: ["pkg"] });
    expect(byPackage.groups).toEqual([]);
    expect(byPackage.insideSeedGroup).toEqual({ directFiles: 1, transitiveFiles: 1 });
    expect(summary(graph, ["missing.ts"])).toMatchObject({ seed: { files: 0, groups: [] }, reachedFiles: 0, groups: [] });
  });

  it("pages a group's files 50 at a time by default", () => {
    const importers = Object.fromEntries(Array.from({ length: 60 }, (_, index) =>
      [`app/f${String(index).padStart(2, "0")}.ts`, { group: "app", imports: ["core.ts"] }]));
    const dependents = computeGroupDependents(graphOf({ "core.ts": { group: "core" }, ...importers }), ["core.ts"]);
    const first = dependents.filesOf("app");
    expect(first.page).toEqual({ total: 60, offset: 0, returned: 50, truncated: true, nextOffset: 50 });
    expect(first.files[0]).toEqual({ relativePath: "app/f00.ts", depth: 1 });
    expect(dependents.filesOf("app", { offset: 50 }).page).toEqual({ total: 60, offset: 50, returned: 10, truncated: false, nextOffset: undefined });
    expect(dependents.filesOf("unknown").page.total).toBe(0);
    expect(dependents.filesOf("app", { offset: 80 })).toEqual({ files: [], page: { total: 60, offset: 80, returned: 0, truncated: false, nextOffset: undefined } });
    expect(computeGroupDependents(graphOf({ "core.ts": { group: "core" } }), [])).toMatchObject({ seed: { files: 0, groups: [] }, reachedFiles: 0, groups: [] });
  });

  it("matches the hand-checked dependents of sample-project (path groups)", async () => {
    // node dist/graph-it.js architecture --groups --format json -w tests/fixtures/sample-project, file pairs:
    const pairs = [
      "src/circular.ts → src/main.ts",
      "src/components/Button.tsx → src/utils.ts",
      "src/index.ts → src/utils.ts",
      "src/main.ts → src/components/Button.tsx",
      "src/main.ts → src/utils.ts",
    ];
    const root = path.resolve(__dirname, "../../fixtures/sample-project");
    const spider = new SpiderBuilder().withRootDir(root).withExcludeNodeModules(true).build();
    const graph = await buildArchitectureGraph(root, (filePath) => spider.analyze(filePath), { communityMode: "path" });
    expect(graph.edges.map((edge) => `${edge.sourceRelative} → ${edge.targetRelative}`).sort()).toEqual(pairs);

    // utils.ts (unassigned): Button.tsx, index.ts and main.ts import it (depth 1), circular.ts imports main.ts (depth 2).
    // Only components lies outside the seed's group; the other three are unassigned like utils.ts.
    expect(summary(graph, ["src/utils.ts"])).toMatchObject({
      seed: { files: 1, groups: [""] },
      groups: [{ key: "components", label: "components", directFiles: 1, transitiveFiles: 1, minDepth: 1 }],
      insideSeedGroup: { directFiles: 2, transitiveFiles: 3 },
      reachedFiles: 4,
    });
    // Button.tsx (components): main.ts imports it (depth 1), circular.ts imports main.ts (depth 2), both unassigned.
    const button = computeGroupDependents(graph, ["src/components/Button.tsx"]);
    expect(button.groups).toEqual([{ key: "", label: "unassigned", directFiles: 1, transitiveFiles: 2, minDepth: 1 }]);
    expect(button.filesOf("").files).toEqual([{ relativePath: "src/main.ts", depth: 1 }, { relativePath: "src/circular.ts", depth: 2 }]);
  });
});
