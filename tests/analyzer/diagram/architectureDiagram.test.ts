import * as path from "node:path";
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
import { escapeXml, renderDiagramHtml, renderDiagramSvg } from "@/analyzer/diagram/diagramSvg";
import { SIZES } from "@/analyzer/diagram/diagramStyle";
import { Parser } from "@/analyzer/Parser";
import { SpiderBuilder } from "@/analyzer/SpiderBuilder";
import { PathResolver } from "@/analyzer/utils/PathResolver";
import { workerState } from "@/mcp/shared/state";

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
  const lines = [[layout.text.title, SIZES.title], [layout.text.caption, SIZES.caption], [layout.text.counts, SIZES.caption], [layout.text.hidden ?? "", SIZES.caption]] as const;
  for (const [line, size] of lines) expect(textWidth(line, size), line).toBeLessThanOrEqual(layout.width - 2 * SIZES.margin);
  expect(legendLayout().width).toBeLessThanOrEqual(layout.width - 2 * SIZES.margin);
}

/** No script, no foreignObject, no URL but the SVG namespace. */
function expectSafeMarkup(markup: string): void {
  expect(markup).not.toMatch(/<script|foreignObject|href=|\son\w+=|url\((?!#arrow-)/i);
  expect(markup.match(/https?:\/\/[^"\s]*/g)?.filter((url) => url !== "http://www.w3.org/2000/svg") ?? []).toEqual([]);
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
