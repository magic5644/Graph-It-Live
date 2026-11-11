import { describe, expect, it } from "vitest";
import { ASSESSMENT_THRESHOLDS, assessArchitecture, type AssessmentInput, type DeadCodeFile } from "@/analyzer/architecture/architectureAssessment";
import { unitMatrix } from "@/analyzer/architecture/architectureMatrix";
import type { ArchitectureUnitEdge, ArchitectureUnits } from "@/shared/architecture-model";

/** `key:files:internal` units and `from>to=pairs` unit edges; `cycles` lists the units in a cycle. */
function input(unitSpecs: string[], edgeSpecs: string[], options: { cycles?: string[]; files?: [string, string, number?][]; deadCode?: DeadCodeFile[] } = {}): AssessmentInput {
  const cycles = new Set(options.cycles ?? []);
  const unitList = unitSpecs.map((spec) => {
    const [key, files, internal] = spec.split(":");
    return { key, name: key, fileCount: Number(files), internalEdgeCount: Number(internal), layer: 0, role: "library", confidence: "inferred", evidence: [] };
  });
  const unitEdges = edgeSpecs.map((spec): ArchitectureUnitEdge => {
    const [pair, count] = spec.split("=");
    const [from, to] = pair.split(">");
    return { from, to, fileEdgeCount: Number(count), kind: cycles.has(from) && cycles.has(to) ? "cycle" : "down" };
  });
  const units = { units: unitList, unitEdges, cycles: 0 } as unknown as Pick<ArchitectureUnits, "units" | "unitEdges" | "cycles">;
  const edges = (options.files ?? []).map(([sourceRelative, targetRelative, line]) => ({ sourceRelative, targetRelative, line }));
  const unitOf = new Map(edges.flatMap((edge) => [edge.sourceRelative, edge.targetRelative]).map((file) => [file, file.split("/")[0]]));
  for (const file of options.deadCode ?? []) unitOf.set(file.relativePath, file.relativePath.split("/")[0]);
  return {
    graph: { edges } as AssessmentInput["graph"],
    units,
    unitOf,
    matrix: unitMatrix(units),
    deadCode: options.deadCode ?? [],
    acceptedViolations: 0,
  };
}

describe("assessArchitecture: quick wins", () => {
  it("breaks a two-unit cycle on its cheaper direction, even against the matrix order", () => {
    // Label order puts a before b: a>b (3 pairs) is the upward cell, b>a (1 pair) the cheaper cut.
    const result = assessArchitecture(input(["a:2:1", "b:2:1"], ["a>b=3", "b>a=1"], {
      cycles: ["a", "b"],
      files: [["a/x.ts", "b/y.ts", 2], ["a/x.ts", "b/z.ts", 3], ["a/w.ts", "b/z.ts", 4], ["b/y.ts", "a/w.ts", 7]],
    }));
    expect(result.quickWins).toEqual([expect.objectContaining({
      kind: "cycle-break",
      effort: 1,
      evidence: ["b/y.ts:7 -> a/w.ts"],
      totalEvidence: 1,
      units: ["a", "b"],
      next: 'graph-it architecture --level units --from "b" --to "a"',
    })]);
    const [upward, block] = result.matrixFindings;
    expect(upward).toMatchObject({ kind: "upward-cell", rows: ["a", "b"], cells: ["a>b=3"], totalEvidence: 3, formula: expect.stringContaining("upward") });
    expect(block).toMatchObject({ kind: "cycle-block", rows: ["a", "b"], cells: ["b>a=1"], evidence: ["b/y.ts:7 -> a/w.ts"] });
    expect(block.action).toContain("removing 1 file pair(s) on 1 cell(s)");
  });

  it("leaves out a cycle whose cut is not cheap", () => {
    const result = assessArchitecture(input(["a:1:0", "b:1:0"], ["a>b=3", "b>a=3"], { cycles: ["a", "b"] }));
    expect(result.quickWins).toEqual([]);
    expect(result.matrixFindings.map((finding) => finding.kind)).toEqual(["upward-cell", "cycle-block"]);
  });

  it("reports each mutual file import once, and no self import", () => {
    const result = assessArchitecture(input(["c:3:3"], [], {
      files: [["c/m1.ts", "c/m2.ts", 1], ["c/m2.ts", "c/m1.ts", 5], ["c/m1.ts", "c/m2.ts", 1], ["c/self.ts", "c/self.ts", 1], ["c/m1.ts", "c/other.ts", 2]],
    }));
    expect(result.quickWins).toEqual([expect.objectContaining({
      kind: "mutual-import",
      effort: 1,
      evidence: ["c/m1.ts:1 -> c/m2.ts", "c/m2.ts:5 -> c/m1.ts"],
      units: ["c"],
      next: 'graph-it cycles "c/m1.ts"',
    })]);
    expect(result.totals.mutualImports).toBe(1);
  });

  it("lists weak unit dependencies up to the threshold, with their import lines", () => {
    const result = assessArchitecture(input(["app:1:0", "core:1:0", "ui:1:0"], [`app>core=${ASSESSMENT_THRESHOLDS.cheapPairs}`, `app>ui=${ASSESSMENT_THRESHOLDS.cheapPairs + 1}`], {
      files: [["app/a.ts", "core/c.ts"], ["app/b.ts", "core/c.ts", 9]],
    }));
    const weak = result.quickWins.filter((win) => win.kind === "weak-dependency");
    expect(weak).toEqual([expect.objectContaining({ effort: 2, evidence: ["app/a.ts -> core/c.ts", "app/b.ts:9 -> core/c.ts"], units: ["app", "core"] })]);
  });

  it("ranks dead code by unused exports, flags unreferenced files and caps the evidence", () => {
    const symbols = Array.from({ length: ASSESSMENT_THRESHOLDS.evidence + 2 }, (_, index) => ({ name: `s${index}`, line: index + 1 }));
    const result = assessArchitecture(input(["core:2:1"], [], {
      files: [["core/used.ts", "core/big.ts", 1]],
      deadCode: [{ relativePath: "core/big.ts", unusedSymbols: symbols }, { relativePath: "core/orphan.ts", unusedSymbols: [{ name: "x", line: 3 }] }, { relativePath: "core/clean.ts", unusedSymbols: [] }],
    }));
    expect(result.quickWins.map((win) => [win.kind, win.effort, win.subject])).toEqual([
      ["dead-code", 1, "core/orphan.ts: 1 unused export(s); no file imports it"],
      ["dead-code", 7, "core/big.ts: 7 unused export(s)"],
    ]);
    expect(result.quickWins[1]).toMatchObject({ evidence: symbols.slice(0, 5).map((s) => `core/big.ts:${s.line} ${s.name}`), totalEvidence: 7, next: 'graph-it check "core/big.ts"' });
    expect(result.totals).toMatchObject({ deadCodeFiles: 2, unusedExports: 8 });
  });

  it("orders quick wins by effort, then kind", () => {
    const result = assessArchitecture(input(["a:1:0", "b:1:0", "c:1:0"], ["a>b=1", "b>a=1", "c>a=2"], {
      cycles: ["a", "b"],
      files: [["a/x.ts", "b/y.ts"], ["b/y.ts", "a/x.ts"]],
      deadCode: [{ relativePath: "c/z.ts", unusedSymbols: [{ name: "z", line: 1 }] }],
    }));
    expect(result.quickWins.map((win) => `${win.kind}:${win.effort}`)).toEqual(["cycle-break:1", "mutual-import:1", "dead-code:1", "weak-dependency:2"]);
  });
});

describe("assessArchitecture: matrix reading", () => {
  const kinds = (result: ReturnType<typeof assessArchitecture>, kind: string) => result.matrixFindings.filter((finding) => finding.kind === kind);

  it("flags a hub at risk at the Ca and I thresholds only", () => {
    // hub: Ca = 10 (from app), Ce = 10 (to core): I = 0.5.
    const result = assessArchitecture(input(["app:1:0", "core:1:0", "hub:2:1"], ["app>hub=10", "hub>core=10"]));
    expect(kinds(result, "hub-at-risk")).toEqual([expect.objectContaining({ rows: ["hub"], formula: expect.stringContaining("I = Ce / (Ca + Ce)") })]);
    const below = assessArchitecture(input(["app:1:0", "core:1:0", "hub:2:1"], ["app>hub=9", "hub>core=10"]));
    expect(kinds(below, "hub-at-risk")).toEqual([]);
  });

  it("flags wide rows, most outgoing pairs first", () => {
    const targets = ["t1", "t2", "t3", "t4", "t5"];
    const result = assessArchitecture(input(
      ["w:1:0", "v:1:0", ...targets.map((t) => `${t}:1:0`)],
      [...targets.map((t) => `w>${t}=1`), ...targets.map((t) => `v>${t}=2`), "v>w=1"],
    ));
    expect(kinds(result, "wide-row").map((finding) => finding.rows[0])).toEqual(["v", "w"]);
    expect(kinds(assessArchitecture(input(["w:1:0", "a:1:0"], ["w>a=9"])), "wide-row")).toEqual([]);
  });

  it("flags entry rows with the dead-code files of the unit", () => {
    const result = assessArchitecture(input(["app:1:0", "core:1:0"], ["app>core=3"], {
      deadCode: [{ relativePath: "app/a.ts", unusedSymbols: [{ name: "a", line: 1 }] }],
    }));
    expect(kinds(result, "entry-row")).toEqual([expect.objectContaining({ rows: ["app"], action: expect.stringContaining("1 of its files have unused exports") })]);
  });

  it("flags weak cohesion for units of enough files only", () => {
    // C = 1 / (1 + 4) = 0.2 < 0.25; the two-file unit is left out.
    const result = assessArchitecture(input(["big:3:1", "small:2:0", "core:1:0"], ["big>core=4", "small>core=4"]));
    expect(kinds(result, "cohesion")).toEqual([expect.objectContaining({ rows: ["big"], action: expect.stringContaining("C = 1/5") })]);
    expect(kinds(assessArchitecture(input(["big:3:2", "core:1:0"], ["big>core=4"])), "cohesion")).toEqual([]);
  });

  it("reports the cycle block alone when its rows show no upward cell", () => {
    const base = input(["a:1:0", "b:1:0"], ["a>b=2", "b>a=1"], { cycles: ["a", "b"] });
    // A malformed matrix: the cycle's cells all below the diagonal.
    const matrix = { ...base.matrix, cells: base.matrix.cells.map((cell) => ({ ...cell, upward: false })) };
    expect(assessArchitecture({ ...base, matrix }).matrixFindings.map((finding) => finding.kind)).toEqual(["cycle-block"]);
  });

  it("finds nothing in an empty workspace", () => {
    const result = assessArchitecture(input([], []));
    expect(result.quickWins).toEqual([]);
    expect(result.matrixFindings).toEqual([]);
    expect(result.totals).toEqual({ units: 0, unitEdges: 0, unitCycles: 0, mutualImports: 0, acceptedViolations: 0, deadCodeFiles: 0, unusedExports: 0, unusedExportsMedium: 0, unusedExportsLow: 0 });
  });
});
