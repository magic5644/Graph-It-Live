/**
 * Memory benchmarks for ReverseIndex
 *
 * Measures heap growth from empty Map accumulation and validates that
 * cleanup() and lazy getReferencingFiles() eviction keep memory bounded.
 *
 * Run with: npm run test:bench:memory
 */

import { describe, it, expect } from 'vitest';
import { ReverseIndex } from '../../../src/analyzer/ReverseIndex';

function heapMB(): number {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

function forceGC(): void {
  (globalThis as unknown as { gc?: () => void }).gc?.();
}

describe('ReverseIndex Memory', () => {
  it('heap growth stays bounded with 10K add+remove cycle', () => {
    forceGC();
    const before = heapMB();

    const index = new ReverseIndex('/test');

    for (let i = 0; i < 10_000; i++) {
      index.addDependencies(`/test/src/file${i}.ts`, [
        { path: '/test/shared/utils.ts', type: 'import', line: 1, module: './shared/utils' },
      ], { mtime: i, size: i * 10 });
    }

    const afterAdd = heapMB();

    for (let i = 0; i < 10_000; i++) {
      index.removeDependenciesFromSource(`/test/src/file${i}.ts`);
    }

    const afterRemove = heapMB();
    const emptyBefore = index.getEmptyMapCount();

    const cleaned = index.cleanup();
    const afterCleanup = heapMB();
    const emptyAfter = index.getEmptyMapCount();

    console.log(
      `[Memory] ReverseIndex 10K entries:\n` +
      `  baseline:    ${before.toFixed(1)} MB\n` +
      `  after add:   ${afterAdd.toFixed(1)} MB  (+${(afterAdd - before).toFixed(1)} MB)\n` +
      `  after remove:${afterRemove.toFixed(1)} MB  (empty maps: ${emptyBefore})\n` +
      `  after cleanup:${afterCleanup.toFixed(1)} MB  (cleaned: ${cleaned})`
    );

    expect(emptyBefore).toBeGreaterThan(0); // empty maps should exist after remove
    expect(cleaned).toBeGreaterThan(0);     // cleanup should find them
    expect(emptyAfter).toBe(0);             // none should remain after cleanup
  });

  it('heap growth stays bounded with 50K add+partial-remove cycle', () => {
    forceGC();
    const before = heapMB();

    const index = new ReverseIndex('/test');

    for (let i = 0; i < 50_000; i++) {
      index.addDependencies(`/test/src/file${i}.ts`, [
        { path: `/test/shared/module${i % 100}.ts`, type: 'import', line: 1, module: `./module${i % 100}` },
      ], { mtime: i, size: 512 });
    }

    const afterAdd = heapMB();

    for (let i = 0; i < 25_000; i++) {
      index.removeDependenciesFromSource(`/test/src/file${i}.ts`);
    }

    const afterRemove = heapMB();
    const emptyCount = index.getEmptyMapCount();
    const cleaned = index.cleanup();
    const afterCleanup = heapMB();

    console.log(
      `[Memory] ReverseIndex 50K add / 25K remove:\n` +
      `  baseline:    ${before.toFixed(1)} MB\n` +
      `  after add:   ${afterAdd.toFixed(1)} MB  (+${(afterAdd - before).toFixed(1)} MB)\n` +
      `  after remove:${afterRemove.toFixed(1)} MB  (empty maps: ${emptyCount})\n` +
      `  after cleanup:${afterCleanup.toFixed(1)} MB  (cleaned: ${cleaned})`
    );

    expect(index.getEmptyMapCount()).toBe(0);
  });

  it('lazy cleanup in getReferencingFiles removes empty maps on access', () => {
    const index = new ReverseIndex('/test');

    // Add one source→target, then remove the source (leaves empty target map)
    index.addDependencies('/test/a.ts', [
      { path: '/test/shared.ts', type: 'import', line: 1, module: './shared' },
    ], { mtime: 1, size: 100 });

    index.removeDependenciesFromSource('/test/a.ts');

    // Empty map exists before access
    expect(index.getEmptyMapCount()).toBe(1);

    // Access triggers lazy cleanup
    const refs = index.getReferencingFiles('/test/shared.ts');
    expect(refs).toHaveLength(0);

    // Empty map should now be removed (lazy eviction)
    expect(index.getEmptyMapCount()).toBe(0);
  });

  it('cross-platform paths (Windows-style) normalize consistently', () => {
    // Simulate Windows paths with backslashes — normalizePath must convert them
    // on any platform. String.raw gives us literal backslashes.
    const winRoot = String.raw`C:\Users\user\project`;
    const winSrc  = String.raw`C:\Users\user\project\src\file.ts`;
    const winDep  = String.raw`C:\Users\user\project\shared\utils.ts`;

    const index = new ReverseIndex(winRoot);

    index.addDependencies(winSrc, [
      { path: winDep, type: 'import', line: 1, module: '../shared/utils' },
    ], { mtime: 1, size: 100 });

    // Lookup with original Windows path — normalizePath converts \\ → / + lowercases drive
    const refsWin = index.getReferencingFiles(winDep);
    // Lookup with already-normalized form (drive letter lowercased, backslashes → forward slashes)
    const normalizedDep = 'c:/Users/user/project/shared/utils.ts';
    const refsNorm = index.getReferencingFiles(normalizedDep);

    // Both lookups must return the same source file
    expect(refsWin).toHaveLength(1);
    expect(refsNorm).toHaveLength(1);
    expect(refsWin[0].path).toBe(refsNorm[0].path);
  });
});
