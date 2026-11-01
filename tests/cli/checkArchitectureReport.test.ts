import { describe, expect, it } from "vitest";
import type { WorkspaceArchitectureCheck } from "@/analyzer/architecture/architectureRules";
import { renderCheckArchitectureMarkdown, renderCheckArchitectureText } from "@/cli/commands/checkArchitectureReport";

// Pure renderers of graph-it check-architecture; the acme workspace goldens live in
// tests/analyzer/architecture/architectureRulesGolden.test.ts.
function check(overrides: Partial<WorkspaceArchitectureCheck> = {}): WorkspaceArchitectureCheck {
  return {
    configFile: "graphit.architecture.json",
    context: { communityMode: "path", revision: "r1", graphKind: "imports", scope: "workspace", exclusions: "", truncated: false, failedFiles: 0, baseline: false },
    passed: true,
    totals: { files: 2, unmatchedFiles: 0, rules: 1, brokenRules: 0, violations: 0, newViolations: 0, errors: 0, newErrors: 0, warnings: 0, resolved: 0 },
    rules: [{ name: "layers", kind: "forbid", severity: "error", reason: undefined, violations: 0, newViolations: 0, elementPairs: [] }],
    violations: [],
    resolved: [],
    unmatchedFiles: [],
    configWarnings: [],
    ...overrides,
  } as WorkspaceArchitectureCheck;
}

const failing = () => check({
  passed: false,
  totals: { files: 2, unmatchedFiles: 1, rules: 1, brokenRules: 1, violations: 1, newViolations: 1, errors: 1, newErrors: 1, warnings: 0, resolved: 0 },
  rules: [{ name: "ui|core", kind: "forbid", severity: "error", reason: "UI calls\nthe API.", violations: 1, newViolations: 1, elementPairs: [] }],
  violations: [{ rule: "ui|core", severity: "error", source: String.raw`src\ui\a|b.ts`, target: String.raw`src\core\x.ts`, line: 3, from: "ui", to: "core", new: true }],
  resolved: [{ rule: "old*rule", source: "a``b.ts", target: "c.ts" }],
  unmatchedFiles: ["scripts\\we`ird.ts"],
  configWarnings: ['element "legacy": path "old/" matches no file'],
});

describe("check-architecture text report", () => {
  it("passes with 0 violations: verdict and rules table only", () => {
    expect(renderCheckArchitectureText(check())).toBe([
      "PASSED: 0 new error violations (config graphit.architecture.json, no baseline)",
      "2 files, 0 unmatched; 0 violations (0 new, 0 accepted): 0 errors, 0 warnings; 0 resolved",
      "",
      "Rules",
      "  Rule    Kind    Severity  Violations  New",
      "  layers  forbid  error     0           0",
    ].join("\n"));
  });

  it("says when no rule is declared and when the analysis is partial", () => {
    const text = renderCheckArchitectureText(check({
      rules: [],
      context: { ...check().context, truncated: true, failedFiles: 1 },
    }));
    expect(text).toContain("Rules\n  No rules.");
    expect(text).toContain("Partial analysis: file limit reached, 1 file failed to parse");
  });

  it("normalizes Windows paths, lists unmatched files and config warnings", () => {
    const text = renderCheckArchitectureText(failing());
    expect(text).toContain("  ui|core (error): UI calls the API.\n    src/ui/a|b.ts:3 → src/core/x.ts");
    expect(text).toContain("Unmatched files\n  No element selects them: no rule checks them.\n  scripts/we`ird.ts");
    expect(text).toContain('Config warnings\n  element "legacy": path "old/" matches no file');
    expect(text).not.toContain("\\");
  });

  it("prints the context with --verbose", () => {
    expect(renderCheckArchitectureText(check(), true)).toContain("Context\n  communityMode: path\n  revision: r1");
  });
});

describe("check-architecture markdown report", () => {
  it("passes with 0 violations: heading, verdict and a GitHub table, no diagram", () => {
    expect(renderCheckArchitectureMarkdown(check())).toBe([
      "## Architecture check: PASSED",
      "",
      "0 new error violations (config graphit.architecture.json, no baseline).",
      "",
      "2 files, 0 unmatched; 0 violations (0 new, 0 accepted): 0 errors, 0 warnings; 0 resolved.",
      "",
      "| Rule | Kind | Severity | Violations | New |",
      "| --- | --- | --- | ---: | ---: |",
      "| `layers` | forbid | error | 0 | 0 |",
    ].join("\n"));
  });

  it("escapes | in table cells, keeps config text on one line, shows names and paths as code", () => {
    const markdown = renderCheckArchitectureMarkdown(failing());
    expect(markdown).toContain(String.raw`| ${"`"}ui\|core${"`"} | forbid | error | 1 | 1 |`);
    expect(markdown).toContain("#### `ui|core` (error)\n\nUI calls the API.\n\n- `src/ui/a|b.ts:3` → `src/core/x.ts`");
    expect(markdown).toContain("- `` scripts/we`ird.ts ``");
    expect(markdown).toContain("- ``` a``b.ts ``` → `c.ts` (`old*rule`)");
    expect(markdown).toContain('### Config warnings\n\n- element "legacy": path "old/" matches no file');
    expect(markdown).not.toMatch(/graph (TD|LR)|```mermaid/);
  });

  it("says when no rule is declared", () => {
    expect(renderCheckArchitectureMarkdown(check({ rules: [] }))).toContain("\nNo rules.");
  });
});
