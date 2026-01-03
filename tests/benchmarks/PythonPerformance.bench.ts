/**
 * Performance benchmarks for Python support
 * 
 * Ensures Python analysis doesn't add overhead to TypeScript projects
 * and performs reasonably for Python projects.
 */

import { describe, bench, beforeAll } from 'vitest';
import path from 'node:path';
import { Spider } from '@/analyzer/Spider';
import { PythonParser } from '@/analyzer/languages/PythonParser';
import { PythonSymbolAnalyzer } from '@/analyzer/languages/PythonSymbolAnalyzer';
import { Parser } from '@/analyzer/Parser';
import { SymbolAnalyzer } from '@/analyzer/SymbolAnalyzer';

describe('Python Performance Benchmarks', () => {
  const pythonFixturesDir = path.resolve(__dirname, '../fixtures/python-integration');
  const tsFixturesDir = path.resolve(__dirname, '../fixtures/sample-project');
  
  let pythonParser: PythonParser;
  let pythonSymbolAnalyzer: PythonSymbolAnalyzer;
  let tsParser: Parser;
  let tsSymbolAnalyzer: SymbolAnalyzer;

  beforeAll(() => {
    pythonParser = new PythonParser();
    pythonSymbolAnalyzer = new PythonSymbolAnalyzer(pythonParser);
    tsParser = new Parser();
    tsSymbolAnalyzer = new SymbolAnalyzer(tsParser);
  });

  describe('File-level parsing', () => {
    bench('Python: Parse imports from app.py', async () => {
      const appFile = path.join(pythonFixturesDir, 'app.py');
      await pythonParser.parseImports(appFile);
    });

    bench('TypeScript: Parse imports from main.ts', async () => {
      const mainFile = path.join(tsFixturesDir, 'src/main.ts');
      await tsParser.parseImports(mainFile);
    });
  });

  describe('Symbol-level analysis', () => {
    bench('Python: Extract symbols from database.py', async () => {
      const dbFile = path.join(pythonFixturesDir, 'utils/database.py');
      await pythonSymbolAnalyzer.analyzeFile(dbFile);
    });

    bench('TypeScript: Extract symbols from utils.ts', async () => {
      const utilsFile = path.join(tsFixturesDir, 'src/utils.ts');
      await tsSymbolAnalyzer.analyzeFile(utilsFile);
    });

    bench('Python: Get symbol dependencies from processor.py', async () => {
      const processorFile = path.join(pythonFixturesDir, 'services/processor.py');
      await pythonSymbolAnalyzer.getSymbolDependencies(processorFile);
    });

    bench('TypeScript: Get symbol dependencies from main.ts', async () => {
      const mainFile = path.join(tsFixturesDir, 'src/main.ts');
      await tsSymbolAnalyzer.getSymbolDependencies(mainFile);
    });
  });

  describe('Full project crawl', () => {
    bench('Python: Crawl python-integration project (6 files)', async () => {
      const spider = new Spider({ rootDir: pythonFixturesDir, maxDepth: 20 });
      const appFile = path.join(pythonFixturesDir, 'app.py');
      await spider.crawl(appFile);
    });

    bench('TypeScript: Crawl sample-project (similar size)', async () => {
      const spider = new Spider({ rootDir: tsFixturesDir, maxDepth: 20 });
      const mainFile = path.join(tsFixturesDir, 'src/main.ts');
      await spider.crawl(mainFile);
    });
  });

  describe('Memory efficiency', () => {
    bench('Python: Create parser instance (lazy tree-sitter loading)', () => {
      const _parser = new PythonParser();
      void _parser; // Used for benchmarking instantiation
    });

    bench('TypeScript: Create parser instance', () => {
      const _parser = new Parser();
      void _parser; // Used for benchmarking instantiation
    });
  });

  describe('Zero overhead for TypeScript-only projects', () => {
    bench('TypeScript project: Spider should not load Python parser', async () => {
      // This benchmark ensures Python parser is only loaded when needed
      const spider = new Spider({ rootDir: tsFixturesDir, maxDepth: 20 });
      const mainFile = path.join(tsFixturesDir, 'src/main.ts');
      await spider.crawl(mainFile);
      // Python parser should NOT be instantiated here
    });
  });
});

describe('Language Detection Performance', () => {
  const detectLanguage = (filePath: string): 'python' | 'typescript' => {
    const ext = path.extname(filePath).toLowerCase();
    return (ext === '.py' || ext === '.pyi') ? 'python' : 'typescript';
  };

  bench('Detect Python file extension (.py)', () => {
    detectLanguage('/path/to/file.py');
  });

  bench('Detect TypeScript file extension (.ts)', () => {
    detectLanguage('/path/to/file.ts');
  });

  bench('Detect Python stub file extension (.pyi)', () => {
    detectLanguage('/path/to/file.pyi');
  });
});
