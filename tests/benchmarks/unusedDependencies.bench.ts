import { describe, bench, beforeAll } from 'vitest';
import { Spider } from '../../src/analyzer/Spider';
import path from 'node:path';

const BENCH_OPTIONS = {
  time: 10,
  warmupTime: 0,
  warmupIterations: 0,
  iterations: 1,
} as const;

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

function getSymbolService(spider: Spider): { getSymbolGraph: (filePath: string) => Promise<unknown> } {
  return (spider as unknown as { symbolService: { getSymbolGraph: (filePath: string) => Promise<unknown> } }).symbolService;
}

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
    }, BENCH_OPTIONS);

    bench('verifyDependencyUsage - cached result', async () => {
      const spider = await getSpider();
      // Second call should hit cache
      await spider.verifyDependencyUsage(TEST_FILES.app, TEST_FILES.shared);
    }, BENCH_OPTIONS);
  });

  describe('Batch Verification (Optimized)', () => {
    bench('verifyDependencyUsageBatch - 3 targets', async () => {
      const spider = await getSpider();
      const targets = [
        TEST_FILES.shared,
        TEST_FILES.utils,
        path.join(BENCH_PERMANENT_PATH, 'src/unused.ts'),
      ];
      await spider.verifyDependencyUsageBatch(TEST_FILES.app, targets);
    }, BENCH_OPTIONS);

    bench('verifyDependencyUsageBatch - 10 targets', async () => {
      const spider = await getSpider();
      // Simulate checking 10 different targets from same source
      const targets = Array.from({ length: 10 }, (_, i) => 
        path.join(BENCH_PERMANENT_PATH, `src/module${i}.ts`)
      );
      await spider.verifyDependencyUsageBatch(TEST_FILES.app, targets);
    }, BENCH_OPTIONS);
  });

  describe('Full Graph Analysis', () => {
    bench('analyze all edges individually (old approach)', async () => {
      const spider = await getSpider();
      const graph = await getGraphData();
      
      for (const edge of graph.edges) {
        await spider.verifyDependencyUsage(edge.source, edge.target);
      }
    }, BENCH_OPTIONS);

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
    }, BENCH_OPTIONS);

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
    }, BENCH_OPTIONS);
  });

  describe('Cache Performance', () => {
    bench('getSymbolGraph - cache hit', async () => {
      const spider = await getSpider();
      const symbolService = getSymbolService(spider);
      // This should always hit cache after first call
      await symbolService.getSymbolGraph(TEST_FILES.app);
    }, BENCH_OPTIONS);

    bench('getSymbolGraph - cache miss (new file)', async () => {
      const spider = await getSpider();
      const symbolService = getSymbolService(spider);
      // Use existing different file to measure cache miss
      // First call on utils.ts will be a cache miss
      const utilsFile = path.join(BENCH_PERMANENT_PATH, 'src/utils.ts');
      await symbolService.getSymbolGraph(utilsFile);
    }, BENCH_OPTIONS);
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
  }, BENCH_OPTIONS);

  bench('optimized: check 10 targets in batch', async () => {
    const spider = await getSpider();
    const targets = Array.from({ length: 10 }, (_, i) => 
      path.join(BENCH_PERMANENT_PATH, `src/module${i}.ts`)
    );
    
    await spider.verifyDependencyUsageBatch(TEST_FILES.app, targets);
  }, BENCH_OPTIONS);
});
