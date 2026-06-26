import { workerState } from "../shared/state";
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
  executeScanDeadCode,
  executeTraceFunctionExecution,
  executeVerifyDependencyUsage,
  executeQueryNaturalLanguage,
  executeGenerateWiki,
} from "../tools";
import type {
  AnalyzeBreakingChangesParams,
  AnalyzeDependenciesParams,
  AnalyzeFileLogicParams,
  CrawlDependencyGraphParams,
  ExpandNodeParams,
  FindReferencingFilesParams,
  FindUnusedSymbolsParams,
  GenerateCodemapParams,
  GetImpactAnalysisParams,
  GetSymbolCallersParams,
  GetSymbolDependentsParams,
  GetSymbolGraphParams,
  InvalidateFilesParams,
  McpToolName,
  McpWorkerConfig,
  McpWorkerResponse,
  ParseImportsParams,
  QueryCallGraphParams,
  ResolveModulePathParams,
  ScanDeadCodeParams,
  TraceFunctionExecutionParams,
  VerifyDependencyUsageParams,
  QueryNaturalLanguageParams,
} from "../types";
import type { GenerateWikiParams } from "../types.js";
import {
  validateFilePath,
  validateToolParams,
} from "../types";

type ToolHandler = (
  params: unknown,
  config: McpWorkerConfig,
  postMessage: (msg: McpWorkerResponse) => void,
) => Promise<unknown> | unknown;

function validateRootPath(filePath: string, config: McpWorkerConfig): void {
  validateFilePath(filePath, config.rootDir);
}

const toolHandlers: Partial<Record<McpToolName, ToolHandler>> = {
  analyze_dependencies: async (params, config) => {
    const p = params as AnalyzeDependenciesParams;
    validateRootPath(p.filePath, config);
    return executeAnalyzeDependencies(p);
  },
  crawl_dependency_graph: async (params, config) => {
    const p = params as CrawlDependencyGraphParams;
    validateRootPath(p.entryFile, config);
    return executeCrawlDependencyGraph(p);
  },
  find_referencing_files: async (params, config) => {
    const p = params as FindReferencingFilesParams;
    validateRootPath(p.targetPath, config);
    return executeFindReferencingFiles(p);
  },
  expand_node: async (params, config) => {
    const p = params as ExpandNodeParams;
    validateRootPath(p.filePath, config);
    return executeExpandNode(p);
  },
  parse_imports: async (params, config) => {
    const p = params as ParseImportsParams;
    validateRootPath(p.filePath, config);
    return executeParseImports(p);
  },
  verify_dependency_usage: async (params, config) => {
    const p = params as VerifyDependencyUsageParams;
    validateRootPath(p.sourceFile, config);
    validateRootPath(p.targetFile, config);
    return executeVerifyDependencyUsage(p);
  },
  resolve_module_path: async (params, config) => {
    const p = params as ResolveModulePathParams;
    validateRootPath(p.fromFile, config);
    return executeResolveModulePath(p);
  },
  get_index_status: () => executeGetIndexStatus(),
  invalidate_files: (params, config) => {
    const p = params as InvalidateFilesParams;
    for (const filePath of p.filePaths) validateRootPath(filePath, config);
    return executeInvalidateFiles(p);
  },
  rebuild_index: (_params, _config, postMessage) => executeRebuildIndex(postMessage),
  get_symbol_graph: async (params, config) => {
    const p = params as GetSymbolGraphParams;
    validateRootPath(p.filePath, config);
    return executeGetSymbolGraph(p);
  },
  find_unused_symbols: async (params, config) => {
    const p = params as FindUnusedSymbolsParams;
    validateRootPath(p.filePath, config);
    return executeFindUnusedSymbols(p);
  },
  get_symbol_dependents: async (params, config) => {
    const p = params as GetSymbolDependentsParams;
    validateRootPath(p.filePath, config);
    return executeGetSymbolDependents(p);
  },
  trace_function_execution: async (params, config) => {
    const p = params as TraceFunctionExecutionParams;
    validateRootPath(p.filePath, config);
    return executeTraceFunctionExecution(p);
  },
  get_symbol_callers: async (params, config) => {
    const p = params as GetSymbolCallersParams;
    validateRootPath(p.filePath, config);
    return executeGetSymbolCallers(p);
  },
  analyze_breaking_changes: async (params, config) => {
    const p = params as AnalyzeBreakingChangesParams;
    validateRootPath(p.filePath, config);
    return executeAnalyzeBreakingChanges(p);
  },
  get_impact_analysis: async (params, config) => {
    const p = params as GetImpactAnalysisParams;
    validateRootPath(p.filePath, config);
    return executeGetImpactAnalysis(p);
  },
  analyze_file_logic: async (params, config) => {
    const p = params as AnalyzeFileLogicParams;
    validateRootPath(p.filePath, config);
    return executeAnalyzeFileLogic(p);
  },
  generate_codemap: async (params, config) => {
    const p = params as GenerateCodemapParams;
    validateRootPath(p.filePath, config);
    return executeGenerateCodemap(p);
  },
  query_call_graph: async (params, config) => {
    const p = params as QueryCallGraphParams;
    validateRootPath(p.filePath, config);
    return executeQueryCallGraph(p);
  },
  scan_dead_code: (params) => executeScanDeadCode(params as ScanDeadCodeParams),
  query_natural_language: (params) => executeQueryNaturalLanguage(params as QueryNaturalLanguageParams),
  generate_wiki: (params) => executeGenerateWiki(params as GenerateWikiParams),
};

async function executeValidatedTool(
  tool: McpToolName,
  params: unknown,
  config: McpWorkerConfig,
  postMessage: (msg: McpWorkerResponse) => void,
): Promise<unknown> {
  const handler = toolHandlers[tool];
  if (!handler) throw new Error(`Unknown tool: ${tool}`);
  return handler(params, config, postMessage);
}

export async function invokeTool(
  requestId: string,
  tool: McpToolName,
  params: unknown,
  postMessage: (msg: McpWorkerResponse) => void,
): Promise<void> {
  if (
    !workerState.isReady ||
    !workerState.spider ||
    !workerState.parser ||
    !workerState.resolver ||
    !workerState.config
  ) {
    postMessage({
      type: "error",
      requestId,
      error: "Worker not initialized",
      code: "NOT_INITIALIZED",
    });
    return;
  }

  const startTime = Date.now();

  try {
    // Validate parameters using Zod schema
    const validation = validateToolParams(tool, params);
    if (!validation.success) {
      postMessage({
        type: "error",
        requestId,
        error: validation.error,
        code: "VALIDATION_ERROR",
      });
      return;
    }

    const validatedParams = validation.data;
    const config = workerState.getConfig();
    const result = await executeValidatedTool(tool, validatedParams, config, postMessage);

    const executionTimeMs = Date.now() - startTime;

    postMessage({
      type: "result",
      requestId,
      data: result,
      executionTimeMs,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    const errorCode =
      errorMessage.includes("Path traversal") ||
      errorMessage.includes("outside workspace")
        ? "SECURITY_ERROR"
        : "EXECUTION_ERROR";

    postMessage({
      type: "error",
      requestId,
      error: errorMessage,
      code: errorCode,
    });
  }
}
