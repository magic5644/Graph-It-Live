import { mapWithConcurrency } from "../../shared/concurrency";
import { getLogger } from "../../shared/logger";
import { cycleKinds as classifyCycles } from "../../shared/cycleUtils";
import { assertOffsetInRange } from "../../shared/paging";
import { normalizePath } from "../../shared/path";
import { computeNodeMetadata } from "../../analyzer/NodeMetadataBuilder";
import type { GraphData } from "../../shared/graph-types";
import {
    buildEdgeCounts,
    buildEdgeInfo,
    buildNodeInfo,
    detectCircularDependencies,
    edgeOwners,
    fitToTokenBudget,
    getRelativePath,
    updateNodeCounts,
} from "../shared/helpers";
import { validateFileExists } from "../../shared/pathSecurity";
import type { Spider } from "../../analyzer/Spider";
import { workerState } from "../shared/state";
import type {
    CrawlDependencyGraphParams,
    CrawlDependencyGraphResult,
    EdgeInfo,
    FindReferencingFilesParams,
    FindReferencingFilesResult,
} from "../types";

const MAX_USAGE_VERIFICATIONS = 5_000;

/**
 * Filter edges by actual usage verification
 * Parallelized for better performance on large graphs
 */
async function filterEdgesByUsage(
  spider: Spider,
  edges: EdgeInfo[],
  signal?: AbortSignal,
): Promise<EdgeInfo[]> {
  const log = getLogger("McpWorker");
  const verificationResults = await mapWithConcurrency(edges, 8, async (edge) => {
    if (signal?.aborted) throw createAbortError();
    try {
      return { edge, isUsed: await spider.verifyDependencyUsage(edge.source, edge.target) };
    } catch (err) {
      log.warn(
        `Failed to verify usage for edge ${edge.source} -> ${edge.target}`,
        err,
      );
      // Conservative: keep edge if verification fails
      return { edge, isUsed: true };
    }
  });

  return verificationResults
    .filter((result) => result.isUsed)
    .map((result) => result.edge);
}

/**
 * Crawl the full dependency graph from an entry file
 */
export async function executeCrawlDependencyGraph(
  params: CrawlDependencyGraphParams,
  signal?: AbortSignal,
): Promise<CrawlDependencyGraphResult> {
  const config = workerState.getConfig();
  return crawlDependencyGraph({ spider: workerState.getSpider(), rootDir: config.rootDir, maxDepth: config.maxDepth }, params, signal);
}

/** The index a crawl reads: the MCP worker's, or the extension's for its language model tool. */
export interface CrawlContext {
  spider: Spider;
  rootDir: string;
  /** Depth used when the call sets none. */
  maxDepth?: number;
}

/** crawl_dependency_graph on a given index, shared by the MCP tool and its VS Code language model tool. */
export async function crawlDependencyGraph(
  context: CrawlContext,
  params: CrawlDependencyGraphParams,
  signal?: AbortSignal,
): Promise<CrawlDependencyGraphResult> {
  const { entryFile, maxDepth, limit, offset, onlyUsed, tokenBudget, communityMode } = params;
  const { spider } = context;
  const config = { rootDir: context.rootDir };

  await validateFileExists(entryFile);
  const configuredMaxDepth = context.maxDepth;

  const graph = await spider.crawl(entryFile, { maxDepth, signal });

    // Build initial counts and detect cycles
    const { dependencyCount, dependentCount } = buildEdgeCounts(graph.edges);
    const circularDependencies = detectCircularDependencies(graph.edges);
    const cycleKinds = classifyCycles(circularDependencies, graph.edges);

    // Compute hubScore + communityId — same logic as CLI and extension
    const parentCounts: Record<string, number> = {};
    for (const [fp, cnt] of dependentCount) parentCounts[normalizePath(fp)] = cnt;
    const graphData: GraphData = { nodes: graph.nodes.map(normalizePath), edges: graph.edges, parentCounts };
    computeNodeMetadata(graphData, config.rootDir, communityMode);

    // Build node and edge info — use graphData.nodes (already normalized) so
    // metadata lookup keys match nodeMetadata index (Règle 03).
    const nodes = buildNodeInfo(
      graphData.nodes,
      dependencyCount,
      dependentCount,
      config.rootDir,
      graphData.nodeMetadata,
    );
    let edges = buildEdgeInfo(graph.edges, config.rootDir);

    // Filter by usage if requested
    if (onlyUsed === true) {
      if (edges.length > MAX_USAGE_VERIFICATIONS) {
        throw new Error(
          `onlyUsed supports at most ${MAX_USAGE_VERIFICATIONS} edges per request`,
        );
      }
      edges = await filterEdgesByUsage(spider, edges, signal);
      updateNodeCounts(nodes, edges);
    }

  // Nodes keep crawl order (nearest first). The page is [offset, offset+limit),
  // cut further by the tokenBudget; nextOffset resumes after the last node sent.
  const start = offset ?? 0;
  assertOffsetInRange(start, nodes.length, "nodes");
  const pageSize = Math.max(0, Math.min(nodes.length, limit === undefined ? nodes.length : start + limit) - start);
  const owners = edgeOwners(nodes.map((node) => node.path), edges);
  const page = (count: number): CrawlDependencyGraphResult => {
    const end = start + count;
    return {
      entryFile,
      maxDepth: maxDepth ?? configuredMaxDepth ?? 3,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      nodes: nodes.slice(start, end),
      edges: edges.filter((_, index) => owners[index] >= start && owners[index] < end),
      circularDependencies,
      cycleKinds,
      // Partial whenever nodes remain after this page, cut by limit or by tokenBudget.
      truncated: end < nodes.length,
      ...(end < nodes.length ? { nextOffset: end } : {}),
    };
  };
  if (!tokenBudget) return page(pageSize);

  const fullPage = page(pageSize);
  return fitToTokenBudget(pageSize, tokenBudget, (count) => {
    const budgeted = page(count);
    return {
      ...budgeted,
      omitted: {
        nodes: pageSize - count,
        edges: fullPage.edges.length - budgeted.edges.length,
      },
    };
  }).result;
}

function createAbortError(): Error {
  const error = new Error("Tool invocation cancelled");
  error.name = "AbortError";
  return error;
}

/**
 * Find all files that reference/import a target file
 */
export async function executeFindReferencingFiles(
  params: FindReferencingFilesParams,
): Promise<FindReferencingFilesResult> {
  const { targetPath } = params;
  const spider = workerState.getSpider();
  const config = workerState.getConfig();

  await validateFileExists(targetPath);

  const references = await spider.findReferencingFilesThroughBarrels(targetPath);

  return {
    targetPath,
    referencingFileCount: references.length,
    referencingFiles: references.map((ref) => ({
      path: ref.path,
      relativePath: getRelativePath(ref.path, config.rootDir),
      type: ref.type,
      line: ref.line,
      module: ref.module,
      ...(ref.typeOnly ? { typeOnly: true } : {}),
      ...(ref.via ? { via: getRelativePath(ref.via, config.rootDir) } : {}),
    })),
  };
}
