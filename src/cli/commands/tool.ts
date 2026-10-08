/**
 * CLI Command: tool
 *
 * MCP parity passthrough — invoke any MCP tool by name.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { workerState } from "../../mcp/shared/state";
import { toolSummary } from "../../mcp/toolDescriptions";
import {
  executeAnalyzeBreakingChanges,
  executeAnalyzeDependencies,
  executeAnalyzeFileLogic,
  executeCrawlDependencyGraph,
  executeExpandNode,
  executeFindReferencingFiles,
  executeFindUnusedSymbols,
  executeGenerateCodemap,
  executeGraphContext,
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
  executeScanDeadCode,
  executeTraceFunctionExecution,
  executeVerifyDependencyUsage,
} from "../../mcp/tools";
import type {
  AnalyzeBreakingChangesParams,
  AnalyzeDependenciesParams,
  AnalyzeFileLogicParams,
  CrawlDependencyGraphParams,
  ExpandNodeParams,
  FindReferencingFilesParams,
  FindUnusedSymbolsParams,
  GenerateCodemapParams,
  GraphContextParams,
  GetImpactAnalysisParams,
  GetSymbolCallersParams,
  GetSymbolDependentsParams,
  GetSymbolGraphParams,
  InvalidateFilesParams,
  McpToolName,
  ParseImportsParams,
  QueryCallGraphParams,
  ResolveModulePathParams,
  ScanDeadCodeParams,
  TraceFunctionExecutionParams,
  VerifyDependencyUsageParams,
} from "../../mcp/types";
import { resolveToolFilePaths, validateToolParams } from "../../mcp/types";
import { CliError, ExitCode } from "../errors";
import type { CliOutputFormat } from "../formatter";
import { formatOutput } from "../formatter";
import type { CliRuntime } from "../runtime";

/** All tool names that the CLI supports (excludes set_workspace which is MCP-server only) */
const TOOL_NAMES: McpToolName[] = [
  "graph_context",
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
  "scan_dead_code",
];

export async function run(
  args: string[],
  runtime: CliRuntime,
  format: CliOutputFormat,
): Promise<string> {
  if (args.length === 0) {
    return "Available tools:\n" + TOOL_NAMES.map((t) => `  ${t}`).join("\n");
  }

  if (args[0] === "--list") {
    const lines = TOOL_NAMES.map((t) => `  ${t.padEnd(28)} ${toolSummary(t)}`);
    return "Available MCP tools:\n\n" + lines.join("\n") + "\n";
  }

  const toolName = args[0] as McpToolName;
  if (!TOOL_NAMES.includes(toolName)) {
    throw new CliError(
      `Unknown tool "${toolName}". Available tools:\n${TOOL_NAMES.join("\n")}`,
      ExitCode.GENERAL_ERROR,
    );
  }

  // Parse --args JSON or key=value pairs from remaining args
  const params = parseToolArgs(args.slice(1));

  // Validate params via Zod before indexing so bad input fails fast
  const validation = validateToolParams(toolName, params);
  if (!validation.success) {
    throw new CliError(validation.error, ExitCode.GENERAL_ERROR);
  }

  await runtime.ensureIndexed();

  const result = await invokeTool(toolName, validation.data);
  return formatOutput(result, format, "tool", runtime.workspaceRoot);
}

export function parseToolArgs(args: string[]): Record<string, unknown> {
  // --args '<json>' provides the base object; named --key=value flags override its keys
  const result: Record<string, unknown> = {};
  const argsIdx = args.indexOf("--args");
  if (argsIdx >= 0 && args[argsIdx + 1]) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args[argsIdx + 1]);
    } catch {
      throw new CliError(
        "Invalid JSON after --args",
        ExitCode.GENERAL_ERROR,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new CliError("--args must be a JSON object", ExitCode.GENERAL_ERROR);
    }
    Object.assign(result, parsed);
  }

  // Parse key=value pairs
  for (const [i, arg] of args.entries()) {
    if (argsIdx >= 0 && i === argsIdx + 1) continue; // the --args JSON value
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

type CliToolHandler = (params: unknown) => Promise<unknown> | void;

const cliToolHandlers: Partial<Record<McpToolName, CliToolHandler>> = {
  graph_context: (params) => executeGraphContext(params as GraphContextParams),
  analyze_dependencies: (params) =>
    executeAnalyzeDependencies(params as AnalyzeDependenciesParams),
  crawl_dependency_graph: (params) =>
    executeCrawlDependencyGraph(params as CrawlDependencyGraphParams),
  find_referencing_files: (params) =>
    executeFindReferencingFiles(params as FindReferencingFilesParams),
  expand_node: (params) =>
    executeExpandNode(params as ExpandNodeParams),
  parse_imports: (params) =>
    executeParseImports(params as ParseImportsParams),
  verify_dependency_usage: (params) =>
    executeVerifyDependencyUsage(params as VerifyDependencyUsageParams),
  resolve_module_path: (params) =>
    executeResolveModulePath(params as ResolveModulePathParams),
  get_index_status: () => executeGetIndexStatus(),
  invalidate_files: (params) =>
    Promise.resolve(executeInvalidateFiles(params as InvalidateFilesParams)),
  rebuild_index: () => executeRebuildIndex(() => {/* no-op progress for CLI */}),
  get_symbol_graph: (params) =>
    executeGetSymbolGraph(params as GetSymbolGraphParams),
  find_unused_symbols: (params) =>
    executeFindUnusedSymbols(params as FindUnusedSymbolsParams),
  get_symbol_dependents: (params) =>
    executeGetSymbolDependents(params as GetSymbolDependentsParams),
  trace_function_execution: (params) =>
    executeTraceFunctionExecution(params as TraceFunctionExecutionParams),
  get_symbol_callers: (params) =>
    executeGetSymbolCallers(params as GetSymbolCallersParams),
  analyze_breaking_changes: (params) =>
    executeAnalyzeBreakingChanges(params as AnalyzeBreakingChangesParams),
  get_impact_analysis: (params) =>
    executeGetImpactAnalysis(params as GetImpactAnalysisParams),
  analyze_file_logic: (params) =>
    executeAnalyzeFileLogic(params as AnalyzeFileLogicParams),
  generate_codemap: (params) =>
    executeGenerateCodemap(params as GenerateCodemapParams),
  query_call_graph: (params) =>
    executeQueryCallGraph(params as QueryCallGraphParams),
  scan_dead_code: (params) => executeScanDeadCode(params as ScanDeadCodeParams),
};

async function invokeTool(tool: McpToolName, params: unknown): Promise<unknown> {
  const config = workerState.getConfig();
  const handler = cliToolHandlers[tool];
  if (!handler) throw new CliError(`Unknown tool: ${tool}`, ExitCode.GENERAL_ERROR);
  return handler(resolveToolFilePaths(tool, params, config.rootDir));
}
