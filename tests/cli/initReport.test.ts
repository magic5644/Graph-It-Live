import { describe, expect, it } from "vitest";
import { assessArchitecture, type AssessmentInput } from "@/analyzer/architecture/architectureAssessment";
import { unitMatrix } from "@/analyzer/architecture/architectureMatrix";
import { REPORT_LIMIT, renderInitMarkdown, renderInitText, type InitResult } from "@/cli/commands/initReport";

const units = { units: [], unitEdges: [], cycles: 0 };
const empty: AssessmentInput = { graph: { edges: [] }, units, unitOf: new Map(), matrix: unitMatrix(units), deadCode: [], acceptedViolations: 0 };

/** Two cycle-free entry units `app` and `cli` importing `core`, `core/x.ts` and `core/y.ts` importing each other. */
function rich(): AssessmentInput {
  const unitList = ["app", "cli", "core"].map((key) => ({ key, name: key, fileCount: 2, internalEdgeCount: 1, layer: 0, role: "library", confidence: "inferred", evidence: [] }));
  const rows = { units: unitList, unitEdges: [{ from: "app", to: "core", fileEdgeCount: 1, kind: "down" }, { from: "cli", to: "core", fileEdgeCount: 3, kind: "down" }], cycles: 0 } as unknown as AssessmentInput["units"];
  const edges = [["app/main.ts", "core/x.ts"], ["core/x.ts", "core/y.ts"], ["core/y.ts", "core/x.ts"]].map(([sourceRelative, targetRelative]) => ({ sourceRelative, targetRelative, line: 1 }));
  const files = ["app/main.ts", "app/old.ts", "core/x.ts", "core/y.ts", ...Array.from({ length: 7 }, (_, i) => `cli/f${i}.ts`)];
  return {
    graph: { edges } as unknown as AssessmentInput["graph"],
    units: rows,
    unitOf: new Map(files.map((file) => [file, file.split("/")[0]])),
    matrix: unitMatrix(rows),
    deadCode: [],
    deadFiles: [
      { relativePath: "app/old.ts", lines: 12, exports: 1, confidence: "low", reasons: ["no-importer"] },
      ...Array.from({ length: 7 }, (_, i) => ({ relativePath: `cli/f${i}.ts`, ...(i === 6 ? {} : { lines: 1 }), exports: 0, confidence: "medium", reasons: ["test-only-use"] })),
      { relativePath: "script.ts", lines: 3, exports: 0, confidence: "low", reasons: ["no-importer"] },
    ],
    acceptedViolations: 2,
  };
}

function result(overrides: Partial<InitResult> = {}): InitResult {
  return {
    configFile: "graphit.architecture.json",
    baselineFile: "graphit.architecture.baseline.json",
    status: "kept",
    written: [],
    reportFiles: [],
    changes: [],
    acceptedViolations: 0,
    guard: { preCommit: "graph-it check-architecture", ci: "- run: x", sarif: "- run: y" },
    assessment: assessArchitecture(empty),
    diagrams: [],
    ...overrides,
  };
}

describe("initReport", () => {
  it("names the focus in the summary, an empty one too", () => {
    const focused = result({ focus: "app", assessment: assessArchitecture(rich(), new Set(["app/main.ts", "app/old.ts"])) });
    const text = renderInitText(focused);
    expect(text).toContain("Focus: app and its direct neighbours only (the files importing it or imported by it); the rules files cover the whole workspace");
    expect(text).toContain("Size: 2 files in app, 2 units with its neighbours, 1 unit edge through it");
    expect(text).not.toContain("cli/f0.ts");
    expect(renderInitMarkdown(focused)).toContain("- Focus: app and its direct neighbours only");
    const none = renderInitText(result({ focus: "lib", assessment: assessArchitecture(rich(), new Set(["lib/a.ts"])) }));
    expect(none).toContain("Size: 1 file in lib, 0 units with its neighbours, 0 unit edges through it");
    expect(none).toContain("Top action: none, nothing to clean up");
    expect(renderInitText(result())).not.toContain("Focus:");
  });

  it("fences the changes longer than any backtick run they hold", () => {
    const markdown = renderInitMarkdown(result({ changes: ["- accepted violation r: gone```.ts -> x.ts", "+ element \"a\": {}"] }));
    expect(markdown).toContain("\n````text\n- accepted violation r: gone```.ts -> x.ts\n");
    expect(markdown).toMatch(/\n````\n\n## Guard/);
    expect(renderInitMarkdown(result({ changes: ["+ element \"a\": {}"] }))).toContain("\n```text\n");
  });

  it("lists the first items only, and says how many more", () => {
    const changes = Array.from({ length: REPORT_LIMIT + 3 }, (_, index) => `+ element "e${index}": {}`);
    const text = renderInitText(result({ changes }));
    expect(text).toContain(`Config changes (${REPORT_LIMIT + 3}):`);
    expect(text).toContain("... 3 more (--format json lists them all)");
    expect(text).not.toContain(`e${REPORT_LIMIT}"`);
  });

  it("links diagrams relative to the folder of report.md, and states the status", () => {
    const diagrams = [{ file: "out/units.svg", view: "units" as const }, { file: "out/folder-1-a.svg", view: "folder" as const, unit: "a`b" }];
    const markdown = renderInitMarkdown(result({ diagrams, status: "kept" }), "out");
    expect(markdown).toContain("existing config kept, not rewritten");
    expect(markdown).toContain("- units ([diagram](units.svg))");
    expect(markdown).toContain("- folder `a'b` ([diagram](folder-1-a.svg))");
    expect(renderInitMarkdown(result({ diagrams }))).toContain("([diagram](out/units.svg))");
  });

  it("states what was written apart from the rules, which were not rewritten", () => {
    const text = renderInitText(result({ status: "unchanged", reportFiles: ["out/units.svg", "out/report.md"] }));
    expect(text.split("\n").slice(0, 2)).toEqual([
      "Rules: graphit.architecture.json: already up to date, not rewritten; the proposed baseline accepts 0 current violations.",
      "Report: wrote out/units.svg, out/report.md",
    ]);
    expect(text).not.toContain("nothing written");
  });

  it("orders the report: summary first, findings by cost, glossary once, guard last", () => {
    const text = renderInitText(result({ changes: ["+ element \"a\": {}"], assessment: assessArchitecture(rich()) }));
    const order = ["Summary:", "Dead files (3):", "Cycles to cut (1):", "Other leads (2):", "Glossary:", "Config changes (1):", "Guard:"].map((title) => text.indexOf(title));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((left, right) => left - right));
    expect(text).not.toContain("formula:");
    expect(text.match(/I = Ce \/ \(Ca \+ Ce\)/g)).toHaveLength(1);
    // A section with nothing to show is left out.
    expect(text).not.toContain("Hubs (");
  });

  it("summarises in five lines, the top action from the first section with items", () => {
    const text = renderInitText(result({ acceptedViolations: 2, assessment: assessArchitecture(rich()) }));
    const summary = text.slice(text.indexOf("Summary:")).split("\n").slice(1, 6);
    expect(summary).toEqual([
      "  Size: 11 files in 3 units, 2 unit edges",
      "  Cycles: 0 unit cycles, 1 mutual file import",
      "  Dead files: 9 files no production file imports, 21 lines (7 only imported by tests)",
      "  Unused exports: 0 high-confidence in 0 files (0 medium, 0 low not listed: graph-it check --minConfidence low)",
      "  Top action: delete app/old.ts (dead file: 12 lines, 1 export)",
    ]);
    expect(renderInitText(result())).toContain("Top action: none, nothing to clean up");
  });

  it("never proposes an export-less dead file (an entry point) as the top action before another lead", () => {
    const input = rich();
    const scripts = { ...input, deadFiles: input.deadFiles!.filter((file) => file.exports === 0) };
    expect(renderInitText(result({ assessment: assessArchitecture(scripts) }))).toContain("Top action: core/x.ts and core/y.ts import each other");
    const only = { ...empty, deadFiles: [{ relativePath: "run.ts", exports: 0, confidence: "low", reasons: ["no-importer"] }] };
    expect(renderInitText(result({ assessment: assessArchitecture(only) }))).toContain("Top action: (root) (dead files: 1 file, 0 lines)");
  });

  it("lists dead files by unit with one next command, capped per unit", () => {
    const text = renderInitText(result({ assessment: assessArchitecture(rich()) }));
    expect(text).toContain("  [1 file, 12 lines] app\n      app/old.ts: 12 lines, 1 export, low no-importer\n      next: graph-it check \"app\" --unreferencedFiles");
    // cli/f6.ts has no line count: sorted last, past the cap.
    expect(text).not.toContain("cli/f6.ts");
    expect(text).toContain("      ... 2 more\n      next: graph-it check \"cli\" --unreferencedFiles");
    // A file outside every unit: the whole-workspace command.
    expect(text).toContain("next: graph-it check --unreferencedFiles");
    expect(text.match(/next: /g)).toHaveLength(5);
  });

  it("collapses the entry rows into one line cross-referenced with the dead files", () => {
    const markdown = renderInitMarkdown(result({ assessment: assessArchitecture(rich()) }));
    expect(markdown).toContain("- **entry-row**: `app, cli` 2 units no other unit imports: entry points, or units nothing uses; 2 of them hold dead files.");
    expect(markdown.match(/entry-row/g)).toHaveLength(1);
    expect(markdown.indexOf("## Summary")).toBeLessThan(markdown.indexOf("## Dead files"));
    expect(markdown.indexOf("## Glossary")).toBeLessThan(markdown.indexOf("## Guard"));
  });

  it("shows hubs in plain words linked to the matrix, and a dead file it could not read", () => {
    const hubUnits = ["app", "core", "hub"].map((key) => ({ key, name: key, fileCount: 2, internalEdgeCount: 1, layer: 0, role: "library", confidence: "inferred", evidence: [] }));
    const rows = { units: hubUnits, unitEdges: [{ from: "app", to: "hub", fileEdgeCount: 10, kind: "down" }, { from: "hub", to: "core", fileEdgeCount: 10, kind: "down" }], cycles: 0 } as unknown as AssessmentInput["units"];
    const assessment = assessArchitecture({
      ...empty, units: rows, matrix: unitMatrix(rows), unitOf: new Map([["hub/big.ts", "hub"]]),
      deadFiles: [{ relativePath: "hub/big.ts", exports: 0, confidence: "low", reasons: ["no-importer"] }],
    });
    const diagrams = [{ file: "out/matrix.svg", view: "matrix" as const }, { file: "out/folder-1-hub.svg", view: "folder" as const, unit: "hub" }];
    const markdown = renderInitMarkdown(result({ assessment, diagrams }), "out");
    expect(markdown).toContain("## Hubs (1)");
    expect(markdown).toContain("- **hub-at-risk**: `hub` 10 file pairs from 1 unit(s) import it (Ca)");
    expect(markdown).toContain("([diagram](folder-1-hub.svg))");
    expect(markdown).toContain("`hub/big.ts: lines unknown, 0 exports, low no-importer`");
  });
});

