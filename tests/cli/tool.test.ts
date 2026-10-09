/**
 * CLI `tool` command: parameter parsing, validation, and dispatch to MCP tool handlers.
 *
 * MCP tool functions are mocked so no WASM / AST is loaded.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workerState } from "../../src/mcp/shared/state";
import type { McpWorkerConfig } from "../../src/mcp/types";

const executeMock = vi.fn();

vi.mock("../../src/mcp/tools", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked: Record<string, unknown> = {};
  for (const name of Object.keys(actual)) {
    if (name.startsWith("execute")) {
      mocked[name] = (...args: unknown[]) => executeMock(name, ...args);
    }
  }
  return mocked;
});

vi.mock("../../src/cli/formatter", () => ({
  formatOutput: (result: unknown) => JSON.stringify(result),
}));

const { run } = await import("../../src/cli/commands/tool.js");

describe("tool command dispatch", () => {
  let root: string;
  let file: string;
  const runtimeStub = {
    ensureIndexed: vi.fn(),
  } as unknown as import("../../src/cli/runtime").CliRuntime;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-tool-"));
    file = path.join(root, "a.ts");
    fs.writeFileSync(file, "export const a = 1;\n");
    vi.spyOn(workerState, "getConfig").mockReturnValue({ rootDir: root } as McpWorkerConfig);
    executeMock.mockReset();
    executeMock.mockImplementation((name: string) => ({ called: name }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects an unknown tool name", async () => {
    await expect(run(["nope"], runtimeStub, "json")).rejects.toThrow('Unknown tool "nope"');
  });

  it("reports Zod validation errors without indexing the workspace (issue #254)", async () => {
    vi.mocked(runtimeStub.ensureIndexed).mockClear();
    await expect(
      run(["get_symbol_dependents", "--symbolName=a"], runtimeStub, "json"),
    ).rejects.toThrow("Invalid parameters: filePath");
    expect(runtimeStub.ensureIndexed).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("indexes the workspace before running a tool with valid params", async () => {
    const order: string[] = [];
    vi.mocked(runtimeStub.ensureIndexed).mockClear().mockImplementationOnce(async () => {
      order.push("index");
    });
    executeMock.mockImplementationOnce((name: string) => {
      order.push("execute");
      return { called: name };
    });
    await run(["get_symbol_dependents", `--filePath=${file}`, "--symbolName=a"], runtimeStub, "json");
    expect(runtimeStub.ensureIndexed).toHaveBeenCalledOnce();
    expect(order).toEqual(["index", "execute"]);
  });

  it("passes merged --args and named flags to the handler (issue #159)", async () => {
    const output = await run(
      ["expand_node", `--filePath=${file}`, "--args", '{"knownPaths":[]}'],
      runtimeStub,
      "json",
    );
    expect(JSON.parse(output)).toEqual({ called: "executeExpandNode" });
    expect(executeMock).toHaveBeenCalledWith(
      "executeExpandNode",
      expect.objectContaining({ filePath: file, knownPaths: [] }),
    );
  });

  it("reads space-separated values and schema booleans (issue #268)", async () => {
    await run(
      ["query_call_graph", "--includeTypeOnly", "--filePath", file, "--symbolName", "a", "--depth", "2"],
      runtimeStub,
      "json",
    );
    expect(executeMock).toHaveBeenCalledWith(
      "executeQueryCallGraph",
      expect.objectContaining({ filePath: file, symbolName: "a", depth: 2, includeTypeOnly: true }),
    );
  });

  it("rejects a stray positional without indexing the workspace", async () => {
    vi.mocked(runtimeStub.ensureIndexed).mockClear();
    await expect(run(["generate_codemap", file], runtimeStub, "json")).rejects.toThrow(
      `Unexpected argument "${file}"`,
    );
    expect(runtimeStub.ensureIndexed).not.toHaveBeenCalled();
  });

  const cases: Array<[string, (f: string) => Record<string, unknown>, string]> = [
    ["analyze_dependencies", (f) => ({ filePath: f }), "executeAnalyzeDependencies"],
    ["crawl_dependency_graph", (f) => ({ entryFile: f }), "executeCrawlDependencyGraph"],
    ["find_referencing_files", (f) => ({ targetPath: f }), "executeFindReferencingFiles"],
    ["parse_imports", (f) => ({ filePath: f }), "executeParseImports"],
    ["verify_dependency_usage", (f) => ({ sourceFile: f, targetFile: f }), "executeVerifyDependencyUsage"],
    ["resolve_module_path", (f) => ({ fromFile: f, moduleSpecifier: "./b" }), "executeResolveModulePath"],
    ["get_index_status", () => ({}), "executeGetIndexStatus"],
    ["invalidate_files", (f) => ({ filePaths: [f] }), "executeInvalidateFiles"],
    ["rebuild_index", () => ({}), "executeRebuildIndex"],
    ["get_symbol_graph", (f) => ({ filePath: f }), "executeGetSymbolGraph"],
    ["find_unused_symbols", (f) => ({ filePath: f }), "executeFindUnusedSymbols"],
    ["get_symbol_dependents", (f) => ({ filePath: f, symbolName: "a" }), "executeGetSymbolDependents"],
    ["trace_function_execution", (f) => ({ filePath: f, symbolName: "a" }), "executeTraceFunctionExecution"],
    ["get_symbol_callers", (f) => ({ filePath: f, symbolName: "a" }), "executeGetSymbolCallers"],
    [
      "analyze_breaking_changes",
      (f) => ({ filePath: f, oldContent: "export const a = 1;", newContent: "export const b = 1;" }),
      "executeAnalyzeBreakingChanges",
    ],
    ["get_impact_analysis", (f) => ({ filePath: f, symbolName: "a" }), "executeGetImpactAnalysis"],
    ["analyze_file_logic", (f) => ({ filePath: f }), "executeAnalyzeFileLogic"],
    ["generate_codemap", (f) => ({ filePath: f }), "executeGenerateCodemap"],
    ["query_call_graph", (f) => ({ filePath: f, symbolName: "a" }), "executeQueryCallGraph"],
    ["scan_dead_code", () => ({}), "executeScanDeadCode"],
    ["graph_context", () => ({ question: "what calls a" }), "executeGraphContext"],
  ];

  it.each(cases)("dispatches %s", async (tool, params, expected) => {
    await run([tool, "--args", JSON.stringify(params(file))], runtimeStub, "json");
    expect(executeMock).toHaveBeenCalledOnce();
    expect(executeMock.mock.calls[0]?.[0]).toBe(expected);
  });

  it("rejects file paths outside the workspace", async () => {
    const outside = path.join(os.tmpdir(), "outside-graph-it.ts");
    await expect(
      run(["analyze_dependencies", `--filePath=${outside}`], runtimeStub, "json"),
    ).rejects.toThrow();
    expect(executeMock).not.toHaveBeenCalled();
  });
});
