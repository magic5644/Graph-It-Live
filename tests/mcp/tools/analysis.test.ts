import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workerState } from "../../../src/mcp/shared/state";
import {
    executeAnalyzeDependencies,
    executeParseImports,
    executeVerifyDependencyUsage,
} from "../../../src/mcp/tools/analysis";

const createTempFile = async (dir: string, name: string, content = ""): Promise<string> => {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
};

describe("analysis tools", () => {
  let tempDir: string;

  const setupWorkerState = (spiderMock: any, parserMock: any) => {
    workerState.spider = spiderMock;
    workerState.parser = parserMock;
    workerState.resolver = {} as any;
    workerState.config = {
      rootDir: tempDir,
      excludeNodeModules: false,
      maxDepth: 3,
    };
    workerState.isReady = true;
  };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gitl-analysis-"));
  });

  afterEach(async () => {
    workerState.reset();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("executeAnalyzeDependencies", () => {
    it("should return enriched dependency info", async () => {
      const entryFile = await createTempFile(tempDir, "entry.ts", "");
      const depFile = path.join(tempDir, "dep.ts");

      const spiderMock = {
        analyze: vi.fn(async () => [
          {
            path: depFile,
            type: "import",
            line: 1,
            module: "./dep",
          },
        ]),
      };

      setupWorkerState(spiderMock, { parse: vi.fn() });

      const result = await executeAnalyzeDependencies({ filePath: entryFile });

      expect(result.dependencyCount).toBe(1);
      expect(result.dependencies[0]).toEqual({
        path: depFile,
        relativePath: "dep.ts",
        type: "import",
        line: 1,
        module: "./dep",
        extension: "ts",
      });
    });
  });

  describe("executeParseImports", () => {
    it("should parse imports using the parser", async () => {
      const entryFile = await createTempFile(tempDir, "entry.ts", "import './dep';");

      const parserMock = {
        parse: vi.fn(() => [
          { module: "./dep", type: "import", line: 1 },
        ]),
      };

      setupWorkerState({ analyze: vi.fn() }, parserMock);

      const result = await executeParseImports({ filePath: entryFile });

      expect(parserMock.parse).toHaveBeenCalledOnce();
      expect(result.importCount).toBe(1);
      expect(result.imports).toEqual([
        { module: "./dep", type: "import", line: 1 },
      ]);
    });
  });

  describe("executeVerifyDependencyUsage", () => {
    it("should report dependency usage", async () => {
      const sourceFile = await createTempFile(tempDir, "source.ts", "");
      const targetFile = await createTempFile(tempDir, "target.ts", "");

      const spiderMock = {
        verifyDependencyUsage: vi.fn(async () => true),
      };

      setupWorkerState(spiderMock, { parse: vi.fn() });

      const result = await executeVerifyDependencyUsage({
        sourceFile,
        targetFile,
      });

      expect(result).toEqual({
        sourceFile,
        targetFile,
        isUsed: true,
        usedSymbolCount: undefined,
      });
    });
  });
});
