import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Parser } from "../../../src/analyzer/Parser";
import { SpiderBuilder } from "../../../src/analyzer/SpiderBuilder";
import { PathResolver } from "../../../src/analyzer/utils/PathResolver";
import { run as runArchitectureCli } from "../../../src/cli/commands/architecture";
import { ArchitectureViewService } from "../../../src/extension/services/ArchitectureViewService";
import { workerState } from "../../../src/mcp/shared/state";
import { executeExploreArchitecture } from "../../../src/mcp/tools/architecture";
import type { IndexerStatusSnapshot } from "../../../src/analyzer/IndexerStatus";
import type { ArchitectureExtensionMessage, ArchitectureMatrixMessage, ArchitectureSummaryMessage } from "../../../src/shared/architecture-types";
import type { CommunityMode } from "../../../src/shared/graph-types";
import { normalizePath } from "../../../src/shared/path";

// Golden output of `graph-it architecture --matrix`: the CLI, explore_architecture view "matrix"
// and the extension's Matrix view report the same rows, cells and totals, and the cells are the
// group edges of `--groups` (the diagonal their internal pairs).
const fixtures = ["sample-project", "cyclic-project"];
const modes: CommunityMode[] = ["path", "louvain"];

interface CliMatrix {
  context: { revision: string; communityMode: string };
  rows: { id: number | string; key: string; internalEdgeCount: number; outgoingPairs: number; incomingPairs: number; instability: number | null }[];
  cells: { row: number; column: number; fileEdgeCount: number; upward: boolean }[];
  cycles: { firstRow: number; lastRow: number; members: string[] }[];
  totals: { rows: number; cells: number; fileEdges: number; intraEdges: number; interEdges: number; upwardCells: number };
}

/** The Matrix view's answer for the level the summary opens on (units in path mode, every group in Louvain). */
async function viewMatrix(rootDir: string, communityMode: CommunityMode): Promise<ArchitectureMatrixMessage> {
  const posted: ArchitectureExtensionMessage[] = [];
  const service = new ArchitectureViewService({
    workspaceRoot: rootDir,
    analyzeFile: (filePath) => workerState.getSpider().analyze(filePath),
    readCommunityMode: () => communityMode,
    subscribeToIndexStatus: (callback) => {
      callback({ state: "idle" } as IndexerStatusSnapshot);
      return () => {};
    },
    post: (message) => posted.push(message),
    openFile: async () => {},
    warn: () => {},
  });
  await service.build();
  const summary = posted.find((message): message is ArchitectureSummaryMessage => message.type === "architectureSummary")!;
  await service.handleWebviewMessage({ command: "architectureMatrix", revision: summary.revision });
  return posted.at(-1) as ArchitectureMatrixMessage;
}

describe.each(fixtures)("architecture matrix golden output: %s", (fixture) => {
  const rootDir = path.resolve(__dirname, "../../fixtures", fixture);
  const root = normalizePath(rootDir);
  const stable = (value: unknown) =>
    [rootDir, root].reduce(
      (json, absolute) => json.replaceAll(JSON.stringify(absolute).slice(1, -1), "<root>"),
      JSON.stringify(value, null, 2),
    ) + "\n";
  const runtime = { workspaceRoot: rootDir, ensureIndexed: async () => undefined, loadState: () => null };

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

  it.each(modes)("matches the --groups counts, explore_architecture and the view in %s mode", async (communityMode) => {
    const communities = ["--communities", communityMode];
    const cli: CliMatrix = JSON.parse(await runArchitectureCli(["--matrix", ...communities], runtime as never, "json"));
    const groups = JSON.parse(await runArchitectureCli(["--groups", ...communities], runtime as never, "json"));
    const mcp = await executeExploreArchitecture({ communityMode, view: "matrix", limit: 500 });
    const firstPage = await executeExploreArchitecture({ communityMode, view: "matrix", limit: 2 });

    expect(cli.context.communityMode).toBe(communityMode);
    expect(cli.context.revision).toBe(groups.context.revision);
    // Off-diagonal cells are the group edges, the diagonal each group's internal pairs.
    const idAt = (index: number) => cli.rows[index].id;
    const offDiagonal = cli.cells.filter((cell) => cell.row !== cell.column)
      .map((cell) => ({ from: idAt(cell.row), to: idAt(cell.column), fileEdgeCount: cell.fileEdgeCount }));
    const byEnds = (left: { from: number | string; to: number | string }, right: { from: number | string; to: number | string }) =>
      Number(left.from) - Number(right.from) || Number(left.to) - Number(right.to);
    expect(offDiagonal.toSorted(byEnds)).toEqual([...groups.groupEdges].sort(byEnds));
    const internal = new Map<number, number>(groups.groups.map((group: { id: number; internalEdgeCount: number }) => [group.id, group.internalEdgeCount]));
    if (groups.unassigned.fileCount > 0) internal.set(0, groups.unassigned.internalEdgeCount);
    expect(Object.fromEntries(cli.rows.map((row) => [row.id, row.internalEdgeCount]))).toEqual(Object.fromEntries(internal));
    expect(cli.totals).toMatchObject({
      fileEdges: groups.totals.fileEdges, intraEdges: groups.totals.intraGroupEdges, interEdges: groups.totals.interGroupEdges,
    });
    // Ce and Ca add up to the pairs between groups: every such pair leaves one row and enters another.
    expect(cli.rows.reduce((total, row) => total + row.outgoingPairs, 0)).toBe(groups.totals.interGroupEdges);
    expect(cli.rows.reduce((total, row) => total + row.incomingPairs, 0)).toBe(groups.totals.interGroupEdges);

    for (const field of ["rows", "cells", "cycles", "totals", "context"] as const) expect(mcp[field], field).toEqual(cli[field]);
    expect(firstPage).toMatchObject({ view: "matrix", page: { total: cli.totals.cells, returned: 2, offset: 0 } });
    expect(firstPage.totals).toEqual(cli.totals);

    // The view opens on the units in path mode, on every group in Louvain: compare it with the same level of the CLI.
    const view = await viewMatrix(rootDir, communityMode);
    const sameLevel: CliMatrix = communityMode === "path"
      ? JSON.parse(await runArchitectureCli(["--level", "units", "--matrix"], runtime as never, "json"))
      : cli;
    expect(view.matrix.rows).toEqual(sameLevel.rows);
    expect(view.matrix.cells).toEqual(sameLevel.cells);
    expect(view.matrix.totals).toEqual(sameLevel.totals);

    const csv = await runArchitectureCli(["--matrix", ...communities], runtime as never, "csv");
    await expect(stable({ cli, firstPage, csv: csv.split("\n") }))
      .toMatchFileSnapshot(`__snapshots__/${fixture}.${communityMode}.matrix.json`);
  });

  it("rejects --matrix with --from and csv without --matrix", async () => {
    await expect(runArchitectureCli(["--level", "units", "--matrix", "--from", "a", "--to", "b"], runtime as never, "json"))
      .rejects.toThrow("--matrix lists every cell");
    await expect(runArchitectureCli(["--groups"], runtime as never, "csv")).rejects.toThrow('Format "csv" is only produced');
  });
});
