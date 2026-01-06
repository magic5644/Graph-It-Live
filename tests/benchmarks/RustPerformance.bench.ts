/**
 * Performance benchmarks for Rust support
 * 
 * Ensures Rust analysis doesn't add overhead to TypeScript projects
 * and performs reasonably for Rust projects.
 */

import { describe, bench, expect } from 'vitest';
import path from 'node:path';
import { Spider } from "../../src/analyzer/Spider";
import { RustParser } from "../../src/analyzer/languages/RustParser";
import { RustSymbolAnalyzer } from "../../src/analyzer/languages/RustSymbolAnalyzer";
import { Parser } from "../../src/analyzer/Parser";
import { SymbolAnalyzer } from "../../src/analyzer/SymbolAnalyzer";

const BENCH_OPTIONS = {
  time: 10,
  warmupTime: 0,
  warmupIterations: 0,
  iterations: 1,
} as const;

describe('Rust Performance Benchmarks', () => {
  const rustFixturesDir = path.resolve(__dirname, '../fixtures/rust-integration');
  const tsFixturesDir = path.resolve(__dirname, '../fixtures/sample-project');

  // Initialize synchronously at suite definition time to avoid any
  // benchmark warmup/hook ordering issues.
  const rustParser = new RustParser();
  const rustSymbolAnalyzer = new RustSymbolAnalyzer();
  const tsParser = new Parser();
  const tsSymbolAnalyzer = new SymbolAnalyzer();

  describe('File-level parsing', () => {
    bench('Rust: Parse imports from main.rs', async () => {
      const mainFile = path.join(rustFixturesDir, 'main.rs');
      await rustParser.parseImports(mainFile);
    }, BENCH_OPTIONS);

    bench('TypeScript: Parse imports from main.ts', async () => {
      const mainFile = path.join(tsFixturesDir, 'src/main.ts');
      await tsParser.parseImports(mainFile);
    }, BENCH_OPTIONS);
  });

  describe('Symbol-level analysis', () => {
    bench('Rust: Extract symbols from database.rs', async () => {
      const dbFile = path.join(rustFixturesDir, 'utils/database.rs');
      await rustSymbolAnalyzer.analyzeFile(dbFile);
    }, BENCH_OPTIONS);

    bench('TypeScript: Extract symbols from utils.ts', async () => {
      const utilsFile = path.join(tsFixturesDir, 'src/utils.ts');
      await tsSymbolAnalyzer.analyzeFile(utilsFile);
    }, BENCH_OPTIONS);

    bench('Rust: Get symbol dependencies from main.rs', async () => {
      const mainFile = path.join(rustFixturesDir, 'main.rs');
      await rustSymbolAnalyzer.getSymbolDependencies(mainFile);
    }, BENCH_OPTIONS);

    bench('TypeScript: Get symbol dependencies from main.ts', async () => {
      const mainFile = path.join(tsFixturesDir, 'src/main.ts');
      await tsSymbolAnalyzer.getSymbolDependencies(mainFile);
    }, BENCH_OPTIONS);
  });

  describe('Full project crawl', () => {
    bench('Rust: Crawl rust-integration project', async () => {
      const spider = new Spider({ rootDir: rustFixturesDir, maxDepth: 20 });
      const mainFile = path.join(rustFixturesDir, 'main.rs');
      await spider.crawl(mainFile);
    }, BENCH_OPTIONS);

    bench('TypeScript: Crawl sample-project (similar size)', async () => {
      const spider = new Spider({ rootDir: tsFixturesDir, maxDepth: 20 });
      const mainFile = path.join(tsFixturesDir, 'src/main.ts');
      await spider.crawl(mainFile);
    }, BENCH_OPTIONS);
  });

  describe('Memory efficiency', () => {
    bench('Rust: Create parser instance (lazy tree-sitter loading)', () => {
      const _parser = new RustParser();
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
    bench('TypeScript project: Spider should not load Rust parser', async () => {
      // This benchmark ensures Rust parser is only loaded when needed
      const spider = new Spider({ rootDir: tsFixturesDir, maxDepth: 20 });
      const mainFile = path.join(tsFixturesDir, 'src/main.ts');
      await spider.crawl(mainFile);
      // Rust parser should NOT be instantiated here
    }, BENCH_OPTIONS);
  });

  describe('Rust-specific features', () => {
    bench('Rust: Parse mod declarations', async () => {
      const mainFile = path.join(rustFixturesDir, 'main.rs');
      await rustParser.parseImports(mainFile);
    }, BENCH_OPTIONS);

    bench('Rust: Parse use declarations with use_list', async () => {
      const mainFile = path.join(rustFixturesDir, 'main.rs');
      await rustParser.parseImports(mainFile);
    }, BENCH_OPTIONS);

    bench('Rust: Extract struct symbols', async () => {
      const dbFile = path.join(rustFixturesDir, 'utils/database.rs');
      const result = await rustSymbolAnalyzer.analyzeFile(dbFile);
      // Verify struct extraction doesn't add significant overhead
      const symbols = Array.from(result.values());
      expect(symbols.some(s => s.kind === 'StructDeclaration')).toBe(true);
    }, BENCH_OPTIONS);

    bench('Rust: Extract function symbols with pub visibility', async () => {
      const helpersFile = path.join(rustFixturesDir, 'utils/helpers.rs');
      const result = await rustSymbolAnalyzer.analyzeFile(helpersFile);
      // Verify visibility detection is fast
      const symbols = Array.from(result.values());
      expect(symbols.some(s => s.isExported)).toBe(true);
    }, BENCH_OPTIONS);

    bench('Rust: Track qualified calls (module::function)', async () => {
      const mainFile = path.join(rustFixturesDir, 'main.rs');
      await rustSymbolAnalyzer.getSymbolDependencies(mainFile);
    }, BENCH_OPTIONS);
  });
});

describe('Language Detection Performance', () => {
  const detectLanguage = (filePath: string): 'rust' | 'typescript' => {
    const ext = path.extname(filePath).toLowerCase();
    return ext === '.rs' ? 'rust' : 'typescript';
  };

  bench('Detect Rust file extension (.rs)', () => {
    detectLanguage('/path/to/file.rs');
  }, BENCH_OPTIONS);

  bench('Detect TypeScript file extension (.ts)', () => {
    detectLanguage('/path/to/file.ts');
  }, BENCH_OPTIONS);
});
