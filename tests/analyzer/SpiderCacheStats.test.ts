import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import { Spider } from '../../src/analyzer/Spider';
import { SpiderBuilder } from '../../src/analyzer/SpiderBuilder';

const fixturesDir = path.join(__dirname, '../fixtures/sample-project');

describe('Spider Cache Statistics', () => {
  let spider: Spider;

  beforeEach(() => {
    spider = new SpiderBuilder()
     .withRootDir(fixturesDir)
     .withMaxDepth(10)
     .withCacheConfig({ maxCacheSize: 100, maxSymbolCacheSize: 50 })
     .build();
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
    const tinySpider = new SpiderBuilder()
     .withRootDir(fixturesDir)
     .withMaxDepth(5)
     .withCacheConfig({ maxCacheSize: 2 })
     .build();
    
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
    let stats = await spider.getCacheStatsAsync();
    expect(stats.symbolAnalyzerFileCount).toBe(0);
    
    // After symbol analysis
    await spider.getSymbolGraph(filePath);
    stats = await spider.getCacheStatsAsync();
    expect(stats.symbolAnalyzerFileCount).toBeGreaterThan(0);
  });
});

describe('Spider Memory Management', () => {
  it('should handle many files without memory issues', async () => {
    const spider = new SpiderBuilder()
     .withRootDir(fixturesDir)
     .withMaxDepth(3)
     .build();
    
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
