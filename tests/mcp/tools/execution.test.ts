import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workerState } from "../../../src/mcp/shared/state";

const { mockQueryCallGraph } = vi.hoisted(() => ({ mockQueryCallGraph: vi.fn() }));
vi.mock("../../../src/mcp/tools/callgraph", () => ({ executeQueryCallGraph: mockQueryCallGraph }));
import {
    executeGetSymbolCallers,
    executeTraceFunctionExecution,
} from "../../../src/mcp/tools/execution";

const createTempFile = async (dir: string, name: string, content = ""): Promise<string> => {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
};

describe("execution tools", () => {
  let tempDir: string;

  const setupWorkerState = (spiderMock: any) => {
    workerState.spider = spiderMock;
    workerState.parser = {} as any;
    workerState.resolver = {} as any;
    workerState.config = {
      rootDir: tempDir,
      excludeNodeModules: false,
      maxDepth: 3,
    };
    workerState.isReady = true;
  };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gitl-exec-"));
  });

  afterEach(async () => {
    mockQueryCallGraph.mockReset();
    workerState.reset();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("executeTraceFunctionExecution", () => {
    it("should enrich call chain with relative paths", async () => {
      const filePath = await createTempFile(tempDir, "main.ts", "");
      const resolvedFilePath = path.join(tempDir, "utils.ts");

      const spiderMock = {
        traceFunctionExecution: vi.fn(async () => ({
          rootSymbol: {
            id: `${filePath}:main`,
            filePath,
            symbolName: "main",
          },
          callChain: [
            {
              depth: 1,
              callerSymbolId: `${filePath}:main`,
              calledSymbolId: `${resolvedFilePath}:helper`,
              calledFilePath: resolvedFilePath,
              resolvedFilePath,
            },
          ],
          visitedSymbols: [`${filePath}:main`],
          maxDepthReached: false,
        })),
      };

      setupWorkerState(spiderMock);

      const result = await executeTraceFunctionExecution({
        filePath,
        symbolName: "main",
        maxDepth: 2,
      });

      expect(result.rootSymbol.relativePath).toBe("main.ts");
      expect(result.callChain[0].resolvedRelativePath).toBe("utils.ts");
      expect(result.callCount).toBe(1);
    });
  });

  describe("executeGetSymbolCallers", () => {
    const edge = (sourceName: string, sourceFile: string, relation: string, sourceLine: number) => ({
      sourceId: `${sourceFile}:${sourceName}:1`,
      sourceName,
      sourceFile,
      targetId: "target",
      targetName: "helper",
      targetFile: path.join(tempDir, "utils.ts"),
      relation,
      sourceLine,
      isCyclic: false,
    });

    it("returns one runtime entry per caller symbol from CALLS edges", async () => {
      const filePath = path.join(tempDir, "utils.ts");
      const fileA = path.join(tempDir, "a.ts");
      const fileB = path.join(tempDir, "b.ts");
      setupWorkerState({});
      mockQueryCallGraph.mockResolvedValue({
        callers: [edge("runA", fileA, "CALLS", 12), edge("runA", fileA, "CALLS", 20), edge("runB", fileB, "CALLS", 5)],
      });

      const result = await executeGetSymbolCallers({ filePath, symbolName: "helper" });

      expect(mockQueryCallGraph).toHaveBeenCalledWith({
        filePath,
        symbolName: "helper",
        direction: "callers",
        depth: 1,
        relationTypes: ["CALLS"],
      });
      expect(result.symbolId).toBe(`${filePath}:helper`);
      expect(result.callers).toEqual([
        { callerSymbolId: `${fileA}:runA`, callerFilePath: fileA, callerRelativePath: "a.ts", line: 12, isTypeOnly: false },
        { callerSymbolId: `${fileB}:runB`, callerFilePath: fileB, callerRelativePath: "b.ts", line: 5, isTypeOnly: false },
      ]);
      expect(result).toMatchObject({ callerCount: 2, runtimeCallerCount: 2, typeOnlyCallerCount: 0 });
      expect(result.callerFiles).toEqual([fileA, fileB]);
    });

    it("adds USES edges as type-only only when includeTypeOnly is set", async () => {
      const filePath = path.join(tempDir, "utils.ts");
      const fileA = path.join(tempDir, "a.ts");
      const fileT = path.join(tempDir, "types.ts");
      setupWorkerState({});
      mockQueryCallGraph.mockResolvedValue({
        callers: [edge("runA", fileA, "USES", 3), edge("runA", fileA, "CALLS", 9), edge("Shape", fileT, "USES", 4)],
      });

      const result = await executeGetSymbolCallers({ filePath, symbolName: "helper", includeTypeOnly: true });

      expect(mockQueryCallGraph.mock.calls[0][0].relationTypes).toEqual(["CALLS", "USES"]);
      expect(result.callers.map((c) => [c.callerSymbolId, c.line, c.isTypeOnly])).toEqual([
        [`${fileA}:runA`, 9, false],
        [`${fileT}:Shape`, 4, true],
      ]);
      expect(result).toMatchObject({ callerCount: 2, runtimeCallerCount: 1, typeOnlyCallerCount: 1 });
    });

    it("returns an empty result when the symbol has no callers", async () => {
      setupWorkerState({});
      mockQueryCallGraph.mockResolvedValue({ callers: [] });

      const result = await executeGetSymbolCallers({ filePath: path.join(tempDir, "utils.ts"), symbolName: "helper" });

      expect(result).toMatchObject({ callerCount: 0, callers: [], callerFiles: [] });
    });
  });
});
