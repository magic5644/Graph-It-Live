import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import { Spider } from '../../src/analyzer/Spider';

const fixturesDir = path.join(__dirname, '../fixtures/sample-project');

describe('Spider Cache Statistics', () => {
  let spider: Spider;

  beforeEach(() => {
    spider = new Spider({
      rootDir: fixturesDir,
      maxDepth: 10,
      maxCacheSize: 100,
      maxSymbolCacheSize: 50,
      maxSymbolAnalyzerFiles: 20,
    });
  });

  it('should return comprehensive cache stats', async () => {
    // Analyze a file first
    await spider.analyze(path.join(fixturesDir, 'src/main.ts'));
    
    const stats = spider.getCacheStats();
    
    // Check dependency cache stats
    expect(stats.dependencyCache).toBeDefined();
    expect(stats.dependencyCache.size).toBeGreaterThan(0);
    expect(stats.dependencyCache.maxSize).toBe(100);
    expect(typeof stats.dependencyCache.hits).toBe('number');
    expect(typeof stats.dependencyCache.misses).toBe('number');
    expect(typeof stats.dependencyCache.hitRate).toBe('number');
    
    // Check symbol cache stats
    expect(stats.symbolCache).toBeDefined();
    expect(stats.symbolCache.maxSize).toBe(50);
    
    // Check symbol analyzer file count
    expect(typeof stats.symbolAnalyzerFileCount).toBe('number');
  });

  it('should track cache hits and misses', async () => {
    const filePath = path.join(fixturesDir, 'src/main.ts');
    
    // First analysis - should be a miss
    await spider.analyze(filePath);
    
    // Second analysis - should be a hit (cached)
    await spider.analyze(filePath);
    const stats = spider.getCacheStats();
    
    expect(stats.dependencyCache.hits).toBeGreaterThan(0);
  });

  it('should evict old entries when cache is full', async () => {
    const tinySpider = new Spider({
      rootDir: fixturesDir,
      maxDepth: 5,
      maxCacheSize: 2, // Very small cache
    });
    
    // Analyze multiple files
    await tinySpider.analyze(path.join(fixturesDir, 'src/main.ts'));
    await tinySpider.analyze(path.join(fixturesDir, 'src/utils.ts'));
    await tinySpider.analyze(path.join(fixturesDir, 'src/circular.ts'));
    
    const stats = tinySpider.getCacheStats();
    
    // Should have evictions
    expect(stats.dependencyCache.evictions).toBeGreaterThan(0);
    // Size should not exceed max
    expect(stats.dependencyCache.size).toBeLessThanOrEqual(2);
  });

  it('should report symbol analyzer memory usage', async () => {
    const filePath = path.join(fixturesDir, 'src/main.ts');
    
    // Initial state
    let stats = spider.getCacheStats();
    expect(stats.symbolAnalyzerFileCount).toBe(0);
    
    // After symbol analysis
    await spider.getSymbolGraph(filePath);
    stats = spider.getCacheStats();
    expect(stats.symbolAnalyzerFileCount).toBeGreaterThan(0);
  });
});

describe('Spider Memory Management', () => {
  it('should handle many files without memory issues', async () => {
    const spider = new Spider({
      rootDir: fixturesDir,
      maxDepth: 3,
      maxCacheSize: 10,
      maxSymbolAnalyzerFiles: 5,
    });
    
    // Analyze the same file multiple times (simulating heavy usage)
    const filePath = path.join(fixturesDir, 'src/main.ts');
    for (let i = 0; i < 20; i++) {
      await spider.analyze(filePath);
    }
    
    const stats = spider.getCacheStats();
    
    // Cache should be bounded
    expect(stats.dependencyCache.size).toBeLessThanOrEqual(10);
    
    // Hit rate should be high (cached results)
    expect(stats.dependencyCache.hitRate).toBeGreaterThan(0.5);
  });
});
