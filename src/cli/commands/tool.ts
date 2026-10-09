/**
 * CLI Command: tool
 *
 * MCP parity passthrough — invoke any MCP tool by name.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { z } from "zod";
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
import { resolveToolFilePaths, toolSchemas, validateToolParams } from "../../mcp/types";
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

  // Parse --args JSON and --key=value / --key value flags from remaining args
  const params = parseToolArgs(args.slice(1), booleanParams(toolName));

  // Validate params via Zod before indexing so bad input fails fast
  const validation = validateToolParams(toolName, params);
  if (!validation.success) {
    throw new CliError(validation.error, ExitCode.GENERAL_ERROR);
  }

  await runtime.ensureIndexed();

  const result = await invokeTool(toolName, validation.data);
  return formatOutput(result, format, "tool", runtime.workspaceRoot);
}

/**
 * Tool parameters from CLI flags. `--args '<json>'` provides the base object;
 * named flags override its keys. A flag takes its value after `=` or from the
 * next token, except the tool's boolean parameters, which may stand alone.
 * Any other token is a usage error: dropping it silently would report the
 * parameter as missing instead of pointing at the mistake.
 */
export function parseToolArgs(
  args: string[],
  booleanKeys: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  const named: Record<string, unknown> = {};
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    const eqIdx = arg.indexOf("=");
    if (arg === "--args") {
      base = parseArgsJson(args[i + 1]);
      i += 2;
    } else if (!arg.startsWith("--")) {
      throw new CliError(
        `Unexpected argument "${arg}". Pass tool parameters as --<name>=<value> or --<name> <value> ` +
          `(see graph-it tool <name> --help)`,
        ExitCode.GENERAL_ERROR,
      );
    } else if (eqIdx >= 0) {
      named[arg.slice(2, eqIdx)] = parseFlagValue(arg.slice(eqIdx + 1));
      i += 1;
    } else {
      const { value, width } = readSpacedValue(arg, args[i + 1], booleanKeys.has(arg.slice(2)));
      named[arg.slice(2)] = value;
      i += width;
    }
  }
  return { ...base, ...named };
}

function parseArgsJson(json: string | undefined): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json ?? "");
  } catch {
    throw new CliError("Invalid JSON after --args", ExitCode.GENERAL_ERROR);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError("--args must be a JSON object", ExitCode.GENERAL_ERROR);
  }
  return parsed as Record<string, unknown>;
}

/** JSON value (number, boolean, array) when the text parses as one, the text otherwise. */
function parseFlagValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Value of a flag written without `=`, and how many tokens it spans. */
function readSpacedValue(
  flag: string,
  next: string | undefined,
  isBoolean: boolean,
): { value: unknown; width: number } {
  if (isBoolean) {
    return next === "true" || next === "false"
      ? { value: next === "true", width: 2 }
      : { value: true, width: 1 };
  }
  if (next === undefined || next.startsWith("--")) {
    throw new CliError(`${flag} needs a value: ${flag}=<value> or ${flag} <value>`, ExitCode.GENERAL_ERROR);
  }
  return { value: parseFlagValue(next), width: 2 };
}

interface ToolInputSchema {
  properties?: Record<string, { type?: string; description?: string }>;
  required?: string[];
}

/** JSON Schema of a tool's input: the same Zod schema that validates it. */
function toolInputSchema(tool: McpToolName): ToolInputSchema {
  return z.toJSONSchema(toolSchemas[tool], { io: "input", unrepresentable: "any" }) as ToolInputSchema;
}

function booleanParams(tool: McpToolName): Set<string> {
  const { properties = {} } = toolInputSchema(tool);
  return new Set(Object.keys(properties).filter((key) => properties[key].type === "boolean"));
}

/**
 * `graph-it tool <name> --help`: the tool's parameters with type, required flag
 * and description, plus an example. Undefined for an unknown tool name, so the
 * caller falls back to the generic `tool` help.
 */
export function getToolHelp(name: string): string | undefined {
  if (!TOOL_NAMES.includes(name as McpToolName)) return undefined;
  const tool = name as McpToolName;
  const { properties = {}, required = [] } = toolInputSchema(tool);
  const params = Object.entries(properties).map(([key, prop]) => {
    const flag = `--${key} <${prop.type ?? "json"}>`.padEnd(32);
    const presence = required.includes(key) ? "required" : "optional";
    return ["  " + flag, presence, prop.description].filter(Boolean).join("  ");
  });
  const example = ["graph-it tool", tool, ...required.map((key) => `--${key} <${key}>`)].join(" ");
  return `graph-it tool ${tool} — ${toolSummary(tool)}

Usage: graph-it tool ${tool} [--<param> <value>...] [--args '<json>'] [options]

Parameters:
${params.length > 0 ? params.join("\n") : "  (none)"}

Array and object values are JSON: --<param>='["a","b"]'.

Example:
  ${example}
`;
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
