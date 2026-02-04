import { getLogger } from "../../shared/logger";
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

/**
 * Filter edges by actual usage verification
 * Parallelized for better performance on large graphs
 */
async function filterEdgesByUsage(edges: EdgeInfo[]): Promise<EdgeInfo[]> {
  const spider = workerState.getSpider();
  const log = getLogger("McpWorker");

  const verificationResults = await Promise.all(
    edges.map(async (edge) => {
      try {
        const isUsed = await spider.verifyDependencyUsage(
          edge.source,
          edge.target,
        );
        return { edge, isUsed };
      } catch (err) {
        log.warn(
          `Failed to verify usage for edge ${edge.source} -> ${edge.target}`,
          err,
        );
        // Conservative: keep edge if verification fails
        return { edge, isUsed: true };
      }
    }),
  );

  return verificationResults
    .filter((result) => result.isUsed)
    .map((result) => result.edge);
}

/**
 * Crawl the full dependency graph from an entry file
 */
export async function executeCrawlDependencyGraph(
  params: CrawlDependencyGraphParams,
): Promise<CrawlDependencyGraphResult> {
  const { entryFile, maxDepth, limit, offset, onlyUsed } = params;
  const spider = workerState.getSpider();
  const config = workerState.getConfig();

  await validateFileExists(entryFile);

  // Temporarily update max depth if specified
  const originalMaxDepth = spider["config"].maxDepth;
  if (maxDepth !== undefined) {
    spider.updateConfig({ maxDepth });
  }

  try {
    const graph = await spider.crawl(entryFile);

    // Restore original max depth
    if (maxDepth !== undefined) {
      spider.updateConfig({ maxDepth: originalMaxDepth });
    }

    // Build initial counts and detect cycles
    const { dependencyCount, dependentCount } = buildEdgeCounts(graph.edges);
    const circularDependencies = detectCircularDependencies(graph.edges);

    // Build node and edge info
    let nodes = buildNodeInfo(
      graph.nodes,
      dependencyCount,
      dependentCount,
      config.rootDir,
    );
    let edges = buildEdgeInfo(graph.edges, config.rootDir);

    // Filter by usage if requested
    if (onlyUsed === true) {
      edges = await filterEdgesByUsage(edges);
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
      maxDepth: maxDepth ?? originalMaxDepth ?? 3,
      nodeCount: totalNodes,
      edgeCount: totalEdges,
      nodes,
      edges,
      circularDependencies,
    };
  } catch (error) {
    // Restore original max depth on error
    if (maxDepth !== undefined) {
      spider.updateConfig({ maxDepth: originalMaxDepth });
    }
    throw error;
  }
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
