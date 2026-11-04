import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewGateResult } from "@/analyzer/ReviewGateAnalyzer";
import type { CliRuntime } from "@/cli/runtime";

const analyze = vi.fn<() => Promise<ReviewGateResult>>();

vi.mock("@/analyzer/ReviewGateAnalyzer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/analyzer/ReviewGateAnalyzer")>()),
  // A function, not an arrow: the command calls it with `new`.
  ReviewGateAnalyzer: vi.fn().mockImplementation(function () {
    return { analyze };
  }),
}));
vi.mock("@/mcp/tools/impact", () => ({ createSpiderDependentsProvider: vi.fn(() => ({})) }));
vi.mock("@/mcp/shared/state", () => ({ workerState: { getSpider: vi.fn(), getConfig: vi.fn(() => ({})) } }));

const { run } = await import("@/cli/commands/reviewPr");

const runtime = { workspaceRoot: "/workspace", ensureIndexed: vi.fn(async () => undefined) } as unknown as CliRuntime;
const base: ReviewGateResult = {
  baseRef: "main", headRef: "HEAD", changedFiles: ["frontend/app.ts"], symbols: [], cycles: [],
  score: 50, risk: "high", isPartial: false, limitations: [],
};
const pair = { source: "frontend/app.ts", target: "backend/db.ts", line: 3, from: "frontend", to: "backend" };
const architecture: NonNullable<ReviewGateResult["architecture"]> = {
  verdict: "degraded", configFile: "graphit.architecture.json", newErrors: 1,
  rules: [
    { name: "frontend-not-backend", kind: "forbid", severity: "error", reason: "API only.", newViolations: [{ ...pair, accepted: false }, { ...pair, source: "frontend/old.ts", accepted: true }], resolvedViolations: [], unchanged: 0 },
    { name: "soft", kind: "forbid", severity: "warning", newViolations: [{ ...pair, accepted: false }], resolvedViolations: [], unchanged: 0 },
  ],
  unitCycles: { newViolations: [], resolvedViolations: [], unchanged: 0 },
};

type Sarif = { runs: Array<{ tool: { driver: { name: string; rules: Array<{ id: string }> } }; results: Array<{ ruleId: string; level: string; locations: Array<{ physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }> }> }> };

describe("review-pr command", () => {
  beforeEach(() => analyze.mockReset());

  it("requires --base", async () => {
    await expect(run([], runtime, "json")).rejects.toThrow("review-pr requires --base <git-ref>");
  });

  it("lists the new architecture violations the baseline does not accept as SARIF", async () => {
    analyze.mockResolvedValue({ ...base, architecture });
    const sarif = JSON.parse(await run(["--base", "main"], runtime, "sarif")) as Sarif;
    expect(sarif.runs[0].tool.driver.name).toBe("graph-it review-pr");
    expect(sarif.runs[0].tool.driver.rules.map((rule) => rule.id)).toEqual(["frontend-not-backend", "soft"]);
    expect(sarif.runs[0].results.map(({ ruleId, level, locations }) =>
      [ruleId, level, locations[0].physicalLocation.artifactLocation.uri, locations[0].physicalLocation.region.startLine]))
      .toEqual([["frontend-not-backend", "error", "frontend/app.ts", 3], ["soft", "warning", "frontend/app.ts", 3]]);
  });

  it("writes an empty SARIF run without a config, and passes --head, --depth and --max-files", async () => {
    analyze.mockResolvedValue(base);
    const sarif = JSON.parse(await run(["--base", "main", "--head", "feature", "--depth", "2", "--max-files", "5"], runtime, "sarif")) as Sarif;
    expect(sarif.runs[0].results).toEqual([]);
    expect(analyze).toHaveBeenCalledWith({ baseRef: "main", headRef: "feature", maxDepth: 2, maxFiles: 5 });
  });

  it("renders markdown and the structured formats with the architecture section", async () => {
    analyze.mockResolvedValue({ ...base, architecture });
    expect(await run(["--base", "main"], runtime, "markdown")).toContain("### Architecture rules: DEGRADED");
    expect(JSON.parse(await run(["--base", "main"], runtime, "json")).architecture).toEqual(architecture);
  });
});
