import { describe, expect, it } from "vitest";
import { assessArchitecture } from "@/analyzer/architecture/architectureAssessment";
import { unitMatrix } from "@/analyzer/architecture/architectureMatrix";
import { REPORT_LIMIT, renderInitMarkdown, renderInitText, type InitResult } from "@/cli/commands/initReport";

const units = { units: [], unitEdges: [], cycles: 0 };

function result(overrides: Partial<InitResult> = {}): InitResult {
  return {
    configFile: "graphit.architecture.json",
    baselineFile: "graphit.architecture.baseline.json",
    status: "kept",
    written: [],
    changes: [],
    acceptedViolations: 0,
    guard: { preCommit: "graph-it check-architecture", ci: "- run: x", sarif: "- run: y" },
    assessment: assessArchitecture({ graph: { edges: [] }, units, unitOf: new Map(), matrix: unitMatrix(units), deadCode: [], acceptedViolations: 0 }),
    diagrams: [],
    ...overrides,
  };
}

describe("initReport", () => {
  it("fences the changes longer than any backtick run they hold", () => {
    const markdown = renderInitMarkdown(result({ changes: ["- accepted violation r: gone```.ts -> x.ts", "+ element \"a\": {}"] }));
    expect(markdown).toContain("\n````text\n- accepted violation r: gone```.ts -> x.ts\n");
    expect(markdown).toMatch(/\n````\n\n## Guard/);
    expect(renderInitMarkdown(result({ changes: ["+ element \"a\": {}"] }))).toContain("\n```text\n");
  });

  it("lists the first items only, and says how many more", () => {
    const changes = Array.from({ length: REPORT_LIMIT + 3 }, (_, index) => `+ element "e${index}": {}`);
    const text = renderInitText(result({ changes }));
    expect(text).toContain(`Changes (${REPORT_LIMIT + 3}):`);
    expect(text).toContain("... 3 more (--format json lists them all)");
    expect(text).not.toContain(`e${REPORT_LIMIT}"`);
  });

  it("links diagrams relative to the folder of report.md, and states the status", () => {
    const diagrams = [{ file: "out/units.svg", view: "units" as const }, { file: "out/folder-1-a.svg", view: "folder" as const, unit: "a`b" }];
    const markdown = renderInitMarkdown(result({ diagrams, status: "kept" }), "out");
    expect(markdown).toContain("existing config kept: nothing written");
    expect(markdown).toContain("- units ([diagram](units.svg))");
    expect(markdown).toContain("- folder `a'b` ([diagram](folder-1-a.svg))");
    expect(renderInitMarkdown(result({ diagrams }))).toContain("([diagram](out/units.svg))");
  });
});
