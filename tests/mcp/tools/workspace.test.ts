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
    it("should map validating to indexing and include warmup info", async () => {
      const spiderMock = {
        getIndexStatus: () => ({
          state: "validating",
          processed: 2,
          total: 4,
          percentage: 50,
          currentFile: "src/index.ts",
        }),
        getCacheStatsAsync: async () => ({
          dependencyCache: { size: 3 },
          reverseIndexStats: {
            indexedFiles: 1,
            targetFiles: 2,
            totalReferences: 3,
          },
        }),
        hasReverseIndex: () => true,
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
  });

  describe("executeRebuildIndex", () => {
    it("should clear cache, rebuild index, and report progress", async () => {
      const postMessage = vi.fn();
      const buildFullIndex = vi.fn(async (cb: any) => {
        cb(1, 2, "src/a.ts");
      });
      const spiderMock = {
        clearCache: vi.fn(),
        buildFullIndex,
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
  });
});
