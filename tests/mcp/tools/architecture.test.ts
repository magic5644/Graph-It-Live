import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizePath } from "../../../src/shared/path";

const mocks = vi.hoisted(() => ({
  collectAllSourceFiles: vi.fn(),
  executeAnalyzeDependencies: vi.fn(),
}));

vi.mock("../../../src/analyzer/SourceFileCollector", () => ({
  SourceFileCollector: class {
    collectAllSourceFiles = mocks.collectAllSourceFiles;
  },
}));

vi.mock("../../../src/mcp/tools/analysis", () => ({
  executeAnalyzeDependencies: mocks.executeAnalyzeDependencies,
}));

import { run as runArchitectureCli } from "../../../src/cli/commands/architecture";
import { workerState } from "../../../src/mcp/shared/state";
import { executeExploreArchitecture } from "../../../src/mcp/tools/architecture";
import { ExploreArchitectureParamsSchema } from "../../../src/mcp/types";

const workspaceRoot = path.resolve("/workspace");
const file = (relative: string) => normalizePath(path.join(workspaceRoot, relative));

// api imports db three times (a→b, a→c, d→b); db has one internal pair; index.ts has no domain.
const imports: Record<string, string[]> = {
  "src/api/a.ts": ["src/db/b.ts", "src/db/c.ts"],
  "src/api/d.ts": ["src/db/b.ts"],
  "src/db/b.ts": ["src/db/c.ts"],
  "src/db/c.ts": [],
  "index.ts": ["src/api/a.ts"],
};

describe("executeExploreArchitecture", () => {
  beforeEach(() => {
    workerState.config = { rootDir: workspaceRoot, excludeNodeModules: true, maxDepth: 3 };
    mocks.collectAllSourceFiles.mockResolvedValue(Object.keys(imports).map(file));
    mocks.executeAnalyzeDependencies.mockImplementation(async ({ filePath }: { filePath: string }) => {
      const relative = normalizePath(path.relative(workspaceRoot, filePath));
      return { dependencies: imports[relative].map(dependency => ({ path: file(dependency) })) };
    });
  });

  afterEach(() => {
    workerState.reset();
    vi.clearAllMocks();
  });

  it("summarises groups and group edges with the same counts as graph-it architecture --groups", async () => {
    const summary = await executeExploreArchitecture({});
    const cli = JSON.parse(await runArchitectureCli(
      ["--groups"],
      { workspaceRoot, ensureIndexed: vi.fn(), loadState: () => null } as never,
      "json",
    ));

    expect(summary.view).toBe("summary");
    expect(summary.totals).toEqual(cli.totals);
    expect(summary.totals).toEqual({ files: 5, fileEdges: 5, intraGroupEdges: 1, interGroupEdges: 4 });
    expect(summary).toMatchObject({ unassigned: cli.unassigned, groups: expect.arrayContaining(cli.groups) });
    expect(summary.groups.map(group => group.key)).toEqual(["api", "db"]);
    expect(summary.groupEdges[0]).toMatchObject({ fromLabel: "api", toLabel: "db", fileEdgeCount: 3 });
    expect(summary.groupEdges).toHaveLength(cli.groupEdges.length);
    expect(summary.context).toMatchObject({ communityMode: "path", graphKind: "imports", truncated: false });
    expect(summary.provenance.facts).toContain("static import relations");
    expect(summary.page).toMatchObject({ totalGroups: 2, totalGroupEdges: 2, truncated: false, nextOffset: undefined });
  });

  it("pages the summary and states what is hidden", async () => {
    const first = await executeExploreArchitecture({ limit: 1 });
    const second = await executeExploreArchitecture({ limit: 1, offset: 1 });

    expect(first.groups).toHaveLength(1);
    expect(first.page).toMatchObject({ totalGroups: 2, truncated: true, nextOffset: 1 });
    expect(second.groups).toHaveLength(1);
    expect(second.page).toMatchObject({ truncated: false, nextOffset: undefined });
  });

  it("returns one group's files and boundary, by key or by id", async () => {
    const byKey = await executeExploreArchitecture({ group: "db" });
    const byId = await executeExploreArchitecture({ group: byKey.group.id });

    expect(byKey.view).toBe("group");
    expect(byKey.group).toMatchObject({ key: "db", fileCount: 2, internalEdgeCount: 1 });
    expect(byKey.files).toEqual(["src/db/b.ts", "src/db/c.ts"]);
    expect(byKey.incoming).toEqual([expect.objectContaining({ fromLabel: "api", toLabel: "db", fileEdgeCount: 3 })]);
    expect(byKey.outgoing).toEqual([]);
    expect(byId.files).toEqual(byKey.files);
  });

  it("returns the unassigned files as a group", async () => {
    const unassigned = await executeExploreArchitecture({ group: "unassigned" });

    expect(unassigned.group).toMatchObject({ id: 0, fileCount: 1 });
    expect(unassigned.files).toEqual(["index.ts"]);
    expect(unassigned.outgoing).toEqual([expect.objectContaining({ fromLabel: "unassigned", toLabel: "api" })]);
  });

  it("lists the file pairs behind a group edge, paginated", async () => {
    const first = await executeExploreArchitecture({ from: "api", to: "db", limit: 2 });
    const rest = await executeExploreArchitecture({ from: "api", to: "db", limit: 2, offset: first.page.nextOffset });

    expect(first.view).toBe("evidence");
    expect(first.pairs).toEqual([
      { source: "src/api/a.ts", target: "src/db/b.ts" },
      { source: "src/api/a.ts", target: "src/db/c.ts" },
    ]);
    expect(first.page).toEqual({ total: 3, offset: 0, returned: 2, truncated: true, nextOffset: 2 });
    expect(rest.pairs).toEqual([{ source: "src/api/d.ts", target: "src/db/b.ts" }]);
    expect(rest.page).toMatchObject({ total: 3, truncated: false, nextOffset: undefined });
    expect(first.nextSteps).toContain("graphitlive_find_referencing_files");
  });

  it("returns empty evidence for groups that are not linked", async () => {
    const evidence = await executeExploreArchitecture({ from: "db", to: "api" });

    expect(evidence.pairs).toEqual([]);
    expect(evidence.page).toMatchObject({ total: 0, returned: 0, truncated: false });
  });

  it("rejects an unknown group", async () => {
    await expect(executeExploreArchitecture({ group: "missing" })).rejects.toThrow('Unknown group "missing"');
    await expect(executeExploreArchitecture({ from: "api", to: 99 })).rejects.toThrow('Unknown group "99"');
  });

  it("groups by import structure with communityMode louvain", async () => {
    const summary = await executeExploreArchitecture({ communityMode: "louvain" });

    expect(summary.context.communityMode).toBe("louvain");
    expect(summary.totals.fileEdges).toBe(5);
  });
});

describe("ExploreArchitectureParamsSchema", () => {
  it("accepts a summary, a group, or both edge ends", () => {
    expect(ExploreArchitectureParamsSchema.safeParse({}).success).toBe(true);
    expect(ExploreArchitectureParamsSchema.safeParse({ group: 2, limit: 10 }).success).toBe(true);
    expect(ExploreArchitectureParamsSchema.safeParse({ from: "api", to: "db", offset: 50 }).success).toBe(true);
  });

  it("rejects a single edge end, a group with an edge, and out-of-range paging", () => {
    expect(ExploreArchitectureParamsSchema.safeParse({ from: "api" }).success).toBe(false);
    expect(ExploreArchitectureParamsSchema.safeParse({ group: "api", from: "api", to: "db" }).success).toBe(false);
    expect(ExploreArchitectureParamsSchema.safeParse({ limit: 501 }).success).toBe(false);
    expect(ExploreArchitectureParamsSchema.safeParse({ group: "" }).success).toBe(false);
  });
});
