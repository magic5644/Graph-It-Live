import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { exploreArchitecture } from "../../../src/analyzer/architecture/ArchitectureExplorer";
import { buildArchitectureGraph, type ArchitectureGraph } from "../../../src/analyzer/architecture/ArchitectureGraphBuilder";
import { SourceFileCollector } from "../../../src/analyzer/SourceFileCollector";
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
