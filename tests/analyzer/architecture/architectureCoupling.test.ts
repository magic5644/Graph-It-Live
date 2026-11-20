import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exploreCoupling } from "@/analyzer/architecture/ArchitectureExplorer";
import { buildArchitectureGraph } from "@/analyzer/architecture/ArchitectureGraphBuilder";
import { architectureCoupling } from "@/analyzer/architecture/architectureCoupling";
import { groupLevel } from "@/analyzer/architecture/architectureMatrix";
import { SpiderBuilder } from "@/analyzer/SpiderBuilder";
import { COUPLING_ROWS, couplingView, renderArchitectureView } from "@/cli/commands/architectureTables";
import { LINK_CELLS, linksCell, renderToolMarkdown } from "@/mcp/markdownViews";

const rows = [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }];
const edge = (source: string, target: string) => ({ sourceRelative: source, targetRelative: target });
/** Files are named after their row: "a/x.ts" sits in row "a". */
const rowOf = (file: string) => (["a", "b", "c", "d"].includes(file.split("/")[0]) ? file.split("/")[0] : undefined);

describe("architectureCoupling", () => {
  it("pairs rows both ways, heaviest first, with the first evidence pairs by path", () => {
    const { coupledPairs } = architectureCoupling(rows, [
      edge("b/2.ts", "a/1.ts"), edge("a/1.ts", "b/1.ts"), edge("a/2.ts", "b/1.ts"), edge("a/3.ts", "b/9.ts"),
      edge("c/1.ts", "a/1.ts"),
    ], rowOf);
    expect(coupledPairs).toEqual([
      {
        a: "a", b: "b", aLabel: "A", bLabel: "B", aToB: 3, bToA: 1, fileEdgeCount: 4, mutual: true,
        evidence: [{ source: "a/1.ts", target: "b/1.ts" }, { source: "a/2.ts", target: "b/1.ts" }, { source: "a/3.ts", target: "b/9.ts" }],
      },
      { a: "a", b: "c", aLabel: "A", bLabel: "C", aToB: 0, bToA: 1, fileEdgeCount: 1, mutual: false, evidence: [{ source: "c/1.ts", target: "a/1.ts" }] },
    ]);
  });

  it("breaks weight ties by row order, whatever the edge order", () => {
    const edges = [edge("b/1.ts", "c/1.ts"), edge("a/1.ts", "c/1.ts"), edge("a/1.ts", "b/1.ts")];
    const forward = architectureCoupling(rows, edges, rowOf);
    expect(forward.coupledPairs.map((pair) => `${pair.a}-${pair.b}`)).toEqual(["a-b", "a-c", "b-c"]);
    expect(architectureCoupling(rows, edges.toReversed(), rowOf)).toEqual(forward);
  });

  it("lists a file touching two other rows as a bridge, not a file touching one", () => {
    const { bridgingFiles } = architectureCoupling(rows, [
      edge("a/hub.ts", "b/1.ts"), edge("c/1.ts", "a/hub.ts"), edge("c/2.ts", "a/hub.ts"),
      edge("a/one.ts", "b/1.ts"), edge("a/one.ts", "b/2.ts"),
    ], rowOf);
    // b/1.ts is imported from a only: one other row.
    expect(bridgingFiles).toEqual([{
      file: "a/hub.ts", group: "a", groupLabel: "A", groupCount: 2, fileEdgeCount: 3,
      links: [
        { group: "b", label: "B", imports: 1, importedBy: 0, evidence: [{ source: "a/hub.ts", target: "b/1.ts" }] },
        { group: "c", label: "C", imports: 0, importedBy: 2, evidence: [{ source: "c/1.ts", target: "a/hub.ts" }, { source: "c/2.ts", target: "a/hub.ts" }] },
      ],
    }]);
  });

  it("orders bridges by rows touched, then pairs, then path", () => {
    const { bridgingFiles } = architectureCoupling([...rows, { id: "d", label: "D" }], [
      edge("a/w.ts", "b/1.ts"), edge("a/w.ts", "c/1.ts"), edge("a/w.ts", "d/1.ts"),
      edge("a/z.ts", "b/1.ts"), edge("a/z.ts", "c/1.ts"),
      edge("a/y.ts", "b/1.ts"), edge("a/y.ts", "c/1.ts"), edge("a/y.ts", "c/2.ts"),
      edge("a/x.ts", "b/1.ts"), edge("a/x.ts", "c/1.ts"),
    ], rowOf);
    expect(bridgingFiles.map((file) => file.file)).toEqual(["a/w.ts", "a/y.ts", "a/x.ts", "a/z.ts"]);
  });

  it("ignores pairs inside one row and files outside the level, and is empty without crossing pairs", () => {
    const coupling = architectureCoupling(rows, [edge("a/1.ts", "a/2.ts"), edge("a/1.ts", "outside/x.ts"), edge("z/1.ts", "b/1.ts")], rowOf);
    expect(coupling).toMatchObject({ coupledPairs: [], bridgingFiles: [] });
    expect(coupling.formulas.coupledPair).toContain("aToB + bToA");
    expect(renderArchitectureView(couplingView("groups", coupling), "text")).toContain("0 coupled pair(s), 0 bridging file(s).");
    expect(renderToolMarkdown("explore_architecture", { view: "coupling", ...coupling })).toContain("_No file pair crosses two rows of this level._");
  });

  it("caps the text tables at COUPLING_ROWS rows and a links cell at LINK_CELLS links, and says so", () => {
    const many = Array.from({ length: COUPLING_ROWS + 1 }, (_, index) => ({ id: `r${index}`, label: `R${index}` }));
    // r0/hub.ts imports every other row: 50 pairs and one bridging file with 50 links.
    const coupling = architectureCoupling(many, many.slice(1).map((row) => edge("r0/hub.ts", `${row.id}/x.ts`)), (file) => file.split("/")[0]);
    const text = renderArchitectureView(couplingView("groups", coupling), "text");
    expect(text).not.toContain("Showing the first");
    expect(text).toContain(`+${COUPLING_ROWS - LINK_CELLS} more`);
    const more = architectureCoupling(many, [...many.slice(1).map((row) => edge("r0/hub.ts", `${row.id}/x.ts`)), edge("r1/x.ts", "r2/x.ts")], (file) => file.split("/")[0]);
    const cut = renderArchitectureView(couplingView("groups", more), "markdown");
    expect(cut).toContain(`Showing the first ${COUPLING_ROWS} pair(s) and 3 file(s); --format json or toon lists them all.`);
    expect(cut.split("\n").filter((line) => line.startsWith("| R"))).toHaveLength(COUPLING_ROWS);
    expect(linksCell(coupling.bridgingFiles[0].links.slice(0, LINK_CELLS))).not.toContain("more");
  });

  it("pairs and bridges the unassigned row (id 0) like any other", () => {
    const groups = [{ id: 1, label: "api" }, { id: 2, label: "db" }, { id: 0, label: "unassigned" }];
    const groupOf = (file: string) => ({ api: 1, db: 2 } as Record<string, number>)[file.split("/")[0]] ?? 0;
    const { coupledPairs, bridgingFiles } = architectureCoupling(groups, [edge("index.ts", "api/a.ts"), edge("index.ts", "db/b.ts"), edge("api/a.ts", "db/b.ts")], groupOf);
    expect(coupledPairs.map((pair) => [pair.a, pair.b, pair.fileEdgeCount])).toEqual([[1, 2, 1], [1, 0, 1], [2, 0, 1]]);
    expect(bridgingFiles.map((file) => [file.file, file.group, file.groupCount])).toEqual([["api/a.ts", 1, 2], ["db/b.ts", 2, 2], ["index.ts", 0, 2]]);
  });

  it("ignores a row id the rows do not list", () => {
    expect(architectureCoupling(rows.slice(0, 2), [edge("a/1.ts", "c/1.ts")], rowOf).coupledPairs).toEqual([]);
  });
});

describe("exploreCoupling", () => {
  const coupling = architectureCoupling(rows, [edge("a/1.ts", "b/1.ts"), edge("a/1.ts", "c/1.ts"), edge("b/1.ts", "c/1.ts")], rowOf);
  const context = { revision: "r1" } as never;

  it("pages both lists together and keeps their totals", () => {
    const first = exploreCoupling(coupling, context, { limit: 2 });
    expect(first).toMatchObject({
      view: "coupling",
      page: { offset: 0, limit: 2, totalCoupledPairs: 3, totalBridgingFiles: 3, truncated: true, nextOffset: 2 },
    });
    expect(first.coupledPairs).toHaveLength(2);
    const last = exploreCoupling(coupling, context, { limit: 2, offset: 2 });
    expect(last.page).toMatchObject({ truncated: false, nextOffset: undefined });
    expect([...first.coupledPairs, ...last.coupledPairs]).toEqual(coupling.coupledPairs);
  });

  it("keeps paging while one list is longer than the other", () => {
    const one = architectureCoupling(rows, [edge("a/1.ts", "b/1.ts"), edge("a/1.ts", "c/1.ts"), edge("b/2.ts", "c/2.ts")], rowOf);
    expect(one.bridgingFiles).toHaveLength(1);
    const first = exploreCoupling(one, context, { limit: 2 });
    expect(first.page).toMatchObject({ totalCoupledPairs: 3, totalBridgingFiles: 1, truncated: true, nextOffset: 2 });
    const next = exploreCoupling(one, context, { limit: 2, offset: 2 });
    expect(next).toMatchObject({ bridgingFiles: [], page: { truncated: false } });
    expect(next.coupledPairs).toHaveLength(1);
  });

  it("names the unit provenance and rejects a stale revision or an offset past the end", () => {
    expect(exploreCoupling(coupling, context, { units: true }).provenance.grouping).toContain("Units are project folders");
    expect(() => exploreCoupling(coupling, context, { revision: "r0" })).toThrow("Architecture changed (revision r0 -> r1)");
    expect(() => exploreCoupling(coupling, context, { offset: 9 })).toThrow("coupled pairs and bridging files");
  });
});

describe("coupling on a workspace", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  async function level(files: Record<string, string>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-coupling-"));
    roots.push(root);
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    }
    const spider = new SpiderBuilder().withRootDir(root).withExcludeNodeModules(true).build();
    const groups = groupLevel(await buildArchitectureGraph(root, (file) => spider.analyze(file)));
    return { matrix: groups.matrix, coupling: architectureCoupling(groups.matrix.rows, groups.edges, groups.rowOf) };
  }
  const keys = (labels: string[]) => labels.map((label) => label.split("/").at(-1) ?? "").sort((left, right) => left.localeCompare(right));

  it("finds the group cycle and its mutual pair on a cyclic workspace", async () => {
    const { matrix, coupling } = await level({
      "api/handler.ts": 'import { save } from "../db/store";\nexport const handle = () => save();\n',
      "db/store.ts": 'import { log } from "../api/logger";\nexport const save = () => log();\n',
      "api/logger.ts": "export const log = () => 1;\n",
    });
    expect(matrix.cycles).toHaveLength(1);
    expect(keys(matrix.cycles[0].members)).toEqual(["api", "db"]);
    expect(coupling.coupledPairs).toHaveLength(1);
    expect(coupling.coupledPairs[0]).toMatchObject({ aToB: 1, bToA: 1, fileEdgeCount: 2, mutual: true });
  });

  it("finds no group cycle on an acyclic workspace, and the shared file bridging its importers", async () => {
    const { matrix, coupling } = await level({
      "web/page.ts": 'import { fmt } from "../shared/format";\nexport const page = () => fmt();\n',
      "cli/main.ts": 'import { fmt } from "../shared/format";\nexport const main = () => fmt();\n',
      "shared/format.ts": "export const fmt = () => 1;\n",
    });
    expect(matrix.cycles).toEqual([]);
    expect(coupling.coupledPairs.every((pair) => !pair.mutual)).toBe(true);
    expect(coupling.coupledPairs.map((pair) => pair.fileEdgeCount)).toEqual([1, 1]);
    expect(coupling.bridgingFiles).toHaveLength(1);
    expect(coupling.bridgingFiles[0]).toMatchObject({ file: "shared/format.ts", groupCount: 2, fileEdgeCount: 2 });
  });
});
