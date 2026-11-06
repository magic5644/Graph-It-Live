import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { diagramLevel } from "@/analyzer/diagram/diagramStyle";
import { run as runDiagram } from "@/cli/commands/diagram";
import type { CliRuntime } from "@/cli/runtime";
import { workerState } from "@/mcp/shared/state";
import { executeExportArchitectureDiagram, INLINE_DIAGRAM_MAX_CHARS } from "@/mcp/tools/architecture";
import { ExportArchitectureDiagramParamsSchema } from "@/mcp/types";
import { startRulesWorker } from "../analyzer/architecture/rulesWorkspace";

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
const edgeOf = (stroke: string) => new RegExp(`class="edge ${stroke}"[^>]*marker-end`);

describe("diagramLevel", () => {
  it("reads a folder alone as its groups, keeps an explicit view, and turns \\ into /", () => {
    expect(diagramLevel(undefined, undefined)).toEqual({ view: "units", folder: undefined });
    expect(diagramLevel(undefined, String.raw`apps\web`)).toEqual({ view: "folder", folder: "apps/web" });
    expect(diagramLevel("matrix", "apps/web")).toEqual({ view: "matrix", folder: "apps/web" });
    expect(diagramLevel("matrix", undefined)).toEqual({ view: "matrix", folder: undefined });
  });
});

describe("export_architecture_diagram schema", () => {
  it.each([
    [{}],
    [{ view: "units", diagramFormat: "html" }],
    [{ folder: "mfe/cart" }],
    [{ view: "matrix" }],
    [{ view: "matrix", folder: "mfe/cart", theme: "dark" }],
    [{ rules: true, config: "rules/a.json", baseline: "rules/b.json", output: "docs/a.svg" }],
  ])("accepts %j", (params) => {
    expect(ExportArchitectureDiagramParamsSchema.safeParse(params).success).toBe(true);
  });

  it.each([
    [{ view: "folder" }, "view folder draws the groups of one unit or folder"],
    [{ view: "units", folder: "apps" }, "view units draws every unit"],
    [{ diagramFormat: "html", theme: "dark" }, "theme sets the colours of diagramFormat svg"],
    [{ format: "svg" }, "format"],
    [{ config: "rules.json" }, "config and baseline apply to the rules overlay"],
    [{ rules: false, baseline: "b.json" }, "config and baseline apply to the rules overlay"],
    [{ view: "graph" }, "view"],
    [{ diagramFormat: "png" }, "diagramFormat"],
    [{ output: "/etc/diagram.svg" }, "Must be relative to the workspace"],
    [{ output: String.raw`C:\diagram.svg` }, "Must be relative to the workspace"],
    [{ output: "" }, "output"],
    [{ unknown: true }, "unknown"],
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
    expect(result).toMatchObject({ format: "svg", counts: expect.stringMatching(/^\d+ units · \d+ layers · 1 cycle · 0 violations$/) });
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
    const matrix = await executeExportArchitectureDiagram({ view: "matrix", folder: String.raw`mfe\cart`, diagramFormat: "html" });
    expect(matrix.markup).toContain("folder mfe/cart");
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
