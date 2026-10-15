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

describe("exploreArchitecture", () => {
  let root: string;
  let graph: ArchitectureGraph;

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gitl-explorer-")));
    for (const relative of Object.keys(workspace)) {
      await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await fs.writeFile(path.join(root, relative), "");
    }
    // readdir order differs between file systems; pin it so group ids are deterministic.
    vi.spyOn(SourceFileCollector.prototype, "collectAllSourceFiles")
      .mockResolvedValue(Object.keys(workspace).map(relative => path.join(root, relative)));
    graph = await buildArchitectureGraph(root, async (filePath) =>
      workspace[normalizePath(path.relative(root, filePath))].map(relative =>
        ({ path: path.join(root, relative), type: "import" as const, line: 1, module: relative })));
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
});
