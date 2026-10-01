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
import { validateFilePath, validateToolParams } from "../../mcp/types";
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

type CliToolHandler = (params: unknown, rootDir: string) => Promise<unknown> | void;

function validateCliPath(filePath: string, rootDir: string): void {
  validateFilePath(filePath, rootDir);
}

const cliToolHandlers: Partial<Record<McpToolName, CliToolHandler>> = {
  graph_context: (params) => executeGraphContext(params as GraphContextParams),
  analyze_dependencies: (params, rootDir) => {
    const p = params as AnalyzeDependenciesParams;
    validateCliPath(p.filePath, rootDir);
    return executeAnalyzeDependencies(p);
  },
  crawl_dependency_graph: (params, rootDir) => {
    const p = params as CrawlDependencyGraphParams;
    validateCliPath(p.entryFile, rootDir);
    return executeCrawlDependencyGraph(p);
  },
  find_referencing_files: (params, rootDir) => {
    const p = params as FindReferencingFilesParams;
    validateCliPath(p.targetPath, rootDir);
    return executeFindReferencingFiles(p);
  },
  expand_node: (params, rootDir) => {
    const p = params as ExpandNodeParams;
    validateCliPath(p.filePath, rootDir);
    return executeExpandNode(p);
  },
  parse_imports: (params, rootDir) => {
    const p = params as ParseImportsParams;
    validateCliPath(p.filePath, rootDir);
    return executeParseImports(p);
  },
  verify_dependency_usage: (params, rootDir) => {
    const p = params as VerifyDependencyUsageParams;
    validateCliPath(p.sourceFile, rootDir);
    validateCliPath(p.targetFile, rootDir);
    return executeVerifyDependencyUsage(p);
  },
  resolve_module_path: (params, rootDir) => {
    const p = params as ResolveModulePathParams;
    validateCliPath(p.fromFile, rootDir);
    return executeResolveModulePath(p);
  },
  get_index_status: () => executeGetIndexStatus(),
  invalidate_files: (params, rootDir) => {
    const p = params as InvalidateFilesParams;
    for (const filePath of p.filePaths) validateCliPath(filePath, rootDir);
    return Promise.resolve(executeInvalidateFiles(p));
  },
  rebuild_index: () => executeRebuildIndex(() => {/* no-op progress for CLI */}),
  get_symbol_graph: (params, rootDir) => {
    const p = params as GetSymbolGraphParams;
    validateCliPath(p.filePath, rootDir);
    return executeGetSymbolGraph(p);
  },
  find_unused_symbols: (params, rootDir) => {
    const p = params as FindUnusedSymbolsParams;
    validateCliPath(p.filePath, rootDir);
    return executeFindUnusedSymbols(p);
  },
  get_symbol_dependents: (params, rootDir) => {
    const p = params as GetSymbolDependentsParams;
    validateCliPath(p.filePath, rootDir);
    return executeGetSymbolDependents(p);
  },
  trace_function_execution: (params, rootDir) => {
    const p = params as TraceFunctionExecutionParams;
    validateCliPath(p.filePath, rootDir);
    return executeTraceFunctionExecution(p);
  },
  get_symbol_callers: (params, rootDir) => {
    const p = params as GetSymbolCallersParams;
    validateCliPath(p.filePath, rootDir);
    return executeGetSymbolCallers(p);
  },
  analyze_breaking_changes: (params, rootDir) => {
    const p = params as AnalyzeBreakingChangesParams;
    validateCliPath(p.filePath, rootDir);
    return executeAnalyzeBreakingChanges(p);
  },
  get_impact_analysis: (params, rootDir) => {
    const p = params as GetImpactAnalysisParams;
    validateCliPath(p.filePath, rootDir);
    return executeGetImpactAnalysis(p);
  },
  analyze_file_logic: (params, rootDir) => {
    const p = params as AnalyzeFileLogicParams;
    validateCliPath(p.filePath, rootDir);
    return executeAnalyzeFileLogic(p);
  },
  generate_codemap: (params, rootDir) => {
    const p = params as GenerateCodemapParams;
    validateCliPath(p.filePath, rootDir);
    return executeGenerateCodemap(p);
  },
  query_call_graph: (params, rootDir) => {
    const p = params as QueryCallGraphParams;
    validateCliPath(p.filePath, rootDir);
    return executeQueryCallGraph(p);
  },
  scan_dead_code: (params) => executeScanDeadCode(params as ScanDeadCodeParams),
};

async function invokeTool(tool: McpToolName, params: unknown): Promise<unknown> {
  const config = workerState.getConfig();
  const handler = cliToolHandlers[tool];
  if (!handler) throw new CliError(`Unknown tool: ${tool}`, ExitCode.GENERAL_ERROR);
  return handler(params, config.rootDir);
}
