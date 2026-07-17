import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// @ts-expect-error The composite Action runs this JavaScript module directly in Node.
import { MARKER, buildReviewDeepLink, fetchJsonOrThrow, findStickyComment, getCommentUpsert, renderReviewComment } from "../../.github/actions/graph-it-review-gate/commentHelpers.mjs";
// @ts-expect-error The composite Action runs this JavaScript module directly in Node.
import { assertSupportedCliVersion, compareSemver, parseCliVersion } from "../../.github/actions/graph-it-review-gate/verifyCliVersion.mjs";

describe("review-gate comment helpers", () => {
  const result = {
    risk: "high", score: 55, changedFiles: ["src/api.ts"], isPartial: true,
    limitations: ["partial|<detail>"],
    symbols: [{ risk: "high", score: 55, filePath: "src/a b&c.ts", name: "greet/?", impactedSymbolCount: 2, cycleEvidence: ["greet"], unusedExportEvidence: true, evidence: [{ detail: "cycle|<detected>" }] }],
  };

  it("selects only a marker-owned bot comment and creates an encoded deep link", () => {
    const sticky = findStickyComment([{ user: { type: "User" }, body: MARKER }, { id: 7, user: { type: "Bot" }, body: `${MARKER} old` }]);
    expect(sticky).toMatchObject({ id: 7 });
    expect(getCommentUpsert("https://example.test/comments", sticky)).toEqual({ method: "PATCH", url: "https://example.test/comments/7", operation: "update comment" });
    expect(getCommentUpsert("https://example.test/comments", undefined)).toEqual({ method: "POST", url: "https://example.test/comments", operation: "create comment" });
    expect(buildReviewDeepLink(result)).toBe("vscode://magic5644.graph-it-live/graph-it-live.reviewCallGraph?file=src%2Fa+b%26c.ts&symbol=greet%2F%3F&depth=3");
    expect(findStickyComment([{ id: 8, user: { type: "Bot" }, body: "other" }, { id: 9, user: { type: "Bot" }, body: 1 }])).toBeUndefined();
    expect(findStickyComment("invalid")).toBeUndefined();
  });

  it("sanitizes hostile content, includes limitations, and omits a link without a target", () => {
    const rendered = renderReviewComment(result, "magic5644.graph-it-live");
    expect(rendered).toContain("### Limitations");
    expect(rendered).not.toContain("<detail>");
    expect(rendered).not.toContain("partial|");
    expect(rendered).toContain("### Evidence");
    expect(renderReviewComment({ ...result, symbols: [] }, "magic5644.graph-it-live")).not.toContain("vscode://");
    expect(buildReviewDeepLink({ symbols: [{ filePath: "src/api.ts" }, { name: "greet" }] })).toBeUndefined();
    expect(buildReviewDeepLink({ symbols: "invalid" })).toBeUndefined();
    expect(renderReviewComment({ symbols: "invalid", limitations: "invalid", changedFiles: "invalid", risk: 7, score: "bad" }, "magic5644.graph-it-live")).toContain("(0/100)");
  });

  it("reports descriptive API failures while allowing mocked successful responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: "Unauthorized", text: async () => '{"message":"Bad credentials"}' });
    await expect(fetchJsonOrThrow(fetchMock, "https://example.test", {}, "list comments")).rejects.toThrow("GitHub list comments failed (401): Bad credentials");
    await expect(fetchJsonOrThrow(vi.fn().mockResolvedValue({ ok: true, text: async () => "[]" }), "https://example.test", {}, "list comments")).resolves.toEqual([]);
    await expect(fetchJsonOrThrow(vi.fn().mockResolvedValue({ ok: true, text: async () => "not-json" }), "https://example.test", {}, "list comments")).resolves.toBe("not-json");
    await expect(fetchJsonOrThrow(vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Error", text: async () => "" }), "https://example.test", {}, "list comments")).rejects.toThrow("Error");
  });

  it("stringifies scalar values before rendering them", () => {
    expect(renderReviewComment({ risk: null, score: 2.6, changedFiles: [1], symbols: [{ risk: false, score: -5, filePath: 1, name: null, impactedSymbolCount: undefined, cycleEvidence: "invalid", unusedExportEvidence: 0, evidence: [{ detail: null }] }], limitations: [null] }, "extension")).toContain("| false | 0 | 1 |  |  | 0 | no |");
  });
});

describe("review-gate CLI version validation", () => {
  it("accepts the minimum and newer installed CLI versions", () => {
    expect(parseCliVersion("graph-it-live v1.12.0\n")).toBe("1.12.0");
    expect(assertSupportedCliVersion("notice\ngraph-it-live v1.13.2\n")).toBe("1.13.2");
    expect(compareSemver("1.13.0", "1.12.0")).toBeGreaterThan(0);
  });

  it("rejects old, prerelease-minimum, and malformed CLI output", () => {
    expect(() => assertSupportedCliVersion("graph-it-live v1.11.9\n")).toThrow("1.12.0 or newer");
    expect(() => assertSupportedCliVersion("graph-it-live v1.12.0-rc.1\n")).toThrow("1.12.0 or newer");
    expect(() => assertSupportedCliVersion("graph-it v1.12.0\n")).toThrow("Unable to parse");
  });
});

describe("review-gate action risk threshold", () => {
  const actionPath = new URL("../../.github/actions/graph-it-review-gate/action.yml", import.meta.url);
  const riskGatePath = fileURLToPath(new URL("../../.github/actions/graph-it-review-gate/riskGate.cjs", import.meta.url));
  const action = readFileSync(actionPath, "utf8");

  function runRiskGate(risk: string, threshold: string) {
    return spawnSync(process.execPath, [riskGatePath], {
      encoding: "utf8",
      env: { ...process.env, RISK: risk, THRESHOLD: threshold },
    });
  }

  it("runs the risk gate with Node rather than a Bash-only script", () => {
    expect(action).toContain("shell: node {0}");
    expect(action).toContain('riskGate.cjs');
  });

  it("remains informative below the configured risk threshold under errexit", () => {
    expect(runRiskGate("low", "").status).toBe(0);
    expect(runRiskGate("medium", "high").status).toBe(0);
    expect(runRiskGate("high", "critical").status).toBe(0);
  });

  it("fails only when risk reaches the configured threshold and rejects invalid thresholds", () => {
    for (const [risk, threshold] of [["high", "high"], ["critical", "high"], ["critical", "critical"]]) {
      const result = runRiskGate(risk, threshold);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Graph-It Review Gate failed: risk=${risk} threshold=${threshold}`);
    }
    const invalid = runRiskGate("low", "medium");
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain("Invalid fail-on-risk value: medium (use high or critical)");
  });
});