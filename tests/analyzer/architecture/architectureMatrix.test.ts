import { describe, expect, it } from "vitest";
import { exploreMatrix } from "@/analyzer/architecture/ArchitectureExplorer";
import type { ArchitectureGraph } from "@/analyzer/architecture/ArchitectureGraphBuilder";
import { buildMatrix, groupMatrix, matrixDigest, matrixToCsv, unitMatrix, type MatrixNode } from "@/analyzer/architecture/architectureMatrix";

const node = (id: string, internalEdgeCount = 0): MatrixNode<string> => ({ id, key: id, label: id, internalEdgeCount });
const edge = (from: string, to: string, fileEdgeCount = 1) => ({ from, to, fileEdgeCount });
const order = (matrix: { rows: { key: string }[] }) => matrix.rows.map((row) => row.key);

describe("buildMatrix", () => {
  it("puts a layered architecture below the diagonal: dependencies first, ties by name", () => {
    // app → (ui, api) → core; tools → core.
    const nodes = ["ui", "core", "app", "api", "tools"].map((id) => node(id));
    const edges = [edge("app", "ui"), edge("app", "api", 3), edge("ui", "core"), edge("api", "core", 2), edge("tools", "core")];
    const matrix = buildMatrix(nodes, edges);

    expect(order(matrix)).toEqual(["core", "api", "tools", "ui", "app"]);
    expect(matrix.rows.map((row) => row.layer)).toEqual([0, 1, 1, 1, 2]);
    expect(matrix.cells.every((cell) => cell.column < cell.row)).toBe(true);
    expect(matrix.totals).toEqual({ rows: 5, cells: 5, fileEdges: 8, intraEdges: 0, interEdges: 8, upwardCells: 0 });
    expect(matrix.cycles).toEqual([]);
  });

  it("gives the same order whatever the input order", () => {
    const nodes = ["b", "a", "d", "c"].map((id) => node(id));
    const edges = [edge("a", "c"), edge("b", "c"), edge("d", "a")];
    const reference = order(buildMatrix(nodes, edges));
    expect(order(buildMatrix(nodes.toReversed(), edges.toReversed()))).toEqual(reference);
    expect(reference).toEqual(["c", "a", "b", "d"]);
  });

  it("keeps a cycle's rows together and flags its cells above the diagonal", () => {
    // x ↔ z form a cycle above base; y shares their layer, and the cycle ranks at its first member x, so y comes after z.
    const nodes = ["z", "y", "x", "base"].map((id) => node(id, id === "x" ? 2 : 0));
    const edges = [edge("x", "z"), edge("z", "x", 4), edge("x", "base"), edge("z", "base"), edge("y", "base")];
    const matrix = buildMatrix(nodes, edges);

    expect(order(matrix)).toEqual(["base", "x", "z", "y"]);
    expect(matrix.cycles).toEqual([{ firstRow: 1, lastRow: 2, members: ["x", "z"] }]);
    expect(matrix.rows.map((row) => row.cycle)).toEqual([undefined, 0, 0, undefined]);
    const upward = matrix.cells.filter((cell) => cell.upward);
    expect(upward).toEqual([{ row: 1, column: 2, fileEdgeCount: 1, upward: true }]);
    expect(matrix.cells).toContainEqual({ row: 2, column: 1, fileEdgeCount: 4, upward: false });
    expect(matrix.cells).toContainEqual({ row: 1, column: 1, fileEdgeCount: 2, upward: false });
    expect(matrix.totals.upwardCells).toBe(1);
  });

  it("computes Ce, Ca and I on the pairs between rows, the diagonal excluded", () => {
    const matrix = buildMatrix([node("a", 5), node("b"), node("c"), node("lonely", 1)], [edge("a", "b", 3), edge("c", "b"), edge("a", "c")]);
    const row = (key: string) => matrix.rows.find((entry) => entry.key === key)!;
    expect(row("a")).toMatchObject({ outgoingPairs: 4, outgoingGroups: 2, incomingPairs: 0, incomingGroups: 0, instability: 1 });
    expect(row("b")).toMatchObject({ outgoingPairs: 0, incomingPairs: 4, incomingGroups: 2, instability: 0 });
    expect(row("c")).toMatchObject({ outgoingPairs: 1, incomingPairs: 1, instability: 0.5 });
    expect(row("lonely")).toMatchObject({ outgoingPairs: 0, incomingPairs: 0, instability: null });
    expect(matrix.formulas.instability).toContain("I = Ce / (Ca + Ce)");
  });

  it("ignores self edges, zero counts and edges to unknown rows", () => {
    const matrix = buildMatrix([node("a")], [edge("a", "a", 7), edge("a", "ghost"), edge("a", "a", 0)]);
    expect(matrix.cells).toEqual([]);
    // A zero-count edge is no dependency: it neither layers nor closes a cycle.
    const zero = buildMatrix([node("a"), node("b")], [edge("a", "b"), edge("b", "a", 0)]);
    expect(zero.cycles).toEqual([]);
    expect(zero.rows.map((row) => [row.key, row.layer])).toEqual([["b", 0], ["a", 1]]);
    expect(buildMatrix([], []).totals).toEqual({ rows: 0, cells: 0, fileEdges: 0, intraEdges: 0, interEdges: 0, upwardCells: 0 });
  });

  it("rounds instability to 2 decimals", () => {
    const matrix = buildMatrix([node("a"), node("b"), node("c")], [edge("a", "b"), edge("b", "c", 2)]);
    expect(matrix.rows.find((row) => row.key === "b")?.instability).toBe(0.67);
  });
});

describe("groupMatrix and unitMatrix", () => {
  const aggregation = {
    groups: [
      { id: 1, key: "app", label: "app", fileCount: 2, internalEdgeCount: 1 },
      { id: 2, key: "lib", label: "lib", fileCount: 1, internalEdgeCount: 0 },
    ],
    unassigned: { fileCount: 3, internalEdgeCount: 2 },
    groupEdges: [{ from: 1, to: 2, fileEdgeCount: 2 }, { from: 0, to: 1, fileEdgeCount: 1 }],
    totals: { files: 6, fileEdges: 6, intraGroupEdges: 3, interGroupEdges: 3 },
  };

  it("adds the unassigned files as row 0 and adds up to the aggregation totals", () => {
    const matrix = groupMatrix(aggregation);
    expect(matrix.rows.map((row) => [row.id, row.label])).toEqual([[2, "lib"], [1, "app"], [0, "unassigned"]]);
    expect(matrix.totals).toMatchObject({ fileEdges: 6, intraEdges: 3, interEdges: 3 });
  });

  it("keeps only the included groups and the edges between them", () => {
    const matrix = groupMatrix(aggregation, (id) => id !== 0);
    expect(matrix.rows.map((row) => row.id)).toEqual([2, 1]);
    expect(matrix.cells).toEqual([{ row: 1, column: 0, fileEdgeCount: 2, upward: false }, { row: 1, column: 1, fileEdgeCount: 1, upward: false }]);
  });

  it("leaves out an empty unassigned group", () => {
    expect(groupMatrix({ ...aggregation, unassigned: { fileCount: 0, internalEdgeCount: 0 } }).rows).toHaveLength(2);
  });

  it("names unit rows by package name and identifies them by key", () => {
    const matrix = unitMatrix({
      units: [
        { key: "apps/web", name: "@ws/web", fileCount: 2, internalEdgeCount: 1, layer: 1 },
        { key: "packages/core", name: "@ws/core", fileCount: 1, internalEdgeCount: 0, layer: 0 },
      ],
      unitEdges: [{ from: "apps/web", to: "packages/core", fileEdgeCount: 3, kind: "down" }],
    });
    expect(matrix.rows.map((row) => [row.id, row.label])).toEqual([["packages/core", "@ws/core"], ["apps/web", "@ws/web"]]);
    expect(matrix.cells).toContainEqual({ row: 1, column: 0, fileEdgeCount: 3, upward: false });
  });
});

describe("matrixDigest", () => {
  it("lists every non-zero cell by keys, in code-unit order", () => {
    const matrix = buildMatrix([node("b", 1), node("a")], [edge("b", "a", 2)]);
    expect(matrixDigest(matrix)).toBe("b>a=2;b>b=1");
  });
});

describe("matrixToCsv", () => {
  it("writes a dense grid with Ce, Ca and I, quoting and neutralising formulas", () => {
    const matrix = buildMatrix(
      [{ id: 1, key: "a", label: "=cmd()", internalEdgeCount: 1 }, { id: 2, key: "b", label: 'say "hi", there', internalEdgeCount: 0 }],
      [{ from: 1, to: 2, fileEdgeCount: 2 }],
    );
    expect(matrixToCsv(matrix).split("\n")).toEqual([
      `row imports column,"say ""hi"", there",'=cmd(),Ce,Ca,I`,
      `"say ""hi"", there",,,0,2,0`,
      `'=cmd(),2,1,2,0,1`,
      "",
    ]);
  });

  it("neutralises the other formula prefixes and quotes line breaks", () => {
    const labels = ["+1", "-1", "@x", "\tx", "two\nlines"];
    const csv = matrixToCsv(buildMatrix(labels.map((label, id) => ({ id, key: label, label, internalEdgeCount: 0 })), []));
    const header = csv.slice(0, csv.indexOf(",Ce"));
    for (const prefix of ["'+1", "'-1", "'@x", "'\tx", '"two\nlines"']) expect(header).toContain(prefix);
  });
});

describe("exploreMatrix", () => {
  const context = { revision: "a".repeat(64) } as ArchitectureGraph["context"];
  const matrix = buildMatrix(["a", "b", "c"].map((id) => node(id, 1)), [edge("b", "a"), edge("c", "b")]);

  it("pages the cells and keeps rows, cycles and totals whole", () => {
    const page = exploreMatrix(matrix, context, { limit: 2, offset: 2 });
    expect(page).toMatchObject({ view: "matrix", context, totals: matrix.totals, rows: matrix.rows });
    expect(page.cells).toEqual(matrix.cells.slice(2, 4));
    expect(page.page).toEqual({ total: 5, offset: 2, returned: 2, truncated: true, nextOffset: 4 });
    expect(exploreMatrix(matrix, context).page).toMatchObject({ total: 5, returned: 5, truncated: false });
  });

  it("names the units provenance for unit rows", () => {
    expect(exploreMatrix(matrix, context, { units: true }).provenance.grouping).toContain("Units are package folders");
    expect(exploreMatrix(matrix, context).provenance.grouping).toContain("communityMode detector");
  });

  it("rejects an offset from another revision", () => {
    expect(() => exploreMatrix(matrix, context, { revision: "b".repeat(64) })).toThrow("Architecture changed");
  });
});
