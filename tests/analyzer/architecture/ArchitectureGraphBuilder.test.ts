import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildArchitectureGraph } from "../../../src/analyzer/architecture/ArchitectureGraphBuilder";
import { SourceFileCollector } from "../../../src/analyzer/SourceFileCollector";
import type { Dependency } from "../../../src/analyzer/types";
import { normalizePath } from "../../../src/shared/path";

const dependency = (filePath: string): Dependency => ({ path: filePath, type: "import", line: 1, module: "./x" });

describe("buildArchitectureGraph", () => {
  let root: string;
  let fileA: string;
  let fileB: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gitl-architecture-")));
    fileA = path.join(root, "src", "api", "a.ts");
    fileB = path.join(root, "src", "db", "b.ts");
    await fs.mkdir(path.dirname(fileA), { recursive: true });
    await fs.mkdir(path.dirname(fileB), { recursive: true });
    await fs.writeFile(fileA, "import './../db/b';\n");
    await fs.writeFile(fileB, "");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("builds nodes, deduplicated edges and path groups from the injected analysis", async () => {
    const analyzeFile = vi.fn(async (filePath: string) =>
      filePath === normalizePath(fileA)
        ? [dependency(fileB), dependency(fileB), dependency(path.join(root, "..", "outside.ts"))]
        : []);

    const graph = await buildArchitectureGraph(root, analyzeFile, { indexedAt: "2026-10-15T00:00:00Z" });

    expect(analyzeFile).toHaveBeenCalledWith(normalizePath(fileA));
    expect(graph.edges).toEqual([{
      source: normalizePath(fileA),
      target: normalizePath(fileB),
      sourceRelative: "src/api/a.ts",
      targetRelative: "src/db/b.ts",
      // The first import of the target: its line locates a rule violation (SARIF).
      line: 1,
    }]);
    expect(graph.nodes.map(node => [node.relativePath, node.dependencyCount, node.dependentCount, node.communityKey]))
      .toEqual([["src/api/a.ts", 1, 0, "api"], ["src/db/b.ts", 0, 1, "db"]]);
    expect(graph).toMatchObject({ scannedFiles: 2, analyzedFiles: 2, failedFiles: [] });
    expect(graph.context).toMatchObject({ communityMode: "path", indexedAt: "2026-10-15T00:00:00Z", truncated: false, maxFiles: undefined });
  });

  it("keeps node ids stable when the analysis returns Windows separators", async () => {
    const windowsB = normalizePath(fileB).replaceAll("/", "\\");
    const graph = await buildArchitectureGraph(root, async (filePath) =>
      filePath === normalizePath(fileA) ? [dependency(windowsB)] : []);

    expect(graph.graphData.nodes).toEqual([normalizePath(fileA), normalizePath(fileB)]);
    expect(graph.edges[0].target).toBe(normalizePath(fileB));
  });

  it("gives the same graph the same revision, whatever the separators, and a new one when it changes", async () => {
    const analyze = (target: string) => async (filePath: string) =>
      filePath === normalizePath(fileA) ? [dependency(target)] : [];
    const posix = await buildArchitectureGraph(root, analyze(fileB));
    const windows = await buildArchitectureGraph(root, analyze(normalizePath(fileB).replaceAll("/", "\\")));
    const louvain = await buildArchitectureGraph(root, analyze(fileB), { communityMode: "louvain" });
    const noEdge = await buildArchitectureGraph(root, async () => []);

    expect(posix.context.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(windows.context.revision).toBe(posix.context.revision);
    expect(louvain.context.revision).not.toBe(posix.context.revision);
    expect(noEdge.context.revision).not.toBe(posix.context.revision);
  });

  it("gives the same revision whatever the file order within a group, and its own one to an empty workspace", async () => {
    const upper = path.join(root, "src", "api", "B.ts");
    await fs.writeFile(upper, "");
    const collect = vi.spyOn(SourceFileCollector.prototype, "collectAllSourceFiles");
    const analyze = async (filePath: string) => filePath === normalizePath(upper) ? [dependency(fileA)] : [];

    collect.mockResolvedValueOnce([fileA, upper, fileB]);
    const forward = await buildArchitectureGraph(root, analyze);
    // Swapping folders would renumber the groups; swapping files inside api must not change anything.
    collect.mockResolvedValueOnce([upper, fileA, fileB]);
    const backward = await buildArchitectureGraph(root, analyze);
    collect.mockResolvedValueOnce([]);
    const empty = await buildArchitectureGraph(root, analyze);

    // Code-unit order puts "B.ts" before "a.ts"; localeCompare would not, and varies with the locale.
    const codeUnitOrder = JSON.stringify([
      "path",
      ["src/api/B.ts\t1", "src/api/a.ts\t1", "src/db/b.ts\t2"],
      ["src/api/B.ts\tsrc/api/a.ts"],
    ]);
    expect(forward.context.revision).toBe(createHash("sha256").update(codeUnitOrder).digest("hex"));
    expect(backward.context.revision).toBe(forward.context.revision);
    expect(empty.context.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(empty.context.revision).not.toBe(forward.context.revision);
  });

  it("reports missing, outside and failing files with the analysis tool's reasons", async () => {
    const missing = path.join(root, "src", "gone.ts");
    const outside = path.join(root, "..", "outside.ts");
    vi.spyOn(SourceFileCollector.prototype, "collectAllSourceFiles").mockResolvedValue([fileA, missing, outside]);

    const graph = await buildArchitectureGraph(root, async () => {
      throw new Error("parse failed");
    });

    expect(graph.failedFiles).toEqual([
      { filePath: normalizePath(fileA), relativePath: "src/api/a.ts", reason: "parse failed" },
      { filePath: normalizePath(missing), relativePath: "src/gone.ts", reason: `File not found: ${normalizePath(missing)}` },
      { filePath: normalizePath(outside), relativePath: "../outside.ts", reason: `File path is outside workspace: ${normalizePath(outside)}` },
    ]);
    expect(graph.context.failedFiles).toBe(3);
  });

  it("caps analysed files with maxFiles and stops when aborted", async () => {
    const capped = await buildArchitectureGraph(root, async () => [], { maxFiles: 1, communityMode: "louvain" });
    expect(capped).toMatchObject({ scannedFiles: 2, analyzedFiles: 1 });
    expect(capped.context).toMatchObject({ communityMode: "louvain", maxFiles: 1, truncated: true });

    await expect(buildArchitectureGraph(root, async () => [], { signal: AbortSignal.abort() }))
      .rejects.toThrow();
  });

  it("reports progress after each analysed file", async () => {
    const onProgress = vi.fn();
    await buildArchitectureGraph(root, async () => [], { onProgress });
    expect(onProgress.mock.calls).toEqual([[1, 2], [2, 2]]);
  });
});
