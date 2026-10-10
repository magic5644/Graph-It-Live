import { describe, bench } from 'vitest';
import { SymbolReverseIndex } from '../../src/analyzer/SymbolReverseIndex';
import type { SymbolDependency } from '../../src/analyzer/types';

const BENCH_OPTIONS = {
  time: 100,
  warmupTime: 0,
  warmupIterations: 2,
  iterations: 10,
} as const;

/**
 * Benchmark tests for SymbolReverseIndex performance
 *
 * These benchmarks measure, on an index built before measurement:
 * 1. Caller lookups (all, runtime-only, type-only)
 * 2. Re-indexing one file (addDependencies replaces the file's entries)
 * 3. Serialization/deserialization performance
 *
 * Run with: npm run test:bench
 */

const FILE_COUNT = 1000;
const DEPS_PER_FILE = 10;
const TARGET_COUNT = 200;
const HOT_SYMBOL_ID = '/test/shared.ts:helper';

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

/** Every file calls the hot symbol (half of them type-only) plus spread targets. */
function fileDependencies(fileIndex: number): SymbolDependency[] {
  const sourceFile = `/test/file${fileIndex}.ts`;
  const deps = [createDependency(sourceFile, 'main', '/test/shared.ts', 'helper', fileIndex % 2 === 0)];
  for (let j = 1; j < DEPS_PER_FILE; j++) {
    const target = (fileIndex * DEPS_PER_FILE + j) % TARGET_COUNT;
    deps.push(createDependency(sourceFile, `func${j}`, `/test/target${target}.ts`, `export${target}`, j % 3 === 0));
  }
  return deps;
}

function buildIndex(): SymbolReverseIndex {
  const index = new SymbolReverseIndex('/test');
  for (let i = 0; i < FILE_COUNT; i++) {
    index.addDependencies(`/test/file${i}.ts`, fileDependencies(i), { mtime: i, size: i * 10 });
  }
  return index;
}

describe(`SymbolReverseIndex Benchmarks (${FILE_COUNT} files x ${DEPS_PER_FILE} deps)`, () => {
  const index = buildIndex();
  const serialized = index.serialize();
  const reindexedDeps = fileDependencies(0);

  bench(`getCallers - ${FILE_COUNT} callers`, () => {
    index.getCallers(HOT_SYMBOL_ID);
  }, BENCH_OPTIONS);

  bench('getRuntimeCallers - half runtime, half type-only', () => {
    index.getRuntimeCallers(HOT_SYMBOL_ID);
  }, BENCH_OPTIONS);

  bench('getTypeOnlyCallers - half runtime, half type-only', () => {
    index.getTypeOnlyCallers(HOT_SYMBOL_ID);
  }, BENCH_OPTIONS);

  bench('addDependencies - re-index 1 file (remove + add)', () => {
    index.addDependencies('/test/file0.ts', reindexedDeps, { mtime: 0, size: 0 });
  }, BENCH_OPTIONS);

  bench(`isFileStale - ${FILE_COUNT} files`, () => {
    for (let i = 0; i < FILE_COUNT; i++) {
      index.isFileStale(`/test/file${i}.ts`, { mtime: i, size: i * 10 });
    }
  }, BENCH_OPTIONS);

  bench('getStats', () => {
    index.getStats();
  }, BENCH_OPTIONS);

  bench('serialize', () => {
    index.serialize();
  }, BENCH_OPTIONS);

  bench('deserialize', () => {
    new SymbolReverseIndex('/test').deserialize(serialized);
  }, BENCH_OPTIONS);
});
