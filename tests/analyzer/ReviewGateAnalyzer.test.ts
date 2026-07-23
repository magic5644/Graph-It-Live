import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewGateAnalyzer, renderReviewMarkdown, riskForScore } from "../../src/analyzer/ReviewGateAnalyzer";

const temporaryDirectories: string[] = [];

async function createGitWorkspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "review-gate-"));
  temporaryDirectories.push(directory);
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
  await fs.mkdir(path.join(directory, "src"));
  await fs.writeFile(path.join(directory, "src", "api.ts"), "export function greet(name: string): string { return name; }\n");
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["commit", "-m", "base"], { cwd: directory });
  await fs.writeFile(path.join(directory, "src", "api.ts"), "export function greet(name: string, formal: boolean): string { return name; }\n");
  return directory;
}

async function createGitWorkspaceWithDiff(oldContent: string, newContent: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "review-gate-"));
  temporaryDirectories.push(directory);
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
  await fs.mkdir(path.join(directory, "src"));
  await fs.writeFile(path.join(directory, "src", "api.ts"), oldContent);
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["commit", "-m", "base"], { cwd: directory });
  await fs.writeFile(path.join(directory, "src", "api.ts"), newContent);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("ReviewGateAnalyzer", () => {
  it("reports deterministic breaking-change risk for a Git diff", async () => {
    const workspace = await createGitWorkspace();
    const result = await new ReviewGateAnalyzer(workspace).analyze({ baseRef: "main" });

    expect(result.changedFiles).toEqual(["src/api.ts"]);
    expect(result.risk).toBe("high");
    expect(result.symbols[0]).toMatchObject({ name: "greet", risk: "high" });
    expect(result.symbols[0].evidence[0].kind).toBe("breaking-change");
  });

  it("rejects invalid limits and renders hostile values as safe Markdown", async () => {
    const workspace = await createGitWorkspace();
    await expect(new ReviewGateAnalyzer(workspace).analyze({ baseRef: "main", maxFiles: 0 })).rejects.toThrow("maxFiles");
    const markdown = renderReviewMarkdown({
      baseRef: "main",
      headRef: "HEAD",
      changedFiles: ["src/<bad>|.ts"],
      symbols: [{
        name: "bad|<script>", filePath: "src/<bad>|.ts", score: 80, risk: "critical", breakingChanges: [], impactedSymbolCount: 0,
        cycleEvidence: [], unusedExportEvidence: false, testCandidates: [],
        scoreFactors: { breakingChanges: 0, dependents: 0, cycles: 0, unusedExport: 0, missingTestCandidate: 0, partialImpact: 0 }, evidence: [],
      }],
      score: 80,
      risk: "critical",
      isPartial: false,
      limitations: [],
    });
    expect(markdown).toContain("## Graph-It Review Gate: CRITICAL (80/100)");
    expect(markdown).not.toContain("<script>");
    expect(markdown).not.toContain("bad|<");
  });

  it("maps score thresholds predictably", () => {
    expect([riskForScore(0), riskForScore(20), riskForScore(50), riskForScore(80)]).toEqual(["low", "medium", "high", "critical"]);
  });

  it("supports explicit refs and marks bounded impact analysis as partial", async () => {
    const workspace = await createGitWorkspace();
    execFileSync("git", ["add", "."], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "breaking"], { cwd: workspace });
    const analyzer = new ReviewGateAnalyzer(workspace, {
      getSymbolDependents: async () => [{ sourceSymbolId: `${path.join(workspace, "src", "consumer.ts")}:useGreeting` }],
    });
    const result = await analyzer.analyze({ baseRef: "HEAD~1", headRef: "HEAD", maxDepth: 1, maxFiles: 1 });

    expect(result.changedFiles).toEqual(["src/api.ts"]);
    expect(result.isPartial).toBe(true);
    expect(result.symbols[0].impactedSymbolCount).toBe(1);
    expect(result.symbols[0].evidence.some((e) => e.kind === "impact")).toBe(true);
  });

  it("does not score dependents for a non-breaking optional interface member", async () => {
    const workspace = await createGitWorkspaceWithDiff(
      "export interface Api { name: string; }\n",
      "export interface Api { name: string; label?: string; }\n",
    );
    const analyzer = new ReviewGateAnalyzer(workspace, {
      getSymbolDependents: async () => Array.from({ length: 107 }, (_, index) => ({
        sourceSymbolId: `${path.join(workspace, "src", `consumer${index}.ts`)}:useApi`,
      })),
    });

    const result = await analyzer.analyze({ baseRef: "main" });

    expect(result.symbols[0]).toMatchObject({
      name: "Api",
      score: 10,
      risk: "low",
      impactedSymbolCount: 0,
      scoreFactors: { breakingChanges: 0, dependents: 0, missingTestCandidate: 10 },
    });
    expect(result.symbols[0].evidence.some((e) => e.kind === "impact")).toBe(false);
  });

  it("reports cycle, unused-export, and conventional test-candidate evidence", async () => {
    const workspace = await createGitWorkspace();
    await fs.mkdir(path.join(workspace, "tests", "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "tests", "src", "api.test.ts"), "export {}\n");
    const apiPath = path.join(workspace, "src", "api.ts");
    const analyzer = new ReviewGateAnalyzer(workspace, {
      getSymbolDependents: async () => [],
      getSymbolGraph: async () => ({
        symbols: [],
        dependencies: [
          { sourceSymbolId: `${apiPath}:greet`, targetSymbolId: `${apiPath}:helper`, targetFilePath: apiPath },
          { sourceSymbolId: `${apiPath}:helper`, targetSymbolId: `${apiPath}:greet`, targetFilePath: apiPath },
        ],
      }),
      findUnusedSymbols: async () => [{ name: "greet" } as never],
    });

    const result = await analyzer.analyze({ baseRef: "main" });

    expect(result.limitations).toEqual([]);
    expect(result.symbols[0]).toMatchObject({
      cycleEvidence: ["greet"],
      unusedExportEvidence: true,
      testCandidates: ["tests/src/api.test.ts"],
      scoreFactors: { cycles: 20, unusedExport: 10, missingTestCandidate: 0 },
    });
    expect(result.symbols[0].evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(["cycle", "unused-export", "test-candidate"]));
  });

  it("marks unavailable optional evidence as a limitation instead of inventing results", async () => {
    const workspace = await createGitWorkspace();
    const result = await new ReviewGateAnalyzer(workspace, { getSymbolDependents: async () => [] }).analyze({ baseRef: "main" });

    expect(result.isPartial).toBe(true);
    expect(result.limitations).toEqual(expect.arrayContaining([
      "Cycle evidence unavailable: symbol graph provider is not configured.",
      "Unused-export evidence unavailable: unused-symbol provider is not configured.",
    ]));
  });

  it("marks unreadable added files as a partial review", async () => {
    const workspace = await createGitWorkspace();
    await fs.writeFile(path.join(workspace, "src", "new.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "src/new.ts"], { cwd: workspace });
    const result = await new ReviewGateAnalyzer(workspace).analyze({ baseRef: "main" });

    expect(result.isPartial).toBe(true);
    expect(result.limitations.some((item) => item.includes("new.ts"))).toBe(true);
  });

  it("marks changed non-source files as unsupported instead of passing them to signature analysis", async () => {
    const workspace = await createGitWorkspace();
    await fs.writeFile(path.join(workspace, "notes.md"), "changed documentation\n");
    execFileSync("git", ["add", "notes.md"], { cwd: workspace });
    const result = await new ReviewGateAnalyzer(workspace).analyze({ baseRef: "main" });

    expect(result.isPartial).toBe(true);
    expect(result.limitations).toEqual(expect.arrayContaining([
      "Signature and symbol evidence unavailable for unsupported file type: notes.md.",
    ]));
  });

  it("continues with an explicit limitation when signature analysis fails for one file", async () => {
    const workspace = await createGitWorkspace();
    const analyzer = new ReviewGateAnalyzer(workspace);
    const signatureAnalyzer = (analyzer as unknown as { signatures: { analyzeBreakingChanges: () => never } }).signatures;
    signatureAnalyzer.analyzeBreakingChanges = () => { throw new Error("parser failure"); };

    const result = await analyzer.analyze({ baseRef: "main" });

    expect(result.isPartial).toBe(true);
    expect(result.limitations).toEqual(expect.arrayContaining([
      "Signature evidence unavailable for src/api.ts: parser failure.",
    ]));
  });
});
