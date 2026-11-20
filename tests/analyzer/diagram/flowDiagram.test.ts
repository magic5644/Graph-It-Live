import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CallGraphIndexer } from "@/analyzer/callgraph/CallGraphIndexer";
import { fileExtToLang, GraphExtractor } from "@/analyzer/callgraph/GraphExtractor";
import { layoutFlow, type FlowLayout, type Point } from "@/analyzer/diagram/flowDiagram";
import { buildFlowModel, type FlowEdge, type FlowLane, type FlowModel, type FlowNode } from "@/analyzer/diagram/flowModel";
import { defaultDiagramFile, diagramLevel, LEGEND, MAX_FLOW_STEPS } from "@/analyzer/diagram/diagramStyle";
import { renderDiagramHtml, renderDiagramSvg } from "@/analyzer/diagram/diagramSvg";
import type { SupportedLang } from "@/shared/callgraph-types";
import { normalizePath } from "@/shared/path";

const node = (name: string, lane: FlowLane = "main", extra: Partial<FlowNode> = {}): FlowNode => ({
  id: `src/${name}.ts#${name}`, title: name, file: `src/${name}.ts`, line: 1, lane, symbolCount: 1, ...extra,
});

const edge = (from: string, to: string, line: number, extra: Partial<FlowEdge> = {}): FlowEdge => ({
  from: `src/${from}.ts#${from}`, to: `src/${to}.ts#${to}`, file: `src/${from}.ts`, line, relation: "CALLS", lane: "main", ...extra,
});

function model(nodes: FlowNode[], edges: FlowEdge[], extra: Partial<FlowModel> = {}): FlowModel {
  return { entry: nodes[0].id, language: "typescript", lanes: "detected", maxSteps: 8, nodes, edges, omittedSteps: 0, ...extra };
}

/** The entry calls three steps, one per lane. */
const LANES = model(
  [node("run", "main", { subtitle: "Runs the command." }), node("load"), node("skip", "alternative"), node("fail", "error")],
  [edge("run", "load", 2), edge("run", "skip", 3, { lane: "alternative", condition: "input === null" }), edge("run", "fail", 5, { lane: "error", condition: "!valid" })],
);

/** a → b → c and a → c: c sits after b, the second call to it is forward too; c → b is a back edge (diamond). */
const DIAMOND = model([node("a"), node("b"), node("c")], [edge("a", "b", 2), edge("b", "c", 3), edge("c", "b", 4), edge("a", "c", 5)]);

/** run → walk → run: the recursion returns to the entry, before the first column. */
const RECURSION = model([node("run"), node("walk")], [edge("run", "walk", 2), edge("walk", "run", 7)]);

const LONG = "aVeryLongFunctionNameThatKeepsGoingAndGoing";
const TWELVE = model(
  Array.from({ length: MAX_FLOW_STEPS }, (_, index) =>
    node(`${LONG}${index}`, (["main", "alternative", "error"] as const)[index % 3], {
      subtitle: "A doc comment sentence that is much longer than forty characters.",
      file: `src/some/deeply/nested/folder/${LONG}${index}.ts`, line: 100 + index, symbolCount: index + 1,
    })),
  Array.from({ length: MAX_FLOW_STEPS - 1 }, (_, index) =>
    edge(`${LONG}${index % 4}`, `${LONG}${index + 1}`, 10 + index, {
      lane: (["main", "alternative", "error"] as const)[(index + 1) % 3],
      ...(index % 2 === 0 ? { condition: "options.verbose && !options.quiet" } : {}),
    })),
  { maxSteps: MAX_FLOW_STEPS, omittedSteps: 3 },
);

interface Segment { a: Point; b: Point }
const segments = (points: readonly Point[]): Segment[] => points.slice(1).map((b, index) => ({ a: points[index], b }));

/** True when an axis-aligned segment enters a box's interior (touching its border is allowed). */
function crossesBox({ a, b }: Segment, box: { x: number; y: number; width: number; height: number }): boolean {
  const [x1, x2] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
  const [y1, y2] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
  return x2 > box.x && x1 < box.x + box.width && y2 > box.y && y1 < box.y + box.height;
}

function expectNoEdgeAcrossBoxes(layout: FlowLayout): void {
  for (const placed of layout.edges) {
    for (const segment of segments(placed.points)) {
      expect(segment.a.x === segment.b.x || segment.a.y === segment.b.y, `${placed.title} is axis-aligned`).toBe(true);
      for (const box of layout.nodes) expect(crossesBox(segment, box), `${placed.title} crosses ${box.id}`).toBe(false);
    }
  }
}

function expectInCanvas(layout: FlowLayout): void {
  for (const box of layout.nodes) {
    expect(box.x + box.width).toBeLessThanOrEqual(layout.width);
    expect(box.y + box.height).toBeLessThanOrEqual(layout.height);
  }
  for (const point of layout.edges.flatMap((placed) => [...placed.points, placed.label])) {
    expect(point.x).toBeGreaterThanOrEqual(0);
    expect(point.y).toBeLessThanOrEqual(layout.height);
  }
}

describe("layoutFlow (#793)", () => {
  it("draws one step without edges and without channel room", () => {
    const layout = layoutFlow(model([node("run")], []), "/home/me/work/shop");
    expect(layout.nodes).toHaveLength(1);
    expect(layout.edges).toEqual([]);
    expect(layout.lanes.map((lane) => lane.text)).toEqual(["main"]);
    // No channel above: the box sits in its band right under the header.
    expect(layout.nodes[0].y - layout.top).toBe(22);
    expect(layout.text).toMatchObject({ title: "Flow · run", caption: "shop · src/run.ts:1 · typescript", counts: "1 step · 0 calls · 0 references", hidden: [] });
    const svg = renderDiagramSvg(layout);
    expect(svg).not.toContain("/home/me");
    expect(svg).toContain('class="node entry"');
  });

  it("puts each step in its own column and each lane on its own row, main first", () => {
    const layout = layoutFlow(LANES, "shop");
    const xs = layout.nodes.map((box) => box.x);
    expect(xs).toEqual(xs.toSorted((left, right) => left - right));
    expect(new Set(xs).size).toBe(4);
    const [run, load, skip, fail] = layout.nodes;
    expect(run.y + run.height / 2).toBe(load.y + load.height / 2);
    expect(skip.y).toBeGreaterThan(load.y);
    expect(fail.y).toBeGreaterThan(skip.y);
    expect(layout.lanes.map((lane) => lane.text)).toEqual(["main", "alternative", "error"]);
    expect(run).toMatchObject({ entry: true, subtitle: "Runs the command.", height: 60, meta: "src/run.ts:1 · 1 symbol" });
    expect(load).toMatchObject({ entry: false, height: 44 });
    expect(layout.edges.map((placed) => [placed.kind, placed.label.text])).toEqual([
      ["main", "line 2"],
      ["alternative", "input === null"],
      ["error-path", "!valid"],
    ]);
    // Neighbour on the same row: one straight line.
    expect(layout.edges[0].points).toHaveLength(2);
    expect(layout.edges[2].title).toBe("src/run.ts#run → src/fail.ts#fail: src/run.ts:5 (CALLS, error)");
    expect(layout.text.counts).toBe("4 steps · 3 calls · 0 references");
    expectNoEdgeAcrossBoxes(layout);
    expectInCanvas(layout);
    const svg = renderDiagramSvg(layout, "dark");
    for (const style of ["s-main", "s-alternative", "s-error-path", "main lane", "alternative lane", "error lane", "thick border: entry"]) expect(svg).toContain(style);
    expect(svg).not.toContain("dependency");
    expect(svg).not.toContain("reference</text>");
  });

  it("routes forward calls over the rows and calls back to an earlier step under them, each on its own channel and track", () => {
    const layout = layoutFlow(DIAMOND, "shop");
    const rowsTop = Math.min(...layout.nodes.map((box) => box.y));
    const rowsBottom = Math.max(...layout.nodes.map((box) => box.y + box.height));
    const channelY = (index: number) => layout.edges[index].points[2].y;
    expect(layout.edges[3].points).toHaveLength(6);
    expect(channelY(3)).toBeLessThan(rowsTop);
    expect(layout.edges[2].points).toHaveLength(6);
    expect(channelY(2)).toBeGreaterThan(rowsBottom);
    // Two edges end in the gap before c: their labels stack, their tracks differ.
    const intoC = layout.edges.filter((placed) => placed.to === "src/c.ts#c");
    expect(new Set(intoC.map((placed) => placed.label.y)).size).toBe(2);
    expect(new Set(intoC.map((placed) => placed.points.at(-2)!.x)).size).toBe(2);
    expectNoEdgeAcrossBoxes(layout);
  });

  it("routes a recursion back into the entry through the gap before the first column", () => {
    const layout = layoutFlow(RECURSION, "shop");
    const back = layout.edges[1];
    const [entry] = layout.nodes;
    expect(back.points.at(-1)).toEqual({ x: entry.x, y: back.points.at(-1)!.y });
    expect(back.points.at(-2)!.x).toBeLessThan(entry.x);
    expect(back.points.at(-2)!.x).toBeGreaterThan(layout.lanes[0].x);
    expect(back.label.x).toBeLessThan(entry.x);
    expect(back.label.text).toBe("line 7");
    expectNoEdgeAcrossBoxes(layout);
  });

  it("fits 12 steps with long names: titles, subtitles and files cut, labels at most 20 cells, no edge across a box", () => {
    const layout = layoutFlow(TWELVE, "shop");
    expect(layout.nodes).toHaveLength(12);
    for (const box of layout.nodes) {
      expect([...box.text].length).toBeLessThanOrEqual(32);
      expect([...box.subtitle!].length).toBeLessThanOrEqual(40);
      expect(box.width).toBeLessThanOrEqual(320);
      expect(box.width % 4).toBe(0);
    }
    for (const placed of layout.edges) expect([...placed.label.text].length).toBeLessThanOrEqual(20);
    expect(layout.width % 4).toBe(0);
    expect(layout.height % 4).toBe(0);
    expect(layout.nodes[0].meta).toMatch(/^src\/so.*….*0\.ts:100 · 1 symbol$/);
    expectNoEdgeAcrossBoxes(layout);
    expectInCanvas(layout);
    expect(layout.text.hidden).toEqual(["3 callees past the step cap left out: 12 steps is the most a flow draws"]);
  });

  it("names the rerun step count when the cap was below 12, at most 12", () => {
    const few = model([node("run"), node("load")], [edge("run", "load", 2)], { maxSteps: 2, omittedSteps: 1 });
    expect(layoutFlow(few, "shop").text.hidden).toEqual(["1 callee past the step cap left out: rerun with --maxSteps 3"]);
    const many = { ...few, maxSteps: 8, omittedSteps: 30 };
    expect(layoutFlow(many, "shop").text.hidden).toEqual(["30 callees past the step cap left out: rerun with --maxSteps 12"]);
  });

  it("notes a language whose lanes are not read", () => {
    const go = model([node("run"), node("load")], [edge("run", "load", 2)], { language: "go", lanes: "unsupported" });
    const layout = layoutFlow(go, "shop");
    expect(layout.text.hidden).toEqual(["lanes not read for go: every step on main, in call order"]);
    expect(layout.text.caption).toBe("shop · src/run.ts:1 · go");
    expect(renderDiagramSvg(layout)).toContain("lanes not read for go");
  });

  it("draws a reference dotted with its own label and count", () => {
    const refs = model([node("run"), node("handler"), node("load")], [edge("run", "handler", 4, { relation: "REFERENCES" }), edge("run", "load", 6)]);
    const layout = layoutFlow(refs, "shop");
    expect(layout.edges[0]).toMatchObject({ kind: "reference", label: { text: "ref · line 4" } });
    expect(layout.edges[0].title).toContain("(REFERENCES, main)");
    expect(layout.text.counts).toBe("3 steps · 1 call · 1 reference");
    expect(renderDiagramSvg(layout)).toContain("s-reference");
    expectNoEdgeAcrossBoxes(layout);
  });

  it("gives the same layout and markup for the same model", () => {
    for (const fixture of [LANES, DIAMOND, RECURSION, TWELVE]) {
      expect(layoutFlow(fixture, "shop")).toEqual(layoutFlow(structuredClone(fixture), "shop"));
      expect(renderDiagramHtml(layoutFlow(fixture, "shop"))).toBe(renderDiagramHtml(layoutFlow(fixture, "shop")));
    }
  });

  it("escapes every text and never draws an absolute path", () => {
    const evil = model(
      [node("run", "main", { title: "<script>alert(1)</script>", subtitle: 'Says "hi" & <b>', id: "src/run.ts#<script>" }), node("load")],
      [edge("run", "load", 2, { from: "src/run.ts#<script>", condition: "a < b && c > d" })],
    );
    const layout = layoutFlow(evil, "/Users/someone/private/shop");
    for (const markup of [renderDiagramSvg(layout), renderDiagramHtml(layout)]) {
      expect(markup).not.toContain("<script>");
      expect(markup).not.toContain("<b>");
      expect(markup).toContain("&lt;script&gt;");
      expect(markup).toContain("a &lt; b &amp;&amp; c &gt; d");
      expect(markup).not.toContain("/Users/someone");
    }
    expect(layout.text.title).toBe("Flow · <script>alert(1)</script>");
  });

  it("skips an edge whose ends are not steps of the model", () => {
    const stray = model([node("run")], [edge("run", "ghost", 2), edge("run", "run", 3)]);
    expect(layoutFlow(stray, "shop").edges).toEqual([]);
  });
});

describe("diagramStyle", () => {
  it("names the flow legend kinds, the step cap, default files and levels", () => {
    expect(MAX_FLOW_STEPS).toBe(12);
    expect(LEGEND.alternative).toMatchObject({ colour: "line", dash: "6 3" });
    expect(LEGEND["error-path"].colour).toBe("error");
    expect(LEGEND.reference).toMatchObject({ dash: "1 3" });
    expect(defaultDiagramFile("svg")).toBe("architecture.svg");
    expect(defaultDiagramFile("diagram-spec")).toBe("architecture.diagram-spec.json");
    expect(diagramLevel(undefined, String.raw`app\core`)).toEqual({ view: "folder", folder: "app/core" });
    expect(diagramLevel("matrix", undefined)).toEqual({ view: "matrix", folder: undefined });
  });
});

describe("layoutFlow on a built flow model", () => {
  let root: string;
  let extractor: GraphExtractor;

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gil-flowdiagram-")));
    for (const dir of ["dist/wasm", "dist/queries"]) await fs.mkdir(path.join(root, dir), { recursive: true });
    await fs.copyFile("node_modules/web-tree-sitter/web-tree-sitter.wasm", path.join(root, "dist/wasm/tree-sitter.wasm"));
    for (const grammar of ["typescript", "tsx"]) {
      await fs.copyFile(`node_modules/tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`, path.join(root, `dist/wasm/tree-sitter-${grammar}.wasm`));
      await fs.copyFile(`resources/queries/${grammar}.scm`, path.join(root, `dist/queries/${grammar}.scm`));
    }
    extractor = new GraphExtractor({ extensionPath: root, workspaceRoot: root });
  });

  afterAll(async () => {
    extractor.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("draws a command's flow from the call graph index", async () => {
    const exported = (name: string) => `export function ${name}(x?: unknown): unknown {\n  return x;\n}\n`;
    const files: Record<string, string> = {
      "src/command.ts": [
        'import { load } from "./load";',
        'import { validate } from "./validate";',
        'import { report } from "./report";',
        'import { audit } from "./audit";',
        'import { save } from "./save";',
        "/** Places an order. Validates it first. */",
        "export function placeOrder(input: string) {",
        "  const order = load(input);",
        "  if (!validate(order)) {",
        "    throw new Error(report(order));",
        "  }",
        "  if (order === null) {",
        "    return audit(order);",
        "  }",
        "  return save(order);",
        "}",
        "",
      ].join("\n"),
      "src/load.ts": exported("load"),
      "src/validate.ts": exported("validate"),
      "src/report.ts": exported("report"),
      "src/audit.ts": exported("audit"),
      "src/save.ts": exported("save"),
    };
    for (const [name, source] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await fs.writeFile(path.join(root, name), source);
    }
    const indexer = new CallGraphIndexer(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
    await indexer.init();
    try {
      for (const [name, source] of Object.entries(files)) {
        const file = normalizePath(path.join(root, name));
        const result = await extractor.extractSource(file, fileExtToLang(file) as SupportedLang, source);
        indexer.indexFile(result.nodes, result.edges, file, fileExtToLang(file) as SupportedLang, 1);
      }
      indexer.resolveExternalEdges();
      const flow = await buildFlowModel(indexer.getDb(), { filePath: path.join(root, "src/command.ts"), symbolName: "placeOrder" }, { rootDir: root, extractor });
      const layout = layoutFlow(flow, root);
      expect(layout.text.title).toBe("Flow · placeOrder");
      expect(layout.lanes.map((lane) => lane.text)).toEqual(["main", "alternative", "error"]);
      expect(layout.edges.map((placed) => placed.kind)).toEqual(["main", "main", "error-path", "alternative", "main"]);
      expectNoEdgeAcrossBoxes(layout);
      const svg = renderDiagramSvg(layout);
      expect(svg).not.toContain(root);
      expect(svg).toContain("Places an order.");
      if (process.env.FLOW_DIAGRAM_OUT) {
        await fs.writeFile(path.join(process.env.FLOW_DIAGRAM_OUT, "real.svg"), svg);
        await fs.writeFile(path.join(process.env.FLOW_DIAGRAM_OUT, "real-dark.svg"), renderDiagramSvg(layout, "dark"));
        await fs.writeFile(path.join(process.env.FLOW_DIAGRAM_OUT, "real.html"), renderDiagramHtml(layout));
        await fs.writeFile(path.join(process.env.FLOW_DIAGRAM_OUT, "twelve.svg"), renderDiagramSvg(layoutFlow(TWELVE, "shop")));
        await fs.writeFile(path.join(process.env.FLOW_DIAGRAM_OUT, "twelve-dark.svg"), renderDiagramSvg(layoutFlow(TWELVE, "shop"), "dark"));
        await fs.writeFile(path.join(process.env.FLOW_DIAGRAM_OUT, "twelve.html"), renderDiagramHtml(layoutFlow(TWELVE, "shop")));
        await fs.writeFile(path.join(process.env.FLOW_DIAGRAM_OUT, "diamond.svg"), renderDiagramSvg(layoutFlow(DIAMOND, "shop")));
      }
    } finally {
      indexer.dispose();
    }
  });
});
