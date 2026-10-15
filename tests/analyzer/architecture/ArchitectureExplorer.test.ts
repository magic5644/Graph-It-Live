import * as path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { exploreArchitecture } from "../../../src/analyzer/architecture/ArchitectureExplorer";
import { buildArchitectureGraph, type ArchitectureGraph } from "../../../src/analyzer/architecture/ArchitectureGraphBuilder";
import { normalizePath } from "../../../src/shared/path";

const mocks = vi.hoisted(() => ({ collectAllSourceFiles: vi.fn() }));

vi.mock("../../../src/analyzer/SourceFileCollector", () => ({
  SourceFileCollector: class {
    collectAllSourceFiles = mocks.collectAllSourceFiles;
  },
}));

// The fixture paths do not exist on disk; the analysis below is the only source of edges.
vi.mock("../../../src/shared/pathSecurity", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  validateFileExists: vi.fn(),
}));

const workspaceRoot = path.resolve("/workspace");
const file = (relative: string) => normalizePath(path.join(workspaceRoot, relative));

// api imports db three times; index.ts has no folder group; folder "2" makes the key "2"
// collide with the text of another group's id.
const imports: Record<string, string[]> = {
  "src/api/a.ts": ["src/db/b.ts", "src/db/c.ts"],
  "src/api/d.ts": ["src/db/b.ts"],
  "src/db/b.ts": ["src/db/c.ts"],
  "src/db/c.ts": [],
  "src/2/e.ts": [],
  "index.ts": ["src/api/a.ts"],
};

describe("exploreArchitecture", () => {
  let graph: ArchitectureGraph;

  beforeAll(async () => {
    mocks.collectAllSourceFiles.mockResolvedValue(Object.keys(imports).map(file));
    graph = await buildArchitectureGraph(workspaceRoot, async (filePath) =>
      imports[normalizePath(path.relative(workspaceRoot, filePath))].map(relative =>
        ({ path: file(relative), type: "import" as const, line: 1, module: relative })));
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

    expect(byId.view === "group" && byId.files).toEqual(["index.ts"]);
    expect(byLabel).toEqual(byId);
  });

  it("prefers a folder key over a group id with the same text", () => {
    const byKey = exploreArchitecture(graph, { group: "2" });
    const idTwo = exploreArchitecture(graph).groups.find(group => group.id === 2);

    expect(idTwo?.key).toMatch(/^(api|db)$/);
    expect(byKey.view === "group" && byKey.group.key).toBe("2");
    expect(byKey.view === "group" && byKey.files).toEqual(["src/2/e.ts"]);
  });

  it("pages evidence: the last page has no nextOffset and an offset past the end is empty", () => {
    const last = exploreArchitecture(graph, { from: "api", to: "db", offset: 2, limit: 2 });
    const past = exploreArchitecture(graph, { from: "api", to: "db", offset: 10, limit: 2 });

    expect(last.view === "evidence" && last.pairs).toEqual([{ source: "src/api/d.ts", target: "src/db/b.ts" }]);
    expect(last.page).toEqual({ total: 3, offset: 2, returned: 1, truncated: false, nextOffset: undefined });
    expect(past.view === "evidence" && past.pairs).toEqual([]);
    expect(past.page).toEqual({ total: 3, offset: 10, returned: 0, truncated: false, nextOffset: undefined });
  });
});
