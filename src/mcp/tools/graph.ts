import { getLogger } from "../../shared/logger";
import { normalizePath } from "../../shared/path";
import { computeNodeMetadata } from "../../analyzer/NodeMetadataBuilder";
import type { GraphData } from "../../shared/graph-types";
import {
    applyPagination,
    buildEdgeCounts,
    buildEdgeInfo,
    buildNodeInfo,
    detectCircularDependencies,
    getRelativePath,
    updateNodeCounts,
    validateFileExists,
} from "../shared/helpers";
import { workerState } from "../shared/state";
import type {
    CrawlDependencyGraphParams,
    CrawlDependencyGraphResult,
    EdgeInfo,
    ExpandNodeParams,
    ExpandNodeResult,
    FindReferencingFilesParams,
    FindReferencingFilesResult,
} from "../types";

const MAX_USAGE_VERIFICATIONS = 5_000;

/**
 * Filter edges by actual usage verification
 * Parallelized for better performance on large graphs
 */
async function filterEdgesByUsage(
  edges: EdgeInfo[],
  signal?: AbortSignal,
): Promise<EdgeInfo[]> {
  const spider = workerState.getSpider();
  const log = getLogger("McpWorker");
  const verificationResults = new Array<{ edge: EdgeInfo; isUsed: boolean }>(edges.length);
  let nextIndex = 0;
  const concurrency = Math.min(8, edges.length);

  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (nextIndex < edges.length) {
      if (signal?.aborted) throw createAbortError();
      const index = nextIndex++;
      const edge = edges[index];
      try {
        const isUsed = await spider.verifyDependencyUsage(
          edge.source,
          edge.target,
        );
        verificationResults[index] = { edge, isUsed };
      } catch (err) {
        log.warn(
          `Failed to verify usage for edge ${edge.source} -> ${edge.target}`,
          err,
        );
        // Conservative: keep edge if verification fails
        verificationResults[index] = { edge, isUsed: true };
      }
    }
  }));

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
  const { entryFile, maxDepth, limit, offset, onlyUsed } = params;
  const spider = workerState.getSpider();
  const config = workerState.getConfig();

  await validateFileExists(entryFile);
  const configuredMaxDepth = config.maxDepth;

  const graph = await spider.crawl(entryFile, { maxDepth, signal });

    // Build initial counts and detect cycles
    const { dependencyCount, dependentCount } = buildEdgeCounts(graph.edges);
    const circularDependencies = detectCircularDependencies(graph.edges);

    // Compute hubScore + communityId — same logic as CLI and extension
    const parentCounts: Record<string, number> = {};
    for (const [fp, cnt] of dependentCount) parentCounts[normalizePath(fp)] = cnt;
    const graphData: GraphData = { nodes: graph.nodes.map(normalizePath), edges: graph.edges, parentCounts };
    computeNodeMetadata(graphData, config.rootDir);

    // Build node and edge info — use graphData.nodes (already normalized) so
    // metadata lookup keys match nodeMetadata index (Règle 03).
    let nodes = buildNodeInfo(
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
      edges = await filterEdgesByUsage(edges, signal);
      updateNodeCounts(nodes, edges);
    }

    // Store totals before pagination
    const totalNodes = nodes.length;
    const totalEdges = edges.length;

    // Apply pagination if requested
    if (limit !== undefined || offset !== undefined) {
      const paginated = applyPagination(nodes, edges, limit, offset);
      nodes = paginated.nodes;
      edges = paginated.edges;
    }

  return {
    entryFile,
    maxDepth: maxDepth ?? configuredMaxDepth ?? 3,
    nodeCount: totalNodes,
    edgeCount: totalEdges,
    nodes,
    edges,
    circularDependencies,
  };
}

function createAbortError(): Error {
  const error = new Error("Tool invocation cancelled");
  error.name = "AbortError";
  return error;
}

/**
 * Expand a node to discover new dependencies not in the known set
 */
export async function executeExpandNode(
  params: ExpandNodeParams,
): Promise<ExpandNodeResult> {
  const { filePath, knownPaths, extraDepth } = params;
  const spider = workerState.getSpider();
  const config = workerState.getConfig();

  await validateFileExists(filePath);

  const existingNodes = new Set<string>(knownPaths);
  const result = await spider.crawlFrom(
    filePath,
    existingNodes,
    extraDepth ?? 10,
  );

  return {
    expandedNode: filePath,
    newNodeCount: result.nodes.length,
    newEdgeCount: result.edges.length,
    newNodes: result.nodes,
    newEdges: result.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      sourceRelative: getRelativePath(edge.source, config.rootDir),
      targetRelative: getRelativePath(edge.target, config.rootDir),
    })),
  };
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

  const references = await spider.findReferencingFiles(targetPath);

  return {
    targetPath,
    referencingFileCount: references.length,
    referencingFiles: references.map((ref) => ({
      path: ref.path,
      relativePath: getRelativePath(ref.path, config.rootDir),
      type: ref.type,
      line: ref.line,
      module: ref.module,
    })),
  };
}
