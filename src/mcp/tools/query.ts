/**
 * MCP Natural Language Query Tool — query_natural_language
 *
 * Converts a natural language question into a TOON-format subgraph by:
 *   1. Reusing the call graph index already built by callgraph.ts (ensureCallGraphReady)
 *   2. Instantiating QueryEngine with the sql.js Database and llmClient = null
 *   3. Delegating synthesis to the LLM caller — this tool only returns the subgraph
 *
 * NO vscode imports — this module is VS Code agnostic.
 */

import { QueryEngine } from "../../analyzer/QueryEngine";
import type { QueryRequest, QueryResultEdge, QueryResultNode } from "../../shared/query-types";
import { z } from "zod/v4";
import { workerState } from "../shared/state";

// ---------------------------------------------------------------------------
// Zod schema (exported for mcpServer registration)
// ---------------------------------------------------------------------------

export const QueryNaturalLanguageSchema = z.object({
  question: z
    .string()
    .max(1024)
    .describe("Natural language question about the codebase"),
  depth: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(2)
    .optional()
    .describe("BFS traversal depth from seed nodes (default: 2, min: 1, max: 5)"),
  tokenBudget: z
    .number()
    .int()
    .min(500)
    .max(16000)
    .default(4000)
    .optional()
    .describe("Maximum token budget for the output subgraph (default: 4000, min: 500, max: 16000)"),
  fileFilter: z
    .string()
    .max(256)
    .optional()
    .describe("Glob pattern to restrict search scope (e.g. 'src/analyzer/**')"),
  outputFormat: z
    .enum(["toon", "json"])
    .default("toon")
    .optional()
    .describe("Output format: 'toon' (token-optimized, default) or 'json'"),
});

export type QueryNaturalLanguageParams = z.infer<typeof QueryNaturalLanguageSchema>;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface QueryNaturalLanguageResult {
  question: string;
  extractedKeywords: string[];
  nodeCount: number;
  edgeCount: number;
  /** TOON-format string when outputFormat='toon' */
  toon?: string;
  /** Full JSON payload when outputFormat='json' */
  nodes?: QueryResultNode[];
  edges?: QueryResultEdge[];
  meta: {
    llmProvider: string;
    keywordExtractionMs: number;
    bfsMs: number;
    totalMs: number;
    tokenEstimate: number;
    truncated: boolean;
  };
}

// ---------------------------------------------------------------------------
// Lazy call graph initialization (delegates to callgraph.ts)
// This avoids duplicating the indexing logic — if callgraph was already indexed
// by a prior query_call_graph call, we reuse the same indexer in workerState.
// ---------------------------------------------------------------------------

async function ensureCallGraphReadyForQuery(): Promise<void> {
  const config = workerState.getConfig();
  const workspaceRoot = config.rootDir;

  // Already indexed for this workspace — reuse
  if (
    workerState.callGraphIndexer &&
    workerState.callGraphIndexedRoot === workspaceRoot
  ) {
    return;
  }

  // Not indexed yet — trigger it via the callgraph tool's lazy init
  // callgraph.ts manages the singleton indexPromise to prevent double-indexing
  const { executeQueryCallGraph } = await import("./callgraph.js");

  // A dummy query to force initialization — we only care about side-effects
  try {
    await executeQueryCallGraph({
      filePath: workspaceRoot,
      symbolName: "__init_only__",
      direction: "both",
      depth: 1,
    });
  } catch {
    // Ignore errors — we only wanted the indexer to be initialized.
    // If it truly failed, workerState.callGraphIndexer will still be null
    // and we surface the error below in executeQueryNaturalLanguage.
  }
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

export async function executeQueryNaturalLanguage(
  params: QueryNaturalLanguageParams,
): Promise<QueryNaturalLanguageResult> {
  const config = workerState.getConfig();
  const workspaceRoot = config.rootDir;

  // Ensure call graph index is available
  await ensureCallGraphReadyForQuery();

  const indexer = workerState.callGraphIndexer;
  if (!indexer) {
    throw new Error(
      "Call graph indexer not initialized. The workspace may not have any supported source files.",
    );
  }

  const db = indexer.getDb();

  // Build QueryRequest — llmClient is null: the LLM caller synthesizes the answer
  const request: QueryRequest = {
    question: params.question,
    workspaceRoot,
    depth: params.depth ?? 2,
    tokenBudget: params.tokenBudget ?? 4000,
    fileFilter: params.fileFilter,
    outputFormat: params.outputFormat === "json" ? "json" : "toon",
  };

  const engine = new QueryEngine(db, null);
  const result = await engine.query(request);

  if (params.outputFormat === "json") {
    return {
      question: result.question,
      extractedKeywords: result.extractedKeywords,
      nodeCount: result.nodeCount,
      edgeCount: result.edgeCount,
      nodes: result.nodes,
      edges: result.edges,
      meta: result.meta,
    };
  }

  // Default: toon
  return {
    question: result.question,
    extractedKeywords: result.extractedKeywords,
    nodeCount: result.nodeCount,
    edgeCount: result.edgeCount,
    toon: result.toon,
    meta: result.meta,
  };
}
