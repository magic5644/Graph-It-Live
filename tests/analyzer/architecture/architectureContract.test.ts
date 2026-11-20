import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cycleCuts } from "@/analyzer/architecture/architectureAssessment";
import { buildArchitectureGraph, type ArchitectureGraph } from "@/analyzer/architecture/ArchitectureGraphBuilder";
import { unitMatrix } from "@/analyzer/architecture/architectureMatrix";
import { rulesByEdge, unitCyclePairs } from "@/analyzer/architecture/architectureRules";
import { byCodeUnit, countPair, cycleKind, folderLevel, type UnitPair } from "@/analyzer/architecture/architectureUnits";
import { viewArchitecture } from "@/analyzer/architecture/architectureView";
import { loadWorkspaceUnits, workspaceUnits, type UnitSource, type WorkspaceUnits } from "@/analyzer/architecture/workspaceUnits";
import { architectureDiagramInput, type DiagramInput } from "@/analyzer/diagram/architectureDiagram";
import type { ArchitectureUnits, UnitCycleKind, UnitRuleCheck } from "@/shared/architecture-model";

// ADR-776 frozen contract: sets B and C code against these signatures. One typed call each, so a
// signature change fails this suite before they rebase.
let root: string;
let graph: ArchitectureGraph;

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-contract-")));
  for (const file of ["a/x.ts", "b/y.ts"]) {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "");
  }
  graph = await buildArchitectureGraph(root, async (filePath) =>
    filePath.endsWith("x.ts") ? [{ path: path.join(root, "b/y.ts"), type: "import" as const, line: 1, module: "../b/y" }] : []);
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("ADR-776 frozen analyzer signatures", () => {
  it("workspaceUnits, loadWorkspaceUnits, viewArchitecture and folderLevel", async () => {
    const source: WorkspaceUnits = workspaceUnits(graph, root, undefined, undefined, undefined);
    const loaded: WorkspaceUnits = await loadWorkspaceUnits(graph, root, { config: false, baseline: false });
    expect(loaded.units.units.map((unit) => unit.key)).toEqual(source.units.units.map((unit) => unit.key));
    const units: ArchitectureUnits = source.units;
    expect(units.unitsFrom).toBe("manifests");
    const view = viewArchitecture(graph, root, 10, source);
    expect(view.source).toBe(source);
    const unitSource: UnitSource = source;
    expect(folderLevel(unitSource, "a").graph.nodes).toHaveLength(1);
    const check: UnitRuleCheck = { name: "r", kind: "forbid", severity: "error", checkedPairs: 0, violations: 0, newViolations: 0, verdict: "pass" };
    expect(check.verdict).toBe("pass");
  });

  it("keeps the signatures set B calls", () => {
    const source = workspaceUnits(graph, root);
    const input: DiagramInput = architectureDiagramInput(source, root, {});
    expect(input.nodes.length).toBeGreaterThan(0);
    const rules: Record<string, string[]> = rulesByEdge([{ rule: "r", source: "a/x.ts", target: "b/y.ts" }], (file) => source.assignment.unitOf.get(file));
    expect(rules).toEqual({ "a>b": ["r"] });
    expect(unitCyclePairs(graph, source.detected)).toEqual([]);
    expect(byCodeUnit("a", "b")).toBe(-1);
    const pairs = new Map<string, UnitPair>();
    countPair(pairs, "a", "b", { typeOnly: false });
    const kind: UnitCycleKind = cycleKind(["a", "b"], pairs);
    expect(kind).toBe("runtime");
    const cuts: ReturnType<typeof cycleCuts> = cycleCuts(unitMatrix(source.units));
    expect(cuts).toEqual([]);
  });
});
