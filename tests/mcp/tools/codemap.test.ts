import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workerState } from "../../../src/mcp/shared/state";
import { executeGenerateCodemap } from "../../../src/mcp/tools/codemap";

const createTempFile = async (dir: string, name: string, content = ""): Promise<string> => {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
};

describe("codemap tools", () => {
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
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gitl-codemap-"));
  });

  afterEach(async () => {
    workerState.reset();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("executeGenerateCodemap", () => {
    it("should return full codemap with exports, internals, and dependencies", async () => {
      const filePath = await createTempFile(
        tempDir,
        "service.ts",
        [
          'import { helper } from "./helper";',
          "export function main() { return helper(); }",
          "function internal() { return 42; }",
        ].join("\n"),
      );

      const spiderMock = {
        getSymbolGraph: vi.fn(async () => ({
          symbols: [
            { name: "main", kind: "FunctionDeclaration", line: 2, isExported: true, id: `${filePath}:main`, category: "function" },
            { name: "internal", kind: "FunctionDeclaration", line: 3, isExported: false, id: `${filePath}:internal`, category: "function" },
          ],
          dependencies: [
            { sourceSymbolId: `${filePath}:main`, targetSymbolId: `${filePath}:internal`, targetFilePath: filePath, isTypeOnly: false },
          ],
        })),
        analyze: vi.fn(async () => [
          { path: path.join(tempDir, "helper.ts"), type: "import", line: 1, module: "./helper" },
        ]),
        findReferencingFiles: vi.fn(async () => [
          { path: path.join(tempDir, "index.ts"), type: "import", line: 5, module: "./service" },
        ]),
      };

      setupWorkerState(spiderMock);

      const result = await executeGenerateCodemap({ filePath });

      expect(result.filePath).toBe(filePath);
      expect(result.relativePath).toBe("service.ts");
      expect(result.language).toBe("typescript");
      expect(result.lineCount).toBe(3);
      expect(result.exports).toHaveLength(1);
      expect(result.exports[0].name).toBe("main");
      expect(result.internals).toHaveLength(1);
      expect(result.internals[0].name).toBe("internal");
      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0].module).toBe("./helper");
      expect(result.dependents).toHaveLength(1);
      expect(result.dependents[0].relativePath).toBe("index.ts");
      expect(result.analysisTimeMs).toBeGreaterThanOrEqual(0);
    });

    it("should handle files with no exports", async () => {
      const filePath = await createTempFile(
        tempDir,
        "private.ts",
        "const x = 1;\nconst y = 2;\n",
      );

      const spiderMock = {
        getSymbolGraph: vi.fn(async () => ({
          symbols: [
            { name: "x", kind: "VariableDeclaration", line: 1, isExported: false, id: `${filePath}:x`, category: "variable" },
            { name: "y", kind: "VariableDeclaration", line: 2, isExported: false, id: `${filePath}:y`, category: "variable" },
          ],
          dependencies: [],
        })),
        analyze: vi.fn(async () => []),
        findReferencingFiles: vi.fn(async () => []),
      };

      setupWorkerState(spiderMock);

      const result = await executeGenerateCodemap({ filePath });

      expect(result.exports).toHaveLength(0);
      expect(result.internals).toHaveLength(2);
      expect(result.dependencies).toHaveLength(0);
      expect(result.dependents).toHaveLength(0);
    });

    it("should gracefully handle reverse index not ready", async () => {
      const filePath = await createTempFile(tempDir, "standalone.ts", "export const a = 1;\n");

      const spiderMock = {
        getSymbolGraph: vi.fn(async () => ({
          symbols: [
            { name: "a", kind: "VariableDeclaration", line: 1, isExported: true, id: `${filePath}:a`, category: "variable" },
          ],
          dependencies: [],
        })),
        analyze: vi.fn(async () => []),
        findReferencingFiles: vi.fn(async () => {
          throw new Error("Reverse index not ready");
        }),
      };

      setupWorkerState(spiderMock);

      const result = await executeGenerateCodemap({ filePath });

      // Should not throw — dependents is empty on failure
      expect(result.dependents).toHaveLength(0);
      expect(result.exports).toHaveLength(1);
    });

    it("should detect call flow with cycles", async () => {
      const filePath = await createTempFile(
        tempDir,
        "recursive.ts",
        "export function a() { return b(); }\nfunction b() { return a(); }\n",
      );

      const spiderMock = {
        getSymbolGraph: vi.fn(async () => ({
          symbols: [
            { name: "a", kind: "FunctionDeclaration", line: 1, isExported: true, id: `${filePath}:a`, category: "function" },
            { name: "b", kind: "FunctionDeclaration", line: 2, isExported: false, id: `${filePath}:b`, category: "function" },
          ],
          dependencies: [
            { sourceSymbolId: `${filePath}:a`, targetSymbolId: `${filePath}:b`, targetFilePath: filePath, isTypeOnly: false },
            { sourceSymbolId: `${filePath}:b`, targetSymbolId: `${filePath}:a`, targetFilePath: filePath, isTypeOnly: false },
          ],
        })),
        analyze: vi.fn(async () => []),
        findReferencingFiles: vi.fn(async () => []),
      };

      setupWorkerState(spiderMock);

      const result = await executeGenerateCodemap({ filePath });

      expect(result.callFlow.length).toBeGreaterThanOrEqual(2);
      expect(result.hasCycle).toBe(true);
      expect(result.cycleSymbols.length).toBeGreaterThan(0);
    });

    it("should handle Python files correctly", async () => {
      const filePath = await createTempFile(
        tempDir,
        "utils.py",
        "def compute():\n    return 42\n",
      );

      const spiderMock = {
        getSymbolGraph: vi.fn(async () => ({
          symbols: [
            { name: "compute", kind: "FunctionDeclaration", line: 1, isExported: true, id: `${filePath}:compute`, category: "function" },
          ],
          dependencies: [],
        })),
        analyze: vi.fn(async () => []),
        findReferencingFiles: vi.fn(async () => []),
      };

      setupWorkerState(spiderMock);

      const result = await executeGenerateCodemap({ filePath });

      expect(result.language).toBe("python");
      expect(result.exports[0].name).toBe("compute");
    });

    it("should throw when file does not exist", async () => {
      const filePath = path.join(tempDir, "nonexistent.ts");

      const spiderMock = {
        getSymbolGraph: vi.fn(async () => ({ symbols: [], dependencies: [] })),
        analyze: vi.fn(async () => []),
        findReferencingFiles: vi.fn(async () => []),
      };

      setupWorkerState(spiderMock);

      await expect(executeGenerateCodemap({ filePath })).rejects.toThrow();
    });

    it("should report correct line count", async () => {
      const filePath = await createTempFile(
        tempDir,
        "lines.ts",
        "line1\nline2\nline3\nline4\nline5\n",
      );

      const spiderMock = {
        getSymbolGraph: vi.fn(async () => ({ symbols: [], dependencies: [] })),
        analyze: vi.fn(async () => []),
        findReferencingFiles: vi.fn(async () => []),
      };

      setupWorkerState(spiderMock);

      const result = await executeGenerateCodemap({ filePath });

      expect(result.lineCount).toBe(6); // 5 lines + trailing newline = 6
    });

    it("should return resolved dependency paths as relative", async () => {
      const filePath = await createTempFile(tempDir, "main.ts", "import { x } from './util';\n");
      const utilPath = path.join(tempDir, "sub", "util.ts");

      const spiderMock = {
        getSymbolGraph: vi.fn(async () => ({ symbols: [], dependencies: [] })),
        analyze: vi.fn(async () => [
          { path: utilPath, type: "import", line: 1, module: "./util" },
        ]),
        findReferencingFiles: vi.fn(async () => []),
      };

      setupWorkerState(spiderMock);

      const result = await executeGenerateCodemap({ filePath });

      expect(result.dependencies[0].relativePath).toBe("sub/util.ts");
      expect(result.dependencies[0].module).toBe("./util");
    });
  });
});
