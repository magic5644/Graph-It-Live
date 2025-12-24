import { describe, bench, beforeAll } from 'vitest';
import { Spider } from '../../src/analyzer/Spider';
import path from 'node:path';

/**
 * Benchmark tests for unused dependency analysis performance
 * 
 * These benchmarks measure:
 * 1. Single file verification (baseline)
 * 2. Batch verification (optimized)
 * 3. Full graph unused edge detection
 * 
 * Run with: npm run test:bench
 * 
 * IMPORTANT: Uses permanent fixtures in tests/fixtures/bench-permanent
 */

const BENCH_PERMANENT_PATH = path.resolve(process.cwd(), 'tests/fixtures/bench-permanent');
const TEST_FILES = {
  app: path.join(BENCH_PERMANENT_PATH, 'src/app.ts'),
  shared: path.join(BENCH_PERMANENT_PATH, 'src/shared.ts'),
  utils: path.join(BENCH_PERMANENT_PATH, 'src/utils.ts'),
};

let _spider: Spider | null = null;
let _graphData: { nodes: string[]; edges: Array<{ source: string; target: string }> } | null = null;

async function getSpider(): Promise<Spider> {
  if (!_spider) {
    _spider = new Spider({
      rootDir: BENCH_PERMANENT_PATH,
      enableReverseIndex: true,
      indexingConcurrency: 8,
    });
    // Pre-warm the cache
    await _spider.crawl(TEST_FILES.app);
  }
  return _spider;
}

async function getGraphData() {
  if (!_graphData) {
    const spider = await getSpider();
    _graphData = await spider.crawl(TEST_FILES.app);
  }
  return _graphData;
}

// Helper to reduce nesting depth
async function processBatchFile(
  spider: Spider,
  edgesBySource: Map<string, Array<{ source: string; target: string }>>,
  sourceFile: string
) {
  const edges = edgesBySource.get(sourceFile)!;
  const targetFiles = edges.map(e => e.target);
  await spider.verifyDependencyUsageBatch(sourceFile, targetFiles);
}

describe('Unused Dependency Analysis Performance', () => {
  beforeAll(async () => {
    // Ensure spider and graph are initialized before benchmarks
    await getSpider();
    await getGraphData();
  });

  describe('Single File Verification', () => {
    bench('verifyDependencyUsage - single edge', async () => {
      const spider = await getSpider();
      await spider.verifyDependencyUsage(TEST_FILES.app, TEST_FILES.shared);
    });

    bench('verifyDependencyUsage - cached result', async () => {
      const spider = await getSpider();
      // Second call should hit cache
      await spider.verifyDependencyUsage(TEST_FILES.app, TEST_FILES.shared);
    });
  });

  describe('Batch Verification (Optimized)', () => {
    bench('verifyDependencyUsageBatch - 3 targets', async () => {
      const spider = await getSpider();
      const targets = [TEST_FILES.shared, TEST_FILES.utils, '/non/existent/file.ts'];
      await spider.verifyDependencyUsageBatch(TEST_FILES.app, targets);
    });

    bench('verifyDependencyUsageBatch - 10 targets', async () => {
      const spider = await getSpider();
      // Simulate checking 10 different targets from same source
      const targets = Array.from({ length: 10 }, (_, i) => 
        path.join(BENCH_PERMANENT_PATH, `src/module${i}.ts`)
      );
      await spider.verifyDependencyUsageBatch(TEST_FILES.app, targets);
    });
  });

  describe('Full Graph Analysis', () => {
    bench('analyze all edges individually (old approach)', async () => {
      const spider = await getSpider();
      const graph = await getGraphData();
      
      for (const edge of graph.edges) {
        await spider.verifyDependencyUsage(edge.source, edge.target);
      }
    });

    bench('analyze all edges with batching (new approach)', async () => {
      const spider = await getSpider();
      const graph = await getGraphData();
      
      // Group by source (simulates GraphViewService.populateUnusedEdges)
      const edgesBySource = new Map<string, string[]>();
      for (const edge of graph.edges) {
        const targets = edgesBySource.get(edge.source) || [];
        targets.push(edge.target);
        edgesBySource.set(edge.source, targets);
      }
      
      for (const [source, targets] of edgesBySource) {
        await spider.verifyDependencyUsageBatch(source, targets);
      }
    });

    bench('analyze edges with concurrency control (production approach)', async () => {
      const spider = await getSpider();
      const graph = await getGraphData();
      
      const edgesBySource = new Map<string, Array<{ source: string; target: string }>>();
      for (const edge of graph.edges) {
        const group = edgesBySource.get(edge.source) || [];
        group.push(edge);
        edgesBySource.set(edge.source, group);
      }
      
      const CONCURRENCY = 8;
      const sourceFiles = Array.from(edgesBySource.keys());
      
      for (let i = 0; i < sourceFiles.length; i += CONCURRENCY) {
        const batch = sourceFiles.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(sourceFile => processBatchFile(spider, edgesBySource, sourceFile)));
      }
    });
  });

  describe('Cache Performance', () => {
    bench('getSymbolGraph - cache hit', async () => {
      const spider = await getSpider();
      // This should always hit cache after first call
      await (spider as any).symbolService.getSymbolGraph(TEST_FILES.app);
    });

    bench('getSymbolGraph - cache miss (new file)', async () => {
      const spider = await getSpider();
      // Use a timestamp to ensure cache miss
      const tempPath = path.join(BENCH_PERMANENT_PATH, `src/temp_${Date.now()}.ts`);
      try {
        await (spider as any).symbolService.getSymbolGraph(tempPath);
      } catch {
        // Expected to fail, just measuring cache miss overhead
      }
    });
  });
});

describe('Comparison: Individual vs Batch', () => {
  bench('baseline: check 10 targets individually', async () => {
    const spider = await getSpider();
    const targets = Array.from({ length: 10 }, (_, i) => 
      path.join(BENCH_PERMANENT_PATH, `src/module${i}.ts`)
    );
    
    for (const target of targets) {
      await spider.verifyDependencyUsage(TEST_FILES.app, target);
    }
  });

  bench('optimized: check 10 targets in batch', async () => {
    const spider = await getSpider();
    const targets = Array.from({ length: 10 }, (_, i) => 
      path.join(BENCH_PERMANENT_PATH, `src/module${i}.ts`)
    );
    
    await spider.verifyDependencyUsageBatch(TEST_FILES.app, targets);
  });
});
