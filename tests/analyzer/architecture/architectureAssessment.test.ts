import { describe, expect, it } from "vitest";
import { ASSESSMENT_THRESHOLDS, assessArchitecture, cycleCuts, type AssessmentInput, type DeadCodeFile, type DeadFile } from "@/analyzer/architecture/architectureAssessment";
import { unitMatrix } from "@/analyzer/architecture/architectureMatrix";
import type { ArchitectureUnitEdge, ArchitectureUnits, UnitCycleKind } from "@/shared/architecture-model";

/** `key:files:internal` units and `from>to=pairs` unit edges; `cycles` lists the units in a cycle. */
function input(unitSpecs: string[], edgeSpecs: string[], options: { cycles?: string[]; cycleKind?: UnitCycleKind; files?: [string, string, number?, boolean?, boolean?][]; deadCode?: DeadCodeFile[]; deadFiles?: DeadFile[] } = {}): AssessmentInput {
  const cycles = new Set(options.cycles ?? []);
  const unitList = unitSpecs.map((spec) => {
    const [key, files, internal] = spec.split(":");
    return { key, name: key, fileCount: Number(files), internalEdgeCount: Number(internal), layer: 0, role: "library", confidence: "inferred", evidence: [] };
  });
  const unitEdges = edgeSpecs.map((spec): ArchitectureUnitEdge => {
    const [pair, count] = spec.split("=");
    const [from, to] = pair.split(">");
    // The cycle kind is buildArchitectureUnits' (architectureUnits.test.ts); here it is given.
    return cycles.has(from) && cycles.has(to)
      ? { from, to, fileEdgeCount: Number(count), kind: "cycle", cycleKind: options.cycleKind ?? "runtime" }
      : { from, to, fileEdgeCount: Number(count), kind: "down" };
  });
  const units = { units: unitList, unitEdges, cycles: 0 } as unknown as Pick<ArchitectureUnits, "units" | "unitEdges" | "cycles">;
  const edges = (options.files ?? []).map(([sourceRelative, targetRelative, line, typeOnly, dynamic]) => ({ sourceRelative, targetRelative, line, ...(typeOnly ? { typeOnly } : {}), ...(dynamic ? { dynamic } : {}) }));
  const unitOf = new Map(edges.flatMap((edge) => [edge.sourceRelative, edge.targetRelative]).map((file) => [file, file.split("/")[0]]));
  for (const file of [...(options.deadCode ?? []), ...(options.deadFiles ?? [])]) unitOf.set(file.relativePath, file.relativePath.split("/")[0]);
  return {
    graph: { edges } as AssessmentInput["graph"],
    units,
    unitOf,
    matrix: unitMatrix(units),
    deadCode: options.deadCode ?? [],
    deadFiles: options.deadFiles,
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
      gain: 2,
      effort: 1,
      subject: "a, b import each other: remove or move 1 import(s) (b>a) to layer these 2 units again",
      evidence: ["b/y.ts:7 -> a/w.ts"],
      totalEvidence: 1,
      units: ["a", "b"],
      next: 'graph-it architecture --level units --from "b" --to "a"',
    })]);
    expect(result.matrixFindings).toEqual([]);
  });

  it("lists every unit cycle, an expensive cut too", () => {
    const result = assessArchitecture(input(["a:1:0", "b:1:0"], ["a>b=3", "b>a=3"], { cycles: ["a", "b"] }));
    expect(result.quickWins).toEqual([expect.objectContaining({ kind: "cycle-break", gain: 2, effort: 3 })]);
  });

  it("reports each mutual file import once, and no self import", () => {
    const result = assessArchitecture(input(["c:3:3"], [], {
      files: [["c/m1.ts", "c/m2.ts", 1], ["c/m2.ts", "c/m1.ts", 5], ["c/m1.ts", "c/m2.ts", 1], ["c/self.ts", "c/self.ts", 1], ["c/m1.ts", "c/other.ts", 2]],
    }));
    expect(result.quickWins).toEqual([expect.objectContaining({
      kind: "mutual-import",
      gain: 1,
      effort: 1,
      evidence: ["c/m1.ts:1 -> c/m2.ts", "c/m2.ts:5 -> c/m1.ts"],
      units: ["c"],
      next: 'graph-it cycles "c/m1.ts"',
    })]);
    expect(result.totals.mutualImports).toBe(1);
    expect(result.totals.mutualHotSpot).toBeUndefined();
  });

  it("groups the mutual imports of a hot spot file into one item", () => {
    const result = assessArchitecture(input(["c:6:6"], [], {
      files: [
        ["c/hub.ts", "c/a.ts", 1], ["c/a.ts", "c/hub.ts", 2], ["c/b.ts", "c/hub.ts", 3], ["c/hub.ts", "c/b.ts", 4],
        ["c/hub.ts", "c/d.ts", 5], ["c/d.ts", "c/hub.ts", 6], ["c/x.ts", "c/y.ts", 7], ["c/y.ts", "c/x.ts", 8],
      ],
    }));
    expect(result.quickWins.map((win) => [win.subject, win.gain, win.effort, win.totalEvidence, win.next])).toEqual([
      // gain: runtime file cycles broken; effort: one file to edit, the hub.
      ["c/hub.ts and 3 files import each other (c/a.ts, c/b.ts, c/d.ts): remove or move one import of each pair", 3, 1, 6, 'graph-it cycles "c/hub.ts"'],
      ["c/x.ts and c/y.ts import each other: remove or move one import", 1, 1, 2, 'graph-it cycles "c/x.ts"'],
    ]);
    expect(result.totals).toMatchObject({ mutualImports: 4, mutualHotSpot: { file: "c/hub.ts", pairs: 3 } });
  });

  it("lists weak unit dependencies up to the threshold, with their import lines", () => {
    const result = assessArchitecture(input(["app:1:0", "core:1:0", "ui:1:0"], [`app>core=${ASSESSMENT_THRESHOLDS.cheapPairs}`, `app>ui=${ASSESSMENT_THRESHOLDS.cheapPairs + 1}`], {
      files: [["app/a.ts", "core/c.ts"], ["app/b.ts", "core/c.ts", 9]],
    }));
    const weak = result.quickWins.filter((win) => win.kind === "weak-dependency");
    expect(weak).toEqual([expect.objectContaining({ gain: 1, effort: 2, evidence: ["app/a.ts -> core/c.ts", "app/b.ts:9 -> core/c.ts"], units: ["app", "core"] })]);
  });

  it("flags unreferenced dead-code files first and caps the evidence", () => {
    const symbols = Array.from({ length: ASSESSMENT_THRESHOLDS.evidence + 2 }, (_, index) => ({ name: `s${index}`, line: index + 1 }));
    const result = assessArchitecture(input(["core:2:1"], [], {
      files: [["core/used.ts", "core/big.ts", 1]],
      deadCode: [{ relativePath: "core/big.ts", unusedSymbols: symbols }, { relativePath: "core/orphan.ts", unusedSymbols: [{ name: "x", line: 3 }] }, { relativePath: "core/clean.ts", unusedSymbols: [] }],
    }));
    expect(result.quickWins.map((win) => [win.gain, win.effort, win.subject])).toEqual([
      [1, 0, "core/orphan.ts: 1 unused export(s); no file imports it"],
      [7, 1, "core/big.ts: 7 unused export(s)"],
    ]);
    expect(result.quickWins[1]).toMatchObject({ evidence: symbols.slice(0, 5).map((s) => `core/big.ts:${s.line} ${s.name}`), totalEvidence: 7, next: 'graph-it check "core/big.ts"' });
    expect(result.totals).toMatchObject({ deadCodeFiles: 2, unusedExports: 8 });
  });

  // #742: gain = lines of the unused declarations, effort = files to edit (0 when nothing imports the file).
  const legacy: DeadFile = { relativePath: "lib/legacy.ts", lines: 300, exports: 1, confidence: "low", reasons: ["no-importer"] };
  const oneLiners = Array.from({ length: 5 }, (_, index) => ({ name: `h${index}`, line: index + 1, endLine: index + 1 }));

  // #758: the Dead files entry deletes the whole file; a dead-code lead on it would count it twice.
  it("never gives a dead-code lead for a dead file, imported by tests only or by nothing", () => {
    const testOnly: DeadFile = { relativePath: "lib/tested.ts", lines: 40, exports: 2, confidence: "medium", reasons: ["test-only-use"] };
    const result = assessArchitecture(input(["app:1:0", "lib:3:0"], [], {
      files: [["app/main.ts", "lib/helpers.ts", 1], ["tests/tested.test.ts", "lib/tested.ts", 1]],
      deadCode: [
        { relativePath: "lib/helpers.ts", unusedSymbols: oneLiners },
        { relativePath: "lib/legacy.ts", unusedSymbols: [{ name: "run", line: 1, endLine: 3 }] },
        { relativePath: "lib/tested.ts", unusedSymbols: [{ name: "a", line: 1 }, { name: "b", line: 9 }] },
      ],
      deadFiles: [legacy, testOnly],
    }));
    expect(result.quickWins.map((win) => [win.subject, win.gain, win.effort])).toEqual([["lib/helpers.ts: 5 unused export(s)", 5, 1]]);
    expect(result.deadFiles.flatMap((group) => group.files.map((file) => file.relativePath))).toEqual(["lib/legacy.ts", "lib/tested.ts"]);
    expect(result.totals).toMatchObject({ deadFiles: 2, deadCodeFiles: 1, unusedExports: 5 });
  });

  it("counts the lines of the unused declarations of an imported file, one when the end is unknown or before the start", () => {
    const result = assessArchitecture(input(["app:1:0", "lib:2:0"], [], {
      files: [["app/main.ts", "lib/big.ts", 1], ["app/main.ts", "lib/helpers.ts", 2]],
      deadCode: [
        { relativePath: "lib/helpers.ts", unusedSymbols: oneLiners },
        { relativePath: "lib/big.ts", unusedSymbols: [{ name: "Big", line: 10, endLine: 49 }, { name: "noEnd", line: 60 }, { name: "bad", line: 70, endLine: 65 }] },
      ],
    }));
    expect(result.quickWins.map((win) => `${win.subject.split(":")[0]}:${win.gain}/${win.effort}`)).toEqual(["lib/big.ts:42/1", "lib/helpers.ts:5/1"]);
  });

  it("breaks an effort-0 tie by gain for files nothing imports that are not dead files (entry points)", () => {
    const result = assessArchitecture(input(["lib:2:0"], [], {
      deadCode: [{ relativePath: "lib/unread.ts", unusedSymbols: [{ name: "u", line: 1, endLine: 20 }] }, { relativePath: "lib/legacy.ts", unusedSymbols: [{ name: "run", line: 1 }] }],
    }));
    expect(result.quickWins.map((win) => `${win.subject.split(":")[0]}:${win.gain}/${win.effort}`)).toEqual(["lib/unread.ts:20/0", "lib/legacy.ts:1/0"]);
  });

  it("leaves out a focused dead file's lead too", () => {
    const result = assessArchitecture(input(["lib:2:0"], [], {
      deadCode: [{ relativePath: "lib/legacy.ts", unusedSymbols: [{ name: "run", line: 1 }] }, { relativePath: "lib/other.ts", unusedSymbols: [{ name: "o", line: 1 }] }],
      deadFiles: [legacy],
    }), new Set(["lib/legacy.ts"]));
    expect(result.quickWins).toEqual([]);
    expect(result.totals).toMatchObject({ deadFiles: 1, deadCodeFiles: 0, unusedExports: 0 });
  });

  it("orders quick wins by gain / effort, then gain, then kind", () => {
    const result = assessArchitecture(input(["a:1:0", "b:1:0", "c:1:0"], ["a>b=1", "b>a=1", "c>a=2"], {
      cycles: ["a", "b"],
      files: [["a/x.ts", "b/y.ts"], ["b/y.ts", "a/x.ts"]],
      deadCode: [{ relativePath: "c/z.ts", unusedSymbols: [{ name: "z", line: 1 }] }],
    }));
    // dead-code 1/0 (nothing imports c/z.ts), cycle-break 2/1, mutual-import 1/1, then weak-dependency 1/2.
    expect(result.quickWins.map((win) => `${win.kind}:${win.gain}/${win.effort}`)).toEqual(["dead-code:1/0", "cycle-break:2/1", "mutual-import:1/1", "weak-dependency:1/2"]);
  });

  it("breaks an equal gain / effort by gain, then by kind", () => {
    const result = assessArchitecture(input(["a:1:0", "b:1:0", "c:2:0"], ["a>b=1", "b>a=1"], {
      cycles: ["a", "b"],
      files: [["a/x.ts", "b/y.ts"], ["b/y.ts", "a/x.ts"], ["c/hub.ts", "c/p.ts"], ["c/p.ts", "c/hub.ts"], ["c/hub.ts", "c/q.ts"], ["c/q.ts", "c/hub.ts"]],
    }));
    // mutual-import 2/1 and cycle-break 2/1 tie on ratio and gain: kind order; the single pair 1/1 last.
    expect(result.quickWins.map((win) => `${win.kind}:${win.gain}/${win.effort}`)).toEqual(["cycle-break:2/1", "mutual-import:2/1", "mutual-import:1/1"]);
  });
});

describe("assessArchitecture: matrix reading", () => {
  const kinds = (result: ReturnType<typeof assessArchitecture>, kind: string) => result.matrixFindings.filter((finding) => finding.kind === kind);

  it("flags a hub at risk at the Ca and I thresholds only", () => {
    // hub: Ca = 10 (from app), Ce = 10 (to core): I = 0.5.
    const result = assessArchitecture(input(["app:1:0", "core:1:0", "hub:2:1"], ["app>hub=10", "hub>core=10"]));
    expect(kinds(result, "hub-at-risk")).toEqual([expect.objectContaining({ rows: ["hub"], action: expect.stringContaining("10 file pairs from 1 unit(s) import it (Ca), and it depends on others too (I = 0.5)") })]);
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

  it("flags entry rows with the dead files of the unit", () => {
    const result = assessArchitecture(input(["app:1:0", "core:1:0"], ["app>core=3"], {
      deadFiles: [{ relativePath: "app/a.ts", lines: 3, exports: 0, confidence: "low", reasons: ["no-importer"] }],
    }));
    expect(kinds(result, "entry-row")).toEqual([expect.objectContaining({ rows: ["app"], action: expect.stringContaining("(1 dead file(s))") })]);
  });

  it("flags weak cohesion for units of enough files only", () => {
    // C = 1 / (1 + 4) = 0.2 < 0.25; the two-file unit is left out.
    const result = assessArchitecture(input(["big:3:1", "small:2:0", "core:1:0"], ["big>core=4", "small>core=4"]));
    expect(kinds(result, "cohesion")).toEqual([expect.objectContaining({ rows: ["big"], action: expect.stringContaining("C = 1/5") })]);
    expect(kinds(assessArchitecture(input(["big:3:2", "core:1:0"], ["big>core=4"])), "cohesion")).toEqual([]);
  });

  it("still cuts a cycle whose rows show no upward cell", () => {
    const base = input(["a:1:0", "b:1:0"], ["a>b=2", "b>a=1"], { cycles: ["a", "b"] });
    // A malformed matrix: the cycle's cells all below the diagonal; the greedy order ignores the flag.
    const matrix = { ...base.matrix, cells: base.matrix.cells.map((cell) => ({ ...cell, upward: false })) };
    expect(assessArchitecture({ ...base, matrix }).quickWins).toEqual([expect.objectContaining({ kind: "cycle-break", effort: 1 })]);
  });

  it("cuts a large block by its greedy order when neither matrix side is cheap", () => {
    // Ring a > c > b > d > a: the matrix order (a, b, c, d) costs 10 or 6 pairs, the greedy one 1 (d > a).
    const ring = input(["a:1:0", "b:1:0", "c:1:0", "d:1:0"], ["a>c=5", "c>b=5", "b>d=5", "d>a=1"], { cycles: ["a", "b", "c", "d"] });
    expect(cycleCuts(ring.matrix)).toEqual([expect.objectContaining({ pairs: 1, cells: [expect.objectContaining({ fileEdgeCount: 1 })] })]);
    expect(assessArchitecture(ring).quickWins[0]).toMatchObject({ kind: "cycle-break", effort: 1, subject: expect.stringContaining("(d>a)") });
  });

  it("finds nothing in an empty workspace", () => {
    const result = assessArchitecture(input([], []));
    expect(result.quickWins).toEqual([]);
    expect(result.matrixFindings).toEqual([]);
    expect(result.deadFiles).toEqual([]);
    expect(result.totals).toEqual({
      files: 0, units: 0, unitEdges: 0, unitCycles: 0, mutualImports: 0, typeOnlyUnitCycles: 0, typeOnlyMutualImports: 0, lazyUnitCycles: 0, lazyMutualImports: 0, acceptedViolations: 0,
      deadFiles: 0, deadFileLines: 0, deadCodeFiles: 0, unusedExports: 0, unusedExportsMedium: 0, unusedExportsMediumByReason: {}, unusedExportsLow: 0,
    });
    expect(Object.keys(result.glossary)).toEqual(expect.arrayContaining(["Ca", "Ce", "I", "C", "cut"]));
  });
});

describe("assessArchitecture: dead files", () => {
  const dead = (relativePath: string, lines?: number): DeadFile => ({ relativePath, ...(lines === undefined ? {} : { lines }), exports: 0, confidence: "low", reasons: ["no-importer"] });

  it("groups dead files by unit, most lines first, an unread file last", () => {
    const base = input(["a:3:0", "b:1:0"], [], { deadFiles: [dead("a/small.ts", 5), dead("a/unread.ts"), dead("b/big.ts", 40), dead("a/large.ts", 30)] });
    const result = assessArchitecture(base);
    expect(result.deadFiles.map((group) => [group.unit, group.lines, group.files.map((file) => file.relativePath)])).toEqual([
      ["b", 40, ["b/big.ts"]],
      ["a", 35, ["a/large.ts", "a/small.ts", "a/unread.ts"]],
    ]);
    expect(result.totals).toMatchObject({ deadFiles: 4, deadFileLines: 75 });
  });

  it("puts the cascade files after the others and counts each test to delete once (#726)", () => {
    const shared = { relativePath: "tests/u.test.ts", lines: 7 };
    const deadFiles: DeadFile[] = [
      { ...dead("a/cascade.ts", 90), reasons: ["cascade"], via: ["a/root.ts"], tests: [shared, { relativePath: "tests/unread.test.ts" }] },
      { ...dead("a/root.ts", 10), tests: [shared] },
    ];
    const result = assessArchitecture(input(["a:2:0"], [], { deadFiles }));
    expect(result.deadFiles.map((group) => [group.lines, group.files.map((file) => file.relativePath)])).toEqual([[107, ["a/root.ts", "a/cascade.ts"]]]);
    // a test shared by two units counts once in the total
    const twoUnits = assessArchitecture(input(["a:1:0", "b:1:0"], [], { deadFiles: [{ ...dead("a/x.ts", 1), tests: [shared] }, { ...dead("b/y.ts", 2), tests: [shared] }] }));
    expect(twoUnits.totals.deadFileLines).toBe(10);
  });

  it("puts a file outside every unit under the root unit", () => {
    const base = input([], []);
    const result = assessArchitecture({ ...base, deadFiles: [dead("script.ts", 2)] });
    expect(result.deadFiles).toEqual([{ unit: "(root)", lines: 2, files: [expect.objectContaining({ relativePath: "script.ts" })] }]);
  });
});

describe("assessArchitecture: focus", () => {
  // a ⇄ b in a unit cycle, c imports a once (weak), d stands apart with its own mutual import.
  const workspace = () => input(["a:3:1", "b:2:1", "c:1:0", "d:2:2"], ["a>b=1", "b>a=1", "c>a=1", "c>d=2"], {
    cycles: ["a", "b"],
    files: [
      ["a/x.ts", "b/y.ts", 1], ["b/y.ts", "a/w.ts", 2], ["a/x.ts", "a/v.ts", 3], ["a/v.ts", "a/x.ts", 4],
      ["c/m.ts", "a/x.ts", 5], ["c/m.ts", "d/p.ts", 6], ["c/m.ts", "d/q.ts", 7], ["d/p.ts", "d/q.ts", 8], ["d/q.ts", "d/p.ts", 9],
    ],
    deadCode: [{ relativePath: "a/v.ts", unusedSymbols: [{ name: "v", line: 1 }] }, { relativePath: "d/p.ts", unusedSymbols: [{ name: "p", line: 1 }] }],
    deadFiles: [
      { relativePath: "a/old.ts", lines: 4, exports: 1, confidence: "low", reasons: ["no-importer"] },
      { relativePath: "d/old.ts", lines: 9, exports: 1, confidence: "low", reasons: ["no-importer"] },
    ],
  });

  it("keeps only what touches the focus files and their direct neighbours, totals included", () => {
    const result = assessArchitecture(workspace(), new Set(["a/x.ts", "a/v.ts", "a/w.ts", "a/old.ts"]));
    expect(result.quickWins.map((win) => `${win.kind} ${win.units.join(",")}`).toSorted()).toEqual([
      "cycle-break a,b", "dead-code a", "mutual-import a", "weak-dependency c,a",
    ]);
    expect(result.deadFiles.map((group) => group.unit)).toEqual(["a"]);
    // Neighbour rows only: d has no file pair with a.
    expect(result.matrixFindings.flatMap((finding) => finding.rows)).not.toContain("d");
    expect(result.totals).toMatchObject({ files: 4, units: 3, unitEdges: 3, unitCycles: 1, mutualImports: 1, deadFiles: 1, deadFileLines: 4, deadCodeFiles: 1, unusedExports: 1 });
  });

  it("keeps the unit cycle of a folder whose files are not in its cut", () => {
    const result = assessArchitecture(workspace(), new Set(["a/v.ts"]));
    expect(result.quickWins.map((win) => win.kind)).toContain("cycle-break");
    expect(result.quickWins.map((win) => win.kind)).not.toContain("weak-dependency");
  });

  it("lists a dead file that imports the focus, nothing imports a dead file", () => {
    const base = workspace();
    const focused = assessArchitecture({ ...base, graph: { edges: [...base.graph.edges, { sourceRelative: "d/old.ts", targetRelative: "a/x.ts", line: 1 }] } }, new Set(["a/x.ts"]));
    expect(focused.deadFiles.map((group) => group.unit)).toEqual(["d"]);
  });

  it("reports an empty focus with zero totals and no item", () => {
    const result = assessArchitecture(workspace(), new Set(["e/alone.ts"]));
    expect(result.quickWins).toEqual([]);
    expect(result.deadFiles).toEqual([]);
    expect(result.matrixFindings).toEqual([]);
    expect(result.totals).toMatchObject({ files: 1, units: 0, unitEdges: 0, unitCycles: 0, mutualImports: 0, deadFiles: 0, unusedExports: 0 });
  });

  it("keeps the whole workspace without a focus", () => {
    expect(assessArchitecture(workspace())).toEqual(assessArchitecture(workspace(), undefined));
    expect(assessArchitecture(workspace()).totals).toMatchObject({ files: 9, units: 4, unitEdges: 4, mutualImports: 2, deadFiles: 2 });
  });
});

describe("assessArchitecture: type-only cycles (#740)", () => {
  it("computes the hot spot on runtime pairs only, and groups the type-only pairs", () => {
    const result = assessArchitecture(input(["c:6:6"], [], {
      files: [
        // h is in three type-only pairs: no hot spot for it.
        ["c/h.ts", "c/x.ts", 1, true], ["c/x.ts", "c/h.ts", 1, true],
        ["c/h.ts", "c/y.ts", 2, true], ["c/y.ts", "c/h.ts", 1, true],
        ["c/h.ts", "c/z.ts", 3, true], ["c/z.ts", "c/h.ts", 1, true],
        // p is in two runtime pairs, one of them with a single runtime import.
        ["c/p.ts", "c/q.ts", 1], ["c/q.ts", "c/p.ts", 1, true],
        ["c/p.ts", "c/r.ts", 2], ["c/r.ts", "c/p.ts", 1],
      ],
    }));
    expect(result.totals).toMatchObject({ mutualImports: 2, typeOnlyMutualImports: 3, mutualHotSpot: { file: "c/p.ts", pairs: 2 } });
    expect(result.quickWins.map((win) => win.subject)).toEqual(["c/p.ts and 2 files import each other (c/q.ts, c/r.ts): remove or move one import of each pair"]);
    expect(result.typeOnlyCycles).toEqual({
      unitCycles: 0, mutualImports: 3, evidence: ["c/h.ts <-> c/x.ts", "c/h.ts <-> c/y.ts", "c/h.ts <-> c/z.ts"], totalEvidence: 3, units: ["c"],
    });
  });

  it("lists a type-only unit cycle apart and ranks a runtime one", () => {
    const cycle = (typeOnly: boolean) => input(["a:2:0", "b:2:0"], ["a>b=2", "b>a=1"], {
      cycles: ["a", "b"],
      cycleKind: typeOnly ? "type-only" : "runtime",
      files: [["a/x.ts", "b/y.ts", 1, true], ["a/w.ts", "b/y.ts", 2, typeOnly], ["b/y.ts", "a/x.ts", 3, true]],
    });
    const typeOnly = { ...cycle(true), units: { ...cycle(true).units, cycles: 1 } };
    expect(assessArchitecture(typeOnly).quickWins).toEqual([]);
    expect(assessArchitecture(typeOnly).totals).toMatchObject({ unitCycles: 0, typeOnlyUnitCycles: 1 });
    expect(assessArchitecture(typeOnly).typeOnlyCycles.evidence).toEqual(["a/x.ts <-> b/y.ts", "units a, b"]);
    const runtime = { ...cycle(false), units: { ...cycle(false).units, cycles: 1 } };
    expect(assessArchitecture(runtime).quickWins.map((win) => win.kind)).toEqual(["cycle-break"]);
    expect(assessArchitecture(runtime).totals).toMatchObject({ unitCycles: 1, typeOnlyUnitCycles: 0 });
  });

  it("keeps only the type-only pairs a focus touches", () => {
    const result = assessArchitecture(input(["c:4:4"], [], {
      files: [["c/a.ts", "c/b.ts", 1, true], ["c/b.ts", "c/a.ts", 1, true], ["c/m.ts", "c/n.ts", 1, true], ["c/n.ts", "c/m.ts", 1, true]],
    }), new Set(["c/a.ts"]));
    expect(result.totals).toMatchObject({ mutualImports: 0, typeOnlyMutualImports: 1 });
    expect(result.typeOnlyCycles.evidence).toEqual(["c/a.ts <-> c/b.ts"]);
  });
});

describe("assessArchitecture: lazy cycles (#741)", () => {
  const withCycles = (spec: AssessmentInput, cycles: number) => ({ ...spec, units: { ...spec.units, cycles } });

  it("lists a lazy unit cycle apart and ranks a runtime one", () => {
    // a -> b -> c -> a, the closing pair lazy; a second, static c -> a pair keeps it runtime.
    const cycle = (staticBack: boolean) => withCycles(input(["a:2:0", "b:1:0", "c:1:0"], ["a>b=1", "b>c=1", "c>a=" + (staticBack ? 2 : 1)], {
      cycles: ["a", "b", "c"],
      cycleKind: staticBack ? "runtime" : "lazy",
      files: [["a/x.ts", "b/y.ts", 1], ["b/y.ts", "c/z.ts", 1], ["c/z.ts", "a/x.ts", 1, false, true], ...(staticBack ? [["c/z.ts", "a/w.ts", 2] as [string, string, number]] : [])],
    }), 1);
    expect(assessArchitecture(cycle(false)).totals).toMatchObject({ unitCycles: 0, lazyUnitCycles: 1, typeOnlyUnitCycles: 0 });
    expect(assessArchitecture(cycle(false)).lazyCycles.evidence).toEqual(["units a, b, c"]);
    expect(assessArchitecture(cycle(false)).quickWins).toEqual([]);
    expect(assessArchitecture(cycle(true)).totals).toMatchObject({ unitCycles: 1, lazyUnitCycles: 0 });
    expect(assessArchitecture(cycle(true)).quickWins.map((win) => win.kind)).toEqual(["cycle-break"]);
  });

  it("keeps a cycle runtime when a static cycle remains inside it beside a lazy pair", () => {
    // a <-> b static, b -> c and c -> a lazy: the block of three still holds the static a <-> b cycle.
    const result = assessArchitecture(withCycles(input(["a:1:0", "b:1:0", "c:1:0"], ["a>b=1", "b>a=1", "b>c=1", "c>a=1"], {
      cycles: ["a", "b", "c"],
      files: [["a/x.ts", "b/y.ts", 1], ["b/y.ts", "a/x.ts", 1], ["b/y.ts", "c/z.ts", 2, false, true], ["c/z.ts", "a/x.ts", 1, false, true]],
    }), 1));
    expect(result.totals).toMatchObject({ unitCycles: 1, lazyUnitCycles: 0, mutualImports: 1, lazyMutualImports: 0 });
  });

  it("calls a mutual pair lazy when one import is import(), type-only beside import() included, and keeps it out of the hot spot", () => {
    const result = assessArchitecture(input(["c:5:5"], [], {
      files: [
        ["c/r.ts", "c/p.ts", 1, false, true], ["c/p.ts", "c/r.ts", 1],
        ["c/r.ts", "c/q.ts", 2, false, true], ["c/q.ts", "c/r.ts", 1, true],
        ["c/s.ts", "c/t.ts", 1], ["c/t.ts", "c/s.ts", 1],
      ],
    }));
    expect(result.totals).toMatchObject({ mutualImports: 1, lazyMutualImports: 2, typeOnlyMutualImports: 0 });
    expect(result.totals.mutualHotSpot).toBeUndefined();
    expect(result.lazyCycles).toEqual({ unitCycles: 0, mutualImports: 2, evidence: ["c/p.ts <-> c/r.ts", "c/q.ts <-> c/r.ts"], totalEvidence: 2, units: ["c"] });
    expect(result.quickWins.map((win) => win.subject)).toEqual([expect.stringContaining("c/s.ts")]);
  });
});
