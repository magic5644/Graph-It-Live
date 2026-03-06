import * as path from 'node:path';
import { bench, describe } from 'vitest';
import { LspCallHierarchyAnalyzer } from '../../src/analyzer/LspCallHierarchyAnalyzer';
import { Spider } from '../../src/analyzer/Spider';
import { convertSpiderToLspFormat } from '../../src/mcp/shared/helpers';

const BENCH_OPTIONS = {
  time: 10,
  warmupTime: 0,
  warmupIterations: 0,
  iterations: 1,
} as const;

/**
 * Benchmark tests for Codemap generation performance
 *
 * Measures the latency of orchestrating multiple Spider + LSP calls
 * that the generate_codemap MCP tool performs per file.
 *
 * Run with: npm run test:bench
 */

const BENCH_PERMANENT_PATH = path.resolve(process.cwd(), 'tests/fixtures/bench-permanent');
const UTILS_PATH = path.join(BENCH_PERMANENT_PATH, 'src/utils.ts');
const LARGE_CLASS_PATH = path.join(BENCH_PERMANENT_PATH, 'src/largeClass.ts');
const SHARED_PATH = path.join(BENCH_PERMANENT_PATH, 'src/shared.ts');

// Lazy-initialized spider singleton
let _spider: Spider | null = null;
let _spiderReady = false;

async function getSpider(): Promise<Spider> {
  if (!_spider) {
    _spider = new Spider({
      rootDir: BENCH_PERMANENT_PATH,
      enableReverseIndex: true,
    });
  }
  if (!_spiderReady) {
    await _spider.buildFullIndex();
    _spiderReady = true;
  }
  return _spider;
}

/**
 * Full codemap orchestration benchmarks
 * These simulate the generate_codemap tool flow: getSymbolGraph + analyze + findReferencingFiles
 */
describe('Codemap Generation Benchmarks', () => {
  bench('full codemap - utility file (50 exports)', async () => {
    const spider = await getSpider();
    await spider.getSymbolGraph(UTILS_PATH);
    await spider.analyze(UTILS_PATH);
    await spider.findReferencingFiles(UTILS_PATH);
  }, BENCH_OPTIONS);

  bench('full codemap - large class file', async () => {
    const spider = await getSpider();
    await spider.getSymbolGraph(LARGE_CLASS_PATH);
    await spider.analyze(LARGE_CLASS_PATH);
    await spider.findReferencingFiles(LARGE_CLASS_PATH);
  }, BENCH_OPTIONS);

  bench('full codemap - shared module', async () => {
    const spider = await getSpider();
    await spider.getSymbolGraph(SHARED_PATH);
    await spider.analyze(SHARED_PATH);
    await spider.findReferencingFiles(SHARED_PATH);
  }, BENCH_OPTIONS);
});

/**
 * Intra-file call hierarchy benchmarks (LspCallHierarchyAnalyzer via convertSpiderToLspFormat)
 */
describe('Codemap Call Flow Benchmarks', () => {
  const lspAnalyzer = new LspCallHierarchyAnalyzer();

  bench('buildIntraFileGraph - utility file with 50 functions', async () => {
    const spider = await getSpider();
    const symbolGraph = await spider.getSymbolGraph(UTILS_PATH);
    const lspData = convertSpiderToLspFormat(symbolGraph, UTILS_PATH);
    lspAnalyzer.buildIntraFileGraph(UTILS_PATH, lspData);
  }, BENCH_OPTIONS);

  bench('buildIntraFileGraph - large class', async () => {
    const spider = await getSpider();
    const symbolGraph = await spider.getSymbolGraph(LARGE_CLASS_PATH);
    const lspData = convertSpiderToLspFormat(symbolGraph, LARGE_CLASS_PATH);
    lspAnalyzer.buildIntraFileGraph(LARGE_CLASS_PATH, lspData);
  }, BENCH_OPTIONS);
});
