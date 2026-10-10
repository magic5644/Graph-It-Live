import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workerState } from "../../../src/mcp/shared/state";
import {
    executeGetIndexStatus,
    executeInvalidateFiles,
    executeRebuildIndex,
} from "../../../src/mcp/tools/workspace";

describe("workspace tools", () => {
  const setupWorkerState = (spiderMock: any) => {
    workerState.spider = spiderMock;
    workerState.parser = {} as any;
    workerState.resolver = {} as any;
    workerState.config = {
      rootDir: "/test",
      excludeNodeModules: true,
      maxDepth: 50,
    };
    workerState.isReady = true;
  };

  afterEach(() => {
    workerState.reset();
  });

  describe("executeGetIndexStatus", () => {
    const idleSpider = {
      getIndexStatus: () => ({ state: "complete", processed: 0, total: 0, percentage: 0 }),
      getOutOfRootImports: () => ({ count: 0, examples: [] }),
      getCacheStatsAsync: async () => ({
        dependencyCache: { size: 0 },
        reverseIndexStats: { indexedFiles: 708, targetFiles: 243, totalReferences: 1415 },
      }),
      hasReverseIndex: () => true,
      isReverseIndexEnabled: () => true,
    };

    it("omits callGraph when no call graph has been built", async () => {
      setupWorkerState(idleSpider);

      const result = await executeGetIndexStatus();

      expect(result.callGraph).toBeUndefined();
    });

    it("reports call graph coverage separately from the dependency index", async () => {
      setupWorkerState(idleSpider);
      // The call graph only covers languages shipping a Tree-sitter query, so its
      // file count is legitimately lower than the dependency index's.
      workerState.callGraphIndexer = {
        getCounts: () => ({ files: 478, symbols: 3446, relations: 5697 }),
        dispose: vi.fn(),
      } as any;

      const result = await executeGetIndexStatus();

      expect(result.reverseIndexStats?.indexedFiles).toBe(708);
      expect(result.callGraph).toEqual({
        indexedFiles: 478,
        symbols: 3446,
        relations: 5697,
      });
    });

    it("omits cacheFiles when this process runs without the shared cache", async () => {
      setupWorkerState(idleSpider);

      const result = await executeGetIndexStatus();

      expect(result.cacheFiles).toBeUndefined();
    });

    it("reports the on-disk size of the shared cache files", async () => {
      setupWorkerState(idleSpider);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-status-cache-"));
      try {
        fs.writeFileSync(path.join(dir, "reverse-index.json"), "{}");
        workerState.indexCache = { dir } as any;

        const result = await executeGetIndexStatus();

        // callgraph.db not written yet: 0, not absent.
        expect(result.cacheFiles).toEqual({ reverseIndexBytes: 2, callGraphBytes: 0 });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("reports no out-of-root imports, and no warning, when none were skipped", async () => {
      setupWorkerState(idleSpider);

      const result = await executeGetIndexStatus();

      expect(result.outOfRootImports).toBe(0);
      expect(result).not.toHaveProperty("warning");
      expect(result).not.toHaveProperty("monorepoRoot");
    });

    // Regression test for #264: a sub-package root must not look workspace-wide.
    it("reports skipped out-of-root imports with the monorepo root relative to the workspace", async () => {
      const mono = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-status-")));
      try {
        const worker = path.join(mono, "apps", "worker");
        fs.mkdirSync(worker, { recursive: true });
        fs.writeFileSync(path.join(mono, "package.json"), '{ "workspaces": ["apps/*"] }');
        setupWorkerState({
          ...idleSpider,
          workspaceRoot: worker,
          getOutOfRootImports: () => ({ count: 1, examples: ["@core/x"] }),
        });

        const result = await executeGetIndexStatus();

        expect(result).toMatchObject({
          outOfRootImports: 1,
          outOfRootImportExamples: ["@core/x"],
          monorepoRoot: "../..",
        });
        expect(result.warning).toContain("Monorepo root detected (../..)");
        expect(result.warning).toContain("graphitlive_set_workspace");
        expect(JSON.stringify(result)).not.toContain(mono);
      } finally {
        fs.rmSync(mono, { recursive: true, force: true });
      }
    });

    it("passes the cache provenance fields of warmup through", async () => {
      setupWorkerState(idleSpider);
      workerState.warmupInfo = {
        completed: true,
        durationMs: 24,
        filesIndexed: 708,
        filesFound: 708,
        filesAnalyzed: 0,
        fromCache: true,
      };

      const result = await executeGetIndexStatus();

      expect(result.warmup).toMatchObject({ fromCache: true, filesAnalyzed: 0, filesFound: 708 });
    });


    it("should map validating to indexing and include warmup info", async () => {
      const spiderMock = {
        getIndexStatus: () => ({
          state: "validating",
          processed: 2,
          total: 4,
          percentage: 50,
          currentFile: "src/index.ts",
        }),
        getOutOfRootImports: () => ({ count: 0, examples: [] }),
      getCacheStatsAsync: async () => ({
          dependencyCache: { size: 3 },
          reverseIndexStats: {
            indexedFiles: 1,
            targetFiles: 2,
            totalReferences: 3,
          },
        }),
        hasReverseIndex: () => true,
        isReverseIndexEnabled: () => true,
      };

      setupWorkerState(spiderMock);
      workerState.warmupInfo = { completed: true, durationMs: 100, filesIndexed: 3 };

      const result = await executeGetIndexStatus();
      expect(result.state).toBe("indexing");
      expect(result.isReady).toBe(true);
      expect(result.reverseIndexEnabled).toBe(true);
      expect(result.cacheSize).toBe(3);
      expect(result.reverseIndexStats).toEqual({
        indexedFiles: 1,
        targetFiles: 2,
        totalReferences: 3,
      });
      expect(result.progress).toBeUndefined();
      expect(result.warmup).toEqual({
        completed: true,
        durationMs: 100,
        filesIndexed: 3,
      });
    });
  });

  describe("executeInvalidateFiles", () => {
    it("should separate invalidated and not found files", () => {
      const spiderMock = {
        invalidateFile: (filePath: string) => filePath.endsWith(".ts"),
        hasReverseIndex: () => true,
        isReverseIndexEnabled: () => true,
      };

      setupWorkerState(spiderMock);

      const result = executeInvalidateFiles({
        filePaths: ["src/a.ts", "src/b.txt"],
      });

      expect(result.invalidatedFiles).toEqual(["src/a.ts"]);
      expect(result.notFoundFiles).toEqual(["src/b.txt"]);
      expect(result.invalidatedCount).toBe(1);
      expect(result.reverseIndexUpdated).toBe(true);
    });

    it("reverseIndexUpdated reflects enabled state, not entry presence", () => {
      // Semantic bug guard: enabled-but-empty index must still report updated=true
      // hasReverseIndex() (entries check) would return false here; isReverseIndexEnabled() returns true
      const spiderMock = {
        invalidateFile: () => true,
        hasReverseIndex: () => false,
        isReverseIndexEnabled: () => true,
      };

      setupWorkerState(spiderMock);

      const result = executeInvalidateFiles({ filePaths: ["src/a.ts"] });
      expect(result.reverseIndexUpdated).toBe(true);
    });
  });

  describe("executeInvalidateFiles call graph (#227)", () => {
    it("schedules every given file for call graph re-extraction", () => {
      setupWorkerState({ invalidateFile: vi.fn(() => false), isReverseIndexEnabled: () => true });
      workerState.callGraphIndexedRoot = "/test";

      executeInvalidateFiles({ filePaths: ["/test/src/a.ts", String.raw`C:\test\src\b.ts`] });

      expect([...workerState.callGraphPendingFiles]).toEqual(["/test/src/a.ts", "c:/test/src/b.ts"]);
      expect(workerState.callGraphIndexedRoot).toBeNull();
    });
  });

  describe("executeRebuildIndex", () => {
    it("reverseIndexEnabled stays true across clear and rebuild cycle", async () => {
      const postMessage = vi.fn();
      const spiderMock = {
        clearCache: vi.fn(),
        buildFullIndex: vi.fn(async () => ({ indexedFiles: 3, duration: 1, cancelled: false })),
        isReverseIndexEnabled: vi.fn(() => true),
        getOutOfRootImports: () => ({ count: 0, examples: [] }),
      getCacheStatsAsync: async () => ({
          dependencyCache: { size: 3 },
          reverseIndexStats: {
            indexedFiles: 3,
            targetFiles: 2,
            totalReferences: 5,
          },
        }),
      };

      setupWorkerState(spiderMock);

      const result = await executeRebuildIndex(postMessage);

      expect(spiderMock.clearCache).toHaveBeenCalledTimes(1);
      expect(result.reverseIndexStats.indexedFiles).toBe(3);
      expect(result.reverseIndexStats.totalReferences).toBe(5);
    });

    it("should clear cache, rebuild index, and report progress", async () => {
      const postMessage = vi.fn();
      const buildFullIndex = vi.fn(async (cb: any) => {
        cb(1, 2, "src/a.ts");
        return { indexedFiles: 5, duration: 1, cancelled: false };
      });
      const spiderMock = {
        clearCache: vi.fn(),
        buildFullIndex,
        getOutOfRootImports: () => ({ count: 0, examples: [] }),
      getCacheStatsAsync: async () => ({
          dependencyCache: { size: 5 },
          reverseIndexStats: null,
        }),
      };

      setupWorkerState(spiderMock);

      const result = await executeRebuildIndex(postMessage);

      expect(spiderMock.clearCache).toHaveBeenCalledTimes(1);
      expect(buildFullIndex).toHaveBeenCalledTimes(1);
      expect(postMessage).toHaveBeenCalledWith({
        type: "warmup-progress",
        processed: 1,
        total: 2,
        currentFile: "src/a.ts",
      });
      expect(result.reindexedCount).toBe(5);
      expect(result.newCacheSize).toBe(5);
      expect(result.reverseIndexStats).toEqual({
        indexedFiles: 0,
        targetFiles: 0,
        totalReferences: 0,
      });
    });
    it("reports why the call graph could not be rebuilt instead of failing (#227)", async () => {
      setupWorkerState({
        clearCache: vi.fn(),
        buildFullIndex: vi.fn(async () => ({ indexedFiles: 1, duration: 1, cancelled: false })),
        getOutOfRootImports: () => ({ count: 0, examples: [] }),
      getCacheStatsAsync: async () => ({ dependencyCache: { size: 1 }, reverseIndexStats: null }),
      });

      // No extensionPath in the config: the call graph WASM parsers cannot load.
      const result = await executeRebuildIndex(vi.fn());

      expect(result.reindexedCount).toBe(1);
      expect(result.callGraph).toEqual({
        rebuilt: false,
        error: "extensionPath required for call graph WASM parsers",
      });
    });

    it("reports the indexed file count, not the capped analysis cache size (#243)", async () => {
      setupWorkerState({
        clearCache: vi.fn(),
        buildFullIndex: vi.fn(async () => ({ indexedFiles: 1200, duration: 1, cancelled: false })),
        getOutOfRootImports: () => ({ count: 0, examples: [] }),
      getCacheStatsAsync: async () => ({
          dependencyCache: { size: 500 },
          reverseIndexStats: { indexedFiles: 1200, targetFiles: 900, totalReferences: 4000 },
        }),
      });

      const result = await executeRebuildIndex(vi.fn());

      expect(result.reindexedCount).toBe(1200);
      expect(result.newCacheSize).toBe(500);
    });
  });
});
