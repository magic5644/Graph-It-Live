import { describe, bench } from 'vitest';
import { SymbolAnalyzer } from '../../src/analyzer/SymbolAnalyzer';
import { Spider } from '../../src/analyzer/Spider';
import * as fs from 'node:fs';
import path from 'node:path';

const BENCH_OPTIONS = {
  time: 10,
  warmupTime: 0,
  warmupIterations: 0,
  iterations: 1,
} as const;

/**
 * Benchmark tests for Symbol Analyzer performance
 * 
 * These benchmarks measure:
 * 1. SymbolAnalyzer.analyzeFile performance with various file sizes
 * 2. Symbol extraction from classes with many methods
 * 3. Dependency tracking performance
 * 4. traceFunctionExecution performance
 * 
 * Run with: npm run test:bench
 * 
 * IMPORTANT: Uses permanent fixtures in tests/fixtures/bench-permanent
 * and lazy initialization to avoid Vitest Bench warmup race condition.
 * All file content is loaded synchronously at module init time.
 */

// Path to permanent fixtures (no cleanup, always available)
const BENCH_PERMANENT_PATH = path.resolve(process.cwd(), 'tests/fixtures/bench-permanent');

// File paths
const UTILS_PATH = path.join(BENCH_PERMANENT_PATH, 'src/utils.ts');
const LARGE_CLASS_PATH = path.join(BENCH_PERMANENT_PATH, 'src/largeClass.ts');
const SHARED_PATH = path.join(BENCH_PERMANENT_PATH, 'src/shared.ts');
const LAYER1_PATH = path.join(BENCH_PERMANENT_PATH, 'src/layers/layer1.ts');

// Load file content SYNCHRONOUSLY at module init (before any hooks)
const UTILS_CONTENT = fs.readFileSync(UTILS_PATH, 'utf-8');
const LARGE_CLASS_CONTENT = fs.readFileSync(LARGE_CLASS_PATH, 'utf-8');
const SHARED_CONTENT = fs.readFileSync(SHARED_PATH, 'utf-8');

// Singleton analyzer (stateless, safe to reuse)
const analyzer = new SymbolAnalyzer();

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
 * SymbolAnalyzer in-memory benchmarks - file content loaded at module init
 * These directly test the AST parsing performance
 */
describe('SymbolAnalyzer Benchmarks', () => {
  bench('analyzeFile - utility file with 50 functions', () => {
    analyzer.analyzeFileContent(UTILS_PATH, UTILS_CONTENT);
  }, BENCH_OPTIONS);

  bench('analyzeFile - class with 30+ methods', () => {
    analyzer.analyzeFileContent(LARGE_CLASS_PATH, LARGE_CLASS_CONTENT);
  }, BENCH_OPTIONS);

  bench('analyzeFile - shared module', () => {
    analyzer.analyzeFileContent(SHARED_PATH, SHARED_CONTENT);
  }, BENCH_OPTIONS);

  bench('getExportedSymbols - utility file', () => {
    analyzer.getExportedSymbols(UTILS_PATH, UTILS_CONTENT);
  }, BENCH_OPTIONS);

  bench('filterRuntimeSymbols - large class symbols', () => {
    const { symbols } = analyzer.analyzeFileContent(LARGE_CLASS_PATH, LARGE_CLASS_CONTENT);
    analyzer.filterRuntimeSymbols(symbols);
  }, BENCH_OPTIONS);
});

/**
 * Spider symbol analysis integration benchmarks
 * These test the full stack: file reading + AST parsing + dependency resolution
 */
describe('Spider Symbol Analysis Benchmarks', () => {
  bench('getSymbolGraph - utility file', async () => {
    const spider = await getSpider();
    await spider.getSymbolGraph(UTILS_PATH);
  }, BENCH_OPTIONS);

  bench('getSymbolGraph - class with methods', async () => {
    const spider = await getSpider();
    await spider.getSymbolGraph(LARGE_CLASS_PATH);
  }, BENCH_OPTIONS);

  bench('findUnusedSymbols - utility file', async () => {
    const spider = await getSpider();
    await spider.findUnusedSymbols(UTILS_PATH);
  }, BENCH_OPTIONS);

  bench('traceFunctionExecution - 4 layer deep call', async () => {
    const spider = await getSpider();
    await spider.traceFunctionExecution(LAYER1_PATH, 'layer1Entry', 10);
  }, BENCH_OPTIONS);

  bench('getSymbolDependents - shared export', async () => {
    const spider = await getSpider();
    await spider.getSymbolDependents(SHARED_PATH, 'shared');
  }, BENCH_OPTIONS);
});

/**
 * Symbol cache performance benchmark
 * Tests the cache hit performance vs cold parse
 */
describe('Symbol Cache Performance', () => {
  bench('getSymbolGraph - cache hit', async () => {
    const spider = await getSpider();
    await spider.getSymbolGraph(UTILS_PATH);
  }, BENCH_OPTIONS);
});
