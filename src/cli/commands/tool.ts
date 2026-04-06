/**
 * CLI Command: tool
 *
 * MCP parity passthrough — invoke any MCP tool by name.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { workerState } from "../../mcp/shared/state";
import {
  executeAnalyzeBreakingChanges,
  executeAnalyzeDependencies,
  executeAnalyzeFileLogic,
  executeCrawlDependencyGraph,
  executeExpandNode,
  executeFindReferencingFiles,
  executeFindUnusedSymbols,
  executeGenerateCodemap,
  executeGetImpactAnalysis,
  executeGetIndexStatus,
  executeGetSymbolCallers,
  executeGetSymbolDependents,
  executeGetSymbolGraph,
  executeInvalidateFiles,
  executeParseImports,
  executeQueryCallGraph,
  executeRebuildIndex,
  executeResolveModulePath,
  executeTraceFunctionExecution,
  executeVerifyDependencyUsage,
} from "../../mcp/tools";
import type { McpToolName } from "../../mcp/types";
import { validateFilePath, validateToolParams } from "../../mcp/types";
import { CliError, ExitCode } from "../errors";
import type { CliOutputFormat } from "../formatter";
import { formatOutput } from "../formatter";
import type { CliRuntime } from "../runtime";

/** All tool names that the CLI supports (excludes set_workspace which is MCP-server only) */
const TOOL_NAMES: McpToolName[] = [
  "analyze_dependencies",
  "crawl_dependency_graph",
  "find_referencing_files",
  "expand_node",
  "parse_imports",
  "verify_dependency_usage",
  "resolve_module_path",
  "get_index_status",
  "invalidate_files",
  "rebuild_index",
  "get_symbol_graph",
  "find_unused_symbols",
  "get_symbol_dependents",
  "trace_function_execution",
  "get_symbol_callers",
  "analyze_breaking_changes",
  "get_impact_analysis",
  "analyze_file_logic",
  "generate_codemap",
  "query_call_graph",
];

/** One-line descriptions for `graph-it tool --list` */
const TOOL_DESCRIPTIONS: Record<string, string> = {
  analyze_dependencies: "Show direct imports and exports of a file",
  crawl_dependency_graph: "Full dependency tree from an entry file (BFS)",
  find_referencing_files: "All files that import a given file",
  expand_node: "Incrementally expand dependencies of a node",
  parse_imports: "Raw import statements parsed from a file",
  verify_dependency_usage: "Check if an import is actually used in source",
  resolve_module_path: "Resolve a module specifier to its absolute path",
  get_index_status: "Current state of the dependency index",
  invalidate_files: "Flush cache entries for specific files",
  rebuild_index: "Trigger a full index rebuild",
  get_symbol_graph: "Symbol-level call graph within a file",
  find_unused_symbols: "Detect dead/unused exported symbols",
  get_symbol_dependents: "All symbols that depend on a given symbol",
  trace_function_execution: "Full recursive call chain from a symbol",
  get_symbol_callers: "All callers of a symbol across the project",
  analyze_breaking_changes: "Detect breaking API changes between two versions",
  get_impact_analysis: "Full impact analysis of changing a file/symbol",
  analyze_file_logic: "Intra-file call hierarchy (AST-based)",
  generate_codemap: "AI-friendly structural overview of a file (TOON)",
  query_call_graph: "BFS callers/callees via the SQLite call graph index",
};

export async function run(
  args: string[],
  runtime: CliRuntime,
  format: CliOutputFormat,
): Promise<string> {
  if (args.length === 0) {
    return "Available tools:\n" + TOOL_NAMES.map((t) => `  ${t}`).join("\n");
  }

  if (args[0] === "--list") {
    const lines = TOOL_NAMES.map((t) => `  ${t.padEnd(28)} ${TOOL_DESCRIPTIONS[t] ?? ""}`);
    return "Available MCP tools:\n\n" + lines.join("\n") + "\n";
  }

  const toolName = args[0] as McpToolName;
  if (!TOOL_NAMES.includes(toolName)) {
    throw new CliError(
      `Unknown tool "${toolName}". Available tools:\n${TOOL_NAMES.join("\n")}`,
      ExitCode.GENERAL_ERROR,
    );
  }

  await runtime.ensureIndexed();

  // Parse --args JSON or key=value pairs from remaining args
  const params = parseToolArgs(args.slice(1));

  // Validate params via Zod
  const validation = validateToolParams(toolName, params);
  if (!validation.success) {
    throw new CliError(validation.error, ExitCode.GENERAL_ERROR);
  }

  const result = await invokeTool(toolName, validation.data);
  return formatOutput(result, format, "tool");
}

function parseToolArgs(args: string[]): Record<string, unknown> {
  // Check for --args '{"key": "value"}'
  const argsIdx = args.indexOf("--args");
  if (argsIdx >= 0 && args[argsIdx + 1]) {
    try {
      return JSON.parse(args[argsIdx + 1]) as Record<string, unknown>;
    } catch {
      throw new CliError(
        "Invalid JSON after --args",
        ExitCode.GENERAL_ERROR,
      );
    }
  }

  // Parse key=value pairs
  const result: Record<string, unknown> = {};
  for (const arg of args) {
    if (arg.startsWith("--") && arg.includes("=")) {
      const eqIdx = arg.indexOf("=");
      const key = arg.slice(2, eqIdx);
      const val = arg.slice(eqIdx + 1);
      // Try to parse as JSON value (number, boolean, array)
      try {
        result[key] = JSON.parse(val);
      } catch {
        result[key] = val;
      }
    }
  }
  return result;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function invokeTool(tool: McpToolName, params: any): Promise<unknown> {
  const config = workerState.getConfig();
  const rootDir = config.rootDir;

  // Helper for path validation on common fields
  const vfp = (p: string) => validateFilePath(p, rootDir);

  switch (tool) {
    case "analyze_dependencies":
      vfp(params.filePath);
      return executeAnalyzeDependencies(params);
    case "crawl_dependency_graph":
      vfp(params.entryFile);
      return executeCrawlDependencyGraph(params);
    case "find_referencing_files":
      vfp(params.targetPath);
      return executeFindReferencingFiles(params);
    case "expand_node":
      vfp(params.filePath);
      return executeExpandNode(params);
    case "parse_imports":
      vfp(params.filePath);
      return executeParseImports(params);
    case "verify_dependency_usage":
      vfp(params.sourceFile);
      vfp(params.targetFile);
      return executeVerifyDependencyUsage(params);
    case "resolve_module_path":
      vfp(params.fromFile);
      return executeResolveModulePath(params);
    case "get_index_status":
      return executeGetIndexStatus();
    case "invalidate_files":
      for (const fp of params.filePaths) vfp(fp);
      return executeInvalidateFiles(params);
    case "rebuild_index":
      return executeRebuildIndex(() => {/* no-op progress for CLI */});
    case "get_symbol_graph":
      vfp(params.filePath);
      return executeGetSymbolGraph(params);
    case "find_unused_symbols":
      vfp(params.filePath);
      return executeFindUnusedSymbols(params);
    case "get_symbol_dependents":
      vfp(params.filePath);
      return executeGetSymbolDependents(params);
    case "trace_function_execution":
      vfp(params.filePath);
      return executeTraceFunctionExecution(params);
    case "get_symbol_callers":
      vfp(params.filePath);
      return executeGetSymbolCallers(params);
    case "analyze_breaking_changes":
      vfp(params.filePath);
      return executeAnalyzeBreakingChanges(params);
    case "get_impact_analysis":
      vfp(params.filePath);
      return executeGetImpactAnalysis(params);
    case "analyze_file_logic":
      vfp(params.filePath);
      return executeAnalyzeFileLogic(params);
    case "generate_codemap":
      vfp(params.filePath);
      return executeGenerateCodemap(params);
    case "query_call_graph":
      vfp(params.filePath);
      return executeQueryCallGraph(params);
    default:
      throw new CliError(`Unknown tool: ${tool}`, ExitCode.GENERAL_ERROR);
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
