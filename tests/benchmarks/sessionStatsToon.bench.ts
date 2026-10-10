import { bench, describe } from "vitest";
import { formatDataAsToon } from "../../src/mcp/responseFormatter";
import type { CrawlDependencyGraphResult } from "../../src/mcp/types";

const BENCH_OPTIONS = {
  time: 100,
  warmupTime: 0,
  warmupIterations: 1,
  iterations: 5,
} as const;

/**
 * Benchmark for the TOON encoding + token estimate that runs on every MCP/CLI
 * TOON response (formatDataAsToon → jsonToToon + estimateTokenSavings, then
 * session stats). Payloads follow the crawl_dependency_graph result shape with
 * ~4 edges per node, the ratio measured on this repository.
 *
 * Run with: npm run test:bench
 */

const EDGES_PER_NODE = 4;

function buildCrawlResult(nodeCount: number): CrawlDependencyGraphResult {
  const relativePath = (i: number) => `src/module${Math.floor(i / 20)}/file${i}.ts`;
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    path: `/workspace/${relativePath(i)}`,
    relativePath: relativePath(i),
    extension: ".ts",
    dependencyCount: EDGES_PER_NODE,
    dependentCount: EDGES_PER_NODE,
    hubScore: (i % 100) / 100,
    communityId: Math.floor(i / 20) + 1,
  }));
  const edges = nodes.flatMap((node, i) =>
    Array.from({ length: EDGES_PER_NODE }, (_, j) => {
      const target = nodes[(i * 7 + j * 13 + 1) % nodeCount];
      return {
        source: node.path,
        target: target.path,
        sourceRelative: node.relativePath,
        targetRelative: target.relativePath,
      };
    }),
  );
  return {
    entryFile: nodes[0].path,
    maxDepth: 50,
    nodeCount,
    edgeCount: edges.length,
    nodes,
    edges,
    circularDependencies: [],
  };
}

describe("TOON response encoding (crawl_dependency_graph payloads)", () => {
  for (const nodeCount of [100, 1_000, 5_000]) {
    const payload = buildCrawlResult(nodeCount);
    bench(`formatDataAsToon - ${nodeCount} nodes / ${payload.edgeCount} edges`, () => {
      formatDataAsToon(payload, "data", "graphitlive_crawl_dependency_graph");
    }, BENCH_OPTIONS);
  }
});
