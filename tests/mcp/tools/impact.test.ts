import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizePath } from "../../../src/shared/path";
import { workerState } from "../../../src/mcp/shared/state";
import {
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

  describe("executeGetImpactAnalysis", () => {
    it("should return impact summary for direct dependents", async () => {
      const filePath = await createTempFile(tempDir, "utils.ts", "");
      const targetFile = path.join(tempDir, "consumer.ts");

      const spiderMock = {
        getSymbolDependents: vi.fn(async () => [
          {
            sourceSymbolId: `${filePath}:greet`,
            targetSymbolId: `${targetFile}:useGreet`,
            targetFilePath: targetFile,
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
