import { describe, bench, beforeAll } from 'vitest';
import { Spider } from '../../src/analyzer/Spider';
import { ReverseIndex } from '../../src/analyzer/ReverseIndex';
import path from 'node:path';

const BENCH_OPTIONS = {
  time: 100,
  warmupTime: 0,
  warmupIterations: 2,
  iterations: 10,
} as const;

/**
 * Benchmark tests for reverse index performance
 *
 * These benchmarks compare:
 * 1. Reverse lookup WITH index (O(1)) vs WITHOUT index (O(n))
 * 2. Full index build time
 * 3. Serialization/deserialization performance
 *
 * Every index is built before measurement: only the named operation is timed.
 *
 * Run with: npm run test:bench
 */

// Path to permanent fixtures (no cleanup, always available)
const BENCH_PERMANENT_PATH = path.resolve(process.cwd(), 'tests/fixtures/bench-permanent');
const SHARED_FILE = path.join(BENCH_PERMANENT_PATH, 'src/shared.ts');
const FILE_COUNT = 1000;
const TARGET_PATH = '/test/shared.ts';

function buildIndex(): ReverseIndex {
  const index = new ReverseIndex('/test');
  for (let i = 0; i < FILE_COUNT; i++) {
    index.addDependencies(`/test/file${i}.ts`, [
      { path: TARGET_PATH, type: 'import', line: 1, module: './shared' },
      { path: `/test/dep${i % 50}.ts`, type: 'import', line: 2, module: `./dep${i % 50}` },
    ], { mtime: i, size: i * 10 });
  }
  return index;
}

/**
 * Unit benchmarks for ReverseIndex - these don't need file system fixtures
 * They use in-memory data structures only
 */
describe('ReverseIndex Unit Benchmarks', () => {
  const index = buildIndex();
  const serialized = index.serialize();
  const deps = Array.from({ length: 10 }, (_, i) => ({
    path: `/test/dep${i}.ts`,
    type: 'import' as const,
    line: i + 1,
    module: `./dep${i}`,
  }));

  bench(`getReferencingFiles O(1) lookup - ${FILE_COUNT} referencing files`, () => {
    index.getReferencingFiles(TARGET_PATH);
  }, BENCH_OPTIONS);

  // Re-adding an existing source replaces its entries: the index size stays constant.
  bench(`addDependencies - re-index 1 file with 10 deps in a ${FILE_COUNT}-file index`, () => {
    index.addDependencies('/test/file0.ts', deps, { mtime: 123, size: 1024 });
  }, BENCH_OPTIONS);

  bench(`serialize - ${FILE_COUNT} files index`, () => {
    index.serialize();
  }, BENCH_OPTIONS);

  bench(`deserialize - ${FILE_COUNT} files index`, () => {
    ReverseIndex.deserialize(serialized, '/test');
  }, BENCH_OPTIONS);

  bench(`isFileStale check - ${FILE_COUNT} files`, () => {
    for (let i = 0; i < FILE_COUNT; i++) {
      index.isFileStale(`/test/file${i}.ts`, { mtime: i, size: i * 10 });
    }
  }, BENCH_OPTIONS);
});

/**
 * Spider integration benchmarks - use permanent fixtures
 * These tests compare indexed vs fallback lookup performance
 */
describe('Spider Integration Benchmarks', () => {
  const spiderWithIndex = new Spider({
    rootDir: BENCH_PERMANENT_PATH,
    enableReverseIndex: true,
    indexingConcurrency: 8,
  });
  const spiderWithoutIndex = new Spider({
    rootDir: BENCH_PERMANENT_PATH,
    enableReverseIndex: false,
  });

  beforeAll(async () => {
    await spiderWithIndex.buildFullIndex();
  });

  bench('findReferencingFiles WITH index (O(1) lookup)', async () => {
    await spiderWithIndex.findReferencingFiles(SHARED_FILE);
  }, BENCH_OPTIONS);

  // findReferencingFiles() would serve the fallback cache after the first call;
  // this variant always runs the project scan.
  bench('findReferencingFilesWithFallback WITHOUT index (O(n) scan)', async () => {
    await spiderWithoutIndex.findReferencingFilesWithFallback(SHARED_FILE);
  }, BENCH_OPTIONS);
});

/**
 * Build performance benchmark - uses permanent fixtures
 */
describe('Index Build Benchmarks', () => {
  bench('buildFullIndex - permanent fixtures project', async () => {
    const spider = new Spider({
      rootDir: BENCH_PERMANENT_PATH,
      enableReverseIndex: true,
      indexingConcurrency: 8,
    });
    await spider.buildFullIndex();
  }, BENCH_OPTIONS);
});
