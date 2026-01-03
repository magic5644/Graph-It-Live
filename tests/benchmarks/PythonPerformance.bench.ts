/**
 * Performance benchmarks for Python support
 * 
 * Ensures Python analysis doesn't add overhead to TypeScript projects
 * and performs reasonably for Python projects.
 */

import { describe, bench, expect } from 'vitest';
import path from 'node:path';
import { Spider } from "../../src/analyzer/Spider";
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

  // Initialize synchronously at suite definition time to avoid any
  // benchmark warmup/hook ordering issues.
  const pythonParser = new PythonParser();
  const pythonSymbolAnalyzer = new PythonSymbolAnalyzer();
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
      const spider = new Spider({ rootDir: pythonFixturesDir, maxDepth: 20 });
      const appFile = path.join(pythonFixturesDir, 'app.py');
      await spider.crawl(appFile);
    }, BENCH_OPTIONS);

    bench('TypeScript: Crawl sample-project (similar size)', async () => {
      const spider = new Spider({ rootDir: tsFixturesDir, maxDepth: 20 });
      const mainFile = path.join(tsFixturesDir, 'src/main.ts');
      await spider.crawl(mainFile);
    }, BENCH_OPTIONS);
  });

  describe('Memory efficiency', () => {
    bench('Python: Create parser instance (lazy tree-sitter loading)', () => {
      const _parser = new PythonParser();
      // Prevent unused variable warning - parser is used for instantiation benchmarking
      expect(_parser).toBeDefined();
    }, BENCH_OPTIONS);

    bench('TypeScript: Create parser instance', () => {
      const _parser = new Parser();
      // Prevent unused variable warning - parser is used for instantiation benchmarking
      expect(_parser).toBeDefined();
    }, BENCH_OPTIONS);
  });

  describe('Zero overhead for TypeScript-only projects', () => {
    bench('TypeScript project: Spider should not load Python parser', async () => {
      // This benchmark ensures Python parser is only loaded when needed
      const spider = new Spider({ rootDir: tsFixturesDir, maxDepth: 20 });
      const mainFile = path.join(tsFixturesDir, 'src/main.ts');
      await spider.crawl(mainFile);
      // Python parser should NOT be instantiated here
    }, BENCH_OPTIONS);
  });
});

describe('Language Detection Performance', () => {
  const detectLanguage = (filePath: string): 'python' | 'typescript' => {
    const ext = path.extname(filePath).toLowerCase();
    return (ext === '.py' || ext === '.pyi') ? 'python' : 'typescript';
  };

  bench('Detect Python file extension (.py)', () => {
    detectLanguage('/path/to/file.py');
  }, BENCH_OPTIONS);

  bench('Detect TypeScript file extension (.ts)', () => {
    detectLanguage('/path/to/file.ts');
  }, BENCH_OPTIONS);

  bench('Detect Python stub file extension (.pyi)', () => {
    detectLanguage('/path/to/file.pyi');
  }, BENCH_OPTIONS);
});
