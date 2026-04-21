import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workerState } from "../../../src/mcp/shared/state";
import { executeScanDeadCode } from "../../../src/mcp/tools/deadcode";

describe("deadcode tools", () => {
  let tempDir: string;

  const makeSymbol = (name: string, kind = "FunctionDeclaration") => ({
    id: `sym:${name}`,
    name,
    kind,
    line: 1,
    isExported: true,
  });

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
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gitl-deadcode-"));
  });

  afterEach(async () => {
    workerState.reset();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("executeScanDeadCode", () => {
    it("should return enriched dead code entries with correct counts", async () => {
      const fileA = path.join(tempDir, "src", "utils.ts");
      const fileB = path.join(tempDir, "src", "helpers.ts");

      const spiderMock = {
        scanDeadCode: vi.fn(async () => ({
          entries: [
            {
              filePath: fileA,
              unusedSymbols: [makeSymbol("unusedFn"), makeSymbol("UnusedClass", "ClassDeclaration")],
            },
            {
              filePath: fileB,
              unusedSymbols: [makeSymbol("orphanVar", "VariableDeclaration")],
            },
          ],
          scannedFiles: 10,
          skippedFiles: 1,
        })),
      };

      setupWorkerState(spiderMock);

      const result = await executeScanDeadCode({});

      expect(spiderMock.scanDeadCode).toHaveBeenCalledWith(tempDir, { maxFiles: undefined });
      expect(result.rootDir).toBe(tempDir);
      expect(result.scopePath).toBe(tempDir);
      expect(result.scannedFiles).toBe(10);
      expect(result.skippedFiles).toBe(1);
      expect(result.filesWithDeadCode).toBe(2);
      expect(result.totalUnusedSymbols).toBe(3);
      expect(result.entries).toHaveLength(2);
      expect(result.analysisTimeMs).toBeGreaterThanOrEqual(0);
    });

    it("should categorize symbol kinds correctly", async () => {
      const fileA = path.join(tempDir, "index.ts");

      const spiderMock = {
        scanDeadCode: vi.fn(async () => ({
          entries: [
            {
              filePath: fileA,
              unusedSymbols: [
                makeSymbol("myFn", "FunctionDeclaration"),
                makeSymbol("MyClass", "ClassDeclaration"),
                makeSymbol("myVar", "VariableDeclaration"),
                makeSymbol("MyInterface", "InterfaceDeclaration"),
                makeSymbol("MyType", "TypeAliasDeclaration"),
                makeSymbol("other", "EnumDeclaration"),
              ],
            },
          ],
          scannedFiles: 1,
          skippedFiles: 0,
        })),
      };

      setupWorkerState(spiderMock);

      const result = await executeScanDeadCode({});
      const symbols = result.entries[0].unusedSymbols;

      expect(symbols.find((s) => s.name === "myFn")?.category).toBe("function");
      expect(symbols.find((s) => s.name === "MyClass")?.category).toBe("class");
      expect(symbols.find((s) => s.name === "myVar")?.category).toBe("variable");
      expect(symbols.find((s) => s.name === "MyInterface")?.category).toBe("interface");
      expect(symbols.find((s) => s.name === "MyType")?.category).toBe("type");
      expect(symbols.find((s) => s.name === "other")?.category).toBe("other");
    });

    it("should use provided scopePath when given", async () => {
      const subDir = path.join(tempDir, "src");
      await fs.mkdir(subDir, { recursive: true });

      const spiderMock = {
        scanDeadCode: vi.fn(async () => ({
          entries: [],
          scannedFiles: 0,
          skippedFiles: 0,
        })),
      };

      setupWorkerState(spiderMock);

      const result = await executeScanDeadCode({ scopePath: subDir });

      expect(spiderMock.scanDeadCode).toHaveBeenCalledWith(subDir, { maxFiles: undefined });
      expect(result.scopePath).toBe(subDir);
      expect(result.filesWithDeadCode).toBe(0);
      expect(result.totalUnusedSymbols).toBe(0);
    });

    it("should pass maxFiles option to spider", async () => {
      const spiderMock = {
        scanDeadCode: vi.fn(async () => ({
          entries: [],
          scannedFiles: 0,
          skippedFiles: 0,
        })),
      };

      setupWorkerState(spiderMock);

      await executeScanDeadCode({ maxFiles: 100 });

      expect(spiderMock.scanDeadCode).toHaveBeenCalledWith(tempDir, { maxFiles: 100 });
    });

    it("should include relative paths in entries", async () => {
      const fileA = path.join(tempDir, "src", "utils.ts");

      const spiderMock = {
        scanDeadCode: vi.fn(async () => ({
          entries: [{ filePath: fileA, unusedSymbols: [makeSymbol("unusedFn")] }],
          scannedFiles: 1,
          skippedFiles: 0,
        })),
      };

      setupWorkerState(spiderMock);

      const result = await executeScanDeadCode({});

      expect(result.entries[0].relativePath).toBe("src/utils.ts");
      expect(result.entries[0].unusedCount).toBe(1);
    });

    it("should throw when scopePath is outside rootDir", async () => {
      const spiderMock = { scanDeadCode: vi.fn() };
      setupWorkerState(spiderMock);

      await expect(executeScanDeadCode({ scopePath: "/outside/workspace" })).rejects.toThrow(
        "INVALID_SCOPE_PATH",
      );
      expect(spiderMock.scanDeadCode).not.toHaveBeenCalled();
    });

    it("should return empty result when no dead code found", async () => {
      const spiderMock = {
        scanDeadCode: vi.fn(async () => ({
          entries: [],
          scannedFiles: 42,
          skippedFiles: 0,
        })),
      };

      setupWorkerState(spiderMock);

      const result = await executeScanDeadCode({});

      expect(result.filesWithDeadCode).toBe(0);
      expect(result.totalUnusedSymbols).toBe(0);
      expect(result.scannedFiles).toBe(42);
      expect(result.entries).toHaveLength(0);
    });
  });
});
