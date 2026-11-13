import { describe, expect, it } from "vitest";
import type { ArchitectureAssessment } from "@/analyzer/architecture/architectureAssessment";
import type { ArchitectureViolation } from "@/analyzer/architecture/architectureRules";
import type { UnitSource } from "@/analyzer/architecture/architectureView";
import { buildHtmlGraphModel } from "@/analyzer/export/HtmlExporter";
import { initPage } from "@/cli/commands/initPage";
import { REPORT_LIMIT, type InitResult } from "@/cli/commands/initReport";

const ROOT = "/ws";
// app -> billing <-> orders (cycle), lib -> app upward, plus one file per unit.
const FILES: Record<string, string> = {
  "app/main.ts": "app",
  "app/view.ts": "app",
  "billing/invoice.ts": "billing",
  "orders/service.ts": "orders",
  "lib/util.ts": "lib",
};
const PAIRS: [string, string][] = [
  ["app/main.ts", "app/view.ts"],
  ["app/main.ts", "billing/invoice.ts"],
  ["billing/invoice.ts", "orders/service.ts"],
  ["orders/service.ts", "billing/invoice.ts"],
  ["lib/util.ts", "app/view.ts"],
];

function source(files = FILES, pairs = PAIRS): UnitSource {
  const keys = [...new Set(Object.values(files))];
  return {
    graph: {
      nodes: Object.keys(files).map((relativePath) => ({ path: `${ROOT}/${relativePath}`, relativePath })),
      edges: [...pairs.map(([source, target]) => ({ source: `${ROOT}/${source}`, target: `${ROOT}/${target}` })), { source: `${ROOT}/app/main.ts`, target: "/elsewhere/x.ts" }],
      graphData: { nodes: [], edges: [], nodeMetadata: { [`${ROOT}/app/view.ts`]: { hubScore: 0.8, framework: "react" } } },
      context: { revision: "rev-1", failedFiles: 2 },
    },
    units: {
      units: keys.map((key) => ({ key, fileCount: Object.values(files).filter((unit) => unit === key).length })),
      unitEdges: [
        { from: "app", to: "billing", kind: "down" },
        { from: "billing", to: "orders", kind: "cycle" },
        { from: "orders", to: "billing", kind: "cycle" },
        { from: "lib", to: "app", kind: "upward" },
      ],
    },
    assignment: { unitOf: new Map(Object.entries(files)), names: new Map() },
  } as unknown as UnitSource;
}

const violation = (source: string, target: string) => ({ rule: "r", severity: "error", source, target, from: "a", to: "b", new: false }) as ArchitectureViolation;

function result(assessment: Partial<ArchitectureAssessment> = {}, focus?: string): InitResult {
  return {
    ...(focus === undefined ? {} : { focus }),
    assessment: { deadFiles: [], quickWins: [], matrixFindings: [], ...assessment },
  } as unknown as InitResult;
}

describe("initPage", () => {
  it("groups the files by unit, with the unit key as label and the unit file counts", () => {
    const page = initPage(source(), ROOT, [], result());
    const model = buildHtmlGraphModel(page.graphData);
    expect(model.groups.map(({ id, label, fileCount }) => [id, label, fileCount])).toEqual([
      [1, "app", 2], [2, "billing", 1], [3, "orders", 1], [4, "lib", 1],
    ]);
    expect(page.graphData.nodeMetadata?.["app/view.ts"]).toEqual({ hubScore: 0.8, framework: "react", communityId: 1, communityKey: "app" });
    expect(page.graphData.nodeMetadata?.["lib/util.ts"]).toEqual({ hubScore: 0, communityId: 4, communityKey: "lib" });
    expect(page.context).toEqual({ scope: "workspace", revision: "rev-1", communityMode: "architecture units", failedFiles: 2 });
    expect(page.workspaceName).toBe("ws");
  });

  it("keeps workspace-relative paths only, and drops pairs leaving the graph", () => {
    const page = initPage(source(), ROOT, [], result());
    expect(page.graphData.edges).toEqual(PAIRS.map(([source, target]) => ({ source, target })));
    expect(JSON.stringify(page)).not.toContain(ROOT);
    expect(page.workspaceRoot).toBeUndefined();
  });

  it("marks cycle and upward pairs from the unit edges, a violation over both, never a down edge", () => {
    const page = initPage(source(), ROOT, [violation("orders/service.ts", "billing/invoice.ts"), violation("app/main.ts", "app/view.ts")], result());
    expect(page.overlay?.edgeKinds).toEqual([
      ["app/main.ts", "app/view.ts", "violation"],
      ["billing/invoice.ts", "orders/service.ts", "cycle"],
      ["orders/service.ts", "billing/invoice.ts", "violation"],
      ["lib/util.ts", "app/view.ts", "upward"],
    ]);
  });

  it("marks the dead files of the page", () => {
    const dead = (relativePath: string) => ({ relativePath, lines: 3, exports: 0, confidence: "low", reasons: ["no-importer"] });
    const deadFiles = [{ unit: "app", lines: 3, files: [dead("app/main.ts"), dead("gone/x.ts")] }];
    expect(initPage(source(), ROOT, [], result({ deadFiles } as never)).overlay?.deadFiles).toEqual(["app/main.ts"]);
  });

  it("lists the report sections, and maps each finding to the files it names", () => {
    const deadFiles = [{ unit: "app", lines: 8, files: [{ relativePath: "app/main.ts", lines: 8, exports: 0, confidence: "low", reasons: ["no-importer"] }] }];
    const win = (kind: string, subject: string, evidence: string[], units: string[]) =>
      ({ kind, gain: 1, effort: 1, subject, evidence, totalEvidence: evidence.length, units, next: "graph-it next" });
    const quickWins = [
      win("cycle-break", "billing, orders import each other", ["billing/invoice.ts:1 -> orders/service.ts"], ["billing", "orders"]),
      win("dead-code", "lib/util.ts: 1 unused export(s)", ["lib/util.ts:7 helper", "lib/unknown.ts:2 gone"], ["lib"]),
    ];
    const matrixFindings = [{ kind: "hub-at-risk", rows: ["app"], cells: [], evidence: ["app is imported by 3 units"], totalEvidence: 1, action: "split it" }];
    const page = initPage(source(), ROOT, [], result({ deadFiles, quickWins, matrixFindings } as never));
    const sections = page.overlay?.findings ?? [];
    expect(sections.map((section) => [section.title, section.total])).toEqual([["Dead files", 1], ["Cycles to cut", 1], ["Hubs", 1], ["Other leads", 1]]);
    const items = sections.flatMap((section) => section.items);
    expect(items.map((entry) => [entry.label, entry.subject, entry.files])).toEqual([
      ["1 file, 8 lines", "app", ["app/main.ts"]],
      ["cycle-break, gain 1 / effort 1", "billing, orders import each other", ["billing/invoice.ts", "orders/service.ts"]],
      ["hub-at-risk", "app", []],
      ["dead-code, gain 1 / effort 1", "lib/util.ts: 1 unused export(s)", ["lib/util.ts"]],
    ]);
    expect(items[0]).toMatchObject({ details: ["app/main.ts: 8 lines, 0 exports, low no-importer"], next: 'graph-it check "app" --unreferencedFiles', units: ["app"] });
    expect(items[2]).toMatchObject({ note: "split it", units: ["app"] });
  });

  it("cuts a section at the report limit and keeps the line counting the rest", () => {
    const matrixFindings = Array.from({ length: REPORT_LIMIT + 2 }, (_, index) =>
      ({ kind: "cohesion", rows: [`u${index}`], cells: [], evidence: [], totalEvidence: 0, action: "a" }));
    const [section] = initPage(source(), ROOT, [], result({ matrixFindings } as never)).overlay?.findings ?? [];
    expect(section).toMatchObject({ title: "Other leads", total: REPORT_LIMIT + 2, more: ["... 2 more (--format json lists them all)"] });
    expect(section.items).toHaveLength(REPORT_LIMIT);
  });

  it("with a focus, keeps its units and their neighbours and opens on its files", () => {
    const focus = { files: new Set(["billing/invoice.ts", "orders/gone.ts"]), units: new Set(["billing", "orders", "app"]) };
    const page = initPage(source(), ROOT, [], result({}, "billing"), focus);
    expect(buildHtmlGraphModel(page.graphData).groups.map(({ label, fileCount }) => [label, fileCount])).toEqual([["app", 2], ["billing", 1], ["orders", 1]]);
    expect(page.graphData.edges.some(({ source }) => source === "lib/util.ts")).toBe(false);
    expect(page.overlay?.focus).toEqual({ label: "billing", files: ["billing/invoice.ts"] });
    expect(page.context.scope).toBe("billing and its direct neighbours");
  });

  it("gives an empty page for an empty workspace", () => {
    const empty = source({}, []);
    const page = initPage(empty, ROOT, [], result());
    expect(page.graphData).toEqual({ nodes: [], edges: [], nodeMetadata: {} });
    expect(page.overlay).toEqual({ edgeKinds: [], deadFiles: [], findings: [] });
  });
});
