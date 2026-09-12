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
        // Consumer paths reach the Markdown too, so they must be escaped as well.
        consumers: { updated: [], covered: [], unverified: ["src/<evil>|.ts"] },
        cycleEvidence: [], unusedExportEvidence: false, testCandidates: [],
        scoreFactors: { breakingChanges: 0, unverifiedConsumers: 5, cycles: 0, unusedExport: 0, missingTestCandidate: 0, partialImpact: 0 }, evidence: [],
      }],
      score: 80,
      risk: "critical",
      isPartial: false,
      limitations: [],
    });
    expect(markdown).toContain("## Graph-It Review Gate: CRITICAL (80/100)");
    expect(markdown).not.toContain("<script>");
    expect(markdown).not.toContain("bad|<");
    expect(markdown).not.toContain("<evil>");
  });

  it("renders the consumer buckets, not a raw dependent count", () => {
    const markdown = renderReviewMarkdown({
      baseRef: "main",
      headRef: "HEAD",
      changedFiles: ["src/api.ts"],
      symbols: [{
        name: "greet", filePath: "src/api.ts", score: 25, risk: "medium", breakingChanges: [], impactedSymbolCount: 42,
        consumers: { updated: ["src/a.ts"], covered: ["src/b.ts", "src/c.ts"], unverified: ["src/d.ts"] },
        cycleEvidence: [], unusedExportEvidence: false, testCandidates: [],
        scoreFactors: { breakingChanges: 25, unverifiedConsumers: 5, cycles: 0, unusedExport: 0, missingTestCandidate: 0, partialImpact: 0 }, evidence: [],
      }],
      score: 25,
      risk: "medium",
      isPartial: false,
      limitations: [],
    });

    expect(markdown).toContain("| Risk | Score | File | Symbol | Updated | Covered | Unverified |");
    expect(markdown).toContain("| medium | 25 | src/api.ts | greet | 1 | 2 | 1 |");
    expect(markdown).toContain("### Consumers to check");
    expect(markdown).toContain("- greet: src/d.ts");
    // The raw dependent count is context, not the headline the old table led with.
    expect(markdown).not.toContain("42");
  });

  it("omits the consumer section when the change requires no call-site update", () => {
    const markdown = renderReviewMarkdown({
      baseRef: "main",
      headRef: "HEAD",
      changedFiles: ["src/api.ts"],
      symbols: [{
        name: "greet", filePath: "src/api.ts", score: 25, risk: "medium", breakingChanges: [], impactedSymbolCount: 3,
        consumers: { updated: [], covered: [], unverified: ["src/d.ts"] },
        cycleEvidence: [], unusedExportEvidence: false, testCandidates: [],
        scoreFactors: { breakingChanges: 25, unverifiedConsumers: 0, cycles: 0, unusedExport: 0, missingTestCandidate: 0, partialImpact: 0 }, evidence: [],
      }],
      score: 25,
      risk: "medium",
      isPartial: false,
      limitations: [],
    });

    expect(markdown).not.toContain("### Consumers to check");
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
      scoreFactors: { breakingChanges: 0, unverifiedConsumers: 0, missingTestCandidate: 10 },
    });
    expect(result.symbols[0].evidence.some((e) => e.kind === "impact")).toBe(false);
  });

  it("downgrades breaking-change weight when a dependents provider confirms zero live consumers", async () => {
    const workspace = await createGitWorkspaceWithDiff(
      "export function greet(name: string): string { return name; }\n",
      "export function greet(name: string, formal: boolean): string { return name; }\n",
    );
    const analyzer = new ReviewGateAnalyzer(workspace, { getSymbolDependents: async () => [] });

    const result = await analyzer.analyze({ baseRef: "main" });

    expect(result.symbols[0]).toMatchObject({
      name: "greet",
      score: 15,
      risk: "low",
      impactedSymbolCount: 0,
      scoreFactors: { breakingChanges: 5, unverifiedConsumers: 0, missingTestCandidate: 10 },
    });
  });

  it("keeps full breaking-change weight when no dependents provider is configured (unknown impact)", async () => {
    const workspace = await createGitWorkspaceWithDiff(
      "export function greet(name: string): string { return name; }\n",
      "export function greet(name: string, formal: boolean): string { return name; }\n",
    );
    const analyzer = new ReviewGateAnalyzer(workspace);

    const result = await analyzer.analyze({ baseRef: "main" });

    expect(result.symbols[0]).toMatchObject({
      name: "greet",
      score: 60,
      risk: "high",
      scoreFactors: { breakingChanges: 50, unverifiedConsumers: 0, missingTestCandidate: 10 },
    });
  });

  it("gives partial credit when a test directly depends on the changed symbol, even with real production dependents", async () => {
    const workspace = await createGitWorkspaceWithDiff(
      "export function greet(name: string): string { return name; }\n",
      "export function greet(name: string, formal: boolean): string { return name; }\n",
    );
    const testConsumer = path.join(workspace, "tests", "consumer.test.ts");
    const prodConsumer = path.join(workspace, "src", "consumer.ts");
    const analyzer = new ReviewGateAnalyzer(workspace, {
      getSymbolDependents: async () => [
        { sourceSymbolId: `${testConsumer}:testsGreet` },
        { sourceSymbolId: `${prodConsumer}:useGreeting` },
      ],
    });

    const result = await analyzer.analyze({ baseRef: "main", maxDepth: 1 });

    expect(result.symbols[0]).toMatchObject({
      name: "greet",
      score: 40,
      risk: "medium",
      impactedSymbolCount: 2,
      // Only src/consumer.ts is unverified: the test consumer is coverage, not risk.
      scoreFactors: { breakingChanges: 25, unverifiedConsumers: 5, partialImpact: 10, missingTestCandidate: 0 },
    });
    expect(result.symbols[0].evidence).toEqual(expect.arrayContaining([
      { kind: "test-candidate", detail: "Symbol is directly depended on by an existing test — a real incompatibility would fail that test." },
    ]));
  });

  it("does not score dependents for a warning-only type alias change", async () => {
    const workspace = await createGitWorkspaceWithDiff(
      'export type Message = { type: "init" };\n',
      'export type Message = { type: "init" } | { type: "cancel" };\n',
    );
    const analyzer = new ReviewGateAnalyzer(workspace, {
      getSymbolDependents: async () => Array.from({ length: 10 }, (_, index) => ({
        sourceSymbolId: `${path.join(workspace, "src", `consumer${index}.ts`)}:useMessage`,
      })),
    });

    const result = await analyzer.analyze({ baseRef: "main" });

    expect(result.symbols[0]).toMatchObject({
      name: "Message",
      score: 10,
      risk: "low",
      impactedSymbolCount: 0,
      scoreFactors: { breakingChanges: 0, unverifiedConsumers: 0, missingTestCandidate: 10 },
    });
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

describe("ReviewGateAnalyzer - test candidate discovery", () => {
  /**
   * Regression: candidates kept the "src/" segment, so the lookup searched
   * tests/src/<area>/ — a directory the mirrored layout never has. Every symbol
   * of every src/** file was therefore scored as untested.
   */
  it("finds a mirrored test under tests/<area>/ for a src/<area>/ file", async () => {
    const workspace = await createGitWorkspace();
    await fs.mkdir(path.join(workspace, "tests", "src"), { recursive: true });
    // The mirrored location the repository convention actually uses.
    await fs.writeFile(path.join(workspace, "tests", "api.test.ts"), "// covers src/api.ts\n");

    const result = await new ReviewGateAnalyzer(workspace).analyze({ baseRef: "main" });

    expect(result.symbols[0].testCandidates).toContain("tests/api.test.ts");
    expect(result.symbols[0].scoreFactors.missingTestCandidate).toBe(0);
  });

  it("still scores a symbol with no test file anywhere as untested", async () => {
    const workspace = await createGitWorkspace();

    const result = await new ReviewGateAnalyzer(workspace).analyze({ baseRef: "main" });

    expect(result.symbols[0].testCandidates).toEqual([]);
    expect(result.symbols[0].scoreFactors.missingTestCandidate).toBe(10);
  });

  it("finds a test colocated next to the source file", async () => {
    const workspace = await createGitWorkspace();
    await fs.writeFile(path.join(workspace, "src", "api.test.ts"), "// colocated\n");

    const result = await new ReviewGateAnalyzer(workspace).analyze({ baseRef: "main" });

    expect(result.symbols[0].testCandidates).toContain("src/api.test.ts");
  });
});

describe("ReviewGateAnalyzer - member-level impact", () => {
  // A new required parameter: every call site has to be edited, so the consumer
  // count genuinely matters here (unlike a return-type change, which leaves calls valid).
  const OLD_CLASS = "export class Service {\n  run(name: string): string { return name; }\n}\n";
  const NEW_CLASS = "export class Service {\n  run(name: string, formal: boolean): string { return name; }\n}\n";

  /**
   * Regression: the dependent index is keyed on exported symbols, not on class
   * members, so a member lookup returned 0 whether the member had no callers or
   * was simply not tracked. The analyzer read that as "confirmed zero impact"
   * and divided the breaking-change weight by ten.
   */
  it("falls back to the containing symbol and marks the count partial", async () => {
    const workspace = await createGitWorkspaceWithDiff(OLD_CLASS, NEW_CLASS);
    const dependents = {
      getSymbolDependents: (_filePath: string, symbolName: string) =>
        Promise.resolve(
          symbolName === "Service"
            ? [{ sourceSymbolId: `${path.join(workspace, "src/consumer.ts")}:useService` }]
            : [],
        ),
    };

    const result = await new ReviewGateAnalyzer(workspace, dependents as never).analyze({ baseRef: "main" });

    const symbol = result.symbols.find((s) => s.name.endsWith("run"));
    expect(symbol?.impactedSymbolCount).toBe(1);
    // Not the 5-point "confirmed zero impact" weight.
    expect(symbol?.scoreFactors.breakingChanges).toBeGreaterThan(5);
    expect(symbol?.evidence.some((e) => e.kind === "partial" && e.detail.includes("per member"))).toBe(true);
  });

  it("keeps a genuine zero when the containing symbol has no dependents either", async () => {
    const workspace = await createGitWorkspaceWithDiff(OLD_CLASS, NEW_CLASS);
    const dependents = { getSymbolDependents: () => Promise.resolve([]) };

    const result = await new ReviewGateAnalyzer(workspace, dependents as never).analyze({ baseRef: "main" });

    const symbol = result.symbols.find((s) => s.name.endsWith("run"));
    expect(symbol?.impactedSymbolCount).toBe(0);
    expect(symbol?.scoreFactors.breakingChanges).toBe(5);
  });
});

describe("ReviewGateAnalyzer - consumer standing", () => {
  const OLD_API = "export function greet(name: string): string { return name; }\n";
  const NEW_API = "export function greet(name: string, formal: boolean): string { return name; }\n";

  /**
   * The gate answers "did we update every consumer, and is the rest under test?".
   * A widely used contract whose consumers are all handled is a well-managed
   * change, not a risky one — so the score follows the unverified remainder, not
   * the raw consumer count.
   */
  const analyzerWith = async (consumerFiles: string[], edges: Record<string, string[]> = {}) => {
    const workspace = await createGitWorkspaceWithDiff(OLD_API, NEW_API);
    const dependents = {
      getSymbolDependents: (filePath: string) => {
        const relative = filePath.slice(workspace.length + 1).replaceAll("\\", "/");
        const children = relative === "src/api.ts" ? consumerFiles : (edges[relative] ?? []);
        return Promise.resolve(
          children.map((file) => ({ sourceSymbolId: `${path.join(workspace, file)}:consumer` })),
        );
      },
    };
    return { workspace, analyzer: new ReviewGateAnalyzer(workspace, dependents as never) };
  };

  it("counts a consumer the diff does not touch and no test reaches as unverified", async () => {
    const { analyzer } = await analyzerWith(["src/consumer.ts"]);

    const [symbol] = (await analyzer.analyze({ baseRef: "main" })).symbols;

    expect(symbol.consumers).toEqual({ updated: [], covered: [], unverified: ["src/consumer.ts"] });
    expect(symbol.scoreFactors.unverifiedConsumers).toBe(5);
  });

  it("treats a consumer the diff already updates as handled", async () => {
    const { workspace, analyzer } = await analyzerWith(["src/consumer.ts"]);
    // The author updated the consumer in the same change set. It has to be tracked:
    // git diff reports added and modified files, never untracked ones.
    await fs.writeFile(path.join(workspace, "src", "consumer.ts"), "export const consumer = 1;\n");
    execFileSync("git", ["add", "src/consumer.ts"], { cwd: workspace });

    const [symbol] = (await analyzer.analyze({ baseRef: "main" })).symbols
      .filter((candidate) => candidate.filePath === "src/api.ts");

    expect(symbol.consumers.updated).toEqual(["src/consumer.ts"]);
    expect(symbol.consumers.unverified).toEqual([]);
    expect(symbol.scoreFactors.unverifiedConsumers).toBe(0);
  });

  it("treats a consumer reached by a test as covered, not as risk", async () => {
    const { analyzer } = await analyzerWith(
      ["src/consumer.ts"],
      { "src/consumer.ts": ["tests/consumer.test.ts"] },
    );

    const [symbol] = (await analyzer.analyze({ baseRef: "main" })).symbols;

    expect(symbol.consumers.covered).toEqual(["src/consumer.ts"]);
    expect(symbol.consumers.unverified).toEqual([]);
    expect(symbol.scoreFactors.unverifiedConsumers).toBe(0);
  });

  it("does not score many consumers when every one of them is covered", async () => {
    const many = Array.from({ length: 12 }, (_, i) => `src/consumer${i}.ts`);
    const edges = Object.fromEntries(many.map((file, i) => [file, [`tests/consumer${i}.test.ts`]]));
    const { analyzer } = await analyzerWith(many, edges);

    const [symbol] = (await analyzer.analyze({ baseRef: "main" })).symbols;

    expect(symbol.consumers.covered).toHaveLength(12);
    expect(symbol.scoreFactors.unverifiedConsumers).toBe(0);
    expect(symbol.risk).not.toBe("critical");
  });

  it("reports the three buckets as evidence a reviewer can act on", async () => {
    const { analyzer } = await analyzerWith(
      ["src/consumer.ts", "src/other.ts"],
      { "src/consumer.ts": ["tests/consumer.test.ts"] },
    );

    const [symbol] = (await analyzer.analyze({ baseRef: "main" })).symbols;
    const consumerEvidence = symbol.evidence.find((e) => e.kind === "consumers");

    expect(consumerEvidence?.detail).toContain("2 consumer file(s)");
    expect(consumerEvidence?.detail).toContain("1 covered by tests");
    expect(consumerEvidence?.detail).toContain("1 unverified: src/other.ts");
  });
});

describe("ReviewGateAnalyzer - does the change require consumers to act?", () => {
  const withDependent = (workspace: string) => ({
    getSymbolDependents: (filePath: string) =>
      Promise.resolve(
        filePath.endsWith("api.ts")
          ? [{ sourceSymbolId: `${path.join(workspace, "src/consumer.ts")}:useApi` }]
          : [],
      ),
  });

  it("counts unverified consumers when a parameter changed — every call site must be edited", async () => {
    const workspace = await createGitWorkspaceWithDiff(
      "export function greet(name: string): string { return name; }\n",
      "export function greet(name: string, formal: boolean): string { return name; }\n",
    );
    const analyzer = new ReviewGateAnalyzer(workspace, withDependent(workspace) as never);

    const [symbol] = (await analyzer.analyze({ baseRef: "main" })).symbols;

    expect(symbol.consumers.unverified).toEqual(["src/consumer.ts"]);
    expect(symbol.scoreFactors.unverifiedConsumers).toBe(5);
  });

  it("does not count them when only the return type changed — the calls stay valid", async () => {
    const workspace = await createGitWorkspaceWithDiff(
      "export function greet(name: string): string { return name; }\n",
      "export function greet(name: string): Promise<string> { return Promise.resolve(name); }\n",
    );
    const analyzer = new ReviewGateAnalyzer(workspace, withDependent(workspace) as never);

    const [symbol] = (await analyzer.analyze({ baseRef: "main" })).symbols;

    // Still listed, still evidenced — just not charged to the author as unhandled work.
    expect(symbol.consumers.unverified).toEqual(["src/consumer.ts"]);
    expect(symbol.scoreFactors.unverifiedConsumers).toBe(0);
    expect(symbol.evidence.some((e) => e.kind === "consumers" && e.detail.includes("requires no call-site update"))).toBe(true);
  });
});

describe("ReviewGateAnalyzer - residual weight", () => {
  const RETURN_TYPE_ONLY = [
    "export function greet(name: string): string { return name; }\n",
    "export function greet(name: string): Promise<string> { return Promise.resolve(name); }\n",
  ] as const;
  const PARAMETER_CHANGE = [
    "export function greet(name: string): string { return name; }\n",
    "export function greet(name: string, formal: boolean): string { return name; }\n",
  ] as const;

  const manyConsumers = (workspace: string) => ({
    getSymbolDependents: (filePath: string) =>
      Promise.resolve(
        filePath.endsWith("api.ts")
          ? Array.from({ length: 8 }, (_, i) => ({
              sourceSymbolId: `${path.join(workspace, `src/consumer${i}.ts`)}:use`,
            }))
          : [],
      ),
  });

  it("keeps a change that requires no call-site update visible but low", async () => {
    const workspace = await createGitWorkspaceWithDiff(...RETURN_TYPE_ONLY);
    const analyzer = new ReviewGateAnalyzer(workspace, manyConsumers(workspace) as never);

    const [symbol] = (await analyzer.analyze({ baseRef: "main", maxDepth: 1 })).symbols;

    // Residual, not zero: the symbol must still appear in the report.
    expect(symbol.scoreFactors.breakingChanges).toBe(5);
    expect(symbol.scoreFactors.partialImpact).toBe(0);
    expect(symbol.risk).toBe("low");
    expect(symbol.score).toBeGreaterThan(0);
  });

  it("keeps full weight when call sites do have to change", async () => {
    const workspace = await createGitWorkspaceWithDiff(...PARAMETER_CHANGE);
    const analyzer = new ReviewGateAnalyzer(workspace, manyConsumers(workspace) as never);

    const [symbol] = (await analyzer.analyze({ baseRef: "main", maxDepth: 1 })).symbols;

    expect(symbol.scoreFactors.breakingChanges).toBe(50);
    expect(symbol.scoreFactors.unverifiedConsumers).toBe(40);
    // An incomplete walk is a real unknown here: there may be more call sites.
    expect(symbol.scoreFactors.partialImpact).toBe(10);
    expect(symbol.risk).toBe("critical");
  });
});
