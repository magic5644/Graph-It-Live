import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizePath } from "../../../src/shared/path";
import { workerState } from "../../../src/mcp/shared/state";
import {
    createSpiderDependentsProvider,
    executeAnalyzeBreakingChanges,
    executeGetImpactAnalysis,
    executeReviewPr,
} from "../../../src/mcp/tools/impact";

const createTempFile = async (dir: string, name: string, content = ""): Promise<string> => {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
};

describe("impact tools", () => {
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
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gitl-impact-"));
  });

  afterEach(async () => {
    workerState.reset();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("executeAnalyzeBreakingChanges", () => {
    it("should aggregate breaking changes", async () => {
      workerState.astWorkerHost = {
        analyzeBreakingChanges: vi.fn(async () => [
          {
            symbolName: "doThing",
            breakingChanges: [
              {
                type: "parameter-added-required",
                symbolName: "doThing",
                description: "New required param",
                severity: "error",
                oldValue: "",
                newValue: "x: string",
                line: 10,
              },
            ],
            nonBreakingChanges: [],
          },
        ]),
        stop: () => {},
      } as any;

      const result = await executeAnalyzeBreakingChanges({
        filePath: path.join(tempDir, "file.ts"),
        oldContent: "",
        newContent: "x",
      });

      expect(result.breakingChangeCount).toBe(1);
      expect(result.errorCount).toBe(1);
      expect(result.warningCount).toBe(0);
      expect(result.breakingChanges[0].type).toBe("parameter-added-required");
    });
  });

  describe("executeAnalyzeBreakingChanges newContent fallback (#223)", () => {
    const oldContent = [
      "export function greet(name: string): string { return name; }",
      "export interface Options { verbose: boolean }",
      "export function farewell(): void {}",
    ].join("\n");

    const useRealAnalyzer = () => {
      const analyze = vi.fn(async (filePath: string, oldText: string, newText: string) => {
        const { SignatureAnalyzer } = await import("../../../src/analyzer/SignatureAnalyzer");
        return new SignatureAnalyzer().analyzeBreakingChanges(filePath, oldText, newText);
      });
      workerState.astWorkerHost = { analyzeBreakingChanges: analyze, stop: () => {} } as any;
      return analyze;
    };

    it("analyzes an empty newContent as an emptied file instead of reading the disk", async () => {
      const filePath = await createTempFile(tempDir, "api.ts", oldContent);
      const analyze = useRealAnalyzer();

      const result = await executeAnalyzeBreakingChanges({ filePath, oldContent, newContent: "" });

      expect(analyze).toHaveBeenCalledWith(filePath, oldContent, "");
      expect(result.breakingChangeCount).toBe(3);
      expect(result.removedSymbols.sort()).toEqual(["Options", "farewell", "greet"]);
      expect(result.errorCount).toBe(3);
    });

    it("reads the file on disk when newContent is omitted", async () => {
      const current = "export function greet(name: string): string { return name; }";
      const filePath = await createTempFile(tempDir, "api.ts", current);
      const analyze = useRealAnalyzer();

      const result = await executeAnalyzeBreakingChanges({ filePath, oldContent });

      expect(analyze).toHaveBeenCalledWith(filePath, oldContent, current);
      expect(result.removedSymbols.sort()).toEqual(["Options", "farewell"]);
    });

    it("reports no change when the omitted newContent matches the old content", async () => {
      const filePath = await createTempFile(tempDir, "api.ts", oldContent);
      useRealAnalyzer();

      const result = await executeAnalyzeBreakingChanges({ filePath, oldContent });

      expect(result.breakingChangeCount).toBe(0);
    });

    it("fails clearly when newContent is omitted and the file cannot be read", async () => {
      useRealAnalyzer();
      const filePath = path.join(tempDir, "missing.ts");

      await expect(executeAnalyzeBreakingChanges({ filePath, oldContent })).rejects.toThrow(
        `Cannot read current file: ${filePath}`,
      );
    });

    it("keeps the symbolName filter on an emptied file", async () => {
      const filePath = await createTempFile(tempDir, "api.ts", oldContent);
      useRealAnalyzer();

      const result = await executeAnalyzeBreakingChanges({ filePath, oldContent, newContent: "", symbolName: "greet" });

      expect(result.removedSymbols).toEqual(["greet"]);
    });
  });

  describe("executeGetImpactAnalysis", () => {
    it("should return impact summary for direct dependents", async () => {
      const filePath = await createTempFile(tempDir, "utils.ts", "");
      const consumerFile = path.join(tempDir, "consumer.ts");

      // Shape returned by Spider.getSymbolDependents: source = caller, target = changed symbol.
      const spiderMock = {
        getSymbolDependents: vi.fn(async () => [
          {
            sourceSymbolId: `${consumerFile}:useGreet`,
            targetSymbolId: `${filePath}:greet`,
            targetFilePath: filePath,
            isTypeOnly: false,
          },
        ]),
      };

      setupWorkerState(spiderMock);

      const result = await executeGetImpactAnalysis({
        filePath,
        symbolName: "greet",
      });

      expect(result.totalImpactCount).toBe(1);
      expect(result.impactLevel).toBe("low");
      expect(result.targetSymbol.relativePath).toBe("utils.ts");
      expect(result.impactedItems[0].relativePath).toBe("consumer.ts");
      expect(result.impactedItems[0].filePath).toBe(consumerFile);
      expect(result.affectedFiles).toEqual([consumerFile]);
    });

    it("reports caller files, not the changed file, for direct and transitive dependents", async () => {
      const filePath = await createTempFile(tempDir, "utils.ts", "");
      const fileA = path.join(tempDir, "a.ts");
      const fileB = path.join(tempDir, "b.ts");
      const fileC = path.join(tempDir, "c.ts");
      const dependency = (source: string, target: string, targetFilePath: string, isTypeOnly = false) => ({
        sourceSymbolId: source,
        targetSymbolId: target,
        targetFilePath,
        isTypeOnly,
      });

      const getSymbolDependents = vi.fn(async (file: string, symbol: string) => {
        if (file === filePath && symbol === "greet") {
          return [
            dependency(`${fileA}:runA`, `${filePath}:greet`, filePath),
            dependency(`${fileB}:TypeB`, `${filePath}:greet`, filePath, true),
          ];
        }
        if (file === fileA && symbol === "runA") {
          return [dependency(`${fileC}:runC`, `${fileA}:runA`, fileA)];
        }
        return [];
      });
      setupWorkerState({ getSymbolDependents });

      const result = await executeGetImpactAnalysis({
        filePath,
        symbolName: "greet",
        includeTransitive: true,
        maxDepth: 3,
      });

      expect(result.impactedItems.map((item) => [item.symbolId, item.relativePath, item.depth, item.usageType])).toEqual([
        [`${fileA}:runA`, "a.ts", 1, "runtime"],
        [`${fileB}:TypeB`, "b.ts", 1, "type-only"],
        [`${fileC}:runC`, "c.ts", 2, "runtime"],
      ]);
      expect(result.affectedFiles.toSorted()).toEqual([fileA, fileB, fileC].toSorted());
      expect(result.affectedFiles).not.toContain(filePath);
      expect(getSymbolDependents).toHaveBeenCalledWith(fileA, "runA");
    });

    it("keeps drive-letter paths intact when deriving the caller file", async () => {
      const filePath = await createTempFile(tempDir, "utils.ts", "");
      const windowsCaller = "C:/repo/src/caller.ts";
      setupWorkerState({
        getSymbolDependents: vi.fn(async () => [
          { sourceSymbolId: `${windowsCaller}:run`, targetSymbolId: `${filePath}:greet`, targetFilePath: filePath },
        ]),
      });

      const result = await executeGetImpactAnalysis({ filePath, symbolName: "greet" });

      expect(result.impactedItems[0].filePath).toBe(windowsCaller);
      expect(result.affectedFiles).toEqual([windowsCaller]);
    });
  });

  describe("executeGetImpactAnalysis symbol check (#229)", () => {
    const symbols = (...names: string[]) =>
      names.map((name) => ({ name, kind: "Function", line: 1, isExported: true, id: name, category: "function" }));

    it("rejects an unknown symbol with close matches instead of a safe verdict", async () => {
      const filePath = await createTempFile(tempDir, "utils.ts", "");
      const getSymbolDependents = vi.fn(async () => []);
      setupWorkerState({
        getSymbolGraph: vi.fn(async () => ({ symbols: symbols("greet", "farewell"), dependencies: [] })),
        getSymbolDependents,
      });

      await expect(executeGetImpactAnalysis({ filePath, symbolName: "gret" })).rejects.toThrow(
        "Symbol 'gret' not found in utils.ts. Did you mean: greet?",
      );
      expect(getSymbolDependents).not.toHaveBeenCalled();
    });

    it("keeps the safe-change message for a known symbol without dependents", async () => {
      const filePath = await createTempFile(tempDir, "utils.ts", "");
      setupWorkerState({
        getSymbolGraph: vi.fn(async () => ({ symbols: symbols("greet"), dependencies: [] })),
        getSymbolDependents: vi.fn(async () => []),
      });

      const result = await executeGetImpactAnalysis({ filePath, symbolName: "greet" });

      expect(result.totalImpactCount).toBe(0);
      expect(result.impactLevel).toBe("low");
      expect(result.summary).toBe("Symbol 'greet' has no known dependents. Changes should be safe.");
    });

    it("does not claim safety when the file's symbols cannot be listed", async () => {
      const filePath = await createTempFile(tempDir, "main.go", "");
      setupWorkerState({
        getSymbolGraph: vi.fn(async () => ({ symbols: [], dependencies: [] })),
        getSymbolDependents: vi.fn(async () => []),
      });

      const result = await executeGetImpactAnalysis({ filePath, symbolName: "Main" });

      expect(result.summary).not.toContain("should be safe");
      expect(result.summary).toContain("was not verified");
    });

    it("still reports dependents of a verified symbol", async () => {
      const filePath = await createTempFile(tempDir, "utils.ts", "");
      const consumerFile = path.join(tempDir, "consumer.ts");
      setupWorkerState({
        getSymbolGraph: vi.fn(async () => ({ symbols: symbols("greet"), dependencies: [] })),
        getSymbolDependents: vi.fn(async () => [
          { sourceSymbolId: `${consumerFile}:useGreet`, targetSymbolId: `${filePath}:greet`, targetFilePath: filePath },
        ]),
      });

      const result = await executeGetImpactAnalysis({ filePath, symbolName: "greet" });

      expect(result.totalImpactCount).toBe(1);
      expect(result.summary).toContain("Modifying 'greet' will affect");
    });
  });

  it("uses the warmed Spider provider for dependent, cycle, and unused-export review evidence", async () => {
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: tempDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tempDir });
    const sourceDir = path.join(tempDir, "src");
    await fs.mkdir(sourceDir);
    const apiPath = await createTempFile(sourceDir, "api.ts", "export function greet(name: string): string { return name; }\n");
    execFileSync("git", ["add", "."], { cwd: tempDir });
    execFileSync("git", ["commit", "-m", "base"], { cwd: tempDir });
    await fs.writeFile(apiPath, "export function greet(name: string, formal: boolean): string { return name; }\n");

    const consumerPath = path.join(sourceDir, "consumer.ts");
    const spiderMock = {
      getSymbolDependents: vi.fn(async () => [{ sourceSymbolId: `${consumerPath}:useGreeting` }]),
      getSymbolGraph: vi.fn(async () => ({
        symbols: [],
        dependencies: [
          { sourceSymbolId: `${apiPath}:greet`, targetSymbolId: `${apiPath}:helper`, targetFilePath: apiPath },
          { sourceSymbolId: `${apiPath}:helper`, targetSymbolId: `${apiPath}:greet`, targetFilePath: apiPath },
        ],
      })),
      findUnusedSymbols: vi.fn(async () => [{ name: "greet" }]),
    };
    setupWorkerState(spiderMock);

    const result = await executeReviewPr({ baseRef: "main", maxDepth: 1 });

    expect(result.limitations).toEqual([]);
    expect(result.symbols[0]).toMatchObject({ impactedSymbolCount: 1, cycleEvidence: ["greet"], unusedExportEvidence: true });
    expect(result.symbols[0].evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(["impact", "cycle", "unused-export"]));
    const normalizedApiPath = normalizePath(apiPath);
    expect(spiderMock.getSymbolDependents).toHaveBeenCalledWith(normalizedApiPath, "greet");
    expect(spiderMock.getSymbolGraph).toHaveBeenCalledWith(normalizedApiPath);
    expect(spiderMock.findUnusedSymbols).toHaveBeenCalledWith(normalizedApiPath);
  });
});

describe("createSpiderDependentsProvider", () => {
  /**
   * Every capability the review gate can use has to be wired through. A missing
   * one is silent: the optional methods simply go unused, and the gate degrades
   * to a weaker answer — which is exactly how consumers under test came to be
   * reported as unverified.
   */
  it("delegates every capability the review gate consumes", async () => {
    const spider = {
      getSymbolDependents: vi.fn().mockResolvedValue([{ sourceSymbolId: "src/a.ts:useIt" }]),
      getSymbolGraph: vi.fn().mockResolvedValue({ symbols: [], dependencies: [] }),
      findUnusedSymbols: vi.fn().mockResolvedValue([]),
      findReferencingFiles: vi.fn().mockResolvedValue([{ path: "tests/a.test.ts" }]),
    };

    const provider = createSpiderDependentsProvider(spider as never);

    await expect(provider.getSymbolDependents("src/a.ts", "useIt")).resolves.toEqual([
      { sourceSymbolId: "src/a.ts:useIt" },
    ]);
    await expect(provider.getSymbolGraph?.("src/a.ts")).resolves.toEqual({
      symbols: [],
      dependencies: [],
    });
    await expect(provider.findUnusedSymbols?.("src/a.ts")).resolves.toEqual([]);
    await expect(provider.findReferencingFiles?.("src/a.ts")).resolves.toEqual([
      { path: "tests/a.test.ts" },
    ]);
  });

  it("forwards its arguments unchanged", async () => {
    const spider = {
      getSymbolDependents: vi.fn().mockResolvedValue([]),
      getSymbolGraph: vi.fn().mockResolvedValue({ symbols: [], dependencies: [] }),
      findUnusedSymbols: vi.fn().mockResolvedValue([]),
      findReferencingFiles: vi.fn().mockResolvedValue([]),
    };

    const provider = createSpiderDependentsProvider(spider as never);
    await provider.getSymbolDependents("/abs/src/a.ts", "useIt");
    await provider.findReferencingFiles?.("/abs/src/a.ts");

    expect(spider.getSymbolDependents).toHaveBeenCalledWith("/abs/src/a.ts", "useIt");
    expect(spider.findReferencingFiles).toHaveBeenCalledWith("/abs/src/a.ts");
  });
});
