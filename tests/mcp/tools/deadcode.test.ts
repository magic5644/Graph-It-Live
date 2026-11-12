import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workerState } from "../../../src/mcp/shared/state";
import { executeScanDeadCode } from "../../../src/mcp/tools/deadcode";

describe("deadcode tools", () => {
  let tempDir: string;

  const makeSymbol = (name: string, kind = "FunctionDeclaration", category = "function", confidence = "high") => ({
    id: `sym:${name}`,
    name,
    kind,
    line: 1,
    isExported: true,
    category,
    confidence,
    reasons: [confidence === "low" ? "no-importer" : "importers-use-other-exports"],
    evidence: { importers: confidence === "low" ? 0 : 1, firstImporters: [] },
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
      expect(result).toMatchObject({ minConfidence: "high", byConfidence: { high: 3, medium: 0, low: 0 } });
      expect(result.hint).toBeUndefined();
    });

    it.each([
      [undefined, ["keep"], 1, "1 medium, 1 low-confidence item(s) not listed: pass minConfidence low to list them."],
      ["medium", ["keep", "maybe"], 1, "1 low-confidence item(s) not listed: pass minConfidence low to list them."],
      ["low", ["keep", "maybe", "entry"], 2, undefined],
    ] as const)("lists items at minConfidence %s or above and counts every item", async (minConfidence, names, files, hint) => {
      const fileA = path.join(tempDir, "src", "a.ts");
      const fileB = path.join(tempDir, "src", "b.ts");
      setupWorkerState({
        scanDeadCode: vi.fn(async () => ({
          entries: [
            { filePath: fileA, unusedSymbols: [makeSymbol("keep"), makeSymbol("maybe", undefined, undefined, "medium")] },
            { filePath: fileB, unusedSymbols: [makeSymbol("entry", undefined, undefined, "low")] },
          ],
          scannedFiles: 2,
          skippedFiles: 0,
          filesBeyondLimit: 0,
        })),
      });

      const result = await executeScanDeadCode(minConfidence ? { minConfidence } : {});

      expect(result.entries.flatMap((e) => e.unusedSymbols.map((s) => s.name))).toEqual(names);
      expect(result.filesWithDeadCode).toBe(files);
      expect(result.totalUnusedSymbols).toBe(names.length);
      expect(result.byConfidence).toEqual({ high: 1, medium: 1, low: 1 });
      expect(result.hint).toBe(hint);
    });

    it("should keep the category set by the language analyzer", async () => {
      const fileA = path.join(tempDir, "index.ts");

      const spiderMock = {
        scanDeadCode: vi.fn(async () => ({
          entries: [
            {
              filePath: fileA,
              unusedSymbols: [
                // Arrow const: kind says variable, the analyzer says function
                makeSymbol("arrowFn", "VariableDeclaration", "function"),
                makeSymbol("count", "VariableDeclaration", "variable"),
                makeSymbol("Color", "EnumDeclaration", "type"),
                // Rust struct: no kind substring maps it, the analyzer says class
                makeSymbol("Point", "StructDeclaration", "class"),
              ],
            },
          ],
          scannedFiles: 1,
          skippedFiles: 0,
        })),
      };

      setupWorkerState(spiderMock);

      const result = await executeScanDeadCode({});
      const categories = result.entries[0].unusedSymbols.map((s) => [s.name, s.category]);

      expect(categories).toEqual([
        ["arrowFn", "function"],
        ["count", "variable"],
        ["Color", "type"],
        ["Point", "class"],
      ]);
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

    it("reports truncation when maxFiles left files unscanned (#231)", async () => {
      setupWorkerState({
        scanDeadCode: vi.fn(async () => ({ entries: [], scannedFiles: 2, skippedFiles: 0, filesBeyondLimit: 3 })),
      });

      const result = await executeScanDeadCode({ maxFiles: 2 });

      expect(result.truncated).toBe(true);
      expect(result.filesBeyondLimit).toBe(3);
      expect(result.scannedFiles).toBe(2);
      expect(result.totalUnusedSymbols).toBe(0);
    });

    it("reports no truncation when every file was scanned (#231)", async () => {
      setupWorkerState({
        scanDeadCode: vi.fn(async () => ({ entries: [], scannedFiles: 4, skippedFiles: 0, filesBeyondLimit: 0 })),
      });

      const result = await executeScanDeadCode({});

      expect(result.truncated).toBe(false);
      expect(result.filesBeyondLimit).toBe(0);
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

    it("lists excluded exports, workspace-relative and sorted, only with verbose (#696)", async () => {
      const excluded = [
        { filePath: path.join(tempDir, "src", "b.ts"), name: "late", kind: "Function", line: 9, reason: "declared:package.json#main" },
        { filePath: path.join(tempDir, "src", "b.ts"), name: "early", kind: "Function", line: 2, reason: "declared:package.json#main" },
        { filePath: path.join(tempDir, "src", "a.tsx"), name: "View", kind: "Function", line: 1, reason: "convention:framework-default-export" },
      ];
      setupWorkerState({ scanDeadCode: vi.fn(async () => ({ entries: [], excluded, scannedFiles: 3, skippedFiles: 0, filesBeyondLimit: 0 })) });

      const verbose = await executeScanDeadCode({ verbose: true });
      expect(verbose.excluded).toEqual([
        { relativePath: "src/a.tsx", name: "View", kind: "Function", line: 1, reason: "convention:framework-default-export" },
        { relativePath: "src/b.ts", name: "early", kind: "Function", line: 2, reason: "declared:package.json#main" },
        { relativePath: "src/b.ts", name: "late", kind: "Function", line: 9, reason: "declared:package.json#main" },
      ]);
      expect((await executeScanDeadCode({})).excluded).toBeUndefined();
      expect((await executeScanDeadCode({ verbose: false })).excluded).toBeUndefined();
    });

    it("lists unreferenced files instead of unused exports with unreferencedFiles (#711)", async () => {
      const file = (name: string, confidence: "low" | "medium") => ({
        filePath: path.join(tempDir, "src", name),
        exports: 1,
        confidence,
        reasons: [confidence === "low" ? "no-importer" : "test-only-use"],
        evidence: { importers: confidence === "low" ? 0 : 1, firstImporters: [] },
      });
      const scanDeadCode = vi.fn();
      const scanUnreferencedFiles = vi.fn(async () => ({
        files: [file("z.ts", "low"), file("a.ts", "medium")],
        excluded: [{ filePath: path.join(tempDir, "src", "main.ts"), reason: "declared:package.json#main" }],
        scannedFiles: 5,
        skippedFiles: 0,
        filesBeyondLimit: 0,
      }));
      setupWorkerState({ scanDeadCode, scanUnreferencedFiles });

      const result = await executeScanDeadCode({ unreferencedFiles: true, verbose: true, maxFiles: 9 });

      expect(scanDeadCode).not.toHaveBeenCalled();
      expect(scanUnreferencedFiles).toHaveBeenCalledWith(tempDir, expect.objectContaining({ maxFiles: 9 }));
      expect(result).toMatchObject({
        scannedFiles: 5,
        totalUnreferencedFiles: 2,
        minConfidence: "low",
        byConfidence: { high: 0, medium: 1, low: 1 },
        unreferencedFiles: [{ relativePath: "src/a.ts" }, { relativePath: "src/z.ts" }],
        excluded: [{ relativePath: "src/main.ts", reason: "declared:package.json#main" }],
        truncated: false,
      });
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
