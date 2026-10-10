import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { GraphExtractor } from "@/analyzer/callgraph/GraphExtractor";
import { LanguageService } from "@/analyzer/LanguageService";
import { Spider } from "@/analyzer/Spider";
import { CliRuntime } from "@/cli/runtime";
import { workerState } from "@/mcp/shared/state";
import { ensureCallGraphReady } from "@/mcp/tools/callgraph";
import { normalizePath } from "@/shared/path";
import { REPO_ROOT, wasmBuilt } from "../mcp/tools/callGraphWorkspace";

/**
 * Issue #290: most performance regressions make the analyzer do more work, not
 * run slower on one machine. These tests count the work done by one CLI process
 * (full builds, files analyzed, call-graph files parsed), so a broken cache path
 * fails on every OS without any timing assertion.
 */
const FILES = 13;

describe.runIf(wasmBuilt)("work counters", { timeout: 30_000 }, () => {
  let rootDir: string;
  let workspace: string;
  let cacheDir: string;
  let spies: { buildFullIndex: MockInstance; handleFileDeleted: MockInstance; extractFile: MockInstance };

  const write = (relPath: string, content: string): void => {
    const filePath = path.join(workspace, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  };

  /** One `graph-it` process: reverse index, then call graph, then exit. */
  const run = async () => {
    for (const spy of Object.values(spies)) spy.mockClear();
    LanguageService.reset();
    const runtime = new CliRuntime(workspace);
    try {
      await runtime.init();
      // Under Vitest the runtime derives its package root from src/, not dist/.
      workerState.config = { ...workerState.getConfig(), extensionPath: REPO_ROOT };
      const outcome = await runtime.ensureIndexed({ silent: true });
      await ensureCallGraphReady();
      const snapshot = workerState.callGraphIndexer!.getIndexSnapshot();
      return {
        fromCache: outcome.fromCache,
        filesIndexed: outcome.filesIndexed,
        filesAnalyzed: outcome.filesAnalyzed,
        fullBuilds: spies.buildFullIndex.mock.calls.length,
        deleted: spies.handleFileDeleted.mock.calls.length,
        parsed: spies.extractFile.mock.calls.length,
        references: workerState.getSpider().getCacheStats().reverseIndexStats?.totalReferences,
        nodes: snapshot.nodes.length,
        edges: snapshot.edges.length,
      };
    } finally {
      await runtime.dispose();
    }
  };

  /** Rewrite a file and move its mtime forward, so coarse clocks cannot hide the edit. */
  const edit = (relPath: string, content: string): void => {
    write(relPath, content);
    const changedAt = new Date(Date.now() + 2_000);
    fs.utimesSync(path.join(workspace, relPath), changedAt, changedAt);
  };

  beforeEach(() => {
    rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-counters-")));
    workspace = path.join(rootDir, "ws");
    cacheDir = path.join(workspace, ".graph-it", "cache");
    write("package.json", "{}");
    write("src/b.ts", "export function b() { return 1; }\n");
    for (let i = 0; i < FILES - 1; i++) {
      write(`src/f${i}.ts`, `import { b } from "./b";\nexport function f${i}() { return b(); }\n`);
    }
    spies = {
      buildFullIndex: vi.spyOn(Spider.prototype, "buildFullIndex"),
      handleFileDeleted: vi.spyOn(Spider.prototype, "handleFileDeleted"),
      extractFile: vi.spyOn(GraphExtractor.prototype, "extractFile"),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("analyzes every file once on a cold run", async () => {
    expect(await run()).toMatchObject({
      fromCache: false, filesIndexed: FILES, filesAnalyzed: FILES, fullBuilds: 1, parsed: FILES,
    });
  });

  it("does no work on a second run when nothing changed", async () => {
    await run();

    expect(await run()).toMatchObject({
      fromCache: true, filesIndexed: FILES, filesAnalyzed: 0, fullBuilds: 0, deleted: 0, parsed: 0,
    });
  });

  it("re-analyzes only the edited file", async () => {
    await run();
    edit("src/f0.ts", 'import { b } from "./b";\nexport function f0() { return b() + 1; }\n');

    // f0.ts has no importers, so no other file needs re-extraction.
    expect(await run()).toMatchObject({ fromCache: true, filesAnalyzed: 1, fullBuilds: 0, parsed: 1 });
  });

  it("drops a deleted file without a full rebuild", async () => {
    await run();
    fs.rmSync(path.join(workspace, "src/f0.ts"));

    expect(await run()).toMatchObject({
      fromCache: true, filesIndexed: FILES - 1, filesAnalyzed: 0, deleted: 1, fullBuilds: 0, parsed: 0, nodes: FILES - 1,
    });
  });

  // Regression guard for #263: an `extends` outside the workspace disabled the cache.
  it("reuses the cache when tsconfig.json extends a file outside the workspace", async () => {
    fs.writeFileSync(path.join(rootDir, "base.json"), '{"compilerOptions":{"strict":true}}');
    write("tsconfig.json", '{"extends":"../base.json"}');
    await run();

    expect(await run()).toMatchObject({ fromCache: true, filesAnalyzed: 0, fullBuilds: 0, parsed: 0 });
  });

  it("keeps the index and cache sizes of the fixture within range", async () => {
    // Every f<i>.ts imports and calls b(): one reference and one call edge each.
    expect(await run()).toMatchObject({ references: FILES - 1, nodes: FILES, edges: FILES - 1 });

    const size = (file: string) => fs.statSync(path.join(cacheDir, file)).size;
    // Paths are stored absolute: drop the workspace root so the size does not
    // depend on the temp directory of the OS running the test.
    const reverseIndex = fs.readFileSync(path.join(cacheDir, "reverse-index.json"), "utf-8");
    // Measured on macOS: 1,604 bytes and 61,440 bytes (15 SQLite pages). The ranges
    // absorb mtimeMs precision, which differs per OS; doubling either one fails.
    const rootFree = reverseIndex.replaceAll(normalizePath(workspace), "").length;
    expect(rootFree).toBeGreaterThan(1_300);
    expect(rootFree).toBeLessThan(2_000);
    expect(size("callgraph.db")).toBeGreaterThanOrEqual(40_960);
    expect(size("callgraph.db")).toBeLessThanOrEqual(81_920);
  });
});
