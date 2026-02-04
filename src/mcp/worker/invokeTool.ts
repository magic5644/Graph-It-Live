import { workerState } from "../shared/state";
import {
    executeAnalyzeBreakingChanges,
    executeAnalyzeDependencies,
    executeAnalyzeFileLogic,
    executeCrawlDependencyGraph,
    executeExpandNode,
    executeFindReferencingFiles,
    executeFindUnusedSymbols,
    executeGetImpactAnalysis,
    executeGetIndexStatus,
    executeGetSymbolCallers,
    executeGetSymbolDependents,
    executeGetSymbolGraph,
    executeInvalidateFiles,
    executeParseImports,
    executeRebuildIndex,
    executeResolveModulePath,
    executeTraceFunctionExecution,
    executeVerifyDependencyUsage,
} from "../tools";
import type {
    AnalyzeBreakingChangesParams,
    AnalyzeDependenciesParams,
    AnalyzeFileLogicParams,
    CrawlDependencyGraphParams,
    ExpandNodeParams,
    FindReferencingFilesParams,
    FindUnusedSymbolsParams,
    GetImpactAnalysisParams,
    GetSymbolCallersParams,
    GetSymbolDependentsParams,
    GetSymbolGraphParams,
    InvalidateFilesParams,
    McpToolName,
    McpWorkerResponse,
    ParseImportsParams,
    ResolveModulePathParams,
    TraceFunctionExecutionParams,
    VerifyDependencyUsageParams,
} from "../types";
import {
    validateFilePath,
    validateToolParams,
} from "../types";

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
    let result: unknown;

    switch (tool) {
      case "analyze_dependencies": {
        const p = validatedParams as AnalyzeDependenciesParams;
        validateFilePath(p.filePath, config.rootDir);
        result = await executeAnalyzeDependencies(p);
        break;
      }
      case "crawl_dependency_graph": {
        const p = validatedParams as CrawlDependencyGraphParams;
        validateFilePath(p.entryFile, config.rootDir);
        result = await executeCrawlDependencyGraph(p);
        break;
      }
      case "find_referencing_files": {
        const p = validatedParams as FindReferencingFilesParams;
        validateFilePath(p.targetPath, config.rootDir);
        result = await executeFindReferencingFiles(p);
        break;
      }
      case "expand_node": {
        const p = validatedParams as ExpandNodeParams;
        validateFilePath(p.filePath, config.rootDir);
        result = await executeExpandNode(p);
        break;
      }
      case "parse_imports": {
        const p = validatedParams as ParseImportsParams;
        validateFilePath(p.filePath, config.rootDir);
        result = await executeParseImports(p);
        break;
      }
      case "verify_dependency_usage": {
        const p = validatedParams as VerifyDependencyUsageParams;
        validateFilePath(p.sourceFile, config.rootDir);
        validateFilePath(p.targetFile, config.rootDir);
        result = await executeVerifyDependencyUsage(p);
        break;
      }
      case "resolve_module_path": {
        const p = validatedParams as ResolveModulePathParams;
        validateFilePath(p.fromFile, config.rootDir);
        result = await executeResolveModulePath(p);
        break;
      }
      case "get_index_status":
        result = await executeGetIndexStatus();
        break;
      case "invalidate_files": {
        const p = validatedParams as InvalidateFilesParams;
        for (const filePath of p.filePaths) {
          validateFilePath(filePath, config.rootDir);
        }
        result = executeInvalidateFiles(p);
        break;
      }
      case "rebuild_index":
        result = await executeRebuildIndex(postMessage);
        break;
      case "get_symbol_graph": {
        const p = validatedParams as GetSymbolGraphParams;
        validateFilePath(p.filePath, config.rootDir);
        result = await executeGetSymbolGraph(p);
        break;
      }
      case "find_unused_symbols": {
        const p = validatedParams as FindUnusedSymbolsParams;
        validateFilePath(p.filePath, config.rootDir);
        result = await executeFindUnusedSymbols(p);
        break;
      }
      case "get_symbol_dependents": {
        const p = validatedParams as GetSymbolDependentsParams;
        validateFilePath(p.filePath, config.rootDir);
        result = await executeGetSymbolDependents(p);
        break;
      }
      case "trace_function_execution": {
        const p = validatedParams as TraceFunctionExecutionParams;
        validateFilePath(p.filePath, config.rootDir);
        result = await executeTraceFunctionExecution(p);
        break;
      }
      case "get_symbol_callers": {
        const p = validatedParams as GetSymbolCallersParams;
        validateFilePath(p.filePath, config.rootDir);
        result = await executeGetSymbolCallers(p);
        break;
      }
      case "analyze_breaking_changes": {
        const p = validatedParams as AnalyzeBreakingChangesParams;
        validateFilePath(p.filePath, config.rootDir);
        result = await executeAnalyzeBreakingChanges(p);
        break;
      }
      case "get_impact_analysis": {
        const p = validatedParams as GetImpactAnalysisParams;
        validateFilePath(p.filePath, config.rootDir);
        result = await executeGetImpactAnalysis(p);
        break;
      }
      case "analyze_file_logic": {
        const p = validatedParams as AnalyzeFileLogicParams;
        validateFilePath(p.filePath, config.rootDir);
        result = await executeAnalyzeFileLogic(p);
        break;
      }
      default:
        throw new Error(`Unknown tool: ${tool}`);
    }

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
