/**
 * MCP worker dispatcher: every file-path parameter reaches its executor as the
 * absolute path that was validated against the workspace, never the raw
 * relative value that Node would read against the process cwd
 * (GHSA-2pv3-2vx4-vf28, CWE-22).
 */
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executors = vi.hoisted(() => {
  const names = [
    "executeAnalyzeBreakingChanges", "executeAnalyzeDependencies", "executeAnalyzeFileLogic",
    "executeCrawlDependencyGraph", "executeExpandNode", "executeFindReferencingFiles",
    "executeFindUnusedSymbols", "executeGenerateCodemap", "executeGraphContext",
    "executeGetImpactAnalysis", "executeGetIndexStatus", "executeGetSymbolCallers",
    "executeGetSymbolDependents", "executeGetSymbolGraph", "executeInvalidateFiles",
    "executeParseImports", "executeQueryCallGraph", "executeReviewPr", "executeRebuildIndex",
    "executeResolveModulePath", "executeScanDeadCode", "executeTraceFunctionExecution",
    "executeVerifyDependencyUsage", "executeQueryNaturalLanguage", "executeGenerateWiki",
  ];
  return Object.fromEntries(names.map((name) => [name, vi.fn(async () => ({ ok: name }))]));
});

vi.mock("@/mcp/tools", () => executors);

import { workerState } from "@/mcp/shared/state";
import type { McpToolName, McpWorkerResponse } from "@/mcp/types";
import { invokeTool } from "@/mcp/worker/invokeTool";

const rootDir = path.resolve("/mcp-root");
const inRoot = (relative: string) => path.join(rootDir, relative);

async function call(tool: McpToolName, params: Record<string, unknown>): Promise<McpWorkerResponse> {
  const postMessage = vi.fn();
  await invokeTool("r1", tool, params, postMessage);
  return postMessage.mock.calls.at(-1)?.[0] as McpWorkerResponse;
}

describe("invokeTool", () => {
  beforeEach(() => {
    for (const executor of Object.values(executors)) executor.mockClear();
    workerState.config = { rootDir, excludeNodeModules: true, maxDepth: 50 };
    workerState.spider = {} as never;
    workerState.parser = {} as never;
    workerState.resolver = {} as never;
    workerState.isReady = true;
  });

  afterEach(() => {
    workerState.reset();
  });

  it.each([
    ["analyze_dependencies", "executeAnalyzeDependencies", { filePath: "src/a.ts" }],
    ["crawl_dependency_graph", "executeCrawlDependencyGraph", { entryFile: "src/a.ts" }],
    ["find_referencing_files", "executeFindReferencingFiles", { targetPath: "src/a.ts" }],
    ["verify_dependency_usage", "executeVerifyDependencyUsage", { sourceFile: "src/a.ts", targetFile: "src/b.ts" }],
    ["resolve_module_path", "executeResolveModulePath", { fromFile: "src/a.ts", moduleSpecifier: "./b" }],
    ["invalidate_files", "executeInvalidateFiles", { filePaths: ["src/a.ts", "src/b.ts"] }],
    ["get_symbol_graph", "executeGetSymbolGraph", { filePath: "src/a.ts" }],
    ["find_unused_symbols", "executeFindUnusedSymbols", { filePath: "src/a.ts" }],
    ["trace_function_execution", "executeTraceFunctionExecution", { filePath: "src/a.ts", symbolName: "run" }],
    ["analyze_breaking_changes", "executeAnalyzeBreakingChanges", { filePath: "src/a.ts", oldContent: "x" }],
    ["get_impact_analysis", "executeGetImpactAnalysis", { filePath: "src/a.ts", symbolName: "run" }],
    ["generate_codemap", "executeGenerateCodemap", { filePath: "src/a.ts" }],
    ["query_call_graph", "executeQueryCallGraph", { filePath: "src/a.ts", symbolName: "run" }],
  ] as const)("passes %s the validated absolute paths", async (tool, executor, params) => {
    const response = await call(tool, params);

    expect(response.type).toBe("result");
    const received = executors[executor].mock.calls[0][0] as Record<string, unknown>;
    for (const [key, value] of Object.entries(params)) {
      if (key === "moduleSpecifier" || key === "symbolName" || key === "oldContent") {
        expect(received[key]).toBe(value);
      } else if (Array.isArray(value)) {
        expect(received[key]).toEqual(value.map(inRoot));
      } else {
        expect(received[key]).toBe(inRoot(value));
      }
    }
  });

  it("passes the tools without file paths through", async () => {
    for (const [tool, executor, params] of [
      ["get_index_status", "executeGetIndexStatus", {}],
      ["rebuild_index", "executeRebuildIndex", {}],
      ["scan_dead_code", "executeScanDeadCode", {}],
      ["review_pr", "executeReviewPr", { baseRef: "HEAD" }],
      ["graph_context", "executeGraphContext", { question: "q" }],
      ["query_natural_language", "executeQueryNaturalLanguage", { question: "q" }],
    ] as const) {
      expect((await call(tool, params)).type).toBe("result");
      expect(executors[executor]).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps the wiki output directory relative to the workspace", async () => {
    expect((await call("generate_wiki", { outputDir: "docs/wiki", scope: "src" })).type).toBe("result");
    expect(executors.executeGenerateWiki).toHaveBeenCalledWith(expect.objectContaining({ outputDir: "docs/wiki", scope: "src" }));

    const absolute = await call("generate_wiki", { outputDir: inRoot("wiki") });
    expect(absolute).toMatchObject({ type: "error", error: expect.stringContaining("relative to the workspace") });
  });

  it("rejects a relative path that leaves the workspace as a security error", async () => {
    const response = await call("parse_imports", { filePath: "../outside/probe.ts" });

    expect(response).toMatchObject({ type: "error", code: "SECURITY_ERROR" });
    expect(executors.executeParseImports).not.toHaveBeenCalled();
  });

  it("reports validation and initialization errors", async () => {
    expect(await call("analyze_dependencies", {})).toMatchObject({ type: "error", code: "VALIDATION_ERROR" });

    workerState.isReady = false;
    expect(await call("analyze_dependencies", { filePath: "src/a.ts" })).toMatchObject({ code: "NOT_INITIALIZED" });
  });

  it("reports a cancelled call", async () => {
    const controller = new AbortController();
    controller.abort();
    const postMessage = vi.fn();

    await invokeTool("r1", "get_index_status", {}, postMessage, controller.signal);

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "error", code: "CANCELLED" }));
  });
});
