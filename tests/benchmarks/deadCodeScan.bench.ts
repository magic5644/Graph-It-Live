import * as path from 'node:path';
import { beforeAll, bench, describe } from 'vitest';
import { Spider } from '../../src/analyzer/Spider';

const BENCH_OPTIONS = {
  time: 10,
  warmupTime: 0,
  warmupIterations: 0,
  iterations: 1,
} as const;

/**
 * Benchmark tests for workspace-wide dead code scan performance
 *
 * These benchmarks measure:
 * 1. Full workspace scan (bench-permanent, ~20 TS files, reverse index pre-built)
 * 2. Scoped scan (single src/ directory)
 * 3. Scan with maxFiles cap (maxFiles = 5)
 *
 * Run with: npm run test:bench
 *
 * IMPORTANT: Uses permanent fixtures in tests/fixtures/bench-permanent
 */

const BENCH_PERMANENT_PATH = path.resolve(process.cwd(), 'tests/fixtures/bench-permanent');
const SRC_PATH = path.join(BENCH_PERMANENT_PATH, 'src');

let _spider: Spider | null = null;

async function getSpider(): Promise<Spider> {
  if (!_spider) {
    _spider = new Spider({
      rootDir: BENCH_PERMANENT_PATH,
      enableReverseIndex: true,
      indexingConcurrency: 4,
    });
    await _spider.buildFullIndex();
  }
  return _spider;
}

describe('Dead Code Scan Benchmarks', () => {
  beforeAll(async () => {
    // Pre-warm: build the full reverse index once before any benchmark runs
    await getSpider();
  });

  bench('scanDeadCode – full workspace (~20 files)', async () => {
    const spider = await getSpider();
    await spider.scanDeadCode(BENCH_PERMANENT_PATH);
  }, BENCH_OPTIONS);

  bench('scanDeadCode – scoped to src/ directory', async () => {
    const spider = await getSpider();
    await spider.scanDeadCode(SRC_PATH);
  }, BENCH_OPTIONS);

  bench('scanDeadCode – maxFiles cap = 5', async () => {
    const spider = await getSpider();
    await spider.scanDeadCode(BENCH_PERMANENT_PATH, { maxFiles: 5 });
  }, BENCH_OPTIONS);
});
