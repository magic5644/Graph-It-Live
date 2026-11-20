import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultDiagramFile, diagramLevel } from "@/analyzer/diagram/diagramStyle";
import { run as runDiagram } from "@/cli/commands/diagram";
import type { CliRuntime } from "@/cli/runtime";
import { workerState } from "@/mcp/shared/state";
import { executeExportArchitectureDiagram, INLINE_DIAGRAM_MAX_CHARS } from "@/mcp/tools/architecture";
import { ExportArchitectureDiagramParamsSchema } from "@/mcp/types";
import { startRulesWorker } from "../analyzer/architecture/rulesWorkspace";
import { indexWorkspace, wasmBuilt } from "./tools/callGraphWorkspace";

// Stands in for a diagram over the inline cap: no fixture is large enough within MAX_DIAGRAM_NODES.
const oversized = vi.hoisted(() => ({ markup: undefined as string | undefined }));
vi.mock("@/analyzer/diagram/workspaceDiagram", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/analyzer/diagram/workspaceDiagram")>();
  return {
    ...original,
    renderWorkspaceDiagram: (...args: Parameters<typeof original.renderWorkspaceDiagram>) =>
      oversized.markup === undefined ? original.renderWorkspaceDiagram(...args) : Promise.resolve({ markup: oversized.markup, counts: "big" }),
  };
});

/** A drawn edge of that stroke: the legend samples carry no arrow. */
const edgeOf = (stroke: string) => new RegExp(`class="edge s-${stroke}"[^>]*marker-end`);

describe("diagramLevel", () => {
  it("reads a folder alone as its groups, keeps an explicit view, and turns \\ into /", () => {
    expect(diagramLevel(undefined, undefined)).toEqual({ view: "units", folder: undefined });
    expect(diagramLevel(undefined, String.raw`apps\web`)).toEqual({ view: "folder", folder: "apps/web" });
    expect(diagramLevel("matrix", "apps/web")).toEqual({ view: "matrix", folder: "apps/web" });
    expect(diagramLevel("matrix", undefined)).toEqual({ view: "matrix", folder: undefined });
  });

  it("names the default file after the view: flow.<format> for a flow, architecture.<format> otherwise", () => {
    expect(defaultDiagramFile("svg")).toBe("architecture.svg");
    expect(defaultDiagramFile("diagram-spec", "matrix")).toBe("architecture.diagram-spec.json");
    expect(defaultDiagramFile("html", "flow")).toBe("flow.html");
    expect(defaultDiagramFile("diagram-spec", "flow")).toBe("flow.diagram-spec.json");
  });
});

describe("export_architecture_diagram schema", () => {
  it.each([
    [{}],
    [{ view: "units", diagramFormat: "html" }],
    [{ folder: "mfe/cart", diagramFormat: "diagram-spec" }],
    [{ folder: "mfe/cart" }],
    [{ view: "matrix" }],
    [{ view: "matrix", folder: "mfe/cart", theme: "dark" }],
    [{ rules: true, config: "rules/a.json", baseline: "rules/b.json", output: "docs/a.svg" }],
    [{ view: "flow", filePath: "src/a.ts", symbolName: "run" }],
    [{ view: "flow", filePath: "/repo/src/a.ts", symbolName: "run", startLine: 1, maxSteps: 12, diagramFormat: "html", output: "docs/flow.html" }],
  ])("accepts %j", (params) => {
    expect(ExportArchitectureDiagramParamsSchema.safeParse(params).success).toBe(true);
  });

  it.each([
    [{ view: "folder" }, "view folder draws the groups of one unit or folder"],
    [{ view: "units", folder: "apps" }, "view units draws every unit"],
    [{ diagramFormat: "html", theme: "dark" }, "theme sets the colours of diagramFormat svg"],
    [{ diagramFormat: "diagram-spec", theme: "light" }, "theme sets the colours of diagramFormat svg"],
    [{ format: "svg" }, "format"],
    [{ config: "rules.json" }, "config and baseline apply to the rules overlay"],
    [{ rules: false, baseline: "b.json" }, "config and baseline apply to the rules overlay"],
    [{ view: "graph" }, "view"],
    [{ diagramFormat: "png" }, "diagramFormat"],
    [{ output: "/etc/diagram.svg" }, "Must be relative to the workspace"],
    [{ output: String.raw`C:\diagram.svg` }, "Must be relative to the workspace"],
    [{ output: "" }, "output"],
    [{ diagramFormat: "svg", output: "out/x.html" }, "output must end with .svg for diagramFormat svg; got out/x.html"],
    [{ diagramFormat: "html", output: "out/x.svg" }, "output must end with .html for diagramFormat html"],
    [{ diagramFormat: "diagram-spec", output: "out/x.svg" }, "output must end with .json for diagramFormat diagram-spec"],
    [{ unknown: true }, "unknown"],
    [{ view: "flow" }, "view flow draws one symbol's flow: pass filePath."],
    [{ view: "flow", filePath: "src/a.ts" }, "view flow draws one symbol's flow: pass symbolName."],
    [{ view: "flow", filePath: "src/a.ts", symbolName: "run", folder: "src" }, "folder applies to view units, folder or matrix, not flow."],
    [{ view: "flow", filePath: "src/a.ts", symbolName: "run", rules: true, config: "c.json" }, "config applies to view units, folder or matrix, not flow."],
    [{ view: "flow", filePath: "src/a.ts", symbolName: "run", baseline: "b.json" }, "baseline applies to view units, folder or matrix, not flow."],
    [{ view: "flow", filePath: "src/a.ts", symbolName: "run", maxSteps: 13 }, "maxSteps"],
    [{ view: "flow", filePath: "src/a.ts", symbolName: "run", maxSteps: 0 }, "maxSteps"],
    [{ view: "flow", filePath: "src/a.ts", symbolName: "run", startLine: 0 }, "startLine is 1-based"],
    [{ view: "flow", filePath: "a\0b", symbolName: "run" }, "null bytes"],
    [{ filePath: "src/a.ts", symbolName: "run" }, "filePath applies to view flow only."],
    [{ view: "matrix", startLine: 3 }, "startLine applies to view flow only."],
    [{ maxSteps: 3 }, "maxSteps applies to view flow only."],
  ])("refuses %j", (params, message) => {
    const result = ExportArchitectureDiagramParamsSchema.safeParse(params);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(message);
  });
});

describe("export_architecture_diagram", { timeout: 60_000 }, () => {
  let root: string;
  let runtime: CliRuntime;

  beforeAll(() => {
    root = startRulesWorker();
    // The CLI dates the diagram by the last scan, the MCP tool by the call: the same day here.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T10:00:00Z"));
    const loadState = () => ({ lastScanTimestamp: "2026-11-06T08:00:00Z" });
    runtime = { workspaceRoot: root, ensureIndexed: vi.fn().mockResolvedValue(undefined), loadState } as unknown as CliRuntime;
  });

  afterEach(() => {
    oversized.markup = undefined;
  });

  afterAll(() => {
    vi.useRealTimers();
    workerState.reset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns the units as an inline SVG, the same markup graph-it diagram writes, dated the day of the call", async () => {
    const result = await executeExportArchitectureDiagram({});
    expect(result.markup).toContain("2026-11-06");
    expect(result).toMatchObject({ format: "svg", counts: expect.stringMatching(/^\d+ units · \d+ layers · 0 cycles · 0 violations$/) });
    expect(result).not.toHaveProperty("path");
    expect(result.markup).toMatch(/^<svg /);
    expect(result.markup).not.toContain(root.replaceAll("\\", "/"));
    expect(result.markup).toBe(await runDiagram(["--output", "-"], runtime, "svg"));
    expect(fs.existsSync(path.join(root, "architecture.svg"))).toBe(false);
  });

  it("draws an HTML page, the rules overlay, the matrix and a folder key given with \\", async () => {
    expect((await executeExportArchitectureDiagram({ diagramFormat: "html" })).markup).toMatch(/^<!doctype html>/);
    const rules = await executeExportArchitectureDiagram({ rules: true, theme: "dark" });
    expect(rules.markup).toMatch(edgeOf("error"));
    expect(rules.markup).toContain("--bg:#0d1117");
    expect(rules.markup).toBe(await runDiagram(["--rules", "--theme", "dark", "--output", "-"], runtime, "svg"));
    // The units are the declared elements (#776): a folder key is an element unit key.
    const matrix = await executeExportArchitectureDiagram({ view: "matrix", folder: String.raw`mfe (mfe\cart)`, diagramFormat: "html" });
    expect(matrix.markup).toContain("folder mfe (mfe/cart)");
    expect(matrix.markup).toContain('class="frame"');
  });

  it("writes the diagram to output, creating its folders, and returns the workspace-relative path", async () => {
    const result = await executeExportArchitectureDiagram({ output: path.join("docs", "diagrams", "units.svg") });
    expect(result).toEqual({ format: "svg", counts: expect.any(String), path: "docs/diagrams/units.svg", characters: expect.any(Number) });
    const written = fs.readFileSync(path.join(root, "docs", "diagrams", "units.svg"), "utf8");
    expect(written).toMatch(/^<svg /);
    expect(written).toHaveLength((result as { characters: number }).characters);
    // An existing file is replaced.
    fs.writeFileSync(path.join(root, "docs", "diagrams", "units.svg"), "old");
    await executeExportArchitectureDiagram({ output: "docs/diagrams/units.svg" });
    expect(fs.readFileSync(path.join(root, "docs", "diagrams", "units.svg"), "utf8")).toBe(written);
  });

  it("writes a diagram over the inline cap to architecture.<format>, and keeps one at the cap inline", async () => {
    oversized.markup = "x".repeat(INLINE_DIAGRAM_MAX_CHARS);
    expect(await executeExportArchitectureDiagram({})).toMatchObject({ markup: oversized.markup });
    expect(fs.existsSync(path.join(root, "architecture.svg"))).toBe(false);

    oversized.markup += "x";
    expect(await executeExportArchitectureDiagram({ diagramFormat: "html" })).toEqual({
      format: "html", counts: "big", path: "architecture.html", characters: INLINE_DIAGRAM_MAX_CHARS + 1,
    });
    expect(fs.readFileSync(path.join(root, "architecture.html"), "utf8")).toBe(oversized.markup);
    expect(await executeExportArchitectureDiagram({ diagramFormat: "diagram-spec" })).toMatchObject({ path: "architecture.diagram-spec.json" });
  });

  it("returns the diagram spec inline, the same document graph-it diagram writes", async () => {
    const result = await executeExportArchitectureDiagram({ diagramFormat: "diagram-spec", rules: true });
    expect(result).toMatchObject({ format: "diagram-spec", counts: expect.stringMatching(/ units · /) });
    expect(JSON.parse(result.markup!)).toMatchObject({ version: 1, level: "units", date: "2026-11-06" });
    // The CLI dates it by the last scan: the same day here.
    expect(result.markup).toBe(await runDiagram(["--rules", "--output", "-"], runtime, "diagram-spec"));
  });

  it.each([
    ["a parent path", () => path.join("..", "outside.svg")],
    ["a nested parent path", () => path.join("docs", "..", "..", "outside.svg")],
    ["an absolute path", () => path.join(path.dirname(root), "outside.svg")],
  ])("refuses an output outside the workspace given as %s, before any work", async (_kind, outside) => {
    oversized.markup = "never drawn";
    await expect(executeExportArchitectureDiagram({ output: outside() })).rejects.toThrow("outside workspace");
    expect(fs.existsSync(path.join(path.dirname(root), "outside.svg"))).toBe(false);
  });

  it.each([
    ["output", { output: "linked.svg" }, "linked.svg"],
    ["the default file of a diagram over the cap", {}, "architecture.svg"],
  ] as const)("refuses %s when it is a symbolic link leading outside the workspace", async (_kind, params, name) => {
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.svg`);
    fs.writeFileSync(outside, "kept");
    fs.symlinkSync(outside, path.join(root, name), "file");
    try {
      oversized.markup = "x".repeat(INLINE_DIAGRAM_MAX_CHARS + 1);
      await expect(executeExportArchitectureDiagram(params)).rejects.toThrow("escapes workspace through a symbolic link");
      expect(fs.readFileSync(outside, "utf8")).toBe("kept");
    } finally {
      fs.rmSync(path.join(root, name), { force: true });
      fs.rmSync(outside, { force: true });
    }
  });

  it("refuses rules files outside the workspace and an unknown folder", async () => {
    await expect(executeExportArchitectureDiagram({ rules: true, config: "../rules.json" })).rejects.toThrow("outside workspace");
    await expect(executeExportArchitectureDiagram({ folder: "nowhere" })).rejects.toThrow('No file below folder "nowhere"');
  });
});

// #793: the flow of one entry symbol, from a real call graph index.
describe.skipIf(!wasmBuilt)("export_architecture_diagram view flow", { timeout: 60_000 }, () => {
  let root: string;
  let runtime: CliRuntime;
  const flow = { view: "flow" as const, filePath: "src/app.ts", symbolName: "run" };

  beforeAll(async () => {
    ({ tmpDir: root, runtime } = await indexWorkspace("export-flow-", {
      "app.ts": [
        'import { load } from "./load";',
        'import { save } from "./save";',
        'import { report } from "./report";',
        'import { fail } from "./fail";',
        "/** Runs the job. */",
        "export function run(input: string) {",
        "  const data = load(input);",
        "  if (data.length === 0) {",
        "    report(\"empty\");",
        "    return;",
        "  }",
        "  try {",
        "    save(data);",
        "  } catch (error) {",
        "    fail(String(error));",
        "  }",
        "}",
        "",
      ].join("\n"),
      "load.ts": "export function load(input: string) { return input.split(','); }\n",
      "save.ts": "export function save(data: string[]) { return data.length; }\n",
      "report.ts": "export function report(text: string) { return text; }\n",
      "fail.ts": "export function fail(text: string) { return text; }\n",
      "twins.ts": "export class A { go() { return 1; } }\nexport class B { go() { return 2; } }\n",
    }));
  }, 120_000);

  afterAll(async () => {
    await runtime.dispose();
    workerState.reset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("draws the same SVG as graph-it diagram --view flow, its lanes from the call sites", async () => {
    const result = await executeExportArchitectureDiagram(flow);
    expect(result).toMatchObject({ format: "svg", counts: "5 steps · 4 calls · 0 references" });
    expect(result.markup).toContain("<title id=\"diagram-title\">Flow · run</title>");
    expect(result.markup).toMatch(/class="edge s-alternative"/);
    expect(result.markup).toMatch(/class="edge s-error-path"/);
    expect(result.markup).not.toContain(root.replaceAll("\\", "/"));
    expect(result.markup).toBe(await runDiagram(["src/app.ts#run", "--view", "flow", "--output", "-"], runtime, "svg"));
  });

  it("draws the HTML page and the flow spec as the CLI does, and writes flow.<format> past the inline cap or to output", async () => {
    const html = await executeExportArchitectureDiagram({ ...flow, diagramFormat: "html" });
    expect(html.markup).toBe(await runDiagram(["src/app.ts#run", "--view", "flow", "--output", "-"], runtime, "html"));
    const spec = await executeExportArchitectureDiagram({ ...flow, diagramFormat: "diagram-spec", maxSteps: 2 });
    expect(JSON.parse(spec.markup!)).toMatchObject({ kind: "flow", workspace: path.basename(root), entry: "src/app.ts#run", maxSteps: 2, omittedSteps: 3 });
    expect(spec.markup).toBe(await runDiagram(["src/app.ts#run", "--view", "flow", "--maxSteps", "2", "--output", "-"], runtime, "diagram-spec"));
    expect(await executeExportArchitectureDiagram({ ...flow, output: "docs/run.svg" })).toMatchObject({ path: "docs/run.svg" });
    expect(await runDiagram(["src/app.ts#run", "--view", "flow"], runtime, "svg")).toBe("Diagram written to flow.svg: 5 steps · 4 calls · 0 references.");
    expect(fs.readFileSync(path.join(root, "flow.svg"), "utf8")).toBe((await executeExportArchitectureDiagram(flow)).markup);
  });

  it("selects a homonym by its 1-based startLine and names the candidates of an ambiguous or unknown symbol", async () => {
    const twins = { view: "flow" as const, filePath: path.join(root, "src", "twins.ts"), symbolName: "go" };
    await expect(executeExportArchitectureDiagram(twins)).rejects.toThrow("Symbol 'go' is ambiguous in src/twins.ts: go (method, line 1), go (method, line 2). Pass startLine to select one.");
    expect((await executeExportArchitectureDiagram({ ...twins, startLine: 2, diagramFormat: "diagram-spec" })).markup).toContain('"line": 2');
    await expect(executeExportArchitectureDiagram({ ...twins, startLine: 3 })).rejects.toThrow("No symbol 'go' starts at line 3 in src/twins.ts.");
    await expect(executeExportArchitectureDiagram({ ...flow, symbolName: "rnu" })).rejects.toThrow("Symbol 'rnu' not found in src/app.ts. Did you mean: run?");
    await expect(executeExportArchitectureDiagram({ ...flow, filePath: "src/missing.ts" })).rejects.toThrow("File 'src/missing.ts' is not in the call graph index.");
    await expect(executeExportArchitectureDiagram({ ...flow, filePath: "../outside.ts" })).rejects.toThrow("outside workspace");
  });

  it("refuses a flow without its symbol or without a call graph source", async () => {
    const { exportArchitectureDiagram } = await import("@/mcp/tools/architecture");
    const analyze = vi.fn();
    await expect(exportArchitectureDiagram(root, analyze, { view: "flow", filePath: "src/app.ts" })).rejects.toThrow("pass filePath and symbolName");
    await expect(exportArchitectureDiagram(root, analyze, flow)).rejects.toThrow("view flow needs the call graph index");
    expect(analyze).not.toHaveBeenCalled();
  });
});
