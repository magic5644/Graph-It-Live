import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workerState } from "../../../src/mcp/shared/state";

const { mockQueryCallGraph } = vi.hoisted(() => ({ mockQueryCallGraph: vi.fn() }));
vi.mock("../../../src/mcp/tools/callgraph", () => ({ executeQueryCallGraph: mockQueryCallGraph }));
import {
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
});
