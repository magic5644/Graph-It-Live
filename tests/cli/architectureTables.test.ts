import { describe, expect, it } from "vitest";
import { evidenceView, folderView, matrixView, renderArchitectureView, unitsView } from "@/cli/commands/architectureTables";
import { buildMatrix } from "@/analyzer/architecture/architectureMatrix";

const units = {
  units: [
    { key: "app", layer: 1, role: "unknown", fileCount: 2 },
    { key: "core|x", layer: 0, role: "library", fileCount: 1 },
  ],
  unitEdges: [{ from: "app", to: "core|x", fileEdgeCount: 3, kind: "down" }],
  layerCount: 2,
  cycles: 0,
  upwardEdges: 0,
};

describe("architecture table views (#767)", () => {
  it("renders the units as aligned text tables with counts and the next command", () => {
    const text = renderArchitectureView(unitsView(units), "text");
    expect(text).toContain("Units\n  2 unit(s) in 2 layer(s), 0 = depends on no other unit; 0 cycle(s), 0 upward edge(s).");
    expect(text).toContain("graph-it architecture --level units --from <unit> --to <unit>");
    expect(text).toContain("Units:\n  Unit    Layer  Role     Files\n  app     1      unknown  2\n  core|x  0      library  1");
    expect(text).toContain("Unit edges:\n  From  To      File pairs  Kind\n  app   core|x  3           down");
  });

  it("renders markdown tables with escaped pipes, and says none for an empty table", () => {
    const markdown = renderArchitectureView(unitsView({ ...units, unitEdges: [] }), "markdown");
    expect(markdown).toMatch(/^## Units\n/);
    expect(markdown).toContain("| Unit | Layer | Role | Files |\n| --- | --- | --- | --- |\n| app | 1 | unknown | 2 |\n| core\\|x | 0 | library | 1 |");
    expect(markdown).toContain("### Unit edges\n\n_None._");
    expect(renderArchitectureView(unitsView({ ...units, unitEdges: [] }), "text")).toContain("Unit edges: none");
  });

  it("names a folder's groups and edges by key, unassigned and nested groups included", () => {
    const view = folderView("src", [1], {
      groups: [{ id: 1, key: "src/a", label: "a", fileCount: 2, internalEdgeCount: 1 }, { id: 2, key: "src/b", label: "b", fileCount: 1, internalEdgeCount: 0 }],
      unassigned: { fileCount: 1, internalEdgeCount: 0 },
      groupEdges: [{ from: 1, to: 2, fileEdgeCount: 2 }, { from: 0, to: 1, fileEdgeCount: 1 }],
      totals: { files: 4, fileEdges: 4, intraGroupEdges: 1, interGroupEdges: 3 },
    });
    const text = renderArchitectureView(view, "text");
    expect(text).toContain("Folder src\n  2 group(s), 4 file(s), 3 file pair(s) between groups.");
    expect(text).toContain("Groups with sub-folders: src/a (graph-it architecture --folder <key> opens one).");
    expect(text).toContain("src/a         src/b  2");
    expect(text).toContain("(unassigned)  src/a  1");
  });

  it("lists a unit edge's file pairs, or says there is no edge", () => {
    const pairs = { from: { key: "app" }, to: { key: "core" }, kind: "down", pairs: [{ source: "app/a.ts", target: "core/c.ts" }] };
    expect(renderArchitectureView(evidenceView(pairs), "text")).toContain("Unit edge app → core\n  1 file pair(s), kind down.\n\nFile pairs:\n  Source    Target\n  app/a.ts  core/c.ts");
    expect(renderArchitectureView(evidenceView({ ...pairs, kind: undefined, pairs: [] }), "text")).toContain("No file of the first unit imports the second.");
  });

  it("lists the matrix rows (Ce, Ca, I), the non-zero cells off the diagonal and the cycles", () => {
    const matrix = buildMatrix(
      [{ id: "a", key: "a", label: "a", internalEdgeCount: 2 }, { id: "b", key: "b", label: "b", internalEdgeCount: 0 }, { id: "c", key: "c", label: "c", internalEdgeCount: 0 }],
      [{ from: "a", to: "b", fileEdgeCount: 2 }, { from: "b", to: "a", fileEdgeCount: 1 }, { from: "c", to: "a", fileEdgeCount: 1 }],
    );
    const markdown = renderArchitectureView(matrixView("units", matrix), "markdown");
    expect(markdown).toMatch(/^## Dependency matrix \(units\)/);
    expect(markdown).toContain("3 row(s), 3 non-zero cell(s).");
    expect(markdown).toContain("Cycle 1: a, b.");
    expect(markdown).toContain("| Row | Ce | Ca | I |");
    expect(markdown).toContain("| c | a | 1 |  |");
    expect(markdown).toMatch(/\| [ab] \| [ab] \| [12] \| yes \|/);
    expect(markdown).not.toMatch(/\| a \| a \|/);
  });
});
