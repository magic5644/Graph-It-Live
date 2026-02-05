import { describe, bench, afterEach } from 'vitest';
import { Spider } from '../../src/analyzer/Spider';
import { SpiderBuilder } from '../../src/analyzer/SpiderBuilder';
import path from 'node:path';

const BENCH_OPTIONS = {
  time: 2000, // 2 seconds per benchmark
  warmupTime: 500, // 0.5 second warmup
  warmupIterations: 2,
  iterations: 10,
} as const;

/**
 * Benchmark tests for SpiderBuilder vs direct Spider construction
 * 
 * These benchmarks compare:
 * 1. Initialization time: SpiderBuilder vs direct Spider constructor
 * 2. Memory overhead of builder pattern
 * 3. Configuration validation performance
 * 
 * Run with: npm run test:bench
 * 
 * IMPORTANT: Uses permanent fixtures in tests/fixtures/bench-permanent
 */

// Path to permanent fixtures (no cleanup, always available)
const BENCH_PERMANENT_PATH = path.resolve(process.cwd(), 'tests/fixtures/bench-permanent');

describe('SpiderBuilder Performance', () => {
  describe('Initialization Performance', () => {
    bench('Direct Spider constructor (legacy)', async () => {
      const spider = new Spider({
        rootDir: BENCH_PERMANENT_PATH,
        maxDepth: 50,
        excludeNodeModules: true,
        enableReverseIndex: false,
        indexingConcurrency: 4,
        maxCacheSize: 500,
        maxSymbolCacheSize: 200,
        maxSymbolAnalyzerFiles: 100,
      });
      await spider.dispose();
    }, BENCH_OPTIONS);

    bench('SpiderBuilder (new pattern)', async () => {
      const spider = new SpiderBuilder()
        .withRootDir(BENCH_PERMANENT_PATH)
        .withMaxDepth(50)
        .withExcludeNodeModules(true)
        .withReverseIndex(false)
        .withIndexingConcurrency(4)
        .withCacheConfig({
          maxCacheSize: 500,
          maxSymbolCacheSize: 200,
          maxSymbolAnalyzerFiles: 100,
        })
        .build();
      await spider.dispose();
    }, BENCH_OPTIONS);

    bench('SpiderBuilder with minimal config', async () => {
      const spider = new SpiderBuilder()
        .withRootDir(BENCH_PERMANENT_PATH)
        .build();
      await spider.dispose();
    }, BENCH_OPTIONS);

    bench('SpiderBuilder with bulk config', async () => {
      const config = {
        rootDir: BENCH_PERMANENT_PATH,
        maxDepth: 50,
        excludeNodeModules: true,
        enableReverseIndex: false,
        indexingConcurrency: 4,
        maxCacheSize: 500,
        maxSymbolCacheSize: 200,
        maxSymbolAnalyzerFiles: 100,
      };
      const spider = new SpiderBuilder()
        .withConfig(config)
        .build();
      await spider.dispose();
    }, BENCH_OPTIONS);
  });

  describe('Configuration Validation', () => {
    bench('Valid configuration', async () => {
      const spider = new SpiderBuilder()
        .withRootDir(BENCH_PERMANENT_PATH)
        .withMaxDepth(50)
        .withIndexingConcurrency(4)
        .build();
      await spider.dispose();
    }, BENCH_OPTIONS);

    bench('Configuration with overrides', async () => {
      const spider = new SpiderBuilder()
        .withRootDir(BENCH_PERMANENT_PATH)
        .withMaxDepth(10)
        .withMaxDepth(20)
        .withMaxDepth(50) // Last value wins
        .build();
      await spider.dispose();
    }, BENCH_OPTIONS);
  });

  describe('Functional Operations', () => {
    bench('Analyze file (legacy construction)', async () => {
      const spider = new Spider({
        rootDir: BENCH_PERMANENT_PATH,
        maxDepth: 50,
      });
      
      const testFile = path.join(BENCH_PERMANENT_PATH, 'src/index.ts');
      await spider.analyze(testFile);
      await spider.dispose();
    }, BENCH_OPTIONS);

    bench('Analyze file (builder construction)', async () => {
      const spider = new SpiderBuilder()
        .withRootDir(BENCH_PERMANENT_PATH)
        .withMaxDepth(50)
        .build();
      
      const testFile = path.join(BENCH_PERMANENT_PATH, 'src/index.ts');
      await spider.analyze(testFile);
      await spider.dispose();
    }, BENCH_OPTIONS);
  });
});
