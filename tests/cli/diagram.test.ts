import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { run as checkArchitecture } from "@/cli/commands/checkArchitecture";
import { readDiagramOptions, readDirectory, readFlowOptions, readSequenceOptions, run } from "@/cli/commands/diagram";
import { classifyError, ExitCode } from "@/cli/errors";
import type { CliRuntime } from "@/cli/runtime";
import { workerState } from "@/mcp/shared/state";
import { startRulesWorker } from "../analyzer/architecture/rulesWorkspace";
import { CliProgress } from "@/cli/progress";

/** A drawn edge of that stroke: the legend samples carry no arrow. */
const edgeOf = (stroke: string) => new RegExp(`class="edge s-${stroke}"[^>]*marker-end`);

describe("graph-it diagram options", () => {
  it("defaults to the units as an HTML page in architecture.html, without rules", () => {
    expect(readDiagramOptions([], "text")).toEqual({ view: "units", folder: undefined, theme: "light", format: "html", file: "architecture.html", rules: undefined });
    expect(readDiagramOptions([], "svg")).toMatchObject({ format: "svg", file: "architecture.svg" });
    expect(readDiagramOptions(["--output", "-"], "html")).toMatchObject({ file: "-" });
    // Without --format, the extension of --output decides; an explicit --format wins.
    expect(readDiagramOptions(["--output", "docs/Units.SVG"], "text")).toMatchObject({ format: "svg", file: "docs/Units.SVG" });
    expect(() => readDiagramOptions(["--output", "units.svg"], "html")).toThrow("--output units.svg does not match --format html: name it *.html, or pass the format of that file.");
    expect(() => readDiagramOptions(["--output", "a.html"], "svg")).toThrow("--output a.html does not match --format svg: name it *.svg");
    expect(readDiagramOptions(["--output", "page.HTM"], "html")).toMatchObject({ format: "html", file: "page.HTM" });
    expect(readDiagramOptions(["--output", "-"], "text")).toMatchObject({ format: "html" });
    expect(readDiagramOptions([], "diagram-spec")).toMatchObject({ format: "diagram-spec", file: "architecture.diagram-spec.json" });
    expect(readDiagramOptions(["--output", "units.json"], "diagram-spec")).toMatchObject({ format: "diagram-spec", file: "units.json" });
    expect(() => readDiagramOptions(["--view", "matrix"], "diagram-spec")).toThrow(expect.objectContaining({ exitCode: 4 }));
  });

  it("reads the view, the folder key with / on every OS, the theme and the rules files", () => {
    expect(readDiagramOptions(["--folder", String.raw`apps\web`], "text")).toMatchObject({ view: "folder", folder: "apps/web" });
    expect(readDiagramOptions(["--view", "matrix", "--folder", "apps/web"], "text")).toMatchObject({ view: "matrix", folder: "apps/web" });
    expect(readDiagramOptions(["--view", "matrix"], "svg")).toMatchObject({ view: "matrix", folder: undefined });
    expect(readDiagramOptions(["--theme", "dark"], "svg")).toMatchObject({ theme: "dark" });
    expect(readDiagramOptions(["--rules"], "text")).toMatchObject({ rules: { config: undefined, baseline: false } });
    expect(readDiagramOptions(["--rules", "--baseline"], "text")).toMatchObject({ rules: { baseline: "graphit.architecture.baseline.json" } });
    expect(readDiagramOptions(["--rules", "--baseline", "--output", "a.html"], "text")).toMatchObject({ file: "a.html", rules: { baseline: "graphit.architecture.baseline.json" } });
    expect(readDiagramOptions(["--rules", "--config", "c.json", "--baseline", "b.json"], "text")).toMatchObject({ rules: { config: "c.json", baseline: "b.json" } });
  });

  it.each([
    [["--view", "graph"], "text", "--view must be units or folder or matrix"],
    [["--view"], "text", "--view must be units or folder or matrix"],
    [["--view", "folder"], "text", "--view folder draws the groups of one unit or folder"],
    [["--view", "units", "--folder", "apps"], "text", "--view units draws every unit"],
    [["--folder", "--rules"], "text", "--folder must be a unit or folder key"],
    [["--theme", "dark"], "html", "--theme sets the colours of --format svg"],
    [["--theme", "light"], "diagram-spec", "--theme sets the colours of --format svg"],
    [["--theme", "sepia"], "svg", "--theme must be light or dark"],
    [["--baseline"], "text", "--config and --baseline apply to the rules overlay"],
    [["--config", "c.json"], "text", "--config and --baseline apply to the rules overlay"],
    [["--rules", "--config"], "text", "--config must be a file of the workspace"],
    [["--output"], "svg", "--output must be a file of the workspace, or - for stdout"],
  ] as const)("refuses %j with --format %s", (args, format, message) => {
    expect(() => readDiagramOptions([...args], format)).toThrow(message);
  });

  it("takes a directory instead of --folder, drawing its level", () => {
    expect(readDiagramOptions(["src/cli"], "text", "src/cli")).toMatchObject({ view: "folder", directory: "src/cli" });
    expect(readDiagramOptions(["src/cli", "--view", "matrix"], "svg", "src/cli")).toMatchObject({ view: "matrix", directory: "src/cli" });
    expect(readDiagramOptions(["src/cli"], "text", "src/cli")).not.toHaveProperty("folder");
    expect(() => readDiagramOptions(["src", "--folder", "(root)/cli"], "text", "src")).toThrow("Pass a directory or --folder <key>, not both");
    expect(() => readDiagramOptions(["src", "--view", "units"], "text", "src")).toThrow("--view units draws every unit: drop the directory or --folder");
  });

  it.each(["json", "toon", "markdown", "csv", "sarif"] as const)("refuses --format %s as an unsupported format", (format) => {
    try {
      readDiagramOptions([], format);
      expect.unreachable();
    } catch (error) {
      expect(classifyError(error)).toEqual({ message: `graph-it diagram writes --format svg, html, diagram-spec or mermaid, not "${format}".`, exitCode: ExitCode.UNSUPPORTED_FORMAT });
    }
  });

  it.each([
    [[], "mermaid"],
    [["--view", "matrix"], "mermaid"],
    [["--output", "units.mmd"], "text"],
  ] as const)("refuses Mermaid for an architecture level: %j --format %s (exit 4)", (args, format) => {
    try {
      readDiagramOptions([...args], format);
      expect.unreachable();
    } catch (error) {
      expect(classifyError(error)).toEqual({ message: "--format mermaid writes --view sequence only: use --format svg, html or diagram-spec for this view.", exitCode: ExitCode.UNSUPPORTED_FORMAT });
    }
  });
});

describe("graph-it diagram --view flow options (#793)", () => {
  const ROOT = path.resolve(__dirname, "../..");
  const REF = "src/cli/commands/diagram.ts#run";

  it("reads the entry symbol, its 1-based startLine, the step cap and flow.<format>", () => {
    const options = readFlowOptions([REF, "--view", "flow", "--maxSteps", "12", "--startLine", "1"], "svg", ROOT);
    expect(options).toMatchObject({ format: "svg", file: "flow.svg", theme: "light", request: { symbolName: "run", startLine: 1, maxSteps: 12 } });
    expect(options.request.filePath).toBe(path.join(ROOT, "src/cli/commands/diagram.ts"));
    expect(readFlowOptions([REF], "text", ROOT)).toMatchObject({ format: "html", file: "flow.html", request: { startLine: undefined, maxSteps: undefined } });
    expect(readFlowOptions([REF, "--output", "-"], "diagram-spec", ROOT)).toMatchObject({ format: "diagram-spec", file: "-" });
    expect(readFlowOptions([REF, "--theme", "dark"], "svg", ROOT)).toMatchObject({ theme: "dark" });
  });

  it.each([
    [[], "--view flow draws one symbol's flow: pass <file#symbol>", ExitCode.GENERAL_ERROR],
    [["--view", "flow"], "--view flow draws one symbol's flow: pass <file#symbol>", ExitCode.GENERAL_ERROR],
    [["src/cli/commands/diagram.ts"], "--view flow draws one symbol's flow: pass <file#symbol>", ExitCode.GENERAL_ERROR],
    [[REF, "--folder", "src"], "--folder applies to --view units, folder or matrix, not flow", ExitCode.GENERAL_ERROR],
    [[REF, "--rules"], "--rules applies to --view units, folder or matrix, not flow", ExitCode.GENERAL_ERROR],
    [[REF, "--maxSteps", "13"], '--maxSteps must be an integer between 1 and 12, got "13"', ExitCode.GENERAL_ERROR],
    [[REF, "--maxSteps", "0"], '--maxSteps must be an integer between 1 and 12, got "0"', ExitCode.GENERAL_ERROR],
    [[REF, "--startLine", "0"], '--startLine must be an integer >= 1, got "0"', ExitCode.GENERAL_ERROR],
    [[REF, "--theme", "dark", "--output", "a.html"], "--theme sets the colours of --format svg", ExitCode.GENERAL_ERROR],
    [["src/cli/commands/nope.ts#run"], "File not found: src/cli/commands/nope.ts.", ExitCode.GENERAL_ERROR],
    [["../outside.ts#run"], "resolves outside workspace", ExitCode.SECURITY_VIOLATION],
  ] as const)("refuses %j", (args, message, exitCode) => {
    try {
      readFlowOptions([...args], "text", ROOT);
      expect.unreachable();
    } catch (error) {
      expect(classifyError(error)).toMatchObject({ message: expect.stringContaining(message), exitCode });
    }
  });

  it("refuses the flow options without --view flow, and a file#symbol positional as a directory", () => {
    expect(() => readDiagramOptions(["--maxSteps", "3"], "text")).toThrow("--maxSteps applies to --view flow");
    expect(() => readDiagramOptions(["--startLine", "3"], "svg")).toThrow("--startLine applies to --view flow or sequence");
    expect(() => readDirectory([REF], ROOT)).toThrow(`a file#symbol positional needs --view flow or sequence: ${REF}`);
  });
});

describe("graph-it diagram --view sequence options (#798 b)", () => {
  const ROOT = path.resolve(__dirname, "../..");
  const REF = "src/cli/commands/diagram.ts#run";

  it("reads the entry symbol, its startLine, depth, message cap, lifelines and sequence.<format>", () => {
    const options = readSequenceOptions([REF, "--view", "sequence", "--depth", "2", "--maxMessages", "60", "--participants", "class", "--startLine", "1"], "svg", ROOT);
    expect(options).toMatchObject({ format: "svg", file: "sequence.svg", theme: "light", request: { symbolName: "run", startLine: 1, depth: 2, maxMessages: 60, participants: "class" } });
    expect(options.request.filePath).toBe(path.join(ROOT, "src/cli/commands/diagram.ts"));
    expect(readSequenceOptions([REF], "text", ROOT)).toMatchObject({ format: "html", file: "sequence.html", request: { depth: undefined, maxMessages: undefined, participants: undefined } });
    expect(readSequenceOptions([REF], "mermaid", ROOT)).toMatchObject({ format: "mermaid", file: "sequence.mmd" });
    // Without --format, an --output ending in .mmd or .mermaid writes Mermaid.
    expect(readSequenceOptions([REF, "--output", "docs/Run.MMD"], "text", ROOT)).toMatchObject({ format: "mermaid", file: "docs/Run.MMD" });
    expect(readSequenceOptions([REF, "--output", "run.mermaid"], "mermaid", ROOT)).toMatchObject({ format: "mermaid" });
    expect(readSequenceOptions([REF, "--output", "-"], "diagram-spec", ROOT)).toMatchObject({ format: "diagram-spec", file: "-" });
  });

  it.each([
    [[], "--view sequence draws one symbol's calls: pass <file#symbol>", ExitCode.GENERAL_ERROR],
    [["src/cli/commands/diagram.ts"], "--view sequence draws one symbol's calls: pass <file#symbol>", ExitCode.GENERAL_ERROR],
    [[REF, "--folder", "src"], "--folder applies to --view units, folder or matrix, not sequence", ExitCode.GENERAL_ERROR],
    [[REF, "--rules"], "--rules applies to --view units, folder or matrix, not sequence", ExitCode.GENERAL_ERROR],
    [[REF, "--maxSteps", "3"], "--maxSteps applies to --view flow, not sequence", ExitCode.GENERAL_ERROR],
    [[REF, "--depth", "0"], '--depth must be an integer >= 1, got "0"', ExitCode.GENERAL_ERROR],
    [[REF, "--maxMessages", "61"], '--maxMessages must be an integer between 1 and 60, got "61"', ExitCode.GENERAL_ERROR],
    [[REF, "--participants", "module"], '--participants must be file or class, got "module"', ExitCode.GENERAL_ERROR],
    [[REF, "--theme", "dark", "--output", "a.mmd"], "--theme sets the colours of --format svg", ExitCode.GENERAL_ERROR],
    [[REF, "--output", "a.svg", "--format", "mermaid"], "--output a.svg does not match --format mermaid: name it *.mmd", ExitCode.GENERAL_ERROR],
    [["../outside.ts#run"], "resolves outside workspace", ExitCode.SECURITY_VIOLATION],
  ] as const)("refuses %j", (args, message, exitCode) => {
    try {
      const format = args.includes("--format") ? "mermaid" : "text";
      readSequenceOptions(args.filter((arg) => arg !== "--format" && arg !== "mermaid"), format, ROOT);
      expect.unreachable();
    } catch (error) {
      expect(classifyError(error)).toMatchObject({ message: expect.stringContaining(message), exitCode });
    }
  });

  it("refuses the sequence options outside --view sequence, and Mermaid with --view flow", () => {
    expect(() => readDiagramOptions(["--depth", "2"], "text")).toThrow("--depth applies to --view sequence");
    expect(() => readDiagramOptions(["--participants", "class"], "svg")).toThrow("--participants applies to --view sequence");
    expect(() => readFlowOptions([REF, "--maxMessages", "3"], "text", ROOT)).toThrow("--maxMessages applies to --view sequence, not flow");
    expect(() => readFlowOptions([REF], "mermaid", ROOT)).toThrow(expect.objectContaining({ exitCode: ExitCode.UNSUPPORTED_FORMAT }));
  });
});

describe("graph-it diagram", { timeout: 60_000 }, () => {
  let root: string;
  let runtime: CliRuntime;

  beforeAll(() => {
    root = startRulesWorker();
    runtime = { workspaceRoot: root, progress: new CliProgress(false), ensureIndexed: vi.fn().mockResolvedValue(undefined), loadState: () => null } as unknown as CliRuntime;
  });

  afterAll(() => {
    workerState.reset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes the HTML page to architecture.html at the workspace root, creating folders for --output", async () => {
    expect(await run([], runtime, "text")).toMatch(/^Diagram written to architecture\.html: \d+ units · \d+ layers · 0 cycles · 0 violations\.$/);
    const html = fs.readFileSync(path.join(root, "architecture.html"), "utf8");
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).not.toContain(root.replaceAll("\\", "/"));
    expect(await run(["--output", "docs/diagrams/units.svg"], runtime, "svg")).toContain("Diagram written to docs/diagrams/units.svg");
    expect(fs.readFileSync(path.join(root, "docs", "diagrams", "units.svg"), "utf8")).toMatch(/^<svg /);
  });

  it("draws the rule violations in the error colour with their names, then the baseline ones apart", async () => {
    const svg = await run(["--rules", "--output", "-", "--theme", "dark"], runtime, "svg");
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain("--bg:#0d1117");
    expect(svg).toMatch(edgeOf("error"));
    // The units are the declared elements: the shared-utils ⇄ shared-ui cycle sits inside `shared`, on no edge (#776).
    expect(svg).toContain("broken rules: frontend-not-backend, functions-only-shared, mfe-isolated<");
    expect(svg).not.toContain("accepted in baseline");

    await expect(run(["--rules", "--baseline", "--output", "-"], runtime, "svg")).rejects.toThrow("Baseline graphit.architecture.baseline.json not found");
    await checkArchitecture(["--update-baseline"], runtime, "text");
    const accepted = await run(["--rules", "--baseline", "--output", "-"], runtime, "svg");
    expect(accepted).toMatch(edgeOf("accepted"));
    expect(accepted).not.toMatch(edgeOf("error"));
    expect(accepted).toMatch(/\d+ violations \(\d+ accepted\)/);
    expect(accepted).toContain("accepted in baseline");
    // Without --baseline every violation counts, the baseline file ignored.
    expect(await run(["--rules", "--output", "-"], runtime, "svg")).not.toMatch(edgeOf("accepted"));
  });

  it("writes the diagram spec of the units with the rules overlay, and of one folder's groups", async () => {
    expect(await run([], runtime, "diagram-spec")).toMatch(/^Diagram written to architecture\.diagram-spec\.json: \d+ units · /);
    const units = JSON.parse(fs.readFileSync(path.join(root, "architecture.diagram-spec.json"), "utf8"));
    expect(units).toMatchObject({ version: 1, level: "units", violations: { count: 0, rules: [] } });
    const spec = JSON.parse(await run(["--rules", "--output", "-"], runtime, "diagram-spec"));
    expect(spec.violations.rules).toEqual(["frontend-not-backend", "functions-only-shared", "mfe-isolated"]);
    expect(spec.nodes).toEqual(units.nodes);
    // --folder takes a unit key: an element instance is named "element (instance)" (#776).
    const folder = JSON.parse(await run(["--folder", "mfe (mfe/cart)", "--output", "-"], runtime, "diagram-spec"));
    expect(folder).toMatchObject({ level: "groups", scope: "mfe (mfe/cart)" });
    await expect(run(["--folder", "mfe/cart", "--output", "-"], runtime, "diagram-spec")).rejects.toThrow('No file below folder "mfe/cart". Did you mean: mfe (mfe/cart)');
    for (const leak of [root.replaceAll("\\", "/"), root, JSON.stringify(root).slice(1, -1)]) expect(JSON.stringify([units, folder])).not.toContain(leak);
  });

  // #794: a spec with the rules overlay is drawn again with the same --rules; without them its violations differ.
  it("redraws a spec of the rules overlay and of a folder unchanged, and names the field a missing --rules changes", async () => {
    fs.writeFileSync(path.join(root, "rules.json"), await run(["--rules", "--output", "-"], runtime, "diagram-spec"));
    expect(await run(["--spec", "rules.json", "--rules", "--output", "-"], runtime, "svg")).toBe(await run(["--rules", "--output", "-"], runtime, "svg"));
    await expect(run(["--spec", "rules.json", "--output", "-"], runtime, "svg")).rejects.toThrow("rules.json is stale or drawn with other rules");
    fs.writeFileSync(path.join(root, "folder.json"), await run(["--folder", "mfe (mfe/cart)", "--output", "-"], runtime, "diagram-spec"));
    const folder = await run(["--spec", "folder.json", "--output", "folder.svg"], runtime, "svg");
    expect(folder).toMatch(/^Diagram written to folder\.svg: \d+ groups? · /);
    expect(fs.readFileSync(path.join(root, "folder.svg"), "utf8")).toBe(await run(["--folder", "mfe (mfe/cart)", "--output", "-"], runtime, "svg"));
    await expect(run(["--spec", "folder.json", "--view", "units"], runtime, "svg")).rejects.toThrow("drop --view");
    // The spec spelled with \ is still the file an --output would replace.
    fs.mkdirSync(path.join(root, "specs"), { recursive: true });
    fs.copyFileSync(path.join(root, "folder.json"), path.join(root, "specs", "folder.json"));
    await expect(run(["--spec", String.raw`specs\folder.json`, "--output", "specs/folder.json"], runtime, "diagram-spec"))
      .rejects.toThrow("--output specs/folder.json would replace the spec it reads");
  });

  it("reads the leading directory against the workspace root, \\ separators included", () => {
    expect(readDirectory([], root)).toBeUndefined();
    expect(readDirectory(["--folder", "mfe/cart"], root)).toBeUndefined();
    expect(readDirectory(["."], root)).toBeUndefined();
    expect(readDirectory(["mfe/cart"], root)).toBe("mfe/cart");
    expect(readDirectory([String.raw`mfe\cart\src`], root)).toBe("mfe/cart/src");
    expect(readDirectory([path.join(root, "mfe", "cart")], root)).toBe("mfe/cart");
  });

  it.each([
    [["nowhere"], "Directory not found: nowhere"],
    [["package.json"], "Directory not found: package.json"],
    [[path.join("..", "elsewhere")], "Directory outside the workspace"],
  ])("refuses the directory %j", (args, message) => {
    expect(() => readDirectory(args, root)).toThrow(message);
  });

  it("exits 5 for a directory outside the workspace", () => {
    const error = (() => { try { return readDirectory([path.join("..", "elsewhere")], root); } catch (failure) { return failure; } })();
    expect(classifyError(error)).toMatchObject({ exitCode: ExitCode.SECURITY_VIOLATION });
  });

  it("draws the level of a directory: a unit root, an umbrella folder of it, a folder of the root unit", async () => {
    const spec = async (...args: string[]) => JSON.parse(await run([...args, "--output", "-"], runtime, "diagram-spec"));
    // The directory of an element instance draws that unit (#776).
    expect(await spec("mfe/cart")).toMatchObject({ level: "groups", scope: "mfe (mfe/cart)" });
    expect(await spec(String.raw`mfe\cart\src`)).toMatchObject({ level: "groups", scope: "mfe (mfe/cart)" });
    expect(await spec("scripts")).toMatchObject({ level: "groups", scope: "(unmatched)/scripts" });
    expect(await spec(".")).toMatchObject({ level: "units" });
    expect(await run(["mfe/cart", "--view", "matrix", "--output", "-"], runtime, "html")).toContain("folder mfe (mfe/cart)");
  });

  it("refuses a directory spanning several units or without indexed files", async () => {
    fs.mkdirSync(path.join(root, "empty"), { recursive: true });
    await expect(run(["mfe", "--output", "-"], runtime, "svg")).rejects.toThrow('"mfe" holds several units');
    await expect(run(["empty", "--output", "-"], runtime, "svg")).rejects.toThrow('No indexed file below "empty".');
    await expect(run(["nowhere", "--output", "-"], runtime, "svg")).rejects.toThrow("Directory not found: nowhere");
  });

  it("draws the matrix of the units, or of one folder's groups", async () => {
    const matrix = await run(["--view", "matrix", "--rules", "--output", "-"], runtime, "svg");
    expect(matrix).toContain('class="frame"');
    expect(matrix).toContain('class="cell s-error"');
    expect(matrix).not.toContain("width = file pairs");
    const folder = await run(["--view", "matrix", "--folder", "mfe (mfe/cart)", "--output", "-"], runtime, "html");
    expect(folder).toContain("folder mfe (mfe/cart)");
  });

  it.each([
    ["a relative path", () => path.join("..", "outside.html")],
    ["an absolute path", () => path.join(path.dirname(root), "outside.html")],
  ])("refuses an output outside the workspace given as %s, before any work", async (_kind, outside) => {
    const ensureIndexed = vi.mocked(runtime.ensureIndexed);
    ensureIndexed.mockClear();
    const error = await run(["--output", outside()], runtime, "text").catch((failure: unknown) => failure);
    expect(classifyError(error)).toMatchObject({ exitCode: ExitCode.SECURITY_VIOLATION, message: expect.stringContaining("it is outside the workspace") });
    expect(ensureIndexed).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(path.dirname(root), "outside.html"))).toBe(false);
  });

  it("refuses rules files outside the workspace, as check-architecture does, and an unknown folder", async () => {
    for (const args of [["--rules", "--config", "../rules.json"], ["--rules", "--baseline", "../baseline.json"]]) {
      const error = await run([...args, "--output", "-"], runtime, "svg").catch((failure: unknown) => failure);
      expect(classifyError(error), args.join(" ")).toMatchObject({ exitCode: ExitCode.SECURITY_VIOLATION });
    }
    await expect(run(["--folder", "nowhere", "--output", "-"], runtime, "svg")).rejects.toThrow('No file below folder "nowhere"');
  });
});
