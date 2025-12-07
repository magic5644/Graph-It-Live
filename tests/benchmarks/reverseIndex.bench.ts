import { describe, bench } from 'vitest';
import { Spider } from '../../src/analyzer/Spider';
import { ReverseIndex } from '../../src/analyzer/ReverseIndex';
import path from 'node:path';

/**
 * Benchmark tests for reverse index performance
 * 
 * These benchmarks compare:
 * 1. Reverse lookup WITH index (O(1)) vs WITHOUT index (O(n))
 * 2. Full index build time
 * 3. Serialization/deserialization performance
 * 
 * Run with: npm run test:bench
 * 
 * IMPORTANT: Uses permanent fixtures in tests/fixtures/bench-permanent
 * and lazy initialization to avoid Vitest Bench warmup race condition.
 */

// Path to permanent fixtures (no cleanup, always available)
const BENCH_PERMANENT_PATH = path.resolve(process.cwd(), 'tests/fixtures/bench-permanent');
const SHARED_FILE = path.join(BENCH_PERMANENT_PATH, 'src/shared.ts');

// Lazy-initialized singletons (survive warmup phase)
let _spiderWithIndex: Spider | null = null;
let _spiderWithoutIndex: Spider | null = null;
let _indexBuilt = false;

async function getSpiderWithIndex(): Promise<Spider> {
  if (!_spiderWithIndex) {
    _spiderWithIndex = new Spider({
      rootDir: BENCH_PERMANENT_PATH,
      enableReverseIndex: true,
      indexingConcurrency: 8,
    });
  }
  if (!_indexBuilt) {
    await _spiderWithIndex.buildFullIndex();
    _indexBuilt = true;
  }
  return _spiderWithIndex;
}

function getSpiderWithoutIndex(): Spider {
  if (!_spiderWithoutIndex) {
    _spiderWithoutIndex = new Spider({
      rootDir: BENCH_PERMANENT_PATH,
      enableReverseIndex: false,
    });
  }
  return _spiderWithoutIndex;
}

/**
 * Unit benchmarks for ReverseIndex - these don't need file system fixtures
 * They use in-memory data structures only
 */
describe('ReverseIndex Unit Benchmarks', () => {
  bench('getReferencingFiles O(1) lookup - 1000 entries', () => {
    const index = new ReverseIndex('/test');
    const targetPath = '/test/shared.ts';

    // Setup: Add 1000 source files referencing target
    for (let i = 0; i < 1000; i++) {
      index.addDependencies(`/test/file${i}.ts`, [
        { path: targetPath, type: 'import', line: 1, module: './shared' },
      ], { mtime: i, size: i * 10 });
    }

    // Benchmark the lookup
    index.getReferencingFiles(targetPath);
  });

  bench('addDependencies - single file with 10 deps', () => {
    const index = new ReverseIndex('/test');
    const deps = Array.from({ length: 10 }, (_, i) => ({
      path: `/test/dep${i}.ts`,
      type: 'import' as const,
      line: i + 1,
      module: `./dep${i}`,
    }));

    index.addDependencies('/test/source.ts', deps, { mtime: 123, size: 1024 });
  });

  bench('serialize - 500 files index', () => {
    const index = new ReverseIndex('/test');
    
    // Setup
    for (let i = 0; i < 500; i++) {
      index.addDependencies(`/test/file${i}.ts`, [
        { path: '/test/shared.ts', type: 'import', line: 1, module: './shared' },
      ], { mtime: i, size: i * 10 });
    }

    index.serialize();
  });

  bench('deserialize - 500 files index', () => {
    const index = new ReverseIndex('/test');
    
    // Setup
    for (let i = 0; i < 500; i++) {
      index.addDependencies(`/test/file${i}.ts`, [
        { path: '/test/shared.ts', type: 'import', line: 1, module: './shared' },
      ], { mtime: i, size: i * 10 });
    }

    const serialized = index.serialize();
    ReverseIndex.deserialize(serialized, '/test');
  });

  bench('isFileStale check - 1000 files', () => {
    const index = new ReverseIndex('/test');
    
    // Setup
    for (let i = 0; i < 1000; i++) {
      index.addDependencies(`/test/file${i}.ts`, [], { mtime: i, size: i * 10 });
    }

    // Check staleness for all files
    for (let i = 0; i < 1000; i++) {
      index.isFileStale(`/test/file${i}.ts`, { mtime: i, size: i * 10 });
    }
  });
});

/**
 * Spider integration benchmarks - use permanent fixtures with lazy init
 * These tests compare indexed vs fallback lookup performance
 */
describe('Spider Integration Benchmarks', () => {
  bench('findReferencingFiles WITH index (O(1) lookup)', async () => {
    const spider = await getSpiderWithIndex();
    await spider.findReferencingFiles(SHARED_FILE);
  });

  bench('findReferencingFiles WITHOUT index (O(n) scan)', async () => {
    const spider = getSpiderWithoutIndex();
    await spider.findReferencingFiles(SHARED_FILE);
  });
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
  });
});
