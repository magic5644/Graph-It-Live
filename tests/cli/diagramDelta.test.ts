import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArchitectureDeltaSource, ReviewGateResult } from "@/analyzer/ReviewGateAnalyzer";
import { CliProgress } from "@/cli/progress";
import type { CliRuntime } from "@/cli/runtime";
import { MAX_DELTA_UNITS } from "@/analyzer/diagram/architectureDelta";
import { deltaSource, edge, item } from "../analyzer/diagram/deltaFixtures";

const analyzeArchitecture = vi.fn<() => Promise<ArchitectureDeltaSource>>();
const analyze = vi.fn<() => Promise<ReviewGateResult>>();
let headUnitEdges: ReadonlyMap<string, number> | undefined;

vi.mock("@/analyzer/ReviewGateAnalyzer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/analyzer/ReviewGateAnalyzer")>()),
  // A function, not an arrow: the command calls it with `new`.
  ReviewGateAnalyzer: vi.fn().mockImplementation(function () {
    return { analyze, analyzeArchitecture, analyzeWithDelta: async () => ({ result: await analyze(), ...(headUnitEdges ? { headUnitEdges } : {}) }) };
  }),
}));
vi.mock("@/mcp/tools/impact", () => ({ createSpiderDependentsProvider: vi.fn(() => ({})) }));
vi.mock("@/mcp/shared/state", () => ({ workerState: { getSpider: vi.fn(), getConfig: vi.fn(() => ({})) } }));

const { run: runDiagram } = await import("@/cli/commands/diagram");
const { run: runReview } = await import("@/cli/commands/reviewPr");

let root = "";
let stderr: string[] = [];
const runtime = () => ({ workspaceRoot: root, progress: new CliProgress(false), ensureIndexed: vi.fn(async () => undefined) }) as unknown as CliRuntime;
const changed = () => deltaSource({ items: [item("ADDED", "billing")] });
const review = (source: ArchitectureDeltaSource): ReviewGateResult => ({ ...source, changedFiles: [], symbols: [], cycles: [], score: 0, risk: "low", isPartial: false });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "delta-cli-"));
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { stderr.push(String(chunk)); return true; });
  analyzeArchitecture.mockReset();
  analyze.mockReset();
  headUnitEdges = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("diagram --delta", () => {
  it("writes architecture-delta.svg and reports the counts", async () => {
    analyzeArchitecture.mockResolvedValue(changed());
    const out = await runDiagram(["--delta", "--base", "main"], runtime(), "text");
    expect(out).toMatch(/^Diagram written to architecture-delta\.svg: units/);
    expect(fs.readFileSync(path.join(root, "architecture-delta.svg"), "utf8")).toContain('data-diagram="architecture-delta"');
    expect(analyzeArchitecture).toHaveBeenCalledWith({ baseRef: "main", headRef: undefined });
  });

  it("draws a rules-only change: structure unchanged, verdict degraded", async () => {
    const source = deltaSource({ verdict: "unchanged" });
    source.architecture = { ...source.architecture!, verdict: "degraded" };
    analyzeArchitecture.mockResolvedValue(source);
    expect(await runDiagram(["--delta", "--base", "main", "--theme", "dark", "--output", "d.svg"], runtime(), "svg")).toContain("Diagram written to d.svg");
    expect(fs.existsSync(path.join(root, "d.svg"))).toBe(true);
  });

  it("writes the svg alone to stdout with --output -", async () => {
    analyzeArchitecture.mockResolvedValue(changed());
    expect(await runDiagram(["--delta", "--base", "main", "--output", "-"], runtime(), "text")).toMatch(/^<svg /);
    expect(fs.existsSync(path.join(root, "architecture-delta.svg"))).toBe(false);
  });

  it("never lets a pull-request unit name start a CI log command on stderr", async () => {
    const source = changed();
    source.structure!.warnings = ["unit \"x\n::error::spoofed\" moved"];
    analyzeArchitecture.mockResolvedValue(source);
    await runDiagram(["--delta", "--base", "main"], runtime(), "text");
    expect(stderr.join("")).not.toMatch(/^::error::/m);
    expect(stderr.join("")).toContain("x\uFFFD::error::spoofed");
  });

  it("sends every structure warning to stderr (incomplete renames)", async () => {
    const source = changed();
    source.structure!.warnings = ["Git rename detection was incomplete: 3 files not mapped."];
    analyzeArchitecture.mockResolvedValue(source);
    await runDiagram(["--delta", "--base", "main"], runtime(), "text");
    expect(stderr.join("")).toContain("Git rename detection was incomplete: 3 files not mapped.");
  });

  it("an unchanged comparison writes no file and leaves a stale one alone", async () => {
    analyzeArchitecture.mockResolvedValue(deltaSource({ verdict: "unchanged" }));
    fs.writeFileSync(path.join(root, "architecture-delta.svg"), "stale");
    const line = await runDiagram(["--delta", "--base", "main"], runtime(), "text");
    expect(line).toBe("No architecture change between main and feature (0 units, 0 unit edges compared): no diagram written.");
    expect(fs.readFileSync(path.join(root, "architecture-delta.svg"), "utf8")).toBe("stale");
    expect(await runDiagram(["--delta", "--base", "main", "--output", "-"], runtime(), "text")).toBe("");
    expect(stderr.join("")).toContain("no diagram written.");
  });

  it("draws nothing when only file and file-pair counts changed, and says so", async () => {
    analyzeArchitecture.mockResolvedValue(deltaSource({ items: [item("CHANGED", "a")], edges: [edge("CHANGED", "a", "b")] }));
    const line = await runDiagram(["--delta", "--base", "main"], runtime(), "text");
    expect(line).toContain("1 unit and 1 unit edge only changed size (file or file-pair counts)): no diagram written.");
    expect(fs.existsSync(path.join(root, "architecture-delta.svg"))).toBe(false);
  });

  it("sends the cut lines to stderr, never into the svg on stdout, with --output -", async () => {
    analyzeArchitecture.mockResolvedValue(deltaSource({ items: Array.from({ length: MAX_DELTA_UNITS + 1 }, (_, index) => item("ADDED", `u${String(index).padStart(3, "0")}`)) }));
    const out = await runDiagram(["--delta", "--base", "main", "--output", "-"], runtime(), "text");
    expect(out).toMatch(/^<svg /);
    expect(out).not.toContain("Diagram written");
    expect(stderr.join("")).toContain("1 changed unit not drawn (1 added): graph-it review-pr --base main --head feature --format json");
  });

  it("fails with exit 1 for an empty comparison and for a missing structure", async () => {
    const empty = deltaSource();
    empty.structure!.verdict = "empty";
    analyzeArchitecture.mockResolvedValueOnce(empty);
    await expect(runDiagram(["--delta", "--base", "main"], runtime(), "text")).rejects.toMatchObject({ exitCode: 1, message: "No analyzable file at main or feature: nothing to compare." });
    analyzeArchitecture.mockResolvedValueOnce({ baseRef: "main", headRef: "HEAD", limitations: ["Architecture rules unavailable: /home/me/repo boom"] });
    const failure = runDiagram(["--delta", "--base", "main"], runtime(), "text");
    await expect(failure).rejects.toThrow("No structure comparison between main and HEAD: the trees could not be read; graph-it review-pr --base main --head HEAD lists the limitations.");
    await expect(failure).rejects.not.toThrow("/home/me");
  });

  it.each([
    [["--delta"], "text", 1, "--delta compares two refs: pass --base <git-ref>"],
    [["--base", "main"], "text", 1, "--base and --head apply to --delta"],
    [["--head", "x"], "text", 1, "--base and --head apply to --delta"],
    [["src", "--delta", "--base", "main"], "text", 1, "--delta draws the structure diff of two refs: drop src"],
    ...["--view", "--folder", "--spec", "--config", "--baseline", "--maxSteps", "--startLine", "--depth", "--maxMessages", "--participants"]
      .map((flag) => [["--delta", "--base", "main", flag, "x"], "text", 1, `drop ${flag}`] as const),
    [["--delta", "--base", "main", "--rules"], "text", 1, "drop --rules"],
    [["--delta", "--base"], "text", 1, "--base must be a Git ref"],
    [["--delta", "--base", "main"], "html", 4, "graph-it diagram --delta writes --format svg"],
    [["--delta", "--base", "main"], "mermaid", 4, "graph-it diagram --delta writes --format svg"],
    [["--delta", "--base", "main", "--output", "x.html"], "text", 4, "graph-it diagram --delta writes --format svg"],
    [["--delta", "--base", "main", "--output", "x.json"], "svg", 1, "--output x.json does not match --format svg"],
    [["--delta", "--base", "main", "--theme", "blue"], "text", 1, "--theme must be light or dark"],
    [["--delta", "--base", "main", "--output", "../x.svg"], "text", 5, "Refusing to write ../x.svg"],
  ] as const)("%j (%s) exits %i: %s", async (args, format, exitCode, message) => {
    await expect(runDiagram([...args], runtime(), format)).rejects.toMatchObject({ exitCode, message: expect.stringContaining(message) });
    expect(analyzeArchitecture).not.toHaveBeenCalled();
  });
});

describe("review-pr --deltaSvg", () => {
  it("writes the delta of the review it holds, only when the structure changed", async () => {
    analyze.mockResolvedValue(review(changed()));
    await runReview(["--base", "main", "--deltaSvg", "out/d.svg"], runtime(), "json");
    expect(fs.readFileSync(path.join(root, "out", "d.svg"), "utf8")).toContain('data-diagram="architecture-delta"');
    expect(analyzeArchitecture).not.toHaveBeenCalled();
  });

  it("draws the unchanged edges from the head unit edges of analyzeWithDelta, not of analyze", async () => {
    headUnitEdges = new Map([["billing\0core", 2]]);
    analyze.mockResolvedValue(review({ ...changed(), structure: deltaSource({ items: [item("ADDED", "billing")], unchangedEdges: 1 }).structure }));
    await runReview(["--base", "main", "--deltaSvg", "d.svg"], runtime(), "json");
    expect(fs.readFileSync(path.join(root, "d.svg"), "utf8")).toContain('data-status="UNCHANGED" class="edge s-down"');
  });

  it("writes no file for an unchanged, empty or structureless review, and says why on stderr for the last two", async () => {
    analyze.mockResolvedValueOnce(review(deltaSource({ verdict: "unchanged" })));
    await runReview(["--base", "main", "--deltaSvg", "d.svg"], runtime(), "json");
    const empty = deltaSource();
    empty.structure!.verdict = "empty";
    analyze.mockResolvedValueOnce(review(empty));
    await runReview(["--base", "main", "--deltaSvg", "d.svg"], runtime(), "json");
    analyze.mockResolvedValueOnce(review({ baseRef: "main", headRef: "HEAD", limitations: [] }));
    await runReview(["--base", "main", "--deltaSvg", "d.svg"], runtime(), "json");
    expect(fs.existsSync(path.join(root, "d.svg"))).toBe(false);
    expect(stderr.join("")).toContain("no analyzable file at main or feature");
    expect(stderr.join("")).toContain("no structure comparison");
  });

  it("writes no file when only sizes changed, and says so on stderr", async () => {
    analyze.mockResolvedValue(review(deltaSource({ items: [item("CHANGED", "a")] })));
    await runReview(["--base", "main", "--deltaSvg", "d.svg"], runtime(), "json");
    expect(fs.existsSync(path.join(root, "d.svg"))).toBe(false);
    expect(stderr.join("")).toContain("1 unit only changed size (file or file-pair counts)): no diagram written.");
  });

  it.each([
    [["--deltaSvg"], 1, "--deltaSvg must be a .svg file of the workspace"],
    [["--deltaSvg", "-"], 1, "--deltaSvg writes a .svg file of the workspace"],
    [["--deltaSvg", "d.png"], 1, "--deltaSvg writes a .svg file of the workspace"],
    [["--deltaSvg", "../d.svg"], 5, "Refusing to write ../d.svg"],
  ])("%j exits %i before any analysis", async (extra, exitCode, message) => {
    await expect(runReview(["--base", "main", ...extra], runtime(), "json")).rejects.toMatchObject({ exitCode, message: expect.stringContaining(message) });
    expect(analyze).not.toHaveBeenCalled();
  });
});

// A backslash separates folders on Windows only; elsewhere it is a file name character, still inside the workspace.
describe.each([
  ["diagram --output", (output: string) => { analyzeArchitecture.mockResolvedValue(changed()); return runDiagram(["--delta", "--base", "main", "--output", output], runtime(), "text"); }],
  ["review-pr --deltaSvg", (output: string) => { analyze.mockResolvedValue(review(changed())); return runReview(["--base", "main", "--deltaSvg", output], runtime(), "json"); }],
] as const)("%s with Windows separators", (_name, write) => {
  it.each([["out\\d.svg", ["out", "d.svg"]], ["..\\x.svg", undefined]] as const)("resolves %s with the platform's separators", async (output, windowsTarget) => {
    const run = write(output);
    if (process.platform !== "win32") {
      await run;
      expect(fs.existsSync(path.join(root, output))).toBe(true);
    } else if (windowsTarget === undefined) {
      await expect(run).rejects.toMatchObject({ exitCode: 5 });
    } else {
      await run;
      expect(fs.existsSync(path.join(root, ...windowsTarget))).toBe(true);
    }
  });
});
