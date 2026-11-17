import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildArchitectureGraph, type ArchitectureGraph } from "@/analyzer/architecture/ArchitectureGraphBuilder";
import { assessArchitecture, type AssessmentInput } from "@/analyzer/architecture/architectureAssessment";
import { unitMatrix } from "@/analyzer/architecture/architectureMatrix";
import { checkGraphArchitecture, parseArchitectureConfig } from "@/analyzer/architecture/architectureRules";
import { assignUnits, buildArchitectureUnits } from "@/analyzer/architecture/architectureUnits";
import { SpiderBuilder } from "@/analyzer/SpiderBuilder";
import { renderInitText, type InitResult } from "@/cli/commands/initReport";

/** The fixtures of #741: a cycle that closes only through import() is lazy, not a runtime cycle. */
describe("lazy cycles (#741)", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  async function assess(files: Record<string, string>) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-lazy-"));
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    }
    const spider = new SpiderBuilder().withRootDir(root).withExcludeNodeModules(true).build();
    const graph = await buildArchitectureGraph(root, (file) => spider.analyze(file));
    const assignment = assignUnits(root, graph.nodes.map((node) => node.relativePath));
    const units = buildArchitectureUnits(graph, root, assignment);
    const input: AssessmentInput = { graph, units, unitOf: assignment.unitOf, matrix: unitMatrix(units), deadCode: [], acceptedViolations: 0 };
    return { graph, assessment: assessArchitecture(input) };
  }

  const edgeFlags = (graph: Pick<ArchitectureGraph, "edges">) =>
    graph.edges.map((edge) => `${edge.sourceRelative} -> ${edge.targetRelative}${edge.typeOnly ? " (type)" : ""}${edge.dynamic ? " (dynamic)" : ""}`).sort();
  const text = (assessment: ReturnType<typeof assessArchitecture>) => renderInitText({
    configFile: "graphit.architecture.json", baselineFile: "graphit.architecture.baseline.json", status: "dry-run",
    written: [], reportFiles: [], changes: [], acceptedViolations: 0,
    guard: { preCommit: "", ci: "", sarif: "" }, assessment, diagrams: [],
  } satisfies InitResult);

  // A router that lazily loads its page, which imports the router back.
  const LAZY_ROUTE = {
    "app/router.ts": 'export const routes = [{ path: "/page", component: () => import("../views/page") }];\n',
    "views/page.ts": 'import { routes } from "../app/router";\nexport const links = () => routes.length;\n',
  };

  it("reports a router lazily importing a page that imports it back as one lazy item, no runtime cycle", async () => {
    const { graph, assessment } = await assess(LAZY_ROUTE);
    expect(edgeFlags(graph)).toEqual(["app/router.ts -> views/page.ts (dynamic)", "views/page.ts -> app/router.ts"]);
    expect(assessment.quickWins.filter((win) => win.kind === "mutual-import" || win.kind === "cycle-break")).toEqual([]);
    expect(assessment.totals).toMatchObject({ unitCycles: 0, mutualImports: 0, lazyUnitCycles: 1, lazyMutualImports: 1, typeOnlyUnitCycles: 0, typeOnlyMutualImports: 0 });
    expect(assessment.totals.mutualHotSpot).toBeUndefined();
    expect(assessment.lazyCycles).toEqual({
      unitCycles: 1, mutualImports: 1, evidence: ["app/router.ts <-> views/page.ts", "units app, views"], totalEvidence: 2, units: ["app", "views"],
    });
    const report = text(assessment);
    expect(report).toContain("Cycles: 0 runtime unit cycles, 0 runtime mutual file imports; type-only: 0 unit cycles, 0 mutual file imports; lazy: 1 unit cycle, 1 mutual file import");
    expect(report).toContain("[lazy] app, views: 1 unit cycle and 1 mutual file import that close through lazy import(s): loaded on demand, no init-order risk.");
    expect(report).not.toMatch(/Top action: .*lazy/);
  });

  it("still reports a static cycle next to it first", async () => {
    const { assessment } = await assess({
      ...LAZY_ROUTE,
      "core/a.ts": 'import { b } from "../lib/b";\nexport const a = () => b;\n',
      "lib/b.ts": 'import { a } from "../core/a";\nexport const b = () => a;\n',
    });
    expect(assessment.totals).toMatchObject({ unitCycles: 1, mutualImports: 1, lazyUnitCycles: 1, lazyMutualImports: 1 });
    expect(assessment.quickWins[0]).toMatchObject({ kind: "cycle-break", units: ["core", "lib"] });
    expect(assessment.quickWins.flatMap((win) => win.units)).not.toContain("views");
    const report = text(assessment);
    const cycles = report.slice(report.indexOf("Cycles to cut"));
    expect(cycles.indexOf("[cycle-break] core, lib")).toBeLessThan(cycles.indexOf("[lazy]"));
    expect(report).toMatch(/Top action: core, lib/);
  });

  it("keeps the dynamic edge for allowOnly rules (check-architecture)", async () => {
    const { graph } = await assess(LAZY_ROUTE);
    const config = parseArchitectureConfig(JSON.stringify({
      elements: { app: { path: "app/" }, views: { path: "views/" } },
      rules: [{ name: "app-imports-nothing-but-app", from: "app", allowOnly: ["app"], severity: "error" }],
    }));
    const { check } = checkGraphArchitecture(graph, root!, config);
    expect(check.violations.map(({ rule, source, target }) => ({ rule, source, target }))).toEqual([
      { rule: "app-imports-nothing-but-app", source: "app/router.ts", target: "views/page.ts" },
    ]);
  });

  it("counts a file imported both statically and through import() as static: a runtime cycle", async () => {
    const { graph, assessment } = await assess({
      "app/router.ts": 'import { title } from "../views/page";\nexport const routes = [{ title, component: () => import("../views/page") }];\n',
      "views/page.ts": 'import { routes } from "../app/router";\nexport const title = "page";\nexport const links = () => routes.length;\n',
    });
    expect(edgeFlags(graph)).toEqual(["app/router.ts -> views/page.ts", "views/page.ts -> app/router.ts"]);
    expect(assessment.totals).toMatchObject({ unitCycles: 1, mutualImports: 1, lazyUnitCycles: 0, lazyMutualImports: 0 });
  });

  it("counts a type-only import plus an import() of one file as lazy, never type-only", async () => {
    const { graph, assessment } = await assess({
      "app/router.ts": 'import type { Links } from "../views/page";\nexport const routes: { links?: Links; load: () => unknown }[] = [{ load: () => import("../views/page") }];\n',
      "views/page.ts": 'import { routes } from "../app/router";\nexport type Links = number;\nexport const links = () => routes.length;\n',
    });
    expect(edgeFlags(graph)).toEqual(["app/router.ts -> views/page.ts (dynamic)", "views/page.ts -> app/router.ts"]);
    expect(assessment.totals).toMatchObject({ unitCycles: 0, mutualImports: 0, lazyUnitCycles: 1, lazyMutualImports: 1, typeOnlyMutualImports: 0 });
  });
});
