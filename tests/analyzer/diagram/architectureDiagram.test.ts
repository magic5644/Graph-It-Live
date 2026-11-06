import * as fs from "node:fs";
import * as path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildArchitectureGraph } from "@/analyzer/architecture/ArchitectureGraphBuilder";
import { checkArchitecture, parseArchitectureConfig } from "@/analyzer/architecture/architectureRules";
import { viewArchitecture, type UnitSource } from "@/analyzer/architecture/architectureView";
import {
  architectureDiagramInput,
  fitLabel,
  layoutDiagram,
  legendLayout,
  strokeWidth,
  textWidth,
  workspaceName,
  type Box,
  type DiagramInput,
  type DiagramLayout,
} from "@/analyzer/diagram/architectureDiagram";
import { layoutMatrix, type MatrixLayout } from "@/analyzer/diagram/diagramMatrix";
import { DIAGRAM_SPEC_SCHEMA, diagramSpec, type DiagramSpec } from "@/analyzer/diagram/diagramSpec";
import { escapeXml, renderDiagramHtml, renderDiagramSvg } from "@/analyzer/diagram/diagramSvg";
import { SIZES } from "@/analyzer/diagram/diagramStyle";
import { renderSourceDiagram, renderWorkspaceDiagram } from "@/analyzer/diagram/workspaceDiagram";
import { Parser } from "@/analyzer/Parser";
import { SpiderBuilder } from "@/analyzer/SpiderBuilder";
import { PathResolver } from "@/analyzer/utils/PathResolver";
import { workerState } from "@/mcp/shared/state";
import { UNIT_ROLES } from "@/shared/architecture-model";

// The acme-like npm-workspaces fixture: apps, packages with a core <-> types cycle, a function, tooling.
const rootDir = path.resolve(__dirname, "../../fixtures/workspaces-project");

const RULES = parseArchitectureConfig(JSON.stringify({
  elements: { ui: { path: "packages/ui/" }, core: { path: "packages/core/" }, web: { path: "apps/web/" }, pages: { path: "apps/web/src/pages/" } },
  rules: [
    { name: "ui-without-core", from: "ui", forbid: "core", reason: "fixture" },
    // Inside one unit: what a folder level draws.
    { name: "web-without-pages", from: "web", forbid: "pages", reason: "fixture" },
  ],
}));

async function fixtureSource(): Promise<UnitSource> {
  const graph = await buildArchitectureGraph(rootDir, (filePath) => workerState.getSpider().analyze(filePath), {
    communityMode: "path",
    indexedAt: "2026-11-06T08:00:00.000Z",
  });
  return viewArchitecture(graph, rootDir, Number.POSITIVE_INFINITY).source!;
}

async function fixtureInput(folder?: string): Promise<DiagramInput> {
  const source = await fixtureSource();
  const { violations } = checkArchitecture(source.graph, source.assignment, RULES);
  return architectureDiagramInput(source, rootDir, { folder, violations });
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const contains = (outer: Box, inner: Box) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

/** An axis-aligned segment crossing a box's interior (its border excluded). */
function crosses(a: { x: number; y: number }, b: { x: number; y: number }, box: Box): boolean {
  const [left, right, top, bottom] = [box.x + 0.5, box.x + box.width - 0.5, box.y + 0.5, box.y + box.height - 0.5];
  if (a.y === b.y) return a.y > top && a.y < bottom && Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right;
  if (a.x === b.x) return a.x > left && a.x < right && Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom;
  throw new Error(`diagonal segment ${JSON.stringify([a, b])}`);
}

/** Every geometry check of #445: no overlap, labels in their boxes and the canvas, no edge through another node. */
function expectSoundGeometry(layout: DiagramLayout): void {
  const canvas = { x: 0, y: 0, width: layout.width, height: layout.height };
  for (const [index, node] of layout.nodes.entries()) {
    expect(contains(canvas, node), node.key).toBe(true);
    expect(node.y, node.key).toBeGreaterThanOrEqual(layout.top);
    for (const other of layout.nodes.slice(index + 1)) expect(overlaps(node, other), `${node.key} / ${other.key}`).toBe(false);
    expect(SIZES.nodePaddingX + textWidth(node.text, SIZES.label), node.key).toBeLessThanOrEqual(node.width - SIZES.nodePaddingX);
    expect(SIZES.nodePaddingX + textWidth(node.meta, SIZES.meta), node.key).toBeLessThanOrEqual(node.width - SIZES.nodePaddingX);
  }
  for (const [index, cycle] of layout.cycles.entries()) {
    expect(contains(canvas, cycle)).toBe(true);
    for (const other of layout.cycles.slice(index + 1)) expect(overlaps(cycle, other), "cycle blocks").toBe(false);
    // The block's title, drawn at its top left, stays clear of every node.
    const title = { x: cycle.x, y: cycle.y, width: SIZES.nodePaddingX + textWidth(`cycle · ${cycle.members.length}`, SIZES.meta), height: 24 };
    expect(title.width).toBeLessThanOrEqual(cycle.width);
    for (const node of layout.nodes) expect(overlaps(title, node), `cycle title / ${node.key}`).toBe(false);
    for (const node of layout.nodes) {
      if (cycle.members.includes(node.key)) expect(contains(cycle, node), node.key).toBe(true);
      else expect(overlaps(cycle, node), node.key).toBe(false);
    }
  }
  for (const edge of layout.edges) {
    expect(edge.points.length, `${edge.from}>${edge.to}`).toBeGreaterThanOrEqual(2);
    for (const point of edge.points) expect(contains(canvas, { ...point, width: 0, height: 0 })).toBe(true);
    for (const node of layout.nodes.filter((candidate) => candidate.key !== edge.from && candidate.key !== edge.to)) {
      for (const [index, point] of edge.points.slice(1).entries()) {
        expect(crosses(edge.points[index], point, node), `${edge.from}>${edge.to} through ${node.key}`).toBe(false);
      }
    }
  }
  expectTextInCanvas(layout, { accepted: layout.edges.some((edge) => edge.accepted) });
}

/** Header lines, notes and legend within the margins. */
function expectTextInCanvas(layout: DiagramLayout | MatrixLayout, legend: Parameters<typeof legendLayout>[0]): void {
  const { title, caption, counts, hidden, rules } = layout.text;
  const lines = [[title, SIZES.title], [caption, SIZES.caption], [counts, SIZES.caption], [hidden ?? "", SIZES.caption], [rules ?? "", SIZES.caption]] as const;
  for (const [line, size] of lines) expect(textWidth(line, size), line).toBeLessThanOrEqual(layout.width - 2 * SIZES.margin);
  expect(legendLayout(legend).width).toBeLessThanOrEqual(layout.width - 2 * SIZES.margin);
}

/** The matrix: every cell in the grid on its row and column, labels left of the grid, cycles around their rows. */
function expectSoundMatrix(layout: MatrixLayout): void {
  const canvas = { x: 0, y: 0, width: layout.width, height: layout.height };
  const size = layout.rows.length === 0 ? 0 : layout.grid.width / layout.rows.length;
  expect(layout.grid.width).toBe(layout.grid.height);
  expect(contains(canvas, layout.grid)).toBe(true);
  expect(layout.grid.y).toBeGreaterThan(layout.top);
  for (const cell of layout.cells) {
    expect(contains(layout.grid, cell), cell.title).toBe(true);
    expect(4 + textWidth(String(cell.count), SIZES.meta), cell.title).toBeLessThanOrEqual(cell.width - 2);
  }
  for (const [index, row] of layout.rows.entries()) {
    expect(row.text.startsWith(`${index + 1} `)).toBe(true);
    expect(row.x + textWidth(row.text, SIZES.label), row.key).toBeLessThanOrEqual(layout.grid.x);
    expect(row.y).toBe(layout.grid.y + index * size);
    expect(4 + textWidth(layout.columns[index].text, SIZES.meta)).toBeLessThanOrEqual(size);
  }
  for (const cycle of layout.cycles) expect(contains(layout.grid, cycle)).toBe(true);
  expectTextInCanvas(layout, { accepted: layout.cells.some((cell) => cell.kind === "accepted"), weight: false });
}

/** No script, no foreignObject, no URL but the SVG namespace. */
function expectSafeMarkup(markup: string): void {
  expect(markup).not.toMatch(/<script|foreignObject|href=|\son\w+=|url\((?!#arrow-)/i);
  expect(markup.match(/https?:\/\/[^"\s]*/g)?.filter((url) => url !== "http://www.w3.org/2000/svg") ?? []).toEqual([]);
}

const SPEC_SCHEMA = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../schemas/diagram-spec.schema.json"), "utf8"));
const validateSpec = new Ajv2020({ allErrors: true }).compile(SPEC_SCHEMA);

/** Valid against the published schema, and every key it refers to is a node of the level. */
function expectSoundSpec(spec: DiagramSpec): void {
  expect(validateSpec(JSON.parse(JSON.stringify(spec))), JSON.stringify(validateSpec.errors)).toBe(true);
  const keys = spec.nodes.map((node) => node.key);
  expect(spec.layers.flatMap((layer) => layer.nodes).toSorted()).toEqual(keys.toSorted());
  for (const layer of spec.layers) for (const key of layer.nodes) expect(spec.nodes.find((node) => node.key === key)?.layer).toBe(layer.layer);
  expect(spec.layers.map((layer) => layer.layer)).toEqual(spec.layers.map((layer) => layer.layer).toSorted((a, b) => a - b));
  for (const edge of spec.edges) expect(keys, `${edge.from}>${edge.to}`).toEqual(expect.arrayContaining([edge.from, edge.to]));
  for (const cycle of spec.cycles) expect(keys).toEqual(expect.arrayContaining(cycle));
  expect(spec.counts).toMatchObject({ nodes: keys.length, layers: spec.layers.length, cycles: spec.cycles.length, edges: spec.edges.length });
}

function input(nodes: [string, number, number][], edges: [string, string, number, DiagramInput["edges"][number]["kind"]][] = []): DiagramInput {
  return {
    workspace: "acme", scope: "units", noun: "units", revision: "0123456789abcdef", date: "2026-11-06", violations: 0,
    nodes: nodes.map(([key, layer, fileCount]) => ({ key, label: key, layer, fileCount })),
    edges: edges.map(([from, to, fileEdgeCount, kind]) => ({ from, to, fileEdgeCount, kind, rules: [] })),
  };
}

describe("architecture diagram: workspaces-project", () => {
  beforeEach(() => {
    workerState.parser = new Parser();
    workerState.resolver = new PathResolver(undefined, true, rootDir);
    workerState.spider = new SpiderBuilder().withRootDir(rootDir).withExcludeNodeModules(true).build();
    workerState.config = { rootDir, excludeNodeModules: true, maxDepth: 50 };
    workerState.isReady = true;
  });

  afterEach(() => {
    workerState.reset();
  });

  it("draws the units, layers, the cycle and the violation as the golden SVG", async () => {
    const diagram = await fixtureInput();
    expect(diagram).toMatchObject({ workspace: "workspaces-project", scope: "units", noun: "units", date: "2026-11-06", violations: 1 });
    expect(diagram.edges.find((edge) => edge.from === "packages/ui" && edge.to === "packages/core")?.rules).toEqual(["ui-without-core"]);

    const layout = await layoutDiagram(diagram);
    expectSoundGeometry(layout);
    expect(layout.cycles.map((cycle) => cycle.members)).toEqual([["packages/core", "packages/types"]]);
    expect(layout.counts).toEqual({ nodes: diagram.nodes.length, layers: new Set(diagram.nodes.map((node) => node.layer)).size, cycles: 1, violations: 1 });
    // Layer 0 at the bottom: a unit never sits below one of its layer or lower.
    for (const lower of layout.nodes) {
      for (const upper of layout.nodes.filter((node) => node.layer > lower.layer)) expect(upper.y, `${upper.key} above ${lower.key}`).toBeLessThan(lower.y);
    }

    const svg = renderDiagramSvg(layout);
    expectSafeMarkup(svg);
    expect(svg).toContain('class="edge error"');
    expect(svg).toContain('class="edge accent"');
    expect(svg).not.toContain(rootDir.replaceAll("\\", "/"));
    await expect(svg).toMatchFileSnapshot("__snapshots__/workspaces-project.units.svg");
    // Same revision, same file.
    expect(renderDiagramSvg(await layoutDiagram(await fixtureInput()))).toBe(svg);
  }, 60_000);

  it("draws the groups of an entered unit, and refuses a folder without files", async () => {
    const diagram = await fixtureInput("apps/web");
    expect(diagram).toMatchObject({ scope: "apps/web", noun: "groups" });
    expect(diagram.nodes.map((node) => node.label).sort()).toEqual(["pages", "web"]);
    expect(diagram.edges).toEqual([expect.objectContaining({ from: "apps/web", to: "apps/web/pages", kind: "down", fileEdgeCount: 1, rules: ["web-without-pages"] })]);
    expect(diagram.violations).toBe(1);
    const layout = await layoutDiagram(diagram);
    expectSoundGeometry(layout);
    expect(layout.text.caption).toContain("folder apps/web");
    expect(renderDiagramSvg(layout)).toContain('class="edge error"');
    const source = await fixtureSource();
    expect(() => architectureDiagramInput(source, rootDir, { folder: "nowhere" })).toThrow('No file below folder "nowhere"');
  }, 60_000);

  it("draws the units' matrix in the architecture --matrix order as the golden SVG", async () => {
    const diagram = await fixtureInput();
    const layout = layoutMatrix(diagram);
    expectSoundMatrix(layout);
    expect(layout.rows).toHaveLength(diagram.nodes.length);
    expect(layout.cycles.map((cycle) => cycle.members)).toEqual([["packages/core", "packages/types"]]);
    const row = (key: string) => layout.rows.findIndex((candidate) => candidate.key === key);
    const cellAt = (from: string, to: string) =>
      layout.cells.find((cell) => cell.y === layout.rows[row(from)].y && cell.x === layout.grid.x + row(to) * cell.width);
    expect(cellAt("packages/ui", "packages/core")).toMatchObject({ kind: "error", title: expect.stringContaining("breaks ui-without-core") });
    // A cycle's upward cell is the accent, the diagonal holds the pairs inside a unit.
    expect(layout.cells.filter((cell) => cell.kind === "accent").length).toBeGreaterThan(0);
    expect(layout.cells.filter((cell) => cell.kind === "diagonal").every((cell) => cell.title.endsWith("file pairs inside"))).toBe(true);
    expect(layout.text).toEqual((await layoutDiagram(diagram)).text);
    const svg = renderDiagramSvg(layout);
    expectSafeMarkup(svg);
    expect(svg).toContain('class="cell error"');
    expect(svg).not.toContain("width = file pairs");
    await expect(svg).toMatchFileSnapshot("__snapshots__/workspaces-project.matrix.svg");
    expectSafeMarkup(renderDiagramHtml(layout));
  }, 60_000);

  it("draws only the units of a role and the edges of at least min. imports, named in the caption (#448)", async () => {
    const source = await fixtureSource();
    const { violations } = checkArchitecture(source.graph, source.assignment, RULES);
    const all = architectureDiagramInput(source, rootDir, { violations });
    const role = source.units.units.find((unit) => unit.key === "packages/core")!.role;
    const kept = new Set(source.units.units.filter((unit) => unit.role === role).map((unit) => unit.key));
    expect(kept.size).toBeLessThan(all.nodes.length);
    const byRole = architectureDiagramInput(source, rootDir, { violations, role });
    expect(byRole.nodes.map((node) => node.key).sort()).toEqual([...kept].sort());
    expect(byRole.edges.length).toBeGreaterThan(0);
    expect(byRole.edges.every((edge) => kept.has(edge.from) && kept.has(edge.to))).toBe(true);
    expect(byRole.filters).toEqual([`role ${role}`]);
    // Only the violations between two units of the role count.
    const unitOf = (file: string) => source.assignment.unitOf.get(file)!;
    const between = violations.filter(({ source: from, target: to }) => kept.has(unitOf(from)) && kept.has(unitOf(to)) && unitOf(from) !== unitOf(to));
    expect(byRole.violations).toBe(between.length);
    expect(architectureDiagramInput(source, rootDir, { role: "no-such-role" }).nodes).toEqual([]);

    const strongest = Math.max(...all.edges.map((edge) => edge.fileEdgeCount));
    const strong = architectureDiagramInput(source, rootDir, { violations, minImports: strongest });
    expect(strong.nodes).toEqual(all.nodes);
    expect(strong.edges).toEqual(all.edges.filter((edge) => edge.fileEdgeCount >= strongest));
    expect(strong.violations).toBe(all.violations);
    expect(strong.filters).toEqual([`min. ${strongest} imports`]);
    expect(architectureDiagramInput(source, rootDir, { minImports: 1 })).not.toHaveProperty("filters");
    const both = architectureDiagramInput(source, rootDir, { role, minImports: 2, folder: undefined });
    expect(both.filters).toEqual([`role ${role}`, "min. 2 imports"]);
    const layout = await layoutDiagram(both);
    expectSoundGeometry(layout);
    expect(layout.text.caption).toMatch(new RegExp(`^units · role ${role} · min\\. 2 imports · revision `));
    // A folder level has no role: only min. imports applies.
    expect(architectureDiagramInput(source, rootDir, { folder: "apps/web", role, minImports: 2 })).toMatchObject({ filters: ["min. 2 imports"], edges: [] });
  }, 60_000);

  it("renders a built source as the workspace renderer does for the same options (#448)", async () => {
    const source = await fixtureSource();
    const analyze = (filePath: string) => workerState.getSpider().analyze(filePath);
    for (const view of ["units", "matrix"] as const) {
      const options = { view, format: "svg", theme: "dark" } as const;
      const built = await renderSourceDiagram(source, rootDir, options);
      const fresh = await renderWorkspaceDiagram(rootDir, analyze, { ...options, indexedAt: "2026-11-06T08:00:00.000Z" });
      expect(built.markup).toBe(fresh.markup);
      expect(built.counts).toEqual(fresh.counts);
      expect(built.markup).toContain(`width="${built.width}" height="${built.height}"`);
    }
    const html = await renderSourceDiagram(source, rootDir, { view: "folder", folder: "apps/web", format: "html", theme: "light" });
    expect(html.markup).toMatch(/^<!doctype html>/i);
  }, 60_000);

  it("draws the pairs the baseline accepts apart, in the counts, edges, cells and legend", async () => {
    const source = await fixtureSource();
    const { violations } = checkArchitecture(source.graph, source.assignment, RULES);
    const diagram = architectureDiagramInput(source, rootDir, { violations: violations.map((violation) => ({ ...violation, new: false })) });
    expect(diagram.acceptedViolations).toBe(1);
    expect(diagram.edges.find((edge) => edge.rules.length > 0)).toMatchObject({ rules: ["ui-without-core"], accepted: true });
    const layout = await layoutDiagram(diagram);
    expectSoundGeometry(layout);
    expect(layout.text.counts).toMatch(/· 1 violation \(1 accepted\)$/);
    const svg = renderDiagramSvg(layout);
    expect(svg).toMatch(/class="edge accepted"[^>]*marker-end="url\(#arrow-accepted\)"/);
    expect(svg).toContain("accepted in baseline");
    expect(layoutMatrix(diagram).cells.filter((cell) => cell.kind === "accepted")).toHaveLength(1);
    // A pair outside the baseline keeps its edge an error.
    const mixed = architectureDiagramInput(source, rootDir, { violations: [...violations.map((violation) => ({ ...violation, new: false })), ...violations] });
    expect(mixed.edges.find((edge) => edge.rules.length > 0)?.accepted).toBeUndefined();
    expect(mixed).toMatchObject({ violations: 2, acceptedViolations: 1 });
  }, 60_000);

  it("lists the golden SVG's units, roles, layers, cycle and violation as a diagram spec valid against its schema (#450)", async () => {
    const diagram = await fixtureInput();
    const spec = diagramSpec(diagram);
    expectSoundSpec(spec);
    const layout = await layoutDiagram(diagram);
    expect(spec).toMatchObject({
      $schema: DIAGRAM_SPEC_SCHEMA, version: 1, workspace: "workspaces-project", level: "units", scope: "units", date: "2026-11-06",
      caption: { title: layout.text.title, caption: layout.text.caption, counts: layout.text.counts },
      counts: { ...layout.counts, edges: diagram.edges.length },
      cycles: [["packages/core", "packages/types"]],
      violations: { count: 1, accepted: 0, rules: ["ui-without-core"] },
    });
    expect(spec.nodes.map((node) => node.role)).toEqual(spec.nodes.map(() => expect.stringMatching(/^[a-z-]+$/)));
    expect(spec.edges.find((edge) => edge.rules.length > 0)).toMatchObject({ from: "packages/ui", to: "packages/core", accepted: false });
    // Forward, raw and JSON-escaped forms: a Windows root would leak as C:\\...
    for (const leak of [rootDir.replaceAll("\\", "/"), rootDir, JSON.stringify(rootDir).slice(1, -1)]) expect(JSON.stringify(spec)).not.toContain(leak);

    const folder = diagramSpec(await fixtureInput("apps/web"));
    expectSoundSpec(folder);
    expect(folder).toMatchObject({ level: "groups", scope: "apps/web", violations: { count: 1, rules: ["web-without-pages"] } });
    expect(folder.nodes.every((node) => node.role === undefined)).toBe(true);

    // The workspace renderer returns the same document, without layout.
    const rendered = await renderSourceDiagram(await fixtureSource(), rootDir, { view: "units", format: "diagram-spec", theme: "light", violations: [] });
    expect(rendered).toMatchObject({ counts: layout.text.counts.replace("1 violation", "0 violations"), width: 0, height: 0 });
    expect(rendered.markup.endsWith("}\n")).toBe(true);
    expect(JSON.parse(rendered.markup)).toEqual(JSON.parse(JSON.stringify(diagramSpec(architectureDiagramInput(await fixtureSource(), rootDir)))));
  }, 60_000);
});

describe("diagram spec", () => {
  it("lists every node past the drawing cap, sorted, and keeps the filters and accepted edges", () => {
    const many = input(Array.from({ length: 70 }, (_, index) => [`n${String(index).padStart(2, "0")}`, index % 3, 1] as [string, number, number]));
    const spec = diagramSpec({ ...many, nodes: many.nodes.toReversed(), filters: ["min. 2 imports"] });
    expectSoundSpec(spec);
    expect(spec.nodes).toHaveLength(70);
    expect(spec.nodes[0]).toEqual({ key: "n00", label: "n00", layer: 0, fileCount: 1, internalEdgeCount: 0 });
    expect(spec.layers.map((layer) => layer.layer)).toEqual([0, 1, 2]);
    expect(spec.filters).toEqual(["min. 2 imports"]);

    const accepted = input([["b", 1, 2], ["a", 0, 1]], [["b", "a", 3, "down"], ["a", "b", 1, "cycle"]]);
    accepted.edges[0] = { ...accepted.edges[0], rules: ["r2", "r1"], accepted: true };
    const withRules = diagramSpec({ ...accepted, violations: 3, acceptedViolations: 3 });
    expectSoundSpec(withRules);
    expect(withRules.edges.map((edge) => [edge.from, edge.to, edge.accepted])).toEqual([["a", "b", false], ["b", "a", true]]);
    expect(withRules.violations).toEqual({ count: 3, accepted: 3, rules: ["r1", "r2"] });
  });

  it("describes an empty level, leaves out an unknown date and replaces control characters in labels", () => {
    const empty = diagramSpec({ ...input([]), date: undefined });
    expectSoundSpec(empty);
    expect(empty).not.toHaveProperty("date");
    expect(empty).not.toHaveProperty("filters");
    expect(empty).toMatchObject({ nodes: [], edges: [], layers: [], cycles: [], caption: { counts: "0 units · 0 layers · 0 cycles · 0 violations" } });

    const hostile = input([["k", 0, 1]]);
    hostile.nodes[0].label = "a\u0007b\u202Ec";
    hostile.workspace = "w\u0000s";
    const spec = diagramSpec(hostile);
    expectSoundSpec(spec);
    expect(spec.nodes[0].label).toBe(`a${String.fromCodePoint(0xfffd)}b${String.fromCodePoint(0xfffd)}c`);
    expect(spec.workspace).toBe(`w${String.fromCodePoint(0xfffd)}s`);
  });

  it("publishes the roles and edge kinds the analyzer produces, and refuses unknown fields", () => {
    const { nodes, edges } = SPEC_SCHEMA.properties;
    expect(nodes.items.properties.role.enum).toEqual([...UNIT_ROLES]);
    expect(edges.items.properties.kind.enum).toEqual(["down", "upward", "cycle"] satisfies DiagramSpec["edges"][number]["kind"][]);
    const spec = diagramSpec(input([["a", 0, 1]]));
    expect(validateSpec({ ...spec, extra: true })).toBe(false);
    expect(validateSpec({ ...spec, nodes: [{ ...spec.nodes[0], role: "backend" }] })).toBe(false);
    expect(validateSpec({ ...spec, cycles: [["a"]] })).toBe(false);
  });
});

describe("architecture diagram rendering", () => {
  it("escapes hostile names and keeps the output free of script and URLs", async () => {
    const hostile = `<script>alert(1)</script>&"'\u0007 https://evil.example/x onload=1`;
    const diagram = input([[hostile, 1, 3], ["lib", 0, 2]], [[hostile, "lib", 2, "down"]]);
    diagram.workspace = `<img src=x onerror=alert(1)>`;
    const layout = await layoutDiagram(diagram);
    expectSoundGeometry(layout);
    for (const markup of [renderDiagramSvg(layout, "dark"), renderDiagramHtml(layout)]) {
      expect(markup).not.toContain("<script>");
      expect(markup).not.toContain("<img");
      expect(markup).not.toContain("\u0007");
      expect(markup).toContain("&lt;script&gt;");
    }
    expect(escapeXml(`a<b>&"'`)).toBe("a&lt;b&gt;&amp;&quot;&#39;");
  });

  it("caps the drawn nodes and says how many are left out", async () => {
    const diagram = input([["a", 2, 9], ["b", 1, 8], ["c", 0, 7], ["d", 0, 1], ["e", 0, 1]], [["a", "b", 1, "down"], ["b", "c", 1, "down"], ["a", "e", 1, "down"]]);
    const layout = await layoutDiagram(diagram, { maxNodes: 3 });
    expectSoundGeometry(layout);
    expect(layout.nodes.map((node) => node.key)).toEqual(["a", "b", "c"]);
    expect(layout.edges.map((edge) => `${edge.from}>${edge.to}`)).toEqual(["a>b", "b>c"]);
    expect(layout.hidden).toBe(2);
    expect(layout.counts.nodes).toBe(5);
    expect(layout.text.hidden).toBe("2 more units not drawn: the 3 largest are drawn");
    expect(renderDiagramSvg(layout)).toContain("2 more units not drawn");
    expect((await layoutDiagram(diagram)).text.hidden).toBeUndefined();
  });

  it("counts the cycles of the whole level, and draws only those the cap keeps whole", async () => {
    const diagram = input([["a", 0, 9], ["b", 0, 1], ["c", 1, 5]], [["a", "b", 1, "cycle"], ["b", "a", 1, "cycle"], ["c", "a", 1, "down"]]);
    const layout = await layoutDiagram(diagram, { maxNodes: 2 });
    expectSoundGeometry(layout);
    expect(layout.cycles).toEqual([]);
    expect(layout.counts.cycles).toBe(1);
    expect(layout.text.hidden).toBe("1 more unit not drawn: the 2 largest are drawn");
  });

  it("draws two cycles apart, sorted by their first member", async () => {
    const diagram = input(
      [["q", 0, 1], ["p", 0, 1], ["b", 0, 1], ["a", 0, 1], ["top", 1, 1]],
      [["p", "q", 1, "cycle"], ["q", "p", 1, "cycle"], ["b", "a", 1, "cycle"], ["a", "b", 1, "cycle"], ["top", "a", 1, "down"], ["top", "p", 1, "down"]],
    );
    const layout = await layoutDiagram(diagram);
    expectSoundGeometry(layout);
    expect(layout.cycles.map((cycle) => cycle.members)).toEqual([["a", "b"], ["p", "q"]]);
    expect(layout.counts.cycles).toBe(2);
  });

  it("outlines a cycle and colours upward edges with the accent", async () => {
    const diagram = input([["x", 1, 1], ["y", 1, 1], ["z", 0, 1]], [["x", "y", 1, "cycle"], ["y", "x", 4, "cycle"], ["y", "z", 1, "down"], ["z", "x", 1, "upward"]]);
    const layout = await layoutDiagram(diagram);
    expectSoundGeometry(layout);
    expect(layout.cycles.map((cycle) => cycle.members)).toEqual([["x", "y"]]);
    expect(layout.text.counts).toBe("3 units · 2 layers · 1 cycle · 0 violations");
    const svg = renderDiagramSvg(layout);
    expect(svg.match(/class="edge accent"/g)).toHaveLength(3 + 1);
    expect(svg).toContain("cycle · 2");
  });

  it("draws an empty level and an edge-less one", async () => {
    const empty = await layoutDiagram(input([]));
    expect(empty.nodes).toEqual([]);
    expect(empty.text.counts).toBe("0 units · 0 layers · 0 cycles · 0 violations");
    expectSafeMarkup(renderDiagramHtml(empty));
    const single = await layoutDiagram({ ...input([["solo", 0, 1]]), date: undefined });
    expectSoundGeometry(single);
    expect(single.text.caption).toBe("units · revision 0123456789ab");
    expect(single.nodes[0].meta).toBe("1 file · layer 0");
  });

  it("makes the HTML follow the colour scheme and the SVG take an explicit theme", async () => {
    const layout = await layoutDiagram(input([["a", 0, 1]]));
    const html = renderDiagramHtml(layout);
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain("default-src 'none'");
    expectSafeMarkup(html);
    expect(renderDiagramSvg(layout, "dark")).toContain("--bg:#0d1117");
    expect(renderDiagramSvg(layout)).toContain("--bg:#ffffff");
  });
});

describe("architecture matrix diagram", () => {
  it("caps the rows, numbers them and sizes cells for the widest count", () => {
    const diagram = input([["a", 1, 9], ["b", 0, 8], ["c", 0, 1]], [["a", "b", 123_456, "down"], ["a", "c", 1, "down"]]);
    diagram.nodes[0].internalEdgeCount = 4;
    const layout = layoutMatrix(diagram, { maxNodes: 2 });
    expectSoundMatrix(layout);
    expect(layout.rows.map((row) => row.text)).toEqual(["1 b", "2 a"]);
    expect(layout.cells.map((cell) => [cell.kind, cell.count])).toEqual([["down", 123_456], ["diagonal", 4]]);
    expect(layout.text.hidden).toBe("1 more unit not drawn: the 2 largest are drawn");
    expect(layout.grid.width / 2).toBeGreaterThan(28);
  });

  it("draws an empty level", () => {
    const layout = layoutMatrix(input([]));
    expectSoundMatrix(layout);
    expect(layout.cells).toEqual([]);
    expectSafeMarkup(renderDiagramSvg(layout, "dark"));
  });

  it("escapes hostile labels in rows and tooltips", () => {
    const hostile = `<script>x</script>`;
    const svg = renderDiagramSvg(layoutMatrix(input([[hostile, 1, 2], ["lib", 0, 1]], [[hostile, "lib", 2, "down"]])));
    expectSafeMarkup(svg);
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });
});

describe("diagram legend", () => {
  it("names the broken rules once each above the legend, under the cap note", async () => {
    const diagram = input([["a", 1, 3], ["b", 0, 2], ["c", 0, 1]], [["a", "b", 1, "down"], ["b", "c", 1, "down"]]);
    diagram.edges[0].rules = ["z-rule", "a-rule"];
    diagram.edges[1].rules = ["a-rule"];
    const layout = await layoutDiagram(diagram, { maxNodes: 2 });
    expectSoundGeometry(layout);
    expect(layout.text.rules).toBe("broken rules: a-rule, z-rule");
    const plain = await layoutDiagram(input([["a", 1, 3], ["b", 0, 2], ["c", 0, 1]]), { maxNodes: 2 });
    expect(layout.height - plain.height).toBe(20);
    const svg = renderDiagramSvg(layout);
    expect(svg.indexOf("1 more unit not drawn")).toBeLessThan(svg.indexOf("broken rules: a-rule, z-rule"));
  });

  it("cuts a long list of rule names to the canvas", async () => {
    const diagram = input([["a", 1, 1], ["b", 0, 1]], [["a", "b", 1, "down"]]);
    diagram.edges[0].rules = Array.from({ length: 30 }, (_, index) => `rule-number-${index}`);
    const layout = await layoutDiagram(diagram);
    expectSoundGeometry(layout);
    expect(layout.text.rules?.endsWith("…")).toBe(true);
  });

  it("drops the width item for the matrix and adds the baseline item when an edge is accepted", () => {
    const base = legendLayout().width;
    expect(legendLayout({ weight: false }).width).toBeLessThan(base);
    expect(legendLayout({ accepted: true }).width).toBeGreaterThan(base);
    expect(legendLayout({ accepted: true }).items.at(-1)).toMatchObject({ kind: "accepted", text: "accepted in baseline" });
  });
});

describe("diagram labels and strokes", () => {
  it("names the workspace by its last folder on every OS", () => {
    expect(workspaceName("/home/me/acme")).toBe("acme");
    expect(workspaceName("C:\\Users\\me\\acme\\")).toBe("acme");
    expect(workspaceName("/")).toBe("workspace");
  });

  it("fits labels: cut with an ellipsis, wide characters counted twice, control characters and lone surrogates replaced", () => {
    expect(fitLabel("short")).toBe("short");
    const long = fitLabel("x".repeat(50));
    expect(long).toBe(`${"x".repeat(31)}…`);
    expect(fitLabel("界".repeat(20))).toBe(`${"界".repeat(15)}…`);
    expect(fitLabel("a\u0000b\nc")).toBe("a\uFFFDb\uFFFDc");
    expect(fitLabel("a\uD800b")).toBe("a\uFFFDb");
    // Bidi overrides would show a label reversed.
    expect(fitLabel("a\u202Eb\u2066c")).toBe("a\uFFFDb\uFFFDc");
    expect(fitLabel("👩\u200D💻")).toBe("👩\u200D💻");
    expect(textWidth("界a", 10)).toBeCloseTo(3 * SIZES.monoAdvance * 10);
  });

  it("widens strokes with the file pairs, up to the cap", () => {
    expect([0, 1, 2, 4, 16, 10_000].map(strokeWidth)).toEqual([1, 1, 1.5, 2, 3, SIZES.maxStroke]);
  });
});
