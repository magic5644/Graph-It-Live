import { LspCallHierarchyAnalyzer } from "../../analyzer/LspCallHierarchyAnalyzer";
import { getLogger } from "../../shared/logger";
import type { IntraFileGraph } from "../../shared/types";
import { convertSpiderToLspFormat, validateAnalysisInput } from "../shared/helpers";
import { workerState } from "../shared/state";
import type { AnalyzeFileLogicParams } from "../types";

const log = getLogger("McpWorker");

/**
 * Analyze intra-file call hierarchy using LSP data
 */
export async function executeAnalyzeFileLogic(
  params: AnalyzeFileLogicParams,
): Promise<{
  filePath: string;
  graph: IntraFileGraph;
  language: string;
  analysisTimeMs: number;
  isPartial?: boolean;
  warnings?: string[];
}> {
  const { filePath } = params;
  const spider = workerState.getSpider();
  // Note: includeExternal will be used in T066 when integrating LSP call hierarchy

  // Validate input parameters
  const { language } = await validateAnalysisInput(filePath);

  const startTime = Date.now();
  const isPartial = false;
  const warnings: string[] = [];

  try {
    // Get symbol graph data using Spider's AST-based analysis
    const symbolGraphData = await spider.getSymbolGraph(filePath);

    // Convert Spider's symbol format to LSP format for LspCallHierarchyAnalyzer
    const lspData = convertSpiderToLspFormat(symbolGraphData, filePath);

    // Use LspCallHierarchyAnalyzer to build the graph (T066)
    const analyzer = new LspCallHierarchyAnalyzer();
    const graph = analyzer.buildIntraFileGraph(filePath, lspData);

    const analysisTimeMs = Date.now() - startTime;

    log.info(
      `Analyzed file logic for ${filePath} in ${analysisTimeMs}ms (${graph.nodes.length} symbols, ${graph.edges.length} edges)`,
    );

    // T065: Return with optional partial results flag
    const result: {
      filePath: string;
      graph: IntraFileGraph;
      language: string;
      analysisTimeMs: number;
      isPartial?: boolean;
      warnings?: string[];
    } = {
      filePath,
      graph,
      language,
      analysisTimeMs,
    };

    if (isPartial) {
      result.isPartial = true;
    }

    if (warnings.length > 0) {
      result.warnings = warnings;
    }

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // T065: Enhanced error code mapping
    // Check for timeout errors
    if (errorMessage.includes("timeout") || errorMessage.includes("timed out")) {
      throw new Error(
        `LSP_TIMEOUT: LSP call hierarchy analysis timed out for ${filePath} (exceeded 5 seconds)`,
        { cause: error }
      );
    }

    // Check for LSP availability errors
    if (errorMessage.includes("LSP") || errorMessage.includes("language server")) {
      throw new Error(
        `LSP_UNAVAILABLE: Language server protocol is not available for ${filePath}. ${errorMessage}`,
        { cause: error }
      );
    }

    // Check for file system errors
    if (errorMessage.includes("ENOENT") || errorMessage.includes("no such file")) {
      throw new Error(`FILE_NOT_FOUND: File does not exist: ${filePath}`, { cause: error });
    }

    // Generic analysis failure
    throw new Error(
      `ANALYSIS_FAILED: Symbol analysis failed for ${filePath}. ${errorMessage}`,
      { cause: error }
    );
  }
}
