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

async function createGitWorkspaceWithDiff(oldContent: string, newContent: string, filename = "src/api.ts"): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "review-gate-"));
  temporaryDirectories.push(directory);
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
  await fs.mkdir(path.dirname(path.join(directory, filename)), { recursive: true });
  await fs.writeFile(path.join(directory, filename), oldContent);
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["commit", "-m", "base"], { cwd: directory });
  await fs.writeFile(path.join(directory, filename), newContent);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

// Each test spawns several git processes; slow on Windows runners.
const GIT_TEST_TIMEOUT = 20_000;

describe("ReviewGateAnalyzer", { timeout: GIT_TEST_TIMEOUT }, () => {
  it("compares Git filenames containing spaces without quoting or splitting them", async () => {
    const workspace = await createGitWorkspace();
    const filename = "src/quoted space file.ts";
    await fs.writeFile(path.join(workspace, filename), "export function value(n: number) { return n; }\n");
    execFileSync("git", ["add", filename], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "special path"], { cwd: workspace });
    await fs.writeFile(path.join(workspace, filename), "export function value(n: number, required: boolean) { return n; }\n");
    const result = await new ReviewGateAnalyzer(workspace).analyze({ baseRef: "main" });
    expect(result.changedFiles).toContain(filename);
    expect(result.symbols.find(s => s.filePath === filename)?.name).toBe("value");
  });

  it("reports deterministic breaking-change risk for a Git diff", async () => {
    const workspace = await createGitWorkspace();
    const result = await new ReviewGateAnalyzer(workspace).analyze({ baseRef: "main" });

    expect(result.changedFiles).toEqual(["src/api.ts"]);
    expect(result.risk).toBe("high");
    expect(result.symbols[0]).toMatchObject({ name: "greet", risk: "high" });
    expect(result.symbols[0].evidence[0].kind).toBe("breaking-change");
  });

  it("reports Vue component files that may still pass a renamed prop", async () => {
    const workspace = await createGitWorkspaceWithDiff(
      '<script setup lang="ts">defineProps<{ oldName: string }>();</script><template />\n',
      '<script setup lang="ts">defineProps<{ newName: string }>();</script><template />\n',
      "src/Child.vue",
    );
    const parent = path.join(workspace, "src", "Parent.vue");
    const provider = {
      parent,
      getSymbolDependents: async () => [],
      findReferencingFilesWithFallback() { return Promise.resolve([{ path: this.parent }]); },
    };
    const analyzer = new ReviewGateAnalyzer(workspace, provider);

    const result = await analyzer.analyze({ baseRef: "main" });
    const symbol = result.symbols.find(item => item.name === "Child.props");

    expect(symbol?.breakingChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "member-renamed", symbolName: "Child.props.newName" }),
    ]));
    expect(symbol?.consumers.unverified).toEqual(["src/Parent.vue"]);
  });

  it("rejects invalid limits and renders hostile values as safe Markdown", async () => {
    const workspace = await createGitWorkspace();
    await expect(new ReviewGateAnalyzer(workspace).analyze({ baseRef: "main", maxFiles: 0 })).rejects.toThrow("maxFiles");
    await expect(new ReviewGateAnalyzer(workspace).analyze({ baseRef: "--output=pwned.txt" })).rejects.toThrow("baseRef");
    await expect(new ReviewGateAnalyzer(workspace).analyze({ baseRef: "main", headRef: "-p" })).rejects.toThrow("headRef");
    await expect(new ReviewGateAnalyzer(workspace).analyze({ baseRef: "" })).rejects.toThrow("baseRef");
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
    // A must-act change leaves every untouched consumer to check, the tested ones included.
    expect(markdown).toContain("- greet: src/b.ts, src/c.ts, src/d.ts");
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
      score: 0,
      risk: "low",
      impactedSymbolCount: 0,
      // No contract broken: a missing test is not a risk this diff creates.
      scoreFactors: { breakingChanges: 0, unverifiedConsumers: 0, cycles: 0, missingTestCandidate: 0 },
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

  it("drops the breaking change to residual weight when every consumer is updated in the diff", async () => {
    const workspace = await createGitWorkspaceWithDiff(
      "export function greet(name: string): string { return name; }\n",
      "export function greet(name: string, formal: boolean): string { return name; }\n",
    );
    const consumer = path.join(workspace, "src", "consumer.ts");
    await fs.writeFile(consumer, "export const useGreeting = 1;\n");
    execFileSync("git", ["add", "src/consumer.ts"], { cwd: workspace });
    const analyzer = new ReviewGateAnalyzer(workspace, {
      getSymbolDependents: async () => [{ sourceSymbolId: `${consumer}:useGreeting` }],
    });

    const result = await analyzer.analyze({ baseRef: "main", maxDepth: 1 });
    const greet = result.symbols.find((symbol) => symbol.name === "greet");

    // The only consumer is carried through in the same diff: nothing is left unchecked.
    expect(greet).toMatchObject({
      risk: "medium",
      consumers: { updated: ["src/consumer.ts"], covered: [], unverified: [] },
      scoreFactors: { breakingChanges: 5, unverifiedConsumers: 0 },
    });
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
      score: 0,
      risk: "low",
      impactedSymbolCount: 0,
      // No contract broken: a missing test is not a risk this diff creates.
      scoreFactors: { breakingChanges: 0, unverifiedConsumers: 0, cycles: 0, missingTestCandidate: 0 },
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

  it("credits an added file instead of reporting it as an analysis gap", async () => {
    const workspace = await createGitWorkspace();
    await fs.writeFile(path.join(workspace, "src", "new.ts"), "export const value = 1;\n");
    await fs.mkdir(path.join(workspace, "tests"), { recursive: true });
    await fs.writeFile(path.join(workspace, "tests", "new.test.ts"), "export const checksValue = 1;\n");
    execFileSync("git", ["add", "src/new.ts", "tests/new.test.ts"], { cwd: workspace });
    const result = await new ReviewGateAnalyzer(workspace).analyze({ baseRef: "main" });

    // A file that did not exist before has no prior contract to break.
    expect(result.limitations.some((item) => item.includes("new.ts"))).toBe(false);
    expect(result.symbols.some((symbol) => symbol.filePath === "src/new.ts")).toBe(false);
  });

  it("marks an unreadable changed file as a partial review", async () => {
    const workspace = await createGitWorkspaceWithDiff(
      "export function greet(name: string): string { return name; }\n",
      "export function greet(name: string, formal: boolean): string { return name; }\n",
    );
    const analyzer = new ReviewGateAnalyzer(workspace);
    (analyzer as unknown as { readHeadContent: () => Promise<null> }).readHeadContent = async () => null;

    const result = await analyzer.analyze({ baseRef: "main" });

    expect(result.isPartial).toBe(true);
    expect(result.limitations).toEqual(expect.arrayContaining([
      "Could not compare src/api.ts; file was deleted or unreadable.",
    ]));
  });

  it("skips changed files that are not source code without marking the review partial", async () => {
    const workspace = await createGitWorkspace();
    await fs.writeFile(path.join(workspace, "notes.md"), "changed documentation\n");
    execFileSync("git", ["add", "notes.md"], { cwd: workspace });
    const result = await new ReviewGateAnalyzer(workspace).analyze({ baseRef: "main" });

    expect(result.changedFiles).toContain("notes.md");
    expect(result.limitations.join(" ")).not.toContain("notes.md");
  });

  it("marks changed source files without signature support as unsupported", async () => {
    const workspace = await createGitWorkspace();
    await fs.writeFile(path.join(workspace, "src", "tool.py"), "def run():\n    return 1\n");
    execFileSync("git", ["add", "src/tool.py"], { cwd: workspace });
    const result = await new ReviewGateAnalyzer(workspace).analyze({ baseRef: "main" });

    expect(result.isPartial).toBe(true);
    expect(result.limitations).toContain("Signature and symbol evidence unavailable for unsupported file type: src/tool.py.");
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

  /**
   * Regression (#266 review): every file that used the class was charged as a
   * consumer to update, although only files that name the member can call it.
   */
  it("keeps only the container's consumers that name the changed member", async () => {
    const workspace = await createGitWorkspaceWithDiff(OLD_CLASS, NEW_CLASS);
    await fs.writeFile(path.join(workspace, "src", "caller.ts"), "export const useRun = (s: { run(n: string): string }) => s.run('a');\n");
    await fs.writeFile(path.join(workspace, "src", "holder.ts"), "export const keep = (s: unknown) => s;\n");
    await fs.mkdir(path.join(workspace, "tests"));
    await fs.writeFile(path.join(workspace, "tests", "holder.test.ts"), "import { keep } from '../src/holder';\n");
    const consumers = ["src/caller.ts", "src/holder.ts", "src/missing.ts", "tests/holder.test.ts"];
    const dependents = {
      getSymbolDependents: (_filePath: string, symbolName: string) => Promise.resolve(
        symbolName === "Service"
          ? consumers.map((file) => ({ sourceSymbolId: `${path.join(workspace, file)}:consumer` }))
          : [],
      ),
    };

    const result = await new ReviewGateAnalyzer(workspace, dependents as never).analyze({ baseRef: "main" });

    const symbol = result.symbols.find((s) => s.name === "Service.run");
    // missing.ts cannot be read, so it stays: unknown is not unaffected.
    expect(symbol?.consumers.unverified).toEqual(["src/caller.ts", "src/missing.ts"]);
    expect(symbol?.scoreFactors.unverifiedConsumers).toBe(10);
    expect(symbol?.evidence.some((e) => e.kind === "partial" && e.detail.includes("per member"))).toBe(true);
  });

  it("treats a member no consumer of the container names as having no impact", async () => {
    const workspace = await createGitWorkspaceWithDiff(OLD_CLASS, NEW_CLASS);
    await fs.writeFile(path.join(workspace, "src", "holder.ts"), "export const runner = 1; // Service holder\n");
    const dependents = {
      getSymbolDependents: (_filePath: string, symbolName: string) => Promise.resolve(
        symbolName === "Service" ? [{ sourceSymbolId: `${path.join(workspace, "src/holder.ts")}:runner` }] : [],
      ),
    };

    const result = await new ReviewGateAnalyzer(workspace, dependents as never).analyze({ baseRef: "main" });

    const symbol = result.symbols.find((s) => s.name === "Service.run");
    expect(symbol?.impactedSymbolCount).toBe(0);
    expect(symbol?.consumers.unverified).toEqual([]);
    expect(symbol?.scoreFactors.breakingChanges).toBe(5);
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

describe("ReviewGateAnalyzer - removed optional parameter", { timeout: GIT_TEST_TIMEOUT }, () => {
  const OLD_CLASS = "export class Service {\n  constructor(path: string, config?: { size: number }) {}\n}\n";
  const NEW_CLASS = "export class Service {\n  constructor(path: string) {}\n}\n";

  const dependentsOf = (workspace: string, symbol: string, files: string[]) => ({
    getSymbolDependents: (_filePath: string, symbolName: string) => Promise.resolve(
      symbolName === symbol ? files.map((file) => ({ sourceSymbolId: `${path.join(workspace, file)}:consumer` })) : [],
    ),
  });

  const write = async (workspace: string, files: Record<string, string>) => {
    for (const [file, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
      await fs.writeFile(path.join(workspace, file), content);
    }
  };

  /** Regression (#295): dropping an optional constructor parameter nobody passed scored "high". */
  it("charges only the consumers whose calls pass the removed argument", async () => {
    const workspace = await createGitWorkspaceWithDiff(OLD_CLASS, NEW_CLASS);
    await write(workspace, {
      "src/omits.ts": "export const a = new Service(`(,)` + fn(1, [2, 3]) /* , ) */);\n",
      "src/passes.ts": "export const b = new Service('p', { size: 1 });\n",
      "src/sub.ts": "export class Sub extends Service { constructor() { super('p', { size: 2 }); } }\n",
    });
    const dependents = dependentsOf(workspace, "Service", ["src/omits.ts", "src/passes.ts", "src/sub.ts"]);

    const result = await new ReviewGateAnalyzer(workspace, dependents as never).analyze({ baseRef: "main" });

    const symbol = result.symbols.find((s) => s.name === "Service.constructor");
    expect(symbol?.breakingChanges[0]).toMatchObject({ type: "parameter-removed", breaksCallsWithArgs: 2 });
    expect(symbol?.consumers.unverified).toEqual(["src/passes.ts", "src/sub.ts"]);
  });

  it("scores the removal as residual when no call passes the argument", async () => {
    const workspace = await createGitWorkspaceWithDiff(OLD_CLASS, NEW_CLASS);
    await write(workspace, {
      "src/omits.ts": "export const a = new Service('p');\n",
      "tests/omits.test.ts": "const s = new Service<string>(\"a, b)\");\n",
    });
    const dependents = dependentsOf(workspace, "Service", ["src/omits.ts", "tests/omits.test.ts"]);

    const result = await new ReviewGateAnalyzer(workspace, dependents as never).analyze({ baseRef: "main" });

    const symbol = result.symbols.find((s) => s.name === "Service.constructor");
    expect(symbol?.impactedSymbolCount).toBe(0);
    expect(symbol?.scoreFactors.breakingChanges).toBe(5);
    expect(symbol?.risk).toBe("low");
  });

  it("keeps a spread call, an unclosed call and an unreadable consumer", async () => {
    const workspace = await createGitWorkspaceWithDiff(
      "export function greet(name: string, formal = false): string { return name; }\n",
      "export function greet(name: string): string { return name; }\n",
    );
    await write(workspace, {
      "src/spread.ts": "export const a = greet(...args);\n",
      "src/unclosed.ts": "export const b = greet('a'",
      "src/omits.ts": "export const c = greet('a'); // greet\n",
    });
    const files = ["src/spread.ts", "src/unclosed.ts", "src/omits.ts", "src/missing.ts"];

    const result = await new ReviewGateAnalyzer(workspace, dependentsOf(workspace, "greet", files) as never)
      .analyze({ baseRef: "main" });

    const symbol = result.symbols.find((s) => s.name === "greet");
    expect(symbol?.consumers.unverified).toEqual(["src/missing.ts", "src/spread.ts", "src/unclosed.ts"]);
  });

  it("still charges every consumer when a required parameter is removed", async () => {
    const workspace = await createGitWorkspaceWithDiff(
      "export function greet(name: string, formal: boolean): string { return name; }\n",
      "export function greet(name: string): string { return name; }\n",
    );
    await write(workspace, { "src/one.ts": "greet('a', true);\n", "src/two.ts": "greet('a');\n" });

    const result = await new ReviewGateAnalyzer(workspace, dependentsOf(workspace, "greet", ["src/one.ts", "src/two.ts"]) as never)
      .analyze({ baseRef: "main" });

    const symbol = result.symbols.find((s) => s.name === "greet");
    expect(symbol?.breakingChanges[0].breaksCallsWithArgs).toBeUndefined();
    expect(symbol?.consumers.unverified).toEqual(["src/one.ts", "src/two.ts"]);
  });

  /** A constructor is called as `new Class(`; the word "constructor" does not name it. */
  it("finds the callers of a changed constructor by `new Class(`", async () => {
    const workspace = await createGitWorkspaceWithDiff(
      "export class Service {\n  constructor(path: string) {}\n}\n",
      "export class Service {\n  constructor(path: string, size: number) {}\n}\n",
    );
    await write(workspace, {
      "src/caller.ts": "export const a = new Service('p');\n",
      "src/other.ts": "export class Other { constructor() {} } // Service\n",
    });

    const result = await new ReviewGateAnalyzer(workspace, dependentsOf(workspace, "Service", ["src/caller.ts", "src/other.ts"]) as never)
      .analyze({ baseRef: "main" });

    const symbol = result.symbols.find((s) => s.name === "Service.constructor");
    expect(symbol?.consumers.unverified).toEqual(["src/caller.ts"]);
  });
});

describe("ReviewGateAnalyzer - consumer standing", () => {
  const OLD_API = "export function greet(name: string): string { return name; }\n";
  const NEW_API = "export function greet(name: string, formal: boolean): string { return name; }\n";

  /**
   * The gate answers "did we update every consumer?". A widely used contract whose
   * consumers are all updated is a well-managed change, not a risky one — so the
   * score follows the untouched remainder, not the raw consumer count. A test on an
   * untouched consumer of a call-site-breaking change does not handle it: it only
   * makes the breakage fail later.
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

  it("still charges an untouched consumer of a call-site-breaking change when a test reaches it", async () => {
    const { analyzer } = await analyzerWith(
      ["src/consumer.ts"],
      { "src/consumer.ts": ["tests/consumer.test.ts"] },
    );

    const [symbol] = (await analyzer.analyze({ baseRef: "main" })).symbols;

    // The test status is kept as evidence, but the consumer still has to be edited.
    expect(symbol.consumers.covered).toEqual(["src/consumer.ts"]);
    expect(symbol.consumers.unverified).toEqual([]);
    expect(symbol.scoreFactors.breakingChanges).toBe(25);
    expect(symbol.scoreFactors.unverifiedConsumers).toBe(5);
  });

  it("rates a new required parameter high when no tested consumer is updated (#261)", async () => {
    const six = Array.from({ length: 6 }, (_, i) => `src/c${i + 1}.ts`);
    const edges = Object.fromEntries(six.map((file, i) => [file, [`src/c${i + 1}.test.ts`]]));
    const { analyzer } = await analyzerWith(six, edges);

    const [symbol] = (await analyzer.analyze({ baseRef: "main" })).symbols;
    const consumerEvidence = symbol.evidence.find((e) => e.kind === "consumers");

    expect(symbol.consumers.covered).toEqual(six);
    expect(symbol.scoreFactors).toMatchObject({ breakingChanges: 25, unverifiedConsumers: 30 });
    expect(symbol.score).toBe(55);
    expect(symbol.risk).toBe("high");
    expect(consumerEvidence?.detail).toBe(
      "6 consumer file(s): 0 updated in this diff, 6 must be updated (6 with tests that will fail, 0 unverified).",
    );
  });

  it("gives the residual weight once the diff updates every consumer", async () => {
    const { workspace, analyzer } = await analyzerWith(["src/a.ts", "src/b.ts"], {
      "src/a.ts": ["tests/a.test.ts"],
      "src/b.ts": ["tests/b.test.ts"],
    });
    for (const file of ["a", "b"]) {
      await fs.writeFile(path.join(workspace, "src", `${file}.ts`), "export const updated = 1;\n");
    }
    execFileSync("git", ["add", "src"], { cwd: workspace });

    const symbol = (await analyzer.analyze({ baseRef: "main" })).symbols.find((s) => s.filePath === "src/api.ts")!;

    expect(symbol.consumers.updated).toEqual(["src/a.ts", "src/b.ts"]);
    expect(symbol.scoreFactors).toMatchObject({ breakingChanges: 5, unverifiedConsumers: 0 });
    expect(symbol.risk).toBe("low");
  });

  it("does not give the residual weight when only part of the consumers is updated", async () => {
    const files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"];
    const edges = Object.fromEntries(files.map((file) => [file, [file.replace("src/", "tests/").replace(".ts", ".test.ts")]]));
    const { workspace, analyzer } = await analyzerWith(files, edges);
    for (const file of files.slice(0, 3)) await fs.writeFile(path.join(workspace, file), "export const updated = 1;\n");
    execFileSync("git", ["add", "src"], { cwd: workspace });

    const symbol = (await analyzer.analyze({ baseRef: "main" })).symbols.find((s) => s.filePath === "src/api.ts")!;

    expect(symbol.consumers.updated).toEqual(files.slice(0, 3));
    expect(symbol.consumers.covered).toEqual(files.slice(3));
    expect(symbol.scoreFactors).toMatchObject({ breakingChanges: 25, unverifiedConsumers: 15 });
    expect(symbol.risk).toBe("medium");
  });

  /**
   * "Updated" is file-level: a consumer edited for an unrelated reason counts as
   * updated even if its call to the changed symbol is still broken. This pins the
   * documented heuristic; verifying call arity is a separate enhancement.
   */
  it("counts a consumer changed for an unrelated reason as updated (file-level heuristic)", async () => {
    const { workspace, analyzer } = await analyzerWith(["src/consumer.ts"]);
    await fs.writeFile(path.join(workspace, "src", "consumer.ts"), "// unrelated edit\ngreet(\"x\");\n");
    execFileSync("git", ["add", "src/consumer.ts"], { cwd: workspace });

    const symbol = (await analyzer.analyze({ baseRef: "main" })).symbols.find((s) => s.filePath === "src/api.ts")!;

    expect(symbol.consumers.updated).toEqual(["src/consumer.ts"]);
    expect(symbol.scoreFactors.unverifiedConsumers).toBe(0);
  });

  /**
   * The symbol traversal only records coverage for consumers it reached before
   * its depth limit. `findReferencingFiles` answers the same question from the
   * reverse index, so a consumer with a test of its own is recognised wherever
   * the walk happened to stop.
   */
  const analyzerWithReverseIndex = async (
    consumerFiles: string[],
    referencing: Record<string, string[]>,
  ) => {
    const workspace = await createGitWorkspaceWithDiff(OLD_API, NEW_API);
    const relative = (filePath: string) =>
      filePath.slice(workspace.length + 1).replaceAll("\\", "/");
    const dependents = {
      getSymbolDependents: (filePath: string) => Promise.resolve(
        relative(filePath) === "src/api.ts"
          ? consumerFiles.map(file => ({ sourceSymbolId: `${path.join(workspace, file)}:consumer` }))
          : [],
      ),
      findReferencingFiles: (filePath: string) => Promise.resolve(
        (referencing[relative(filePath)] ?? []).map(file => ({ path: path.join(workspace, file) })),
      ),
    };
    return new ReviewGateAnalyzer(workspace, dependents as never);
  };

  it("recognises a consumer its own test references, beyond the traversal depth", async () => {
    const analyzer = await analyzerWithReverseIndex(
      ["src/consumer.ts"],
      { "src/consumer.ts": ["tests/consumer.test.ts"] },
    );

    const [symbol] = (await analyzer.analyze({ baseRef: "main" })).symbols;

    expect(symbol.consumers.covered).toEqual(["src/consumer.ts"]);
    expect(symbol.consumers.unverified).toEqual([]);
  });

  it("follows the reverse index through an intermediate file to reach the test", async () => {
    const analyzer = await analyzerWithReverseIndex(["src/consumer.ts"], {
      "src/consumer.ts": ["src/middle.ts"],
      "src/middle.ts": ["tests/middle.test.ts"],
    });

    const [symbol] = (await analyzer.analyze({ baseRef: "main" })).symbols;

    expect(symbol.consumers.covered).toEqual(["src/consumer.ts"]);
  });

  it("still reports a consumer no test references at all", async () => {
    const analyzer = await analyzerWithReverseIndex(
      ["src/consumer.ts"],
      { "src/consumer.ts": ["src/other.ts"] },
    );

    const [symbol] = (await analyzer.analyze({ baseRef: "main" })).symbols;

    expect(symbol.consumers.unverified).toEqual(["src/consumer.ts"]);
    expect(symbol.scoreFactors.unverifiedConsumers).toBe(5);
  });

  it("does not loop forever on a reference cycle", async () => {
    const analyzer = await analyzerWithReverseIndex(["src/consumer.ts"], {
      "src/consumer.ts": ["src/a.ts"],
      "src/a.ts": ["src/consumer.ts"],
    });

    const [symbol] = (await analyzer.analyze({ baseRef: "main" })).symbols;

    expect(symbol.consumers.unverified).toEqual(["src/consumer.ts"]);
  });

  it("treats a failing reverse-index lookup as no coverage rather than crashing", async () => {
    const workspace = await createGitWorkspaceWithDiff(OLD_API, NEW_API);
    const analyzer = new ReviewGateAnalyzer(workspace, {
      getSymbolDependents: (filePath: string) => Promise.resolve(
        filePath.endsWith("api.ts")
          ? [{ sourceSymbolId: `${path.join(workspace, "src/consumer.ts")}:consumer` }]
          : [],
      ),
      findReferencingFiles: () => Promise.reject(new Error("index unavailable")),
    } as never);

    const [symbol] = (await analyzer.analyze({ baseRef: "main" })).symbols;

    expect(symbol.consumers.unverified).toEqual(["src/consumer.ts"]);
  });

  it("reports the consumers a call-site-breaking change leaves to update, with their test status", async () => {
    const { analyzer } = await analyzerWith(
      ["src/consumer.ts", "src/other.ts"],
      { "src/consumer.ts": ["tests/consumer.test.ts"] },
    );

    const [symbol] = (await analyzer.analyze({ baseRef: "main" })).symbols;
    const consumerEvidence = symbol.evidence.find((e) => e.kind === "consumers");

    expect(consumerEvidence?.detail).toContain("2 consumer file(s)");
    expect(consumerEvidence?.detail).toContain("0 updated in this diff");
    expect(consumerEvidence?.detail).toContain("2 must be updated (1 with tests that will fail, 1 unverified: src/other.ts)");
    expect(consumerEvidence?.detail).not.toContain("0 unverified");
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

describe("ReviewGateAnalyzer - tested consumers of a change that keeps call sites valid", () => {
  const consumersWithTests = (workspace: string) => ({
    getSymbolDependents: (filePath: string) => {
      const relative = filePath.slice(workspace.length + 1).replaceAll("\\", "/");
      if (relative === "src/api.ts") return Promise.resolve([{ sourceSymbolId: `${path.join(workspace, "src/consumer.ts")}:use` }]);
      if (relative === "src/consumer.ts") return Promise.resolve([{ sourceSymbolId: `${path.join(workspace, "tests/consumer.test.ts")}:(file)` }]);
      return Promise.resolve([]);
    },
  });

  it.each([
    ["return type changed", "export function greet(name: string): Promise<string> { return Promise.resolve(name); }\n"],
    ["optional parameter added", "export function greet(name: string, formal?: boolean): string { return name; }\n"],
  ])("stays low when the %s and the untouched consumer is tested", async (_label, newApi) => {
    const workspace = await createGitWorkspaceWithDiff("export function greet(name: string): string { return name; }\n", newApi);
    const analyzer = new ReviewGateAnalyzer(workspace, consumersWithTests(workspace) as never);

    const symbol = (await analyzer.analyze({ baseRef: "main" })).symbols.find((s) => s.filePath === "src/api.ts");

    expect(symbol).toBeDefined();
    expect(symbol!.risk).toBe("low");
    expect(symbol!.scoreFactors.unverifiedConsumers).toBe(0);
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

describe("ReviewGateAnalyzer - interface consumed through its factory", () => {
  const OLD_STATE = [
    "export interface SessionState { root: string; lastResult?: unknown; lastCommandLine?: string; recentFiles: string[]; tipCounter: number; }",
    "export function createSessionState(root: string): SessionState { return { root, recentFiles: [], tipCounter: 0 }; }",
    "",
  ].join("\n");
  const NEW_STATE = [
    "export interface SessionState { root: string; }",
    "export function createSessionState(root: string): SessionState { return { root }; }",
    "",
  ].join("\n");

  /**
   * Shape of PR #212: the only production consumer types its state as
   * `ReturnType<typeof createSessionState>`, so the dependent index links it to
   * the factory, never to the interface. Only the test names the interface.
   */
  const analyzerFor = async (options: { updateConsumer: boolean }) => {
    const workspace = await createGitWorkspaceWithDiff(OLD_STATE, NEW_STATE, "src/sessionState.ts");
    await fs.writeFile(path.join(workspace, "src", "repl.ts"), "export const repl = 1;\n");
    execFileSync("git", ["add", "src/repl.ts"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "consumer"], { cwd: workspace });
    if (options.updateConsumer) {
      await fs.writeFile(path.join(workspace, "src", "repl.ts"), "export const repl = 2;\n");
    }
    const at = (file: string, symbol: string) => ({ sourceSymbolId: `${path.join(workspace, file)}:${symbol}` });
    const dependents = {
      getSymbolDependents: (_filePath: string, symbolName: string) => {
        if (symbolName === "SessionState") return Promise.resolve([at("tests/repl.test.ts", "(file)")]);
        if (symbolName === "createSessionState") return Promise.resolve([at("src/repl.ts", "run"), at("src/repl.ts", "help")]);
        return Promise.resolve([]);
      },
    };
    return new ReviewGateAnalyzer(workspace, dependents as never);
  };

  it("credits a consumer reached through the factory and updated in the diff", async () => {
    const analyzer = await analyzerFor({ updateConsumer: true });

    const symbol = (await analyzer.analyze({ baseRef: "main" })).symbols.find((s) => s.name === "SessionState")!;

    expect(symbol.breakingChanges.filter((change) => change.severity === "error")).toHaveLength(4);
    expect(symbol.consumers).toEqual({ updated: ["src/repl.ts"], covered: [], unverified: [] });
    expect(symbol.scoreFactors.breakingChanges).toBe(5);
    expect(symbol.risk).toBe("low");
  });

  it("reports a factory consumer the diff does not touch as unverified", async () => {
    const analyzer = await analyzerFor({ updateConsumer: false });

    const symbol = (await analyzer.analyze({ baseRef: "main" })).symbols.find((s) => s.name === "SessionState")!;

    expect(symbol.consumers.unverified).toEqual(["src/repl.ts"]);
    // Scored once for the symbol, not once per removed member.
    expect(symbol.scoreFactors.breakingChanges).toBe(25);
    expect(symbol.risk).not.toBe("critical");
  });
});

/** Regression (#363): a function moved behind a re-export was reported as removed, raising the risk to high. */
describe("ReviewGateAnalyzer - re-exported declaration", { timeout: GIT_TEST_TIMEOUT }, () => {
  const OLD_HELPERS = "export function check(target: string): boolean { return target.length > 0; }\n";
  const MOVED = "export function check(target: string): boolean { return target.length > 0; }\n";

  async function moveCheck(newHelpers: string, moved?: string): Promise<string> {
    const workspace = await createGitWorkspaceWithDiff(OLD_HELPERS, newHelpers, "src/mcp/helpers.ts");
    if (moved !== undefined) {
      await fs.mkdir(path.join(workspace, "src", "shared"), { recursive: true });
      await fs.writeFile(path.join(workspace, "src", "shared", "security.ts"), moved);
    }
    return workspace;
  }

  it.each([
    ['import { check } from "../shared/security";\nexport { check };\n'],
    ['export { check } from "../shared/security.js";\n'],
  ])("scores a moved but still exported function low: %s", async (newHelpers) => {
    const workspace = await moveCheck(newHelpers, MOVED);
    const result = await new ReviewGateAnalyzer(workspace).analyze({ baseRef: "main" });

    expect(result.symbols).toEqual([]);
    expect(result.risk).toBe("low");
    expect(result.limitations.filter((limitation) => limitation.includes("Re-export"))).toEqual([]);
  });

  it("follows a tsconfig path alias found from the changed file", async () => {
    const workspace = await moveCheck('export { check } from "@/shared/security";\n', MOVED);
    await fs.writeFile(
      path.join(workspace, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
    );
    const result = await new ReviewGateAnalyzer(workspace).analyze({ baseRef: "main" });

    expect(result.symbols).toEqual([]);
  });

  it("reports a parameter change made while moving the function", async () => {
    const workspace = await moveCheck(
      'export * from "../shared/security";\n',
      "export function check(target: string, root: string): boolean { return target.startsWith(root); }\n",
    );
    const result = await new ReviewGateAnalyzer(workspace).analyze({ baseRef: "main" });

    expect(result.symbols[0].breakingChanges[0]).toMatchObject({ type: "parameter-added-required", symbolName: "check" });
  });

  it("keeps the removal and lists a limitation when the re-export target is missing", async () => {
    const workspace = await moveCheck('export { check } from "../shared/security";\n');
    const result = await new ReviewGateAnalyzer(workspace).analyze({ baseRef: "main" });

    expect(result.symbols[0].breakingChanges[0]).toMatchObject({ type: "member-removed", symbolName: "check" });
    expect(result.limitations).toContain(
      "src/mcp/helpers.ts: Re-export of 'check' from '../shared/security' could not be resolved; its removal is unverified.",
    );
  });

  it("loads an unresolvable export * once for every removal behind it", async () => {
    const workspace = await createGitWorkspaceWithDiff(
      "export function check(a: string): string { return a; }\nexport function scan(a: string): string { return a; }\n",
      'export * from "../shared/missing";\n',
      "src/mcp/helpers.ts",
    );
    const result = await new ReviewGateAnalyzer(workspace).analyze({ baseRef: "main" });

    expect(result.symbols.map((symbol) => symbol.name).sort()).toEqual(["check", "scan"]);
    expect(result.limitations.filter((limitation) => limitation.includes("Re-exports"))).toEqual([
      "src/mcp/helpers.ts: Re-exports from '../shared/missing' could not be resolved; removals behind them are unverified.",
    ]);
  });

  it("reads the re-export target at the head ref, not the working tree", async () => {
    const workspace = await moveCheck('export * from "../shared/security";\n', MOVED);
    execFileSync("git", ["add", "."], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "move"], { cwd: workspace });
    await fs.writeFile(path.join(workspace, "src", "shared", "security.ts"), "export const unrelated = 1;\n");

    const result = await new ReviewGateAnalyzer(workspace).analyze({ baseRef: "main~1", headRef: "main" });

    expect(result.symbols).toEqual([]);
  });

  it("does not follow a re-export outside the workspace", async () => {
    const workspace = await moveCheck('export * from "../../../outside";\n');
    const result = await new ReviewGateAnalyzer(workspace).analyze({ baseRef: "main" });

    expect(result.symbols[0].breakingChanges[0].type).toBe("member-removed");
  });
});

/** Reference index with no symbol dependents: `referrers` reference every file. */
function referenceIndex(referrers: string[] = []) {
  return {
    getSymbolDependents: async () => [],
    findReferencingFiles: async () => referrers.map((file) => ({ path: file })),
  };
}

/** Regression (#444): a symbol moved to another file of the same diff was scored as a breaking removal. */
describe("ReviewGateAnalyzer - symbol moved between changed files", { timeout: GIT_TEST_TIMEOUT }, () => {
  const OLD_API = [
    "export interface Shape { size: number }",
    'export type Kind = "a" | "b";',
    "export class Box { constructor(size: number) {} area(): number { return 1; } }",
    "export function make(kind: Kind): Shape { return { size: kind.length }; }",
    "",
  ].join("\n");
  const NEW_API = 'import type { Kind, Shape } from "./model";\nexport function make(kind: Kind): Shape { return { size: kind.length }; }\n';
  const MODEL = [
    "export interface Shape { size: number }",
    'export type Kind = "a" | "b";',
    "export class Box { constructor(size: number) {} area(): number { return 1; } }",
    "",
  ].join("\n");

  /** Commits `base`, then writes and stages `head` (null deletes), so new files are part of the diff. */
  async function workspaceWith(base: Record<string, string>, head: Record<string, string | null>): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "review-gate-move-"));
    temporaryDirectories.push(directory);
    const write = async (files: Record<string, string | null>) => {
      for (const [file, content] of Object.entries(files)) {
        const target = path.join(directory, file);
        if (content === null) await fs.rm(target);
        else {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, content);
        }
      }
    };
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: directory });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
    await write(base);
    execFileSync("git", ["add", "."], { cwd: directory });
    execFileSync("git", ["commit", "-m", "base"], { cwd: directory });
    await write(head);
    execFileSync("git", ["add", "-A"], { cwd: directory });
    return directory;
  }

  const symbol = (result: Awaited<ReturnType<ReviewGateAnalyzer["analyze"]>>, name: string) =>
    result.symbols.find((candidate) => candidate.name === name);

  it("reports a pure move as a low-risk move, not a removal", async () => {
    const workspace = await workspaceWith(
      { "src/api.ts": OLD_API, "src/use.ts": 'import type { Shape } from "./api";\nexport const s: Shape = { size: 1 };\n' },
      { "src/api.ts": NEW_API, "src/model.ts": MODEL, "src/use.ts": 'import type { Shape } from "./model";\nexport const s: Shape = { size: 1 };\n' },
    );
    const result = await new ReviewGateAnalyzer(workspace, referenceIndex()).analyze({ baseRef: "main" });

    expect(result.risk).toBe("low");
    expect(result.symbols.map((candidate) => candidate.name).sort()).toEqual(["Box.area", "Box.constructor", "Kind", "Shape"]);
    for (const moved of result.symbols) {
      expect(moved).toMatchObject({ filePath: "src/api.ts", score: 5, risk: "low" });
      expect(moved.breakingChanges).toEqual([
        { type: "symbol-moved", symbolName: moved.name, severity: "warning", newValue: "src/model.ts", description: `'${moved.name}' moved to src/model.ts` },
      ]);
      expect(moved.evidence[0]).toEqual({ kind: "moved", detail: `'${moved.name}' moved to src/model.ts` });
    }
    expect(renderReviewMarkdown(result)).toContain("### Moved symbols\n- 'Box.area' moved to src/model.ts");
  });

  it("reports the differences between the old and the new declaration of a moved symbol", async () => {
    const workspace = await workspaceWith(
      { "src/api.ts": "export function make(kind: string): number { return kind.length; }\nexport const other = 1;\n" },
      { "src/api.ts": "export const other = 1;\n", "src/model.ts": "export function make(kind: string, size: number): number { return size; }\n" },
    );
    const result = await new ReviewGateAnalyzer(workspace, referenceIndex()).analyze({ baseRef: "main" });

    expect(symbol(result, "make")?.breakingChanges.map((change) => change.type)).toEqual(["parameter-added-required", "symbol-moved"]);
  });

  it("keeps a move breaking while a file still imports the name from the old path", async () => {
    const workspace = await workspaceWith(
      { "src/api.ts": OLD_API, "src/use.ts": 'import type { Kind, Shape } from "./api";\nexport const s: Shape = { size: 1 };\nexport const k: Kind = "a";\n' },
      { "src/api.ts": NEW_API, "src/model.ts": MODEL, "src/use.ts": 'import type { Shape } from "./api";\nimport type { Kind } from "./model";\nexport const s: Shape = { size: 1 };\nexport const k: Kind = "a";\n' },
    );
    const result = await new ReviewGateAnalyzer(workspace, referenceIndex()).analyze({ baseRef: "main" });

    const shape = symbol(result, "Shape");
    expect(shape?.breakingChanges.map((change) => change.type)).toEqual(["member-removed", "symbol-moved"]);
    expect(shape?.breakingChanges[1].description).toBe("'Shape' moved to src/model.ts, but 1 file(s) may still reach it through the old module: src/use.ts");
    expect(shape?.consumers).toEqual({ updated: [], covered: [], unverified: ["src/use.ts"] });
    expect(shape?.risk).toBe("high");
    expect(symbol(result, "Kind")?.risk).toBe("low");
  });

  it("finds an unchanged importer through the reference index, with Windows separators", async () => {
    const legacy = 'import type { Shape } from "./api";\nexport const s: Shape = { size: 1 };\n';
    const workspace = await workspaceWith(
      { "src/api.ts": OLD_API, "src/legacy.ts": legacy },
      { "src/api.ts": NEW_API, "src/model.ts": MODEL },
    );
    const windowsPath = path.join(workspace, "src", "legacy.ts").replaceAll("/", "\\");
    const provider = {
      getSymbolDependents: async () => [],
      findReferencingFiles: async (file: string) => (file.endsWith("src/api.ts") ? [{ path: windowsPath }] : []),
    };
    const result = await new ReviewGateAnalyzer(workspace, provider).analyze({ baseRef: "main" });

    expect(symbol(result, "Shape")?.consumers.unverified).toEqual(["src/legacy.ts"]);
    expect(symbol(result, "Kind")?.breakingChanges.map((change) => change.type)).toEqual(["symbol-moved"]);
  });

  it("keeps a plain removal, or a name redeclared with another kind, as a removal", async () => {
    const workspace = await workspaceWith(
      { "src/api.ts": OLD_API },
      { "src/api.ts": NEW_API.replace('import type { Kind, Shape } from "./model";', 'type Kind = string; interface Shape { size: number }'), "src/model.ts": "export const Shape = 1;\n" },
    );
    const result = await new ReviewGateAnalyzer(workspace, referenceIndex()).analyze({ baseRef: "main" });

    expect(symbol(result, "Shape")?.breakingChanges).toEqual([
      expect.objectContaining({ type: "member-removed", description: "Interface 'Shape' was removed" }),
    ]);
    expect(result.symbols.flatMap((candidate) => candidate.breakingChanges).some((change) => change.type === "symbol-moved")).toBe(false);
  });

  it("leaves a file renamed with git mv as before", async () => {
    const workspace = await workspaceWith({ "src/api.ts": OLD_API }, {});
    execFileSync("git", ["mv", "src/api.ts", "src/model.ts"], { cwd: workspace });
    const result = await new ReviewGateAnalyzer(workspace, referenceIndex()).analyze({ baseRef: "main" });

    expect(result.changedFiles).toEqual(["src/model.ts"]);
    expect(result.symbols).toEqual([]);
  });
});

describe("ReviewGateAnalyzer - symbol moved with another type kind", { timeout: GIT_TEST_TIMEOUT }, () => {
  async function moveInfo(oldDeclaration: string, newDeclaration: string) {
    const workspace = await createGitWorkspaceWithDiff(`${oldDeclaration}export const keep = 1;\n`, "export const keep = 1;\n", "src/api.ts");
    await fs.writeFile(path.join(workspace, "src", "model.ts"), newDeclaration);
    execFileSync("git", ["add", "-A"], { cwd: workspace });
    return new ReviewGateAnalyzer(workspace, referenceIndex()).analyze({ baseRef: "main" });
  }

  it.each([
    ["export type Info = { size: number };\n", "export interface Info { size: number }\n", "'Info' changed from a type alias to an interface"],
    ["export interface Info { size: number }\n", "export type Info = { size: number };\n", "'Info' changed from an interface to a type alias"],
    [
      "function info() { return { size: 1 }; }\nexport type Info = ReturnType<typeof info>;\n",
      "export interface Info { size: number }\n",
      "'Info' changed from an inferred type alias to an interface; the inferred shape is not compared",
    ],
  ])("reports a same-shape move from %s to %s as a low-risk warning", async (oldDeclaration, newDeclaration, description) => {
    const result = await moveInfo(oldDeclaration, newDeclaration);

    expect(result.risk).toBe("low");
    expect(result.symbols[0].breakingChanges).toEqual([
      expect.objectContaining({ type: "type-alias-changed", severity: "warning", description }),
      expect.objectContaining({ type: "symbol-moved", newValue: "src/model.ts" }),
    ]);
  });

  it("keeps the members an interface loses when it becomes a type alias", async () => {
    const result = await moveInfo("export interface Info { a: number; b: string }\n", "export type Info = { a: number };\n");

    expect(result.symbols[0].breakingChanges.map((change) => [change.type, change.severity])).toEqual([
      ["member-removed", "error"], ["type-alias-changed", "warning"], ["symbol-moved", "warning"],
    ]);
  });

  it.each([
    ["export interface Info { a: number }\n", "export type Info = { a: number } | null;\n", "'Info' changed from an interface to a type alias whose members cannot be compared"],
    ["export type Info = Base & { a: number };\ntype Base = { b: number };\n", "export interface Info { a: number }\n", "'Info' changed from a type alias to an interface whose members cannot be compared"],
  ])("keeps a kind change whose members cannot be compared breaking: %s", async (oldDeclaration, newDeclaration, description) => {
    const result = await moveInfo(oldDeclaration, newDeclaration);

    expect(result.symbols[0].breakingChanges[0]).toMatchObject({ type: "type-alias-changed", severity: "error", description });
  });
});

/** #444 review: a move is reported only when it is proven; anything else keeps the removal. */
describe("ReviewGateAnalyzer - unproven moves stay removals", { timeout: GIT_TEST_TIMEOUT }, () => {
  const OLD_API = "export interface Shape { size: number }\nexport const keep = 1;\n";
  const MODEL = "export interface Shape { size: number }\n";

  async function moveShape(extra: Record<string, string> = {}, staged: Record<string, string> = {}): Promise<string> {
    const workspace = await createGitWorkspaceWithDiff(OLD_API, "export const keep = 1;\n", "src/api.ts");
    for (const [file, content] of Object.entries(extra)) await fs.writeFile(path.join(workspace, file), content);
    if (Object.keys(extra).length > 0) {
      // Into the base commit, so the referrers stay unchanged by the reviewed diff.
      execFileSync("git", ["add", "--", ...Object.keys(extra)], { cwd: workspace });
      execFileSync("git", ["commit", "--amend", "--no-edit", "--", ...Object.keys(extra)], { cwd: workspace });
    }
    for (const [file, content] of Object.entries({ "src/model.ts": MODEL, ...staged })) {
      await fs.writeFile(path.join(workspace, file), content);
    }
    execFileSync("git", ["add", "-A"], { cwd: workspace });
    return workspace;
  }

  const shapeChanges = (result: Awaited<ReturnType<ReviewGateAnalyzer["analyze"]>>) =>
    result.symbols.find((candidate) => candidate.name === "Shape")?.breakingChanges.map((change) => change.type);

  it.each([
    ["default import", 'import api from "./api";\nexport const a = api;\n'],
    ["namespace import", 'import * as api from "./api";\nexport const s: api.Shape = { size: 1 };\n'],
    ["export * barrel", 'export * from "./api";\n'],
    ["export { Shape } barrel", 'export { Shape } from "./api";\n'],
    ["dynamic import", 'export const load = () => import("./api");\n'],
    ["require", 'export const api = require("./api");\n'],
    ["import type", 'export type Api = typeof import("./api");\n'],
    ["import = require", 'import api = require("./api");\nexport { api };\n'],
  ])("keeps the removal breaking for a file reaching the old module through a %s", async (_form, consumer) => {
    const workspace = await moveShape({ "src/use.ts": consumer });
    const index = referenceIndex([path.join(workspace, "src", "use.ts")]);
    const result = await new ReviewGateAnalyzer(workspace, index).analyze({ baseRef: "main" });

    expect(shapeChanges(result)).toEqual(["member-removed", "symbol-moved"]);
    expect(result.symbols.find((candidate) => candidate.name === "Shape")?.consumers.unverified).toEqual(["src/use.ts"]);
  });

  it("ignores a file importing other names from the old module", async () => {
    const workspace = await moveShape({ "src/use.ts": 'import { keep } from "./api";\nexport const k = keep;\n' });
    const index = referenceIndex([path.join(workspace, "src", "use.ts")]);
    const result = await new ReviewGateAnalyzer(workspace, index).analyze({ baseRef: "main" });

    expect(shapeChanges(result)).toEqual(["symbol-moved"]);
  });

  it("keeps the removal when two changed files newly export the name", async () => {
    const workspace = await moveShape({}, { "src/other.ts": MODEL });
    const result = await new ReviewGateAnalyzer(workspace, referenceIndex()).analyze({ baseRef: "main" });

    expect(shapeChanges(result)).toEqual(["member-removed"]);
    expect(result.limitations).toContain(
      "src/api.ts: 'Shape' is newly exported by src/model.ts, src/other.ts; its removal is kept because the move target is ambiguous.",
    );
  });

  it("keeps the removal when no reference index can list the importers", async () => {
    const workspace = await moveShape();
    const result = await new ReviewGateAnalyzer(workspace).analyze({ baseRef: "main" });

    expect(shapeChanges(result)).toEqual(["member-removed"]);
    expect(result.limitations).toContain(
      "src/api.ts: 'Shape' looks moved, but its removal is kept because files importing the old module could not be listed (no reference index is configured).",
    );
  });

  it("keeps the removal when the reference index fails", async () => {
    const workspace = await moveShape();
    const index = { getSymbolDependents: async () => [], findReferencingFiles: async () => { throw new Error("boom"); } };
    const result = await new ReviewGateAnalyzer(workspace, index).analyze({ baseRef: "main" });

    expect(shapeChanges(result)).toEqual(["member-removed"]);
    expect(result.limitations.some((limitation) => limitation.includes("(reference index failed: boom)"))).toBe(true);
  });
});

describe("ReviewGateAnalyzer - type impact without a dependents provider", { timeout: GIT_TEST_TIMEOUT }, () => {
  it("reports a changed type returned by a factory instead of throwing", async () => {
    const workspace = await createGitWorkspaceWithDiff(
      "export interface Shape { a: number; b: number }\nexport function make(): Shape { return { a: 1, b: 2 }; }\n",
      "export interface Shape { a: number }\nexport function make(): Shape { return { a: 1 }; }\n",
    );
    const result = await new ReviewGateAnalyzer(workspace).analyze({ baseRef: "main" });

    expect(result.symbols[0]).toMatchObject({ name: "Shape", impactedSymbolCount: 0 });
    expect(result.symbols[0].breakingChanges[0].type).toBe("member-removed");
  });
});
