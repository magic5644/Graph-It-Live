/**
 * MCP user contract (#769, .claude/rules/user-contract.md): every tool × {each
 * response format, unknown parameter, invalid value, missing required
 * parameter, missing target}, through the built `graph-it serve` over stdio.
 *
 * The tool list comes from tools/list, so a new tool fails here until it has
 * its rows; a new parameter fails until the description names it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeSession, startMcpSession, type ToolResult } from "../../scripts/mcpSession.mts";
import { elementsWorkspace, rootWorkspace } from "../cli/architectureUnitsFixture";

const REPO_ROOT = path.resolve(__dirname, "../..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist/graph-it.js");
const distExists = fs.existsSync(DIST_ENTRY) && fs.existsSync(path.join(REPO_ROOT, "dist/mcpServer.mjs"));
const TIMEOUT_MS = 240_000;
const FORMATS = ["toon", "json", "markdown"] as const;

type Args = Record<string, unknown>;
interface ListedTool {
  name: string;
  description: string;
  inputSchema: { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
}

let root = "";
const contractRoot = (workspace: string) => {
  root = workspace;
};

/** One valid call per tool, on the fixture below. */
const VALID: Record<string, () => Args> = {
  set_workspace: () => ({ workspacePath: root }),
  analyze_dependencies: () => ({ filePath: "src/a.ts" }),
  crawl_dependency_graph: () => ({ entryFile: "src/a.ts" }),
  find_referencing_files: () => ({ targetPath: "src/b.ts" }),
  verify_dependency_usage: () => ({ sourceFile: "src/a.ts", targetFile: "src/b.ts" }),
  resolve_module_path: () => ({ fromFile: "src/a.ts", moduleSpecifier: "./b" }),
  get_index_status: () => ({}),
  invalidate_files: () => ({ filePaths: ["src/a.ts"] }),
  rebuild_index: () => ({}),
  get_symbol_graph: () => ({ filePath: "src/a.ts" }),
  find_unused_symbols: () => ({ filePath: "src/b.ts", minConfidence: "low" }),
  trace_function_execution: () => ({ filePath: "src/a.ts", symbolName: "run" }),
  analyze_breaking_changes: () => ({ filePath: "src/b.ts", oldContent: "export function helper(x: number) { return x; }\n" }),
  review_pr: () => ({ baseRef: "HEAD" }),
  get_impact_analysis: () => ({ filePath: "src/b.ts", symbolName: "helper" }),
  generate_codemap: () => ({ filePath: "src/a.ts" }),
  query_call_graph: () => ({ filePath: "src/a.ts", symbolName: "run" }),
  scan_dead_code: () => ({ scopePath: "src" }),
  graph_context: () => ({ mode: "neighbors", seeds: [{ filePath: "src/a.ts", symbolName: "run" }] }),
  explore_architecture: () => ({ level: "units" }),
  check_architecture: () => ({}),
  export_architecture_diagram: () => ({}),
  query_natural_language: () => ({ question: "what calls helper" }),
  generate_wiki: () => ({ outputDir: "wiki-out" }),
  get_session_stats: () => ({}),
};

/** One invalid value per tool: refused before any work, naming the parameter and what it accepts. */
const INVALID_VALUE: Record<string, { args: Args; message: string }> = {
  set_workspace: { args: { maxDepth: 0 }, message: '"maxDepth" must be >= 1; got 0.' },
  analyze_dependencies: { args: { filePath: 3 }, message: '"filePath" must be a string; got 3.' },
  crawl_dependency_graph: { args: { communityMode: "x" }, message: '"communityMode" must be one of path, louvain; got "x".' },
  find_referencing_files: { args: { targetPath: true }, message: '"targetPath" must be a string; got true.' },
  verify_dependency_usage: { args: { targetFile: [] }, message: '"targetFile" must be a string; got an array.' },
  resolve_module_path: { args: { moduleSpecifier: 1 }, message: '"moduleSpecifier" must be a string; got 1.' },
  get_index_status: { args: { response_format: "xml" }, message: '"response_format" must be one of toon, json, markdown; got "xml".' },
  invalidate_files: { args: { filePaths: "src/a.ts" }, message: '"filePaths" must be an array; got "src/a.ts".' },
  rebuild_index: { args: { response_format: "yaml" }, message: '"response_format" must be one of toon, json, markdown; got "yaml".' },
  get_symbol_graph: { args: { filePath: null }, message: '"filePath" must be a string; got null.' },
  find_unused_symbols: { args: { minConfidence: "x" }, message: '"minConfidence" must be one of high, medium, low; got "x".' },
  trace_function_execution: { args: { maxDepth: 101 }, message: '"maxDepth" must be <= 100; got 101.' },
  analyze_breaking_changes: { args: { newContent: 5 }, message: '"newContent" must be a string; got 5.' },
  review_pr: { args: { maxDepth: 11 }, message: '"maxDepth" must be <= 10; got 11.' },
  get_impact_analysis: { args: { includeTransitive: "yes" }, message: '"includeTransitive" must be true or false; got "yes".' },
  generate_codemap: { args: { filePath: 1 }, message: '"filePath" must be a string; got 1.' },
  query_call_graph: { args: { direction: "up" }, message: '"direction" must be one of callers, callees, both; got "up".' },
  scan_dead_code: { args: { maxFiles: 0 }, message: '"maxFiles" must be >= 1; got 0.' },
  graph_context: { args: { detail: "huge" }, message: '"detail" must be one of compact, standard, full; got "huge".' },
  explore_architecture: { args: { level: "x" }, message: '"level" must be one of groups, units; got "x".' },
  check_architecture: { args: { limit: 0 }, message: '"limit" must be >= 1; got 0.' },
  export_architecture_diagram: { args: { diagramFormat: "png" }, message: '"diagramFormat" must be one of svg, html, diagram-spec; got "png".' },
  query_natural_language: { args: { depth: 9 }, message: '"depth" must be <= 5; got 9.' },
  generate_wiki: { args: { topHubsLimit: 0 }, message: '"topHubsLimit" must be >= 1; got 0.' },
  get_session_stats: { args: { response_format: "csv" }, message: '"response_format" must be one of toon, json, markdown; got "csv".' },
};

/** A target that does not exist: an error naming it and the closest candidates, never an empty success. */
const MISSING_TARGET: Record<string, { args: () => Args; message: string }> = {
  set_workspace: { args: () => ({ workspacePath: path.join(root, "nope") }), message: "Path does not exist: nope" },
  analyze_dependencies: { args: () => ({ filePath: "src/aa.ts" }), message: "File not found: src/aa.ts. Did you mean: src/a.ts" },
  crawl_dependency_graph: { args: () => ({ entryFile: "src/nope.ts" }), message: "File not found: src/nope.ts." },
  find_referencing_files: { args: () => ({ targetPath: "src/bb.ts" }), message: "File not found: src/bb.ts. Did you mean: src/b.ts" },
  verify_dependency_usage: { args: () => ({ sourceFile: "src/a.ts", targetFile: "src/nope.ts" }), message: "File not found: src/nope.ts." },
  resolve_module_path: { args: () => ({ fromFile: "src/nope.ts", moduleSpecifier: "./b" }), message: "File not found: src/nope.ts." },
  invalidate_files: { args: () => ({ filePaths: ["src/nope.ts"] }), message: "File not found: src/nope.ts: neither on disk nor in the index." },
  get_symbol_graph: { args: () => ({ filePath: "src/nope.ts" }), message: "File not found: src/nope.ts." },
  find_unused_symbols: { args: () => ({ filePath: "src/nope.ts" }), message: "File not found: src/nope.ts." },
  trace_function_execution: { args: () => ({ filePath: "src/a.ts", symbolName: "rnu" }), message: "Symbol 'rnu' not found in src/a.ts. Did you mean: run?" },
  analyze_breaking_changes: { args: () => ({ filePath: "src/nope.ts", oldContent: "" }), message: "File not found: src/nope.ts." },
  review_pr: { args: () => ({ baseRef: "nope-ref" }), message: 'Unknown Git ref "nope-ref"' },
  get_impact_analysis: { args: () => ({ filePath: "src/b.ts", symbolName: "helpr" }), message: "Symbol 'helpr' not found in src/b.ts. Did you mean: helper?" },
  generate_codemap: { args: () => ({ filePath: "src/nope.ts" }), message: "File not found: src/nope.ts." },
  query_call_graph: { args: () => ({ filePath: "src/a.ts", symbolName: "rnu" }), message: "Symbol 'rnu' not found in src/a.ts. Did you mean: run?" },
  scan_dead_code: { args: () => ({ scopePath: "srx" }), message: "Folder not found: srx. Did you mean: src?" },
  graph_context: { args: () => ({ mode: "neighbors", seeds: [{ filePath: "src/a.ts", symbolName: "rnu" }] }), message: "Seed not found: src/a.ts#rnu. Did you mean: run?" },
  explore_architecture: { args: () => ({ level: "units", from: "srx", to: "lib" }), message: 'Unknown unit "srx"' },
  check_architecture: { args: () => ({ rule: "nope" }), message: '"nope"' },
  export_architecture_diagram: { args: () => ({ folder: "nope" }), message: "nope" },
  query_natural_language: { args: () => ({ question: "what calls helper", fileFilter: "nope/**" }), message: "fileFilter matches no indexed file: nope/**." },
  generate_wiki: { args: () => ({ scope: "nope" }), message: "No indexed file matches the wiki filters" },
};
/** Tools with no target to miss. */
const NO_TARGET = new Set(["get_index_status", "rebuild_index", "get_session_stats"]);

/** The text an agent reads never carries Zod, git or internal wording, nor the absolute workspace path. */
function expectReadableError(result: ToolResult, message: string): void {
  // TOON escapes the commas of a value.
  const text = result.content[0].text.replaceAll(String.raw`\,`, ",");
  expect(result.isError, text).toBe(true);
  expect(text).toContain(message);
  expect(text).not.toMatch(/Invalid input|expected \w+, received|Command failed|INVALID_|FILE_NOT_FOUND|UNSUPPORTED_FILE_TYPE|Check --/);
  expect(text).not.toContain(root);
}

/** The requested view: parseable data, a titled markdown report, never a key dump. */
function expectView(format: (typeof FORMATS)[number], result: ToolResult): void {
  const text = result.content[0].text;
  expect(result.isError, text).toBeFalsy();
  expect(text.trim()).not.toBe("");
  expect(text).not.toContain(root);
  if (format === "json") expect(JSON.parse(text)).toMatchObject({ success: true });
  if (format === "markdown") {
    expect(text).toMatch(/^# /);
    expect(text).not.toMatch(/^- \*\*[\w.]+\*\*:/m);
  }
  if (format === "toon") expect(() => JSON.parse(text)).toThrow();
}

describe.skipIf(!distExists)("MCP user contract (E2E)", { timeout: TIMEOUT_MS }, () => {
  let session: Awaited<ReturnType<typeof startMcpSession>>;
  let tools: ListedTool[] = [];
  const call = (tool: string, args: Args) => session.callTool(`graphitlive_${tool}`, args);

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-mcp-contract-")));
    fs.writeFileSync(path.join(root, "package.json"), '{ "name": "contract" }\n');
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "lib"));
    fs.writeFileSync(path.join(root, "src/b.ts"), 'import { util } from "../lib/u";\nexport function helper(x: number, y = 1) { return util() + x + y; }\nexport function unused() { return 0; }\n');
    fs.writeFileSync(path.join(root, "src/a.ts"), 'import { helper } from "./b";\nexport function run() { return helper(1); }\n');
    fs.writeFileSync(path.join(root, "lib/u.ts"), 'import { run } from "../src/a";\nexport function util() { return typeof run; }\n');
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, stdio: "ignore" }); // NOSONAR S4036 test fixture: git from the developer's PATH
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    // check_architecture reads the rules init writes.
    expect(spawnSync(process.execPath, [DIST_ENTRY, "init", "--yes"], { cwd: root, encoding: "utf-8" }).status).toBe(0);
    session = await startMcpSession(DIST_ENTRY, root, root);
    tools = ((await session.request("tools/list", {})).result as { tools: ListedTool[] }).tools;
  }, TIMEOUT_MS);

  afterAll(async () => {
    if (session) await closeSession(session.child);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("has contract rows for every listed tool, strict schemas, and descriptions naming every parameter", () => {
    const names = tools.map((tool) => tool.name.replace(/^graphitlive_/, "")).sort();
    expect(names).toEqual(Object.keys(VALID).sort());
    for (const tool of tools) {
      const short = tool.name.replace(/^graphitlive_/, "");
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      expect(INVALID_VALUE[short], `${short} invalid-value row`).toBeDefined();
      expect(MISSING_TARGET[short] !== undefined || NO_TARGET.has(short), `${short} missing-target row`).toBe(true);
      for (const parameter of Object.keys(tool.inputSchema.properties ?? {})) {
        expect(tool.description, `${tool.name} names ${parameter}`).toMatch(new RegExp(String.raw`\b${parameter}\b`));
      }
    }
  });

  it.each(Object.keys(VALID))("%s renders each response format", async (tool) => {
    for (const format of FORMATS) {
      expectView(format, await call(tool, { ...VALID[tool](), response_format: format }));
    }
  });

  it.each(Object.keys(VALID))("%s refuses an unknown parameter, naming the parameters", async (tool) => {
    expectReadableError(await call(tool, { ...VALID[tool](), bogusParam: 1 }), 'Unknown parameter "bogusParam".');
  });

  it.each(Object.keys(INVALID_VALUE))("%s refuses an invalid value", async (tool) => {
    expectReadableError(await call(tool, { ...VALID[tool](), ...INVALID_VALUE[tool].args }), INVALID_VALUE[tool].message);
  });

  it.each(Object.keys(VALID).filter((tool) => Object.keys(VALID[tool]()).length > 0 && tool !== "check_architecture"))(
    "%s names a missing required parameter",
    async (tool) => {
      const listed = tools.find((entry) => entry.name === `graphitlive_${tool}`);
      const [required] = listed?.inputSchema.required ?? [];
      if (required === undefined) return;
      const args = { ...VALID[tool]() };
      delete args[required];
      expectReadableError(await call(tool, args), `Missing required parameter "${required}"`);
    },
  );

  it.each(Object.keys(MISSING_TARGET))("%s fails on a missing target", async (tool) => {
    expectReadableError(await call(tool, MISSING_TARGET[tool].args()), MISSING_TARGET[tool].message);
  });

  it("says when a page is the last one and refuses an offset past the end", async () => {
    const page = JSON.parse((await call("crawl_dependency_graph", { entryFile: "src/a.ts", limit: 1, response_format: "json" })).content[0].text);
    expect(page.data).toMatchObject({ truncated: true, nextOffset: 1 });
    expect(page.pagination).toMatchObject({ hasMore: true });
    expectReadableError(await call("crawl_dependency_graph", { entryFile: "src/a.ts", offset: 99 }), "offset 99 is past the end: 3 nodes, last offset 2.");
  });

  it("draws a flow (#793) and refuses a flow without its symbol, an unknown symbol or a level parameter", async () => {
    const flow = { view: "flow", filePath: "src/a.ts", symbolName: "run" };
    const spec = JSON.parse(JSON.parse((await call("export_architecture_diagram", { ...flow, diagramFormat: "diagram-spec", response_format: "json" })).content[0].text).data.markup);
    expect(spec).toMatchObject({ kind: "flow", entry: "src/a.ts#run", nodes: [{ id: "src/a.ts#run" }, { id: "src/b.ts#helper" }, { id: "lib/u.ts#util" }] });
    const svg = await call("export_architecture_diagram", { ...flow, response_format: "json" });
    expect(JSON.parse(svg.content[0].text).data).toMatchObject({ format: "svg", counts: "3 steps · 2 calls · 0 references" });
    expectReadableError(await call("export_architecture_diagram", { ...flow, bogusParam: 1 }), 'Unknown parameter "bogusParam".');
    expectReadableError(await call("export_architecture_diagram", { view: "flow", filePath: "src/a.ts" }), "view flow draws one symbol's flow: pass symbolName.");
    expectReadableError(await call("export_architecture_diagram", { ...flow, symbolName: "rnu" }), "Symbol 'rnu' not found in src/a.ts. Did you mean: run?");
    expectReadableError(await call("export_architecture_diagram", { ...flow, folder: "src" }), "folder applies to view units, folder or matrix, not flow.");
    expectReadableError(await call("export_architecture_diagram", { filePath: "src/a.ts", symbolName: "run" }), "filePath applies to view flow only.");
    expectReadableError(await call("export_architecture_diagram", { ...flow, filePath: "src/nope.ts" }), "File not found: src/nope.ts.");
  });

  // #794: the spec parameter, as the CLI's --spec.
  it("redraws an annotated spec unchanged when untouched, and refuses an altered, stale or misplaced one", async () => {
    const data = async (args: Args) => {
      const result = await call("export_architecture_diagram", { ...args, response_format: "json" });
      expect(result.isError, result.content[0].text).toBeFalsy();
      return JSON.parse(result.content[0].text).data as { markup: string; cut?: string[] };
    };
    const flowArgs = { view: "flow", filePath: "src/a.ts", symbolName: "run" };
    const flow = JSON.parse((await data({ ...flowArgs, diagramFormat: "diagram-spec" })).markup);
    const units = JSON.parse((await data({ diagramFormat: "diagram-spec" })).markup);
    const write = (file: string, spec: unknown) => fs.writeFileSync(path.join(root, file), JSON.stringify(spec));
    write("flow.json", flow);
    write("units.json", units);
    expect((await data({ spec: "flow.json" })).markup).toBe((await data(flowArgs)).markup);
    expect((await data({ spec: "units.json", diagramFormat: "html" })).markup).toBe((await data({ diagramFormat: "html" })).markup);
    write("annotated.json", { ...flow, edges: flow.edges.map((edge: object) => ({ ...edge, label: "fetches helper results quickly" })) });
    const annotated = await data({ spec: "annotated.json" });
    expect(annotated.markup).toContain("fetches helper resu…");
    expect(annotated.cut).toEqual(["edges[0].label", "edges[1].label"]);

    write("moved.json", { ...flow, nodes: flow.nodes.map((node: { line: number }) => ({ ...node, line: node.line + 1 })) });
    write("stale.json", { ...units, revision: "0".repeat(64) });
    write("added.json", { ...flow, nodes: [...flow.nodes, { ...flow.nodes[0], id: "src/a.ts#extra" }] });
    expectReadableError(await call("export_architecture_diagram", { spec: "moved.json" }), "moved.json is stale: No symbol 'run' starts at line 3 in src/a.ts. Candidates: run (function, line 2).");
    expectReadableError(await call("export_architecture_diagram", { spec: "stale.json" }), "stale.json is stale or drawn with other rules: it was exported at revision");
    expectReadableError(await call("export_architecture_diagram", { spec: "added.json" }), "src/a.ts#extra is not in the current index; nodes and edges cannot be added or renamed");
    expectReadableError(await call("export_architecture_diagram", { spec: "../x.json" }), "Spec file outside workspace: ../x.json.");
    expectReadableError(await call("export_architecture_diagram", { spec: "nope.json" }), "Spec file not found: nope.json.");
    expectReadableError(await call("export_architecture_diagram", { spec: "flow.json", view: "flow" }), "view: spec draws the view, level or symbol written in the spec; drop view.");
    expectReadableError(await call("export_architecture_diagram", { spec: "flow.json", filePath: "src/a.ts" }), "drop filePath.");
    expectReadableError(await call("export_architecture_diagram", { spec: "flow.json", rules: true }), "rules applies to an architecture spec, not a flow spec.");
    expectReadableError(await call("export_architecture_diagram", { spec: "flow.json", diagramFormat: "diagram-spec", output: "flow.json" }), "output flow.json would replace the spec it reads");
  });

  // #774, last: it moves the session to another workspace. MCP and CLI count the same unresolved imports.
  it("reports an import resolving to no file like the CLI, in scan_dead_code and get_index_status", async () => {
    const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-mcp-unresolved-")));
    try {
      fs.cpSync(path.join(REPO_ROOT, "tests/fixtures/unresolved-generated-import"), fixture, { recursive: true });
      const cli = spawnSync(process.execPath, [DIST_ENTRY, "check", "--unreferencedFiles", "--format", "json"], { cwd: fixture, encoding: "utf-8" });
      const expected = JSON.parse(cli.stdout).unresolvedImports;
      expect(expected.count).toBe(3);

      expect((await call("set_workspace", { workspacePath: fixture })).isError).toBeFalsy();
      const data = async (tool: string, args: Args) => JSON.parse((await call(tool, { ...args, response_format: "json" })).content[0].text).data;
      const files = await data("scan_dead_code", { unreferencedFiles: true });
      expect(files.unresolvedImports).toEqual(expected);
      expect(files.unreferencedFiles.filter((file: { reasons: string[] }) => file.reasons.includes("unresolved-import-in-workspace"))).toHaveLength(2);
      expect((await data("get_index_status", {})).unresolvedImports).toEqual(expected);
      expect((await call("scan_dead_code", { unreferencedFiles: true, response_format: "markdown" })).content[0].text).toContain("**Unresolved imports: 3 resolving to no file, 0 to a file excluded from the analysis, 0 differing only in letter case from a file, 0 matching a file not analyzed.**");
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});

// ADR-776 contract rows, as the CLI ones: units from declared elements, warnings, refused config, two kinds of cycle.
describe.skipIf(!distExists)("MCP units contract (#776, E2E)", { timeout: TIMEOUT_MS }, () => {
  let session: Awaited<ReturnType<typeof startMcpSession>>;
  const roots: string[] = [];
  const call = (tool: string, args: Args) => session.callTool(`graphitlive_${tool}`, args);
  const data = async (tool: string, args: Args) => {
    const result = await call(tool, { ...args, response_format: "json" });
    expect(result.isError, result.content[0].text).toBeFalsy();
    return JSON.parse(result.content[0].text).data;
  };
  /** Moves the session to a new workspace of the fixture. */
  const open = async (root: string) => {
    roots.push(root);
    expect((await call("set_workspace", { workspacePath: root })).isError).toBeFalsy();
    // expectReadableError checks the module's root never leaks into an error.
    contractRoot(root);
    return root;
  };

  beforeAll(async () => {
    const elements = elementsWorkspace();
    roots.push(elements);
    contractRoot(elements);
    session = await startMcpSession(DIST_ENTRY, elements, elements);
  }, TIMEOUT_MS);

  afterAll(async () => {
    if (session) await closeSession(session.child);
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("returns the declared elements, edges with their rules and the element cycle; review_pr sees the detected-project cycles only", async () => {
    const units = await data("explore_architecture", { level: "units" });
    expect(units).toMatchObject({ unitsFrom: "elements", configFile: "graphit.architecture.json", configWarnings: [], cycles: 1 });
    expect(units.units.map((unit: { key: string }) => unit.key).toSorted((left: string, right: string) => left.localeCompare(right))).toEqual(["alpha", "beta", "pkgs"]);
    const edge = units.unitEdges.find((candidate: { from: string }) => candidate.from === "alpha");
    expect(edge).toMatchObject({ to: "beta", kind: "cycle", ruleVerdict: "violated", rules: [{ name: "alpha-not-beta", verdict: "violated" }] });
    expect(units.rules.map((rule: { name: string }) => rule.name)).toEqual(["alpha-not-beta"]);
    const markdown = (await call("explore_architecture", { level: "units", response_format: "markdown" })).content[0].text;
    expect(markdown).toContain("- Units from: declared elements of graphit.architecture.json");

    const elementCycle = await data("review_pr", { baseRef: "HEAD~2", headRef: "HEAD~1" });
    expect(elementCycle.architecture.unitCycles.newViolations).toEqual([]);
    const projectCycle = await data("review_pr", { baseRef: "HEAD~1", headRef: "HEAD" });
    expect(projectCycle.architecture.unitCycles.newViolations.map((pair: { from: string; to: string }) => [pair.from, pair.to]))
      .toEqual(expect.arrayContaining([["packages/p", "packages/q"]]));
  });

  it("refuses an unknown unit with the element names closest to it", async () => {
    expectReadableError(await call("explore_architecture", { level: "units", from: "alpah", to: "beta" }), 'Unknown unit "alpah". Did you mean: alpha?');
  });

  it('warns that roles["(root)"] holds the root files only, in configWarnings', async () => {
    await open(rootWorkspace({ elements: {}, rules: [], roles: { "(root)": "tooling" } }));
    const units = await data("explore_architecture", { level: "units" });
    expect(units.unitsFrom).toBe("manifests");
    expect(units.configWarnings[0]).toBe('$.roles["(root)"]: "(root)" now holds only the 1 file at the workspace root; files outside every project moved to the units scripts, tools: name those instead');
  });

  it("fails on a refused config with the CLI's one line", async () => {
    await open(rootWorkspace({ elements: {}, rules: [], roles: { x: "nope" } }));
    expectReadableError(await call("explore_architecture", { level: "units" }), "graphit.architecture.json: $.roles.x: ");
  });

  it("returns one (unmatched) unit with a warning when no element selects a file", async () => {
    await open(rootWorkspace({ elements: { only: { path: "nowhere/" } }, rules: [] }));
    const units = await data("explore_architecture", { level: "units" });
    expect(units.units.map((unit: { key: string; fileCount: number }) => [unit.key, unit.fileCount])).toEqual([["(unmatched)", 3]]);
    expect(units.configWarnings).toContain('$.elements: 3 files match no element; drawn in unit "(unmatched)"');
  });
});

