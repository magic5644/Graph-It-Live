import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { exploreArchitecture, groupDetail, overviewArchitecture } from "../../../src/analyzer/architecture/ArchitectureExplorer";
import { buildArchitectureGraph, type ArchitectureGraph } from "../../../src/analyzer/architecture/ArchitectureGraphBuilder";
import { SourceFileCollector } from "../../../src/analyzer/SourceFileCollector";
import { SpiderBuilder } from "../../../src/analyzer/SpiderBuilder";
import { normalizePath } from "../../../src/shared/path";

// ui imports store three times; main.ts sits at the root, outside any folder group.
// Group ids follow file order (ui 1, store 2, "2" 3), so key "2" collides with store's id.
const workspace: Record<string, string[]> = {
  "main.ts": ["src/ui/view.ts"],
  "src/ui/view.ts": ["src/store/state.ts", "src/store/actions.ts"],
  "src/ui/form.ts": ["src/store/state.ts"],
  "src/store/state.ts": ["src/store/actions.ts"],
  "src/store/actions.ts": [],
  "src/2/extra.ts": [],
};

// The hub imports one file in each of 600 groups, and each of those files imports the hub back.
const SPOKES = 600;
const spokes = Array.from({ length: SPOKES }, (_, index) => `src/s${index}/spoke.ts`);
const hubWorkspace: Record<string, string[]> = {
  "src/hub/hub.ts": spokes,
  ...Object.fromEntries(spokes.map(spoke => [spoke, ["src/hub/hub.ts"]])),
};

// 201 files in src/big, all imported once: main imports the first 200 and the first imports the
// last, so the last file sorts on page 2 while its importer sits on page 1.
const BIG = Array.from({ length: 201 }, (_, index) => `src/big/f${String(index).padStart(3, "0")}.ts`);
const bigWorkspace: Record<string, string[]> = {
  "src/main/main.ts": BIG.slice(0, 200),
  [BIG[0]]: [BIG[200]],
  ...Object.fromEntries(BIG.slice(1).map(file => [file, []])),
};

async function buildWorkspace(root: string, files: Record<string, string[]>): Promise<ArchitectureGraph> {
  for (const relative of Object.keys(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), "");
  }
  // readdir order differs between file systems; pin it so group ids are deterministic.
  vi.spyOn(SourceFileCollector.prototype, "collectAllSourceFiles")
    .mockResolvedValue(Object.keys(files).map(relative => path.join(root, relative)));
  return buildArchitectureGraph(root, async (filePath) =>
    files[normalizePath(path.relative(root, filePath))].map(relative =>
      ({ path: path.join(root, relative), type: "import" as const, line: 1, module: relative })));
}

describe("exploreArchitecture", () => {
  let root: string;
  let graph: ArchitectureGraph;
  let hubGraph: ArchitectureGraph;

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gitl-explorer-")));
    graph = await buildWorkspace(path.join(root, "small"), workspace);
    hubGraph = await buildWorkspace(path.join(root, "hub"), hubWorkspace);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("summarises every group with counts from the full graph", () => {
    const summary = exploreArchitecture(graph);

    expect(summary.view).toBe("summary");
    expect(summary.totals).toMatchObject({ files: 6, fileEdges: 5 });
    expect(summary.unassigned.fileCount).toBe(1);
    expect(summary.page).toMatchObject({ offset: 0, limit: 50, truncated: false, nextOffset: undefined });
  });

  it("answers with the current revision and rejects another one", () => {
    const { revision } = graph.context;

    expect(exploreArchitecture(graph, { group: 2, revision })).toEqual(exploreArchitecture(graph, { group: 2 }));
    expect(() => exploreArchitecture(graph, { group: 2, revision: hubGraph.context.revision }))
      .toThrow(`Architecture changed (revision ${hubGraph.context.revision} -> ${revision})`);
  });

  it("throws for an unknown group", () => {
    expect(() => exploreArchitecture(graph, { group: "missing" }))
      .toThrow('Unknown group "missing". Call explore_architecture without group, from or to to list the groups.');
  });

  it("resolves the unassigned files by 0 and by \"unassigned\"", () => {
    const byId = exploreArchitecture(graph, { group: 0 });
    const byLabel = exploreArchitecture(graph, { group: "unassigned" });

    expect(byId.view === "group" && byId.files).toEqual(["main.ts"]);
    expect(byLabel).toEqual(byId);
  });

  it("prefers a folder key over a group id with the same text", () => {
    const byKey = exploreArchitecture(graph, { group: "2" });
    const idTwo = exploreArchitecture(graph).groups.find(group => group.id === 2);

    expect(idTwo?.key).toBe("store");
    expect(byKey.view === "group" && byKey.group.key).toBe("2");
    expect(byKey.view === "group" && byKey.files).toEqual(["src/2/extra.ts"]);
  });

  it("pages evidence: the last page has no nextOffset and an offset past the end is empty", () => {
    const last = exploreArchitecture(graph, { from: "ui", to: "store", offset: 2, limit: 2 });
    const past = exploreArchitecture(graph, { from: "ui", to: "store", offset: 10, limit: 2 });

    expect(last.view === "evidence" && last.pairs).toEqual([{ source: "src/ui/view.ts", target: "src/store/state.ts" }]);
    expect(last.page).toEqual({ total: 3, offset: 2, returned: 1, truncated: false, nextOffset: undefined });
    expect(past.view === "evidence" && past.pairs).toEqual([]);
    expect(past.page).toEqual({ total: 3, offset: 10, returned: 0, truncated: false, nextOffset: undefined });
  });

  it("resolves a numeric reference by id only, even when a folder key has the same text", () => {
    const byId = exploreArchitecture(graph, { group: 2 });
    const edge = exploreArchitecture(graph, { from: 1, to: 2 });
    const reversed = exploreArchitecture(graph, { from: 2, to: 1 });

    expect(byId.view === "group" && byId.group.key).toBe("store");
    expect(edge.view === "evidence" && edge.to.key).toBe("store");
    expect(edge.view === "evidence" && edge.pairs).toHaveLength(3);
    expect(reversed.view === "evidence" && reversed.from.key).toBe("store");
    expect(() => exploreArchitecture(graph, { group: 99 })).toThrow('Unknown group "99"');
  });

  it("pages a group's incoming and outgoing edges with the files", () => {
    const first = exploreArchitecture(hubGraph, { group: "hub", limit: 1 });

    expect(first.view === "group" && first.files).toEqual(["src/hub/hub.ts"]);
    expect(first.view === "group" && first.incoming).toHaveLength(1);
    expect(first.view === "group" && first.outgoing).toHaveLength(1);
    expect(first.page).toEqual({
      offset: 0, limit: 1, totalFiles: 1, totalIncoming: SPOKES, totalOutgoing: SPOKES, truncated: true, nextOffset: 1,
    });
  });

  it("walks every boundary edge exactly once, then stops", () => {
    const incoming: string[] = [];
    const outgoing: string[] = [];
    let offset: number | undefined = 0;
    let last;
    while (offset !== undefined) {
      last = exploreArchitecture(hubGraph, { group: "hub", offset, limit: 250 });
      if (last.view !== "group") throw new Error("expected the group view");
      incoming.push(...last.incoming.map(edge => edge.fromLabel));
      outgoing.push(...last.outgoing.map(edge => edge.toLabel));
      offset = last.page.nextOffset;
    }
    const past = exploreArchitecture(hubGraph, { group: "hub", offset: SPOKES, limit: 250 });

    expect(new Set(incoming).size).toBe(SPOKES);
    expect(incoming).toHaveLength(SPOKES);
    expect(new Set(outgoing).size).toBe(SPOKES);
    expect(outgoing).toHaveLength(SPOKES);
    expect(last?.page).toMatchObject({ offset: 500, truncated: false, nextOffset: undefined });
    expect(past.view === "group" && [past.files, past.incoming, past.outgoing]).toEqual([[], [], []]);
    expect(past.page).toMatchObject({ totalFiles: 1, totalIncoming: SPOKES, totalOutgoing: SPOKES, truncated: false });
  });
});

describe("groupDetail", () => {
  let root: string;
  let graph: ArchitectureGraph;
  let bigGraph: ArchitectureGraph;

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gitl-detail-")));
    graph = await buildWorkspace(path.join(root, "small"), workspace);
    bigGraph = await buildWorkspace(path.join(root, "big"), bigWorkspace);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("lists a group's files most depended-on first, with their pairs and boundary counts", () => {
    const store = groupDetail(graph, "store");

    expect(store.group).toMatchObject({ key: "store", fileCount: 2, internalEdgeCount: 1 });
    expect(store.files).toEqual([
      { relativePath: "src/store/state.ts", dependencyCount: 1, dependentCount: 2 },
      { relativePath: "src/store/actions.ts", dependencyCount: 0, dependentCount: 2 },
    ].sort((left, right) => left.relativePath.localeCompare(right.relativePath)));
    expect(store.internalPairs).toEqual([{ source: "src/store/state.ts", target: "src/store/actions.ts" }]);
    expect(store.outgoing).toEqual([]);
    expect(store.incoming).toEqual([
      { relativePath: "src/store/actions.ts", fromGroup: 1, fileEdgeCount: 1 },
      { relativePath: "src/store/state.ts", fromGroup: 1, fileEdgeCount: 2 },
    ]);
    expect(store.page).toEqual({ total: 2, offset: 0, returned: 2, truncated: false, nextOffset: undefined, limit: 200 });

    const ui = groupDetail(graph, 1);
    expect(ui.outgoing).toEqual([
      { relativePath: "src/ui/form.ts", toGroup: 2, fileEdgeCount: 1 },
      { relativePath: "src/ui/view.ts", toGroup: 2, fileEdgeCount: 2 },
    ]);
    expect(ui.outgoingPairs).toHaveLength(3);
    expect(ui.incoming).toEqual([{ relativePath: "src/ui/view.ts", fromGroup: 0, fileEdgeCount: 1 }]);
  });

  it("expands the unassigned files as group 0", () => {
    const unassigned = groupDetail(graph, 0);

    expect(unassigned.group).toMatchObject({ id: 0, label: "unassigned" });
    expect(unassigned.files.map(file => file.relativePath)).toEqual(["main.ts"]);
    expect(unassigned.outgoingPairs).toEqual([{ source: "main.ts", target: "src/ui/view.ts", toGroup: 1 }]);
  });

  it("returns a pair on its source's page, so pages hold every internal pair once", () => {
    const first = groupDetail(bigGraph, "big");
    const second = groupDetail(bigGraph, "big", { offset: first.page.nextOffset });

    expect(first.files).toHaveLength(200);
    expect(first.page).toMatchObject({ total: 201, returned: 200, truncated: true, nextOffset: 200 });
    expect(first.internalPairs).toEqual([{ source: BIG[0], target: BIG[200] }]);
    expect(second.files.map(file => file.relativePath)).toEqual([BIG[200]]);
    expect(second.page).toMatchObject({ offset: 200, returned: 1, truncated: false, nextOffset: undefined });
    expect(second.internalPairs).toEqual([]);
    expect(groupDetail(bigGraph, "big", { offset: 201 }).files).toEqual([]);
    expect(first.incoming).toHaveLength(200);
    expect(second.incoming).toEqual([]);
  });

  it("rejects another revision and an unknown group", () => {
    expect(groupDetail(graph, 2, { revision: graph.context.revision }).group.key).toBe("store");
    expect(() => groupDetail(graph, 2, { revision: bigGraph.context.revision })).toThrow("Architecture changed");
    expect(() => groupDetail(graph, 99)).toThrow('Unknown group "99"');
  });

  it("filters evidence by source or target file, normalizing Windows separators", () => {
    const bySource = exploreArchitecture(graph, { from: "ui", to: "store", sourceFile: String.raw`src\ui\view.ts` });
    const byTarget = exploreArchitecture(graph, { from: "ui", to: "store", targetFile: "src/store/state.ts" });
    const byBoth = exploreArchitecture(graph, { from: 1, to: 2, sourceFile: "src/ui/form.ts", targetFile: "src/store/state.ts" });

    expect(bySource.view === "evidence" && bySource.pairs).toEqual([
      { source: "src/ui/view.ts", target: "src/store/actions.ts" },
      { source: "src/ui/view.ts", target: "src/store/state.ts" },
    ]);
    expect(byTarget.page).toMatchObject({ total: 2 });
    expect(byBoth.page).toMatchObject({ total: 1 });
  });
});

describe.each(["sample-project", "cyclic-project"])("groupDetail on %s", (fixture) => {
  const rootDir = path.resolve(__dirname, "../../fixtures", fixture);

  it.each(["path", "louvain"] as const)("adds up to the group edges and their evidence in %s mode", async (communityMode) => {
    const spider = new SpiderBuilder().withRootDir(rootDir).withExcludeNodeModules(true).build();
    const graph = await buildArchitectureGraph(rootDir, filePath => spider.analyze(filePath), { communityMode });
    const summary = exploreArchitecture(graph, { limit: 1000 });
    if (summary.view !== "summary") throw new Error("expected the summary view");
    const outgoing = new Map<string, number>();
    const incoming = new Map<string, number>();
    const add = (counts: Map<string, number>, key: string, count: number) => counts.set(key, (counts.get(key) ?? 0) + count);
    const groups = [...summary.groups.map(entry => entry.id), ...(summary.unassigned.fileCount > 0 ? [0] : [])];
    for (const group of groups) {
      const internal = new Set<string>();
      // One file per page: the sums must not depend on paging.
      for (let offset: number | undefined = 0; offset !== undefined;) {
        const detail = groupDetail(graph, group, { offset, limit: 1 });
        for (const entry of detail.outgoing) add(outgoing, `${group}>${entry.toGroup}`, entry.fileEdgeCount);
        for (const entry of detail.incoming) add(incoming, `${entry.fromGroup}>${group}`, entry.fileEdgeCount);
        for (const pair of detail.internalPairs) internal.add(`${pair.source}>${pair.target}`);
        for (const entry of detail.outgoing) {
          const evidence = exploreArchitecture(graph, { from: group, to: entry.toGroup, sourceFile: entry.relativePath });
          expect(evidence.page).toMatchObject({ total: entry.fileEdgeCount });
        }
        expect(detail.internalPairs.length + detail.outgoingPairs.length)
          .toBe(detail.files.reduce((total, file) => total + file.dependencyCount, 0));
        offset = detail.page.nextOffset;
      }
      const internalEdgeCount = group === 0 ? summary.unassigned.internalEdgeCount : summary.groups.find(entry => entry.id === group)?.internalEdgeCount;
      expect(internal.size).toBe(internalEdgeCount);
    }
    for (const edge of summary.groupEdges) {
      const key = `${edge.from}>${edge.to}`;
      expect([outgoing.get(key), incoming.get(key)]).toEqual([edge.fileEdgeCount, edge.fileEdgeCount]);
      expect(exploreArchitecture(graph, { from: edge.from, to: edge.to }).page).toMatchObject({ total: edge.fileEdgeCount });
    }
    expect(outgoing.size).toBe(summary.groupEdges.length);
    expect(incoming.size).toBe(summary.groupEdges.length);
    expect([...outgoing.values()].reduce((total, count) => total + count, 0)).toBe(summary.totals.interGroupEdges);
  }, 60000);
});

describe("overviewArchitecture", () => {
  let root: string;
  let graph: ArchitectureGraph;
  let hubGraph: ArchitectureGraph;

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gitl-overview-")));
    graph = await buildWorkspace(path.join(root, "small"), workspace);
    hubGraph = await buildWorkspace(path.join(root, "hub"), hubWorkspace);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("lists every group and labelled group edge when under the cap", () => {
    const overview = overviewArchitecture(graph, 150);

    expect(overview.groups.map(group => group.key)).toEqual(["ui", "store", "2"]);
    expect(overview.groupEdges).toEqual([
      { from: 0, to: 1, fileEdgeCount: 1, fromLabel: "unassigned", toLabel: "ui" },
      { from: 1, to: 2, fileEdgeCount: 3, fromLabel: "ui", toLabel: "store" },
    ]);
    expect(overview).toMatchObject({ totalGroups: 3, hiddenGroups: 0, hiddenGroupEdges: 0, scannedFiles: 6, analyzedFiles: 6 });
    expect(overview.unassigned).toEqual({ fileCount: 1, internalEdgeCount: 0 });
    expect(overview.context.revision).toBe(graph.context.revision);
  });

  it.each([[0, SPOKES + 1], [SPOKES + 1, 0], [SPOKES, 1]])("keeps the cap of %i groups, %i hidden", (cap, hidden) => {
    const overview = overviewArchitecture(hubGraph, cap);
    expect(overview.groups).toHaveLength(cap);
    expect(overview).toMatchObject({ totalGroups: SPOKES + 1, hiddenGroups: hidden });
  });

  it("keeps the largest groups and their edges, with totals from the full graph", () => {
    const overview = overviewArchitecture(hubGraph, 150);
    const shown = new Set(overview.groups.map(group => group.id));

    expect(overview.groups).toHaveLength(150);
    expect(overview.groups[0].key).toBe("hub");
    expect(overview.hiddenGroups).toBe(SPOKES + 1 - 150);
    expect(overview.groupEdges.every(edge => shown.has(edge.from) && shown.has(edge.to))).toBe(true);
    expect(overview.groupEdges).toHaveLength(2 * 149);
    expect(overview.hiddenGroupEdges).toBe(2 * SPOKES - 2 * 149);
    expect(overview.totals).toEqual(exploreArchitecture(hubGraph).totals);
    expect(overview.totals.interGroupEdges).toBe(2 * SPOKES);
  });
});
