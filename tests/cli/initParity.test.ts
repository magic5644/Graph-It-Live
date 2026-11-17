import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { run, type InitIo } from "@/cli/commands/init";
import type { InitResult } from "@/cli/commands/initReport";
import type { CliRuntime } from "@/cli/runtime";
import { CliProgress } from "@/cli/progress";
import { workerState } from "@/mcp/shared/state";
import { startRulesWorker } from "../analyzer/architecture/rulesWorkspace";

vi.mock("@/mcp/tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/tools")>()),
  // The real scan needs the reverse index of a full CLI run (covered by the E2E test); one dead file here.
  executeScanDeadCode: vi.fn().mockImplementation(async ({ unreferencedFiles }: { unreferencedFiles?: boolean }) => (unreferencedFiles
    ? { unreferencedFiles: [{ relativePath: "scripts/seed.ts", exports: 1, confidence: "low", reasons: ["no-importer"] }] }
    : { entries: [], byConfidence: { high: 0, medium: 0, low: 0 } })),
}));

const pkg = (name: string) => JSON.stringify({ name });

/** Next to the rules workspace's runtime cycle (shared/ui <-> shared/utils): a type-only one and a lazy one, between packages. */
const EXTRA = {
  "types/a/package.json": pkg("@acme/types-a"),
  "types/a/src/a.ts": 'import type { B } from "../../b/src/b";\nexport interface A { b: B }\n',
  "types/b/package.json": pkg("@acme/types-b"),
  "types/b/src/b.ts": 'import type { A } from "../../a/src/a";\nexport interface B { a: A }\n',
  "lazy/router/package.json": pkg("@acme/router"),
  "lazy/router/src/router.ts": 'export const open = () => import("../../page/src/page");\n',
  "lazy/page/package.json": pkg("@acme/page"),
  "lazy/page/src/page.ts": 'import { open } from "../../router/src/router";\nexport const back = open;\n',
};

type Kind = "cycle" | "type-only" | "lazy";

/** A JSON value the page script declares as `const name = ...;`. */
function pageValue<T>(page: string, name: string): T {
  const match = new RegExp(String.raw`const ${name} = (.*);\n`).exec(page);
  if (!match) throw new Error(`no ${name} in the page`);
  return JSON.parse(match[1]) as T;
}

/** Unit keys of the edges drawn in each cycle style of an SVG (edge titles start "from → to:"). */
function svgCycleUnits(svg: string): Record<Kind, Set<string>> {
  const units: Record<Kind, Set<string>> = { cycle: new Set(), "type-only": new Set(), lazy: new Set() };
  for (const [, kind, from, to] of svg.matchAll(/class="edge s-(cycle|type-only|lazy)"[^>]*><title>([^<]+?) → ([^<]+?): /g)) {
    units[kind as Kind].add(from).add(to);
  }
  return units;
}

describe("graph-it init: report, diagrams and page in phase (#745)", { timeout: 60_000 }, () => {
  let root: string;
  let result: InitResult;
  const read = (name: string) => fs.readFileSync(path.join(root, name), "utf8");

  beforeAll(async () => {
    root = startRulesWorker();
    // A first init: no config yet, so no rule breaks today's code and every pair keeps its cycle style.
    fs.rmSync(path.join(root, "graphit.architecture.json"));
    for (const [file, content] of Object.entries(EXTRA)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    }
    const runtime = { workspaceRoot: root, progress: new CliProgress(false), ensureIndexed: vi.fn().mockResolvedValue(undefined), loadState: () => null } as unknown as CliRuntime;
    const offline: InitIo = { interactive: false, confirm: vi.fn() };
    result = JSON.parse(await run(["--output", "out"], runtime, "json", offline));
  });

  afterAll(() => {
    workerState.reset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("names the same unit cycles, by kind, in the report, units.svg and the page", () => {
    const { assessment } = result;
    const report: Record<Kind, Set<string>> = {
      cycle: new Set(assessment.quickWins.filter((win) => win.kind === "cycle-break").flatMap((win) => win.units)),
      "type-only": new Set(assessment.typeOnlyCycles.units),
      lazy: new Set(assessment.lazyCycles.units),
    };
    expect(report).toEqual({
      cycle: new Set(["shared/ui", "shared/utils"]),
      "type-only": new Set(["types/a", "types/b"]),
      lazy: new Set(["lazy/page", "lazy/router"]),
    });
    expect(svgCycleUnits(read("out/units.svg"))).toEqual(report);

    const page = read("out/index.html");
    const overlay = pageValue<{ edgeKinds: [string, string, string][]; deadFiles: string[] }>(page, "overlay");
    const files = pageValue<{ id: string; group: number }[]>(page, "filesData");
    const groups = pageValue<{ id: number; label: string }[]>(page, "groupsData");
    const unitOf = (file: string) => groups.find((group) => group.id === files.find((candidate) => candidate.id === file)?.group)?.label;
    const pageUnits: Record<Kind, Set<string>> = { cycle: new Set(), "type-only": new Set(), lazy: new Set() };
    for (const [from, to, kind] of overlay.edgeKinds) {
      if (kind in pageUnits) pageUnits[kind as Kind].add(unitOf(from)!).add(unitOf(to)!);
    }
    expect(pageUnits).toEqual(report);
  });

  it("outlines one block per unit cycle, in its kind, in units.svg and matrix.svg", () => {
    const blocks = (svg: string) => [...svg.matchAll(/<rect class="cycle s-(cycle|type-only|lazy)"/g)].map((match) => match[1]).sort((a, b) => a.localeCompare(b));
    const { totals } = result.assessment;
    const expected = [
      ...Array<string>(totals.unitCycles).fill("cycle"),
      ...Array<string>(totals.lazyUnitCycles).fill("lazy"),
      ...Array<string>(totals.typeOnlyUnitCycles).fill("type-only"),
    ];
    expect(expected).toEqual(["cycle", "lazy", "type-only"]);
    expect(blocks(read("out/units.svg"))).toEqual(expected);
    expect(blocks(read("out/matrix.svg"))).toEqual(expected);
  });

  it("marks the same dead files in the report and the page", () => {
    const page = read("out/index.html");
    const reportDead = result.assessment.deadFiles.flatMap((group) => group.files.map((file) => file.relativePath));
    expect(reportDead).toEqual(["scripts/seed.ts"]);
    expect(pageValue<{ deadFiles: string[] }>(page, "overlay").deadFiles).toEqual(reportDead);
  });

  it("shows matrix.svg itself in the page's matrix panel, with the report's reading guide", () => {
    const page = read("out/index.html");
    expect(page).toContain(read("out/matrix.svg").trimEnd());
    const report = read("out/report.md");
    expect(report).toContain("## How to read the matrix");
    for (const { action } of result.assessment.matrixGuide.patterns) {
      expect(report).toContain(action);
      // No character of the actions needs escaping in HTML.
      expect(page).toContain(action);
    }
  });
});
