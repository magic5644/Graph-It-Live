import { afterEach, describe, expect, it } from "vitest";
import { checkGraphArchitecture, parseArchitectureConfig } from "@/analyzer/architecture/architectureRules";
import { assessWorkspace as assess, cycleWins, edgeFlags, removeWorkspaces, renderDryRun as text } from "./cycleHarness";

/** The fixtures of #741: a cycle that closes only through import() is lazy, not a runtime cycle. */
describe("lazy cycles (#741)", () => {
  afterEach(removeWorkspaces);

  // A router that lazily loads its page, which imports the router back.
  const LAZY_ROUTE = {
    "app/router.ts": 'export const routes = [{ path: "/page", component: () => import("../views/page") }];\n',
    "views/page.ts": 'import { routes } from "../app/router";\nexport const links = () => routes.length;\n',
  };

  it("reports a router lazily importing a page that imports it back as one lazy item, no runtime cycle", async () => {
    const { graph, assessment } = await assess(LAZY_ROUTE);
    expect(edgeFlags(graph)).toEqual(["app/router.ts -> views/page.ts (dynamic)", "views/page.ts -> app/router.ts"]);
    expect(cycleWins(assessment)).toEqual([]);
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
    const { root, graph } = await assess(LAZY_ROUTE);
    const config = parseArchitectureConfig(JSON.stringify({
      elements: { app: { path: "app/" }, views: { path: "views/" } },
      rules: [{ name: "app-imports-nothing-but-app", from: "app", allowOnly: ["app"], severity: "error" }],
    }));
    const { check } = checkGraphArchitecture(graph, root, config);
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
