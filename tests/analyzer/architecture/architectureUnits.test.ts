import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exploreUnits } from "@/analyzer/architecture/ArchitectureExplorer";
import { buildArchitectureGraph, type AnalyzeFile } from "@/analyzer/architecture/ArchitectureGraphBuilder";
import {
  assignUnits,
  buildArchitectureUnits,
  classifyUnitEdge,
  groupByUnit,
  layerGroupsWithinUnits,
  ROOT_UNIT,
} from "@/analyzer/architecture/architectureUnits";
import { SpiderBuilder } from "@/analyzer/SpiderBuilder";
import { normalizePath } from "@/shared/path";

let root: string;

function write(relative: string, content = ""): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const manifest = (name?: string, extra: Record<string, unknown> = {}) => JSON.stringify({ ...(name ? { name } : {}), ...extra });

/** Files with their imports (workspace-relative); imports are resolved by the fake analyzer. */
function workspace(files: Record<string, string[]>): AnalyzeFile {
  for (const relative of Object.keys(files)) write(relative);
  return async (filePath) =>
    (files[normalizePath(path.relative(root, filePath))] ?? []).map((relative) =>
      ({ path: path.join(root, relative), type: "import" as const, line: 1, module: relative }));
}

async function unitsOf(files: Record<string, string[]>) {
  const graph = await buildArchitectureGraph(root, workspace(files));
  return { graph, units: buildArchitectureUnits(graph, root) };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-units-")));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("assignUnits", () => {
  it("puts each file in its deepest package, workspace member or not, and the rest in (root)", () => {
    write("package.json", manifest("root", { workspaces: ["apps/*", "packages/*"] }));
    write("apps/web/package.json", manifest("@acme/web"));
    write("packages/lib/package.json", manifest("@acme/lib"));
    write("packages/lib/examples/demo/package.json", manifest("demo"));
    write("tools/gen/package.json", manifest()); // outside the workspaces globs, no name
    write("services/broken/package.json", "{ not json");
    const files = [
      "apps/web/src/main.ts",
      "packages/lib/src/index.ts",
      "packages/lib/examples/demo/run.ts",
      "tools/gen/cli.ts",
      "services/broken/index.ts",
      "scripts/build.ts",
      "index.ts",
    ];
    const { unitOf, names } = assignUnits(root, files);
    expect(Object.fromEntries(unitOf)).toEqual({
      "apps/web/src/main.ts": "apps/web",
      "packages/lib/src/index.ts": "packages/lib",
      "packages/lib/examples/demo/run.ts": "packages/lib/examples/demo",
      "tools/gen/cli.ts": "tools/gen",
      "services/broken/index.ts": "services/broken",
      "scripts/build.ts": ROOT_UNIT,
      "index.ts": ROOT_UNIT,
    });
    expect(Object.fromEntries(names)).toEqual({
      "apps/web": "@acme/web",
      "packages/lib": "@acme/lib",
      "packages/lib/examples/demo": "demo",
      "tools/gen": "tools/gen",
      "services/broken": "services/broken",
      [ROOT_UNIT]: ROOT_UNIT,
    });
  });

  it("uses the top-level folders when no package sits below the root", () => {
    write("package.json", manifest("single"));
    const { unitOf, names } = assignUnits(root, ["src/a/x.ts", "src/b/y.ts", "tests/x.test.ts", "main.ts"]);
    expect(Object.fromEntries(unitOf)).toEqual({ "src/a/x.ts": "src", "src/b/y.ts": "src", "tests/x.test.ts": "tests", "main.ts": ROOT_UNIT });
    expect(names.get("src")).toBe("src");
  });
});

describe("assignUnits edge cases", () => {
  it("returns nothing for no file", () => {
    expect(assignUnits(root, [])).toEqual({ unitOf: new Map(), names: new Map() });
  });

  it("accepts Windows separators and keys files by normalized path", () => {
    write("apps/web/package.json", manifest("@acme/web"));
    const { unitOf } = assignUnits(root, [String.raw`apps\web\src\main.ts`, String.raw`tools\x.ts`]);
    expect(Object.fromEntries(unitOf)).toEqual({ "apps/web/src/main.ts": "apps/web", "tools/x.ts": ROOT_UNIT });
  });
});

describe("classifyUnitEdge", () => {
  it("flags cycles, edges to the same or a higher layer, and keeps the others down", () => {
    expect(classifyUnitEdge(1, 1, true)).toBe("cycle");
    expect(classifyUnitEdge(0, 2, false)).toBe("upward");
    expect(classifyUnitEdge(1, 1, false)).toBe("upward");
    expect(classifyUnitEdge(2, 0, false)).toBe("down");
  });
});

describe("buildArchitectureUnits", () => {
  it("ranks a chain A → B → C as layers 2, 1, 0 with every edge down", async () => {
    const { units } = await unitsOf({ "A/a.ts": ["B/b.ts"], "B/b.ts": ["C/c.ts"], "C/c.ts": [] });
    expect(units.units.map((unit) => [unit.key, unit.layer])).toEqual([["A", 2], ["B", 1], ["C", 0]]);
    expect(units.unitEdges.map((edge) => edge.kind)).toEqual(["down", "down"]);
    expect(units.upwardEdges).toBe(0);
    expect(units.cycles).toBe(0);
  });

  it("gives a two-unit cycle one layer and flags its edges", async () => {
    const { units } = await unitsOf({ "app/main.ts": ["x/x.ts"], "x/x.ts": ["y/y.ts"], "y/y.ts": ["x/x.ts"] });
    expect(Object.fromEntries(units.units.map((unit) => [unit.key, unit.layer]))).toEqual({ app: 1, x: 0, y: 0 });
    expect(units.unitEdges.map((edge) => `${edge.from}>${edge.to}:${edge.kind}`).sort()).toEqual(["app>x:down", "x>y:cycle", "y>x:cycle"]);
    expect(units.cycles).toBe(1);
  });

  it("adds up: unit files are the analysed files, unit edges the file pairs between their files", async () => {
    const { graph, units } = await unitsOf({
      "web/a.ts": ["web/b.ts", "lib/x.ts"],
      "web/b.ts": ["lib/x.ts", "lib/y.ts"],
      "lib/x.ts": ["lib/y.ts"],
      "lib/y.ts": [],
      "main.ts": ["web/a.ts"],
    });
    expect(units.units.reduce((total, unit) => total + unit.fileCount, 0)).toBe(graph.analyzedFiles);
    expect(units.unitEdges.find((edge) => edge.from === "web" && edge.to === "lib")?.fileEdgeCount).toBe(3);
    expect(units.totals).toEqual({ files: 5, fileEdges: 6, intraUnitEdges: 2, interUnitEdges: 4 });
    const internal = units.units.reduce((total, unit) => total + unit.internalEdgeCount, 0);
    expect(internal).toBe(units.totals.intraUnitEdges);
  });

  it("changes its revision when a package appears, even with the same files and edges", async () => {
    const analyze = workspace({ "pkg/src/a.ts": [], "other/b.ts": [] });
    const graph = await buildArchitectureGraph(root, analyze);
    const before = buildArchitectureUnits(graph, root).context.revision;
    write("pkg/package.json", manifest("pkg"));
    expect(buildArchitectureUnits(graph, root).context.revision).not.toBe(before);
    expect(before).not.toBe(graph.context.revision);
  });
});

describe("buildArchitectureUnits on an empty graph", () => {
  it("has no unit, edge or cycle", async () => {
    const { units } = await unitsOf({});
    expect(units).toMatchObject({ units: [], unitEdges: [], upwardEdges: 0, cycles: 0, totals: { files: 0, fileEdges: 0 } });
  });
});

describe("layerGroupsWithinUnits", () => {
  it("layers each unit's groups on their own and flags their cycles, leaving edges across units out", () => {
    const groupUnits = { 1: "web", 2: "web", 3: "web", 4: "lib", 5: "lib" };
    const { groupLayers, groupEdgeKinds } = layerGroupsWithinUnits(
      [{ from: 1, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 2 }, { from: 1, to: 4 }, { from: 4, to: 5 }],
      groupUnits,
    );
    expect(groupLayers).toEqual({ 1: 1, 2: 0, 3: 0, 4: 1, 5: 0 });
    expect(groupEdgeKinds).toEqual({ "1>2": "down", "2>3": "cycle", "3>2": "cycle", "4>5": "down" });
  });
});

describe("groupByUnit", () => {
  it("never mixes the files of two units in one folder group", async () => {
    write("web/package.json", manifest("web"));
    write("lib/package.json", manifest("lib"));
    const { graph } = await unitsOf({
      "web/src/components/a.ts": ["lib/src/components/b.ts"],
      "lib/src/components/b.ts": [],
      "web/index.ts": [],
      "loose.ts": [],
    });
    const assignment = assignUnits(root, graph.nodes.map((node) => node.relativePath));
    const units = buildArchitectureUnits(graph, root, assignment);
    const { graph: grouped, groupUnits } = groupByUnit(graph, units, assignment);
    const keyOf = Object.fromEntries(grouped.nodes.map((node) => [node.relativePath, node.communityKey]));
    expect(keyOf).toEqual({
      "web/src/components/a.ts": "web/components",
      "lib/src/components/b.ts": "lib/components",
      "web/index.ts": "web",
      "loose.ts": ROOT_UNIT,
    });
    for (const node of grouped.nodes) {
      expect(groupUnits[node.communityId]).toBe(assignment.unitOf.get(node.relativePath));
      expect(grouped.graphData.nodeMetadata?.[node.path]?.communityId).toBe(node.communityId);
    }
    expect(grouped.context.revision).toBe(units.context.revision);
  });
});

describe("exploreUnits", () => {
  it("pages units and unit edges, and rejects another revision", async () => {
    const { units } = await unitsOf({ "A/a.ts": ["B/b.ts"], "B/b.ts": ["C/c.ts"], "C/c.ts": [] });
    const first = exploreUnits(units, { limit: 1 });
    expect(first.units.map((unit) => unit.key)).toEqual(["A"]);
    expect(first.page).toMatchObject({ totalUnits: 3, totalUnitEdges: 2, truncated: true, nextOffset: 1 });
    expect(exploreUnits(units, { offset: 1, limit: 5, revision: units.context.revision }).units).toHaveLength(2);
    expect(() => exploreUnits(units, { revision: "0".repeat(64) })).toThrow("Architecture changed");
  });
});

describe("cross-package imports by package name", () => {
  it("is an edge between the two units through the symlinked node_modules of npm workspaces", async () => {
    write("package.json", manifest("root", { workspaces: ["apps/*", "services/*"] }));
    write("apps/web/package.json", manifest("@acme/web", { dependencies: { "@acme/core": "*", "shared-utils": "*" } }));
    write("apps/web/src/main.ts", 'import { core } from "@acme/core";\nimport { u } from "shared-utils";\nexport const x = [core, u];\n');
    write("services/core-lib/package.json", manifest("@acme/core", { main: "dist/index.js" }));
    write("services/core-lib/src/index.ts", "export const core = 1;\n");
    write("services/utils/package.json", manifest("shared-utils"));
    write("services/utils/src/index.ts", "export const u = 1;\n");
    fs.mkdirSync(path.join(root, "node_modules/@acme"), { recursive: true });
    fs.symlinkSync(path.join(root, "services/core-lib"), path.join(root, "node_modules/@acme/core"), "junction");
    fs.symlinkSync(path.join(root, "services/utils"), path.join(root, "node_modules/shared-utils"), "junction");

    const spider = new SpiderBuilder().withRootDir(root).withExcludeNodeModules(true).build();
    const graph = await buildArchitectureGraph(root, (filePath) => spider.analyze(filePath));
    const units = buildArchitectureUnits(graph, root);
    expect(units.unitEdges.map((edge) => `${edge.from}>${edge.to}`).sort()).toEqual(["apps/web>services/core-lib", "apps/web>services/utils"]);
    expect(units.units.find((unit) => unit.key === "services/core-lib")?.name).toBe("@acme/core");
  });
});
