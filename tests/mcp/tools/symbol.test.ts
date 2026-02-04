import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workerState } from "../../../src/mcp/shared/state";
import {
    executeFindUnusedSymbols,
    executeGetSymbolDependents,
    executeGetSymbolGraph,
} from "../../../src/mcp/tools/symbol";

const createTempFile = async (dir: string, name: string, content = ""): Promise<string> => {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
};

describe("symbol tools", () => {
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
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gitl-symbol-"));
  });

  afterEach(async () => {
    workerState.reset();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("executeGetSymbolGraph", () => {
    it("should return categorized symbols and enriched dependencies", async () => {
      const filePath = await createTempFile(tempDir, "main.ts", "");
      const depFile = path.join(tempDir, "dep.ts");

      const spiderMock = {
        getSymbolGraph: vi.fn(async () => ({
          symbols: [
            {
              name: "main",
              kind: "FunctionDeclaration",
              line: 1,
              isExported: true,
              id: `${filePath}:main`,
            },
          ],
          dependencies: [
            {
              sourceSymbolId: `${filePath}:main`,
              targetSymbolId: `${depFile}:dep`,
              targetFilePath: depFile,
              isTypeOnly: false,
            },
          ],
        })),
      };

      setupWorkerState(spiderMock);

      const result = await executeGetSymbolGraph({ filePath });

      expect(result.symbolCount).toBe(1);
      expect(result.dependencies[0].targetRelativePath).toBe("dep.ts");
      expect(result.symbols[0].category).toBe("function");
      expect(result.relativePath).toBe("main.ts");
    });
  });

  describe("executeFindUnusedSymbols", () => {
    it("should return unused symbols and percentage", async () => {
      const filePath = await createTempFile(tempDir, "utils.ts", "");

      const spiderMock = {
        findUnusedSymbols: vi.fn(async () => [
          {
            name: "unused",
            kind: "VariableDeclaration",
            line: 2,
            isExported: true,
            id: `${filePath}:unused`,
          },
        ]),
        getSymbolGraph: vi.fn(async () => ({
          symbols: [
            {
              name: "unused",
              kind: "VariableDeclaration",
              line: 2,
              isExported: true,
              id: `${filePath}:unused`,
            },
            {
              name: "used",
              kind: "FunctionDeclaration",
              line: 5,
              isExported: true,
              id: `${filePath}:used`,
            },
          ],
        })),
      };

      setupWorkerState(spiderMock);

      const result = await executeFindUnusedSymbols({ filePath });

      expect(result.unusedCount).toBe(1);
      expect(result.totalExportedSymbols).toBe(2);
      expect(result.unusedPercentage).toBe(50);
      expect(result.unusedSymbols[0].category).toBe("variable");
    });
  });

  describe("executeGetSymbolDependents", () => {
    it("should return dependents with relative paths", async () => {
      const filePath = await createTempFile(tempDir, "entry.ts", "");
      const targetFile = path.join(tempDir, "target.ts");

      const spiderMock = {
        getSymbolDependents: vi.fn(async () => [
          {
            sourceSymbolId: `${filePath}:main`,
            targetSymbolId: `${targetFile}:dep`,
            targetFilePath: targetFile,
            isTypeOnly: false,
          },
        ]),
      };

      setupWorkerState(spiderMock);

      const result = await executeGetSymbolDependents({
        filePath,
        symbolName: "main",
      });

      expect(result.dependentCount).toBe(1);
      expect(result.dependents[0].targetRelativePath).toBe("target.ts");
    });
  });
});
