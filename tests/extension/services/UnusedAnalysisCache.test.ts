import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { UnusedAnalysisCache } from '../../../src/extension/services/UnusedAnalysisCache';

// Mock vscode module
vi.mock('vscode', () => ({
  default: {},
}));

// Mock extension logger
vi.mock('../../../src/extension/extensionLogger', () => ({
  getExtensionLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('UnusedAnalysisCache - LRU Eviction', () => {
  let tempDir: string;
  let mockContext: vscode.ExtensionContext;
  let testFiles: string[];

  beforeEach(async () => {
    // Create temp directory for cache
    tempDir = path.join(os.tmpdir(), `cache-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    // Create test files
    testFiles = [];
    for (let i = 0; i < 5; i++) {
      const filePath = path.join(tempDir, `test${i}.ts`);
      await fs.writeFile(filePath, `// test file ${i}`);
      testFiles.push(filePath);
    }

    // Mock ExtensionContext
    mockContext = {
      globalStorageUri: {
        fsPath: tempDir,
      },
    } as unknown as vscode.ExtensionContext;
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should evict least recently used entries when limit is exceeded', async () => {
    const cache = new UnusedAnalysisCache(mockContext, true, 10); // Min is 10

    // Ensure we have 11 test files
    while (testFiles.length < 11) {
      const idx = testFiles.length;
      const filePath = path.join(tempDir, `file${idx}.ts`);
      await fs.writeFile(filePath, `// file ${idx}`);
      testFiles.push(filePath);
    }

    // Add 10 entries to fill the cache
    for (let i = 0; i < 10; i++) {
      const results = new Map([[testFiles[i], true]]);
      await cache.set(testFiles[i], results);
    }

    let stats = cache.getStats();
    expect(stats.entries).toBe(10);
    expect(stats.maxEntries).toBe(10);

    // Access entry 0 to make it more recently used
    await cache.get(testFiles[0], [testFiles[0]]);

    // Add 11th entry - should evict entry 1 (oldest access)
    const results11 = new Map([[testFiles[10], true]]);
    await cache.set(testFiles[10], results11);

    stats = cache.getStats();
    expect(stats.entries).toBe(10); // Still 10 entries
    expect(stats.evictions).toBe(1); // One eviction occurred

    // Entry 0 should still exist (was accessed recently)
    const hit0 = await cache.get(testFiles[0], [testFiles[0]]);
    expect(hit0).not.toBeNull();

    // Entry 1 should be evicted
    const miss1 = await cache.get(testFiles[1], [testFiles[1]]);
    expect(miss1).toBeNull();

    await cache.flush();
  });

  it('should track hit rate correctly', async () => {
    const cache = new UnusedAnalysisCache(mockContext, true, 10);

    // Add 4 entries
    for (let i = 0; i < 4; i++) {
      const results = new Map([[testFiles[i], true]]);
      await cache.set(testFiles[i], results);
    }

    // 3 hits (all cached files)
    await cache.get(testFiles[0], [testFiles[0]]);
    await cache.get(testFiles[1], [testFiles[1]]);
    await cache.get(testFiles[2], [testFiles[2]]);

    // Note: querying a non-existent file doesn't count as miss
    // Only failures after finding cache entry count

    const stats = cache.getStats();
    // 3 hits, 0 misses = 100% hit rate
    expect(stats.hitRate).toBe(1.0);

    await cache.flush();
  });

  it('should respect minimum cache size of 10 entries', async () => {
    const cache = new UnusedAnalysisCache(mockContext, true, 5); // Request 5, but min is 10

    const stats = cache.getStats();
    expect(stats.maxEntries).toBe(10); // Enforced minimum

    await cache.flush();
  });

  it('should not create cache when disabled', async () => {
    const cache = new UnusedAnalysisCache(mockContext, false, 100);

    const results = new Map([[testFiles[0], true]]);
    await cache.set(testFiles[0], results);

    const stats = cache.getStats();
    expect(stats.entries).toBe(0); // Nothing cached

    await cache.flush();
  });

  it('should invalidate entries with changed mtime', async () => {
    const cache = new UnusedAnalysisCache(mockContext, true, 10);

    // Add entry
    const results = new Map([[testFiles[0], true]]);
    await cache.set(testFiles[0], results);

    // Verify it's cached
    let hit = await cache.get(testFiles[0], [testFiles[0]]);
    expect(hit).not.toBeNull();

    // Modify file (change mtime)
    await new Promise(resolve => setTimeout(resolve, 10)); // Ensure time passes
    await fs.writeFile(testFiles[0], '// modified');

    // Should be cache miss now
    hit = await cache.get(testFiles[0], [testFiles[0]]);
    expect(hit).toBeNull();

    await cache.flush();
  });

  it('should persist and reload cache with LRU data', async () => {
    const cache1 = new UnusedAnalysisCache(mockContext, true, 10);

    // Add entries
    for (let i = 0; i < 3; i++) {
      const results = new Map([[testFiles[i], true]]);
      await cache1.set(testFiles[i], results);
    }

    // Flush to disk
    await cache1.flush();

    // Create new cache instance (simulates extension reload)
    const cache2 = new UnusedAnalysisCache(mockContext, true, 10);

    // Wait for async load
    await new Promise(resolve => setTimeout(resolve, 100));

    // Should have loaded entries
    const stats = cache2.getStats();
    expect(stats.entries).toBe(3);

    // Should be able to retrieve
    const hit = await cache2.get(testFiles[0], [testFiles[0]]);
    expect(hit).not.toBeNull();

    await cache2.flush();
  });

  it('should handle multiple targets per source file', async () => {
    const cache = new UnusedAnalysisCache(mockContext, true, 10);

    // Add entry with multiple targets
    const results = new Map([
      [testFiles[1], true],
      [testFiles[2], false],
      [testFiles[3], true],
    ]);
    await cache.set(testFiles[0], results);

    // Retrieve all targets
    const hit = await cache.get(testFiles[0], [testFiles[1], testFiles[2], testFiles[3]]);
    expect(hit).not.toBeNull();
    expect(hit?.get(testFiles[1])).toBe(true);
    expect(hit?.get(testFiles[2])).toBe(false);
    expect(hit?.get(testFiles[3])).toBe(true);

    // Partial retrieval returns full results (implementation allows it)
    const partial = await cache.get(testFiles[0], [testFiles[1]]);
    expect(partial).not.toBeNull(); // Actually returns full cached results
    expect(partial?.size).toBe(3); // Has all 3 targets

    await cache.flush();
  });

  it('should provide accurate statistics', async () => {
    const cache = new UnusedAnalysisCache(mockContext, true, 50); // Request 50

    // Add entries with different numbers of targets
    await cache.set(testFiles[0], new Map([[testFiles[1], true], [testFiles[2], false]]));
    await cache.set(testFiles[1], new Map([[testFiles[0], true]]));

    const stats = cache.getStats();
    expect(stats.entries).toBe(2); // 2 source files
    expect(stats.totalTargets).toBe(3); // 2 + 1 targets
    expect(stats.maxEntries).toBe(50);
    expect(stats.evictions).toBe(0);
    expect(stats.oldestEntry).not.toBeNull();

    await cache.flush();
  });

  it('should clear all entries', async () => {
    const cache = new UnusedAnalysisCache(mockContext, true, 10);

    // Add entries
    for (let i = 0; i < 3; i++) {
      const results = new Map([[testFiles[i], true]]);
      await cache.set(testFiles[i], results);
    }

    expect(cache.getStats().entries).toBe(3);

    // Clear
    cache.clear();

    expect(cache.getStats().entries).toBe(0);

    await cache.flush();
  });

  it('should invalidate specific files', async () => {
    const cache = new UnusedAnalysisCache(mockContext, true, 10);

    // Add 3 entries
    for (let i = 0; i < 3; i++) {
      const results = new Map([[testFiles[i], true]]);
      await cache.set(testFiles[i], results);
    }

    expect(cache.getStats().entries).toBe(3);

    // Invalidate 2 files
    cache.invalidate([testFiles[0], testFiles[1]]);

    expect(cache.getStats().entries).toBe(1);

    // Only file 2 should remain
    const hit = await cache.get(testFiles[2], [testFiles[2]]);
    expect(hit).not.toBeNull();

    const miss = await cache.get(testFiles[0], [testFiles[0]]);
    expect(miss).toBeNull();

    await cache.flush();
  });
});
