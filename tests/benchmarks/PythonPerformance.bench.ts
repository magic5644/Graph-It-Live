/**
 * Performance benchmarks for Python support
 * 
 * Measures Python parsing and crawl cost next to the TypeScript equivalent.
 * Lazy parser loading for TypeScript-only projects is asserted in
 * tests/analyzer/LanguageService.lazyLoading.test.ts.
 */

import path from 'node:path';
import { bench, describe } from 'vitest';
import { PythonParser } from "../../src/analyzer/languages/PythonParser";
import { PythonSymbolAnalyzer } from "../../src/analyzer/languages/PythonSymbolAnalyzer";
import { Parser } from "../../src/analyzer/Parser";
import { SymbolAnalyzer } from "../../src/analyzer/SymbolAnalyzer";

const BENCH_OPTIONS = {
  time: 10,
  warmupTime: 0,
  warmupIterations: 0,
  iterations: 1,
} as const;

describe('Python Performance Benchmarks', () => {
  const pythonFixturesDir = path.resolve(__dirname, '../fixtures/python-integration');
  const tsFixturesDir = path.resolve(__dirname, '../fixtures/sample-project');
  
  // Extension path for WASM parser initialization
  // Points to project root where dist/wasm directory is located
  const extensionPath = path.resolve(__dirname, '../..');

  // Initialize synchronously at suite definition time to avoid any
  // benchmark warmup/hook ordering issues.
  const pythonParser = new PythonParser(undefined, extensionPath);
  const pythonSymbolAnalyzer = new PythonSymbolAnalyzer(extensionPath);
  const tsParser = new Parser();
  const tsSymbolAnalyzer = new SymbolAnalyzer();

  describe('File-level parsing', () => {
    bench('Python: Parse imports from app.py', async () => {
      const appFile = path.join(pythonFixturesDir, 'app.py');
      await pythonParser.parseImports(appFile);
    }, BENCH_OPTIONS);

    bench('TypeScript: Parse imports from main.ts', async () => {
      const mainFile = path.join(tsFixturesDir, 'src/main.ts');
      await tsParser.parseImports(mainFile);
    }, BENCH_OPTIONS);
  });

  describe('Symbol-level analysis', () => {
    bench('Python: Extract symbols from database.py', async () => {
      const dbFile = path.join(pythonFixturesDir, 'utils/database.py');
      await pythonSymbolAnalyzer.analyzeFile(dbFile);
    }, BENCH_OPTIONS);

    bench('TypeScript: Extract symbols from utils.ts', async () => {
      const utilsFile = path.join(tsFixturesDir, 'src/utils.ts');
      await tsSymbolAnalyzer.analyzeFile(utilsFile);
    }, BENCH_OPTIONS);

    bench('Python: Get symbol dependencies from processor.py', async () => {
      const processorFile = path.join(pythonFixturesDir, 'services/processor.py');
      await pythonSymbolAnalyzer.getSymbolDependencies(processorFile);
    }, BENCH_OPTIONS);

    bench('TypeScript: Get symbol dependencies from main.ts', async () => {
      const mainFile = path.join(tsFixturesDir, 'src/main.ts');
      await tsSymbolAnalyzer.getSymbolDependencies(mainFile);
    }, BENCH_OPTIONS);
  });

  describe('Full project crawl', () => {
    bench('Python: Crawl python-integration project (6 files)', async () => {
      const { SpiderBuilder } = await import('../../src/analyzer/SpiderBuilder');
      const spider = new SpiderBuilder()
        .withRootDir(pythonFixturesDir)
        .withMaxDepth(20)
        .withExtensionPath(extensionPath)
        .build();
      const appFile = path.join(pythonFixturesDir, 'app.py');
      await spider.crawl(appFile);
    }, BENCH_OPTIONS);

    bench('TypeScript: Crawl sample-project (similar size)', async () => {
      const { SpiderBuilder } = await import('../../src/analyzer/SpiderBuilder');
      const spider = new SpiderBuilder()
        .withRootDir(tsFixturesDir)
        .withMaxDepth(20)
        .withExtensionPath(extensionPath)
        .build();
      const mainFile = path.join(tsFixturesDir, 'src/main.ts');
      await spider.crawl(mainFile);
    }, BENCH_OPTIONS);
  });
});
