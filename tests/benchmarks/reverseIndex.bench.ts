import { describe, bench, beforeAll, afterAll } from 'vitest';
import { Spider } from '../../src/analyzer/Spider';
import { ReverseIndex } from '../../src/analyzer/ReverseIndex';
import * as fs from 'node:fs/promises';
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
 */

const BENCH_FIXTURES_PATH = path.resolve(process.cwd(), 'tests/fixtures/bench-project');

async function createBenchmarkFixtures(numFiles: number): Promise<void> {
  // Clean up first
  try {
    await fs.rm(BENCH_FIXTURES_PATH, { recursive: true, force: true });
  } catch {
    // Ignore if doesn't exist
  }

  await fs.mkdir(path.join(BENCH_FIXTURES_PATH, 'src'), { recursive: true });

  // Create shared files that will be imported
  await fs.writeFile(
    path.join(BENCH_FIXTURES_PATH, 'src/shared.ts'),
    'export const shared = "shared";\nexport function helper() { return "help"; }\n'
  );

  await fs.writeFile(
    path.join(BENCH_FIXTURES_PATH, 'src/utils.ts'),
    'export const utils = "utils";\nexport function format() { return "formatted"; }\n'
  );

  // Create many files that import shared modules
  for (let i = 0; i < numFiles; i++) {
    const imports = i % 2 === 0 
      ? "import { shared } from './shared';\nimport { utils } from './utils';"
      : "import { shared, helper } from './shared';";
    
    await fs.writeFile(
      path.join(BENCH_FIXTURES_PATH, 'src', `component${i}.ts`),
      `${imports}\nexport const component${i} = { shared, id: ${i} };\n`
    );
  }
}

async function cleanupBenchmarkFixtures(): Promise<void> {
  try {
    await fs.rm(BENCH_FIXTURES_PATH, { recursive: true, force: true });
  } catch {
    // Ignore errors during cleanup
  }
}

// Test configurations
const FILE_COUNTS = {
  small: 50,
  medium: 200,
  large: 500,
};

describe('ReverseIndex Benchmarks', () => {
  describe('Small project (50 files)', () => {
    beforeAll(async () => {
      await createBenchmarkFixtures(FILE_COUNTS.small);
    });

    afterAll(async () => {
      await cleanupBenchmarkFixtures();
    });

    bench('buildFullIndex', async () => {
      const spider = new Spider({
        rootDir: BENCH_FIXTURES_PATH,
        enableReverseIndex: true,
        indexingConcurrency: 8,
      });
      await spider.buildFullIndex();
    });

    bench('findReferencingFiles WITH index', async () => {
      const spider = new Spider({
        rootDir: BENCH_FIXTURES_PATH,
        enableReverseIndex: true,
        indexingConcurrency: 8,
      });
      await spider.buildFullIndex();

      const sharedFile = path.join(BENCH_FIXTURES_PATH, 'src/shared.ts');
      await spider.findReferencingFiles(sharedFile);
    });

    bench('findReferencingFiles WITHOUT index (fallback)', async () => {
      const spider = new Spider({
        rootDir: BENCH_FIXTURES_PATH,
        enableReverseIndex: false,
      });

      const sharedFile = path.join(BENCH_FIXTURES_PATH, 'src/shared.ts');
      await spider.findReferencingFiles(sharedFile);
    });
  });
});

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

describe('Performance Comparison Summary', () => {
  const results: { test: string; indexed: number; fallback: number; speedup: string }[] = [];

  afterAll(() => {
    console.log('\n=== Performance Comparison Summary ===');
    console.table(results);
  });

  bench('Compare: 100 files - findReferencingFiles', async () => {
    // Create fixtures
    await createBenchmarkFixtures(100);

    try {
      // With index
      const spiderIndexed = new Spider({
        rootDir: BENCH_FIXTURES_PATH,
        enableReverseIndex: true,
        indexingConcurrency: 8,
      });
      await spiderIndexed.buildFullIndex();

      const sharedFile = path.join(BENCH_FIXTURES_PATH, 'src/shared.ts');

      const startIndexed = performance.now();
      await spiderIndexed.findReferencingFiles(sharedFile);
      const durationIndexed = performance.now() - startIndexed;

      // Without index
      const spiderFallback = new Spider({
        rootDir: BENCH_FIXTURES_PATH,
        enableReverseIndex: false,
      });

      const startFallback = performance.now();
      await spiderFallback.findReferencingFiles(sharedFile);
      const durationFallback = performance.now() - startFallback;

      results.push({
        test: '100 files',
        indexed: Math.round(durationIndexed * 100) / 100,
        fallback: Math.round(durationFallback * 100) / 100,
        speedup: `${(durationFallback / durationIndexed).toFixed(1)}x`,
      });
    } finally {
      await cleanupBenchmarkFixtures();
    }
  });
});
