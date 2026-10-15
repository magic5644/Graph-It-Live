import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workerState } from "../../../src/mcp/shared/state";
import {
    executeFindUnusedSymbols,
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
    it("should keep analyzer categories and enrich dependencies", async () => {
      const filePath = await createTempFile(tempDir, "main.ts", "");
      const depFile = path.join(tempDir, "dep.ts");

      const spiderMock = {
        getSymbolGraph: vi.fn(async () => ({
          symbols: [
            {
              name: "main",
              kind: "VariableDeclaration",
              line: 1,
              isExported: true,
              id: `${filePath}:main`,
              category: "function",
            },
            {
              name: "Draw",
              kind: "InterfaceDeclaration",
              line: 3,
              isExported: true,
              id: `${filePath}:Draw`,
              category: "type",
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

      expect(result.symbolCount).toBe(2);
      expect(result.dependencies[0].targetRelativePath).toBe("dep.ts");
      // Not re-derived from kind: arrow const stays function, Rust trait stays type
      expect(result.symbols.map((s) => s.category)).toEqual(["function", "type"]);
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
            kind: "EnumDeclaration",
            line: 2,
            isExported: true,
            id: `${filePath}:unused`,
            category: "type",
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
      expect(result.unusedSymbols[0].category).toBe("type");
    });
  });
});
