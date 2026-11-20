import { describe, expect, it } from "vitest";
import { evidenceView, folderView, matrixView, renderArchitectureView, unitsView } from "@/cli/commands/architectureTables";
import { EVIDENCE_CELLS, evidenceCell } from "@/mcp/markdownViews";
import type { ArchitectureUnit, UnitRuleCheck } from "@/shared/architecture-model";
import { buildMatrix } from "@/analyzer/architecture/architectureMatrix";

const unit = (key: string, layer: number, role: ArchitectureUnit["role"], fileCount: number, detail: string): ArchitectureUnit => ({
  key, name: key, folder: key, layer, role, fileCount, internalEdgeCount: 0, confidence: "inferred", evidence: [{ role, detail }],
});

const units = {
  units: [unit("app", 1, "unknown", 2, "no evidence"), unit("core|x", 0, "library", 1, "imported by `app`")],
  unitEdges: [{ from: "app", to: "core|x", fileEdgeCount: 3, kind: "down" as const }],
  layerCount: 2,
  cycles: 0,
  upwardEdges: 0,
  unitsFrom: "manifests" as const,
};

describe("architecture table views (#767)", () => {
  it("renders the units as aligned text tables with counts, the evidence and the next command", () => {
    const text = renderArchitectureView(unitsView(units), "text");
    expect(text).toContain("Units: detected projects\n  2 unit(s) in 2 layer(s), 0 = depends on no other unit; 0 cycle(s), 0 upward edge(s).");
    expect(text).toContain("graph-it architecture --level units --from <unit> --to <unit>");
    expect(text).toContain("Units:\n  Unit    Layer  Role     Evidence           Files\n  app     1      unknown  no evidence        2\n  core|x  0      library  imported by `app`  1");
    expect(text).toContain("Unit edges:\n  From  To      File pairs  Kind\n  app   core|x  3           down");
    expect(text).toContain("Cycles between detected projects: none");
    // No config read: no warnings section, no Rules column.
    expect(text).not.toContain("Config warnings");
    expect(text).not.toContain("Rules");
  });

  it("adds a Name column only when a unit's name differs from its folder (#774)", () => {
    const named = { ...units, units: [{ ...units.units[0], name: "app" }, { ...units.units[1], name: "@acme/core" }] };
    expect(renderArchitectureView(unitsView(named), "text")).toContain("Units:\n  Unit    Name        Layer  Role     Evidence           Files\n  app     app         1      unknown  no evidence        2");
    expect(renderArchitectureView(unitsView(named), "markdown")).toContain("| Unit | Name | Layer | Role | Evidence | Files |");
    expect(renderArchitectureView(unitsView(units), "text")).toContain("Units:\n  Unit    Layer  Role     Evidence");
  });

  it("renders markdown tables with escaped pipes, and says none for an empty table", () => {
    const markdown = renderArchitectureView(unitsView({ ...units, unitEdges: [] }), "markdown");
    expect(markdown).toMatch(/^## Units: detected projects\n/);
    expect(markdown).toContain("| Unit | Layer | Role | Evidence | Files |\n| --- | --- | --- | --- | --- |\n| app | 1 | unknown | no evidence | 2 |\n| core\\|x | 0 | library | imported by `app` | 1 |");
    expect(markdown).toContain("### Unit edges\n\n_None._");
    expect(renderArchitectureView(unitsView({ ...units, unitEdges: [] }), "text")).toContain("Unit edges: none");
  });

  it("says declared for a declared role, else the first evidence of the role cut at 60 cells, never a ?", () => {
    expect(evidenceCell({ role: "library", confidence: "declared", evidence: [{ role: "library", detail: 'roles["core"]' }] })).toBe("declared");
    const long = "x".repeat(80);
    const cell = evidenceCell({ role: "test", confidence: "inferred", evidence: [{ role: "library", detail: "pom.xml jar" }, { role: "test", detail: long }] });
    expect(cell).toBe(`${"x".repeat(EVIDENCE_CELLS - 1)}…`);
    expect(Array.from(cell)).toHaveLength(EVIDENCE_CELLS);
    expect(evidenceCell({ role: "test", confidence: "inferred", evidence: [{ role: "test", detail: "x".repeat(EVIDENCE_CELLS) }] })).toBe("x".repeat(EVIDENCE_CELLS));
    // No entry of the chosen role: the first one; none at all: empty.
    expect(evidenceCell({ role: "test", confidence: "inferred", evidence: [{ role: "library", detail: "pom.xml jar" }] })).toBe("pom.xml jar");
    expect(evidenceCell({ role: "unknown", confidence: "inferred", evidence: [] })).toBe("");
  });

  it("names the declared elements, lists the config warnings, the rules of units and edges and the element cycles", () => {
    const check = (name: string, verdict: UnitRuleCheck["verdict"]): UnitRuleCheck => ({ name, kind: "forbid", severity: "error", checkedPairs: 1, violations: verdict === "pass" ? 0 : 1, newViolations: verdict === "violated" ? 1 : 0, verdict });
    const elements = {
      ...units,
      unitsFrom: "elements" as const,
      configFile: "graphit.architecture.json",
      configWarnings: ['$.roles["(root)"]: "(root)" matches no unit'],
      units: [{ ...units.units[0], rules: [check("leaf", "pass")] }, { ...units.units[1], confidence: "declared" as const }],
      unitEdges: [
        { from: "app", to: "core|x", fileEdgeCount: 3, kind: "cycle" as const, rules: [check("a", "pass"), check("b", "violated")], ruleVerdict: "violated" as const },
        { from: "core|x", to: "app", fileEdgeCount: 1, kind: "cycle" as const },
      ],
      cycles: 1,
      rules: [{ name: "b", kind: "forbid" as const, severity: "error" as const, violations: 1, newViolations: 1, elementPairs: [] }],
    };
    const text = renderArchitectureView(unitsView(elements), "text");
    expect(text).toMatch(/^Units: declared elements of graphit.architecture.json\n/);
    expect(text).toContain('Config warnings:\n  Warning\n  $.roles["(root)"]: "(root)" matches no unit');
    expect(text).toContain("app     1      unknown  no evidence  2      leaf pass");
    expect(text).toContain("core|x  0      library  declared     1");
    expect(text).toContain("app     core|x  3           cycle  a pass, b violated");
    expect(text).toContain("Cycles between declared elements:\n  Units\n  app, core|x");
    expect(text).toContain("Rules:\n  Rule  Kind    Severity  Violations  New\n  b     forbid  error     1           1");
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
