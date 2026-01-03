import { describe, bench } from 'vitest';
import { SymbolReverseIndex } from '../../src/analyzer/SymbolReverseIndex';
import type { SymbolDependency } from '../../src/analyzer/types';

const BENCH_OPTIONS = {
  time: 10,
  warmupTime: 0,
  warmupIterations: 0,
  iterations: 1,
} as const;

/**
 * Benchmark tests for SymbolReverseIndex performance
 * 
 * These benchmarks measure:
 * 1. O(1) symbol lookup performance vs linear scan baseline
 * 2. addDependencies ingestion throughput
 * 3. Serialization/deserialization performance
 * 4. Runtime vs type-only filtering performance
 * 
 * Run with: npm run test:bench
 */

/**
 * Helper to create mock symbol dependencies
 */
function createDependency(
  sourceFile: string,
  sourceSymbol: string,
  targetFile: string,
  targetSymbol: string,
  isTypeOnly = false
): SymbolDependency {
  return {
    sourceSymbolId: `${sourceFile}:${sourceSymbol}`,
    targetSymbolId: `${targetFile}:${targetSymbol}`,
    targetFilePath: targetFile,
    isTypeOnly,
  };
}

/**
 * Unit benchmarks for SymbolReverseIndex - in-memory only
 */
describe('SymbolReverseIndex Unit Benchmarks', () => {
  bench('getCallers O(1) lookup - 1000 callers', () => {
    const index = new SymbolReverseIndex('/test');
    const targetFile = '/test/shared.ts';
    const targetSymbol = 'helperFunction';
    const targetSymbolId = `${targetFile}:${targetSymbol}`;

    // Setup: Add 1000 files calling the target symbol
    for (let i = 0; i < 1000; i++) {
      const sourceFile = `/test/file${i}.ts`;
      index.addDependencies(sourceFile, [
        createDependency(sourceFile, `caller${i}`, targetFile, targetSymbol),
      ], { mtime: i, size: i * 10 });
    }

    // Benchmark the O(1) lookup
    index.getCallers(targetSymbolId);
  }, BENCH_OPTIONS);

  bench('getRuntimeCallers - 500 runtime + 500 type-only', () => {
    const index = new SymbolReverseIndex('/test');
    const targetFile = '/test/shared.ts';
    const targetSymbol = 'MyType';
    const targetSymbolId = `${targetFile}:${targetSymbol}`;

    // Setup: Add 500 runtime and 500 type-only callers
    for (let i = 0; i < 500; i++) {
      const sourceFile = `/test/file${i}.ts`;
      index.addDependencies(sourceFile, [
        createDependency(sourceFile, `runtimeCaller${i}`, targetFile, targetSymbol, false),
      ], { mtime: i, size: i * 10 });
    }
    for (let i = 500; i < 1000; i++) {
      const sourceFile = `/test/file${i}.ts`;
      index.addDependencies(sourceFile, [
        createDependency(sourceFile, `typeCaller${i}`, targetFile, targetSymbol, true),
      ], { mtime: i, size: i * 10 });
    }

    // Benchmark runtime-only filtering
    index.getRuntimeCallers(targetSymbolId);
  }, BENCH_OPTIONS);

  bench('getTypeOnlyCallers - 500 runtime + 500 type-only', () => {
    const index = new SymbolReverseIndex('/test');
    const targetFile = '/test/shared.ts';
    const targetSymbol = 'MyInterface';
    const targetSymbolId = `${targetFile}:${targetSymbol}`;

    // Setup: Add 500 runtime and 500 type-only callers
    for (let i = 0; i < 500; i++) {
      const sourceFile = `/test/file${i}.ts`;
      index.addDependencies(sourceFile, [
        createDependency(sourceFile, `runtimeCaller${i}`, targetFile, targetSymbol, false),
      ], { mtime: i, size: i * 10 });
    }
    for (let i = 500; i < 1000; i++) {
      const sourceFile = `/test/file${i}.ts`;
      index.addDependencies(sourceFile, [
        createDependency(sourceFile, `typeCaller${i}`, targetFile, targetSymbol, true),
      ], { mtime: i, size: i * 10 });
    }

    // Benchmark type-only filtering
    index.getTypeOnlyCallers(targetSymbolId);
  }, BENCH_OPTIONS);

  bench('addDependencies - single file with 20 symbol deps', () => {
    const index = new SymbolReverseIndex('/test');
    const sourceFile = '/test/consumer.ts';
    
    const deps: SymbolDependency[] = Array.from({ length: 20 }, (_, i) => 
      createDependency(
        sourceFile,
        `localFunc${i}`,
        `/test/dep${i % 5}.ts`,
        `exportedFunc${i}`,
        i % 3 === 0 // Every 3rd is type-only
      )
    );

    index.addDependencies(sourceFile, deps, { mtime: 123, size: 1024 });
  }, BENCH_OPTIONS);

  bench('addDependencies - batch 100 files', () => {
    const index = new SymbolReverseIndex('/test');

    for (let i = 0; i < 100; i++) {
      const sourceFile = `/test/file${i}.ts`;
      const deps: SymbolDependency[] = [
        createDependency(sourceFile, `func${i}`, '/test/shared.ts', 'helper'),
        createDependency(sourceFile, `func${i}`, '/test/utils.ts', 'format', true),
      ];
      index.addDependencies(sourceFile, deps, { mtime: i, size: i * 10 });
    }
  }, BENCH_OPTIONS);

  bench('isFileStale - check staleness', () => {
    const index = new SymbolReverseIndex('/test');
    
    // Setup
    for (let i = 0; i < 100; i++) {
      index.addDependencies(`/test/file${i}.ts`, [], { mtime: 1000, size: 100 });
    }

    // Benchmark staleness check
    for (let i = 0; i < 100; i++) {
      index.isFileStale(`/test/file${i}.ts`, { mtime: 1000, size: 100 });
    }
  }, BENCH_OPTIONS);

  bench('serialize - 500 files with 2 deps each', () => {
    const index = new SymbolReverseIndex('/test');
    
    // Setup
    for (let i = 0; i < 500; i++) {
      const sourceFile = `/test/file${i}.ts`;
      index.addDependencies(sourceFile, [
        createDependency(sourceFile, `func${i}`, '/test/shared.ts', 'helper'),
        createDependency(sourceFile, `type${i}`, '/test/types.ts', 'MyType', true),
      ], { mtime: i, size: i * 10 });
    }

    index.serialize();
  }, BENCH_OPTIONS);

  bench('deserialize - 500 files index', () => {
    const index = new SymbolReverseIndex('/test');
    
    // Setup: Create and serialize
    for (let i = 0; i < 500; i++) {
      const sourceFile = `/test/file${i}.ts`;
      index.addDependencies(sourceFile, [
        createDependency(sourceFile, `func${i}`, '/test/shared.ts', 'helper'),
      ], { mtime: i, size: i * 10 });
    }
    const serialized = index.serialize();

    // Benchmark deserialization
    const newIndex = new SymbolReverseIndex('/test');
    newIndex.deserialize(serialized);
  }, BENCH_OPTIONS);

  bench('removeDependenciesFromSource - remove file from index', () => {
    const index = new SymbolReverseIndex('/test');
    
    // Setup: 100 files each with 5 deps
    for (let i = 0; i < 100; i++) {
      const sourceFile = `/test/file${i}.ts`;
      const deps: SymbolDependency[] = Array.from({ length: 5 }, (_, j) =>
        createDependency(sourceFile, `func${j}`, `/test/target${j}.ts`, `export${j}`)
      );
      index.addDependencies(sourceFile, deps, { mtime: i, size: i * 10 });
    }

    // Benchmark invalidation
    for (let i = 0; i < 100; i++) {
      index.removeDependenciesFromSource(`/test/file${i}.ts`);
    }
  }, BENCH_OPTIONS);

  bench('getStats - 1000 unique symbols', () => {
    const index = new SymbolReverseIndex('/test');
    
    // Setup: Create diverse symbol graph
    for (let i = 0; i < 200; i++) {
      const sourceFile = `/test/file${i}.ts`;
      const deps: SymbolDependency[] = Array.from({ length: 5 }, (_, j) =>
        createDependency(
          sourceFile, 
          `caller${i}_${j}`, 
          `/test/target${j * 10 + (i % 10)}.ts`, 
          `symbol${j * 10 + (i % 10)}`
        )
      );
      index.addDependencies(sourceFile, deps, { mtime: i, size: i * 10 });
    }

    index.getStats();
  }, BENCH_OPTIONS);
});

/**
 * Comparison benchmarks: O(1) lookup vs simulated O(n) scan
 */
describe('SymbolReverseIndex vs Linear Scan', () => {
  // Pre-built index for comparison
  const prebuiltIndex = new SymbolReverseIndex('/test');
  const linearData: Map<string, SymbolDependency[]> = new Map();
  const targetSymbolId = '/test/shared.ts:targetFunc';
  
  // Initialize both with same data
  for (let i = 0; i < 1000; i++) {
    const sourceFile = `/test/file${i}.ts`;
    const dep = createDependency(sourceFile, `caller${i}`, '/test/shared.ts', 'targetFunc');
    
    prebuiltIndex.addDependencies(sourceFile, [dep], { mtime: i, size: 100 });
    
    const existing = linearData.get(sourceFile) || [];
    existing.push(dep);
    linearData.set(sourceFile, existing);
  }

  bench('O(1) SymbolReverseIndex.getCallers', () => {
    prebuiltIndex.getCallers(targetSymbolId);
  }, BENCH_OPTIONS);

  bench('O(n) linear scan equivalent', () => {
    // Simulate what a linear scan would do
    let count = 0;
    for (const deps of linearData.values()) {
      for (const dep of deps) {
        if (dep.targetSymbolId === targetSymbolId) {
          count++;
        }
      }
    }
    // Use count to prevent dead code elimination
    if (count < 0) throw new Error('impossible');
  }, BENCH_OPTIONS);
});
