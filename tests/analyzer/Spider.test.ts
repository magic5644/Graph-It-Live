import { describe, it, expect, beforeEach } from 'vitest';
import { Spider } from '../../src/analyzer/Spider';
import { SpiderBuilder } from '../../src/analyzer/SpiderBuilder';
import { normalizePath } from '../../src/analyzer/types';
import path from 'node:path';

// Use absolute path for test fixtures
const fixturesPath = path.resolve(process.cwd(), 'tests/fixtures/sample-project');
const np = (p: string) => normalizePath(p);

describe('Spider', () => {
  let spider: Spider;

  beforeEach(() => {
    spider = new SpiderBuilder()
      .withRootDir(fixturesPath)
      .withTsConfigPath(path.join(fixturesPath, 'tsconfig.json'))
      .build();
  });

  it('should resolve relative imports', async () => {
    const mainFile = path.join(fixturesPath, 'src/main.ts');
    const deps = await spider.analyze(mainFile);
    
    expect(deps.length).toBeGreaterThan(0);
    
    const utilsDep = deps.find(d => d.path.includes('utils.ts'));
    expect(utilsDep).toBeDefined();
    expect(utilsDep?.type).toBe('import');
    expect(utilsDep?.module).toBe('./utils');
  });

  it('should resolve TypeScript path aliases', async () => {
    const mainFile = path.join(fixturesPath, 'src/main.ts');
    const deps = await spider.analyze(mainFile);
    
    const buttonDep = deps.find(d => d.path.includes('Button.tsx'));
    expect(buttonDep).toBeDefined();
    expect(buttonDep?.type).toBe('import');
    expect(buttonDep?.module).toBe('@components/Button');
  });

  it('should resolve imports with implicit extensions', async () => {
    const buttonFile = path.join(fixturesPath, 'src/components/Button.tsx');
    const deps = await spider.analyze(buttonFile);
    
    const utilsDep = deps.find(d => d.path.includes('utils'));
    expect(utilsDep).toBeDefined();
    expect(path.extname(utilsDep!.path)).toBe('.ts');
  });

  it('should cache results for performance', async () => {
    const mainFile = path.join(fixturesPath, 'src/main.ts');
    
    const start1 = Date.now();
    const deps1 = await spider.analyze(mainFile);
    const time1 = Date.now() - start1;
    
    const start2 = Date.now();
    const deps2 = await spider.analyze(mainFile);
    const time2 = Date.now() - start2;
    
    expect(deps1).toEqual(deps2);
    expect(time2).toBeLessThan(time1 || 10); // Cached should be faster or both very fast
  });

  it('should handle non-existent files gracefully', async () => {
    const fakeFile = path.join(fixturesPath, 'src/does-not-exist.ts');
    
    await expect(spider.analyze(fakeFile)).rejects.toThrow();
  });

  it('should detect multiple imports in single file', async () => {
    const mainFile = path.join(fixturesPath, 'src/main.ts');
    const deps = await spider.analyze(mainFile);
    
    // main.ts has 2 imports: utils and Button
    expect(deps.length).toBe(2);
  });

  it('should preserve line numbers', async () => {
    const mainFile = path.join(fixturesPath, 'src/main.ts');
    const deps = await spider.analyze(mainFile);
    
    deps.forEach(dep => {
      expect(dep.line).toBeGreaterThan(0);
    });
  });

  it('should update configuration', () => {
    spider.updateConfig({ excludeNodeModules: false, maxDepth: 10 });
    const stats = spider.getCacheStats();
    expect(stats.dependencyCache.size).toBe(0); // Cache should be cleared
  });

  it('should enable reverse index via updateConfig', () => {
    const spiderNoIndex = new SpiderBuilder()
      .withRootDir(fixturesPath)
      .withTsConfigPath(path.join(fixturesPath, 'tsconfig.json'))
      .withReverseIndex(false)
      .build();
    
    expect(spiderNoIndex.hasReverseIndex()).toBe(false);
    
    spiderNoIndex.updateConfig({ enableReverseIndex: true });
    expect(spiderNoIndex.hasReverseIndex()).toBe(false); // Still false until indexed
  });

  it('should disable reverse index via updateConfig', async () => {
    const spiderWithIndex = new SpiderBuilder()
      .withRootDir(fixturesPath)
      .withTsConfigPath(path.join(fixturesPath, 'tsconfig.json'))
      .withReverseIndex(true)
      .build();
    
    // Analyze a file to populate the reverse index
    const mainFile = path.join(fixturesPath, 'src/main.ts');
    await spiderWithIndex.analyze(mainFile);
    
    // Disable reverse index
    spiderWithIndex.updateConfig({ enableReverseIndex: false });
    expect(spiderWithIndex.hasReverseIndex()).toBe(false);
  });

  it('should update indexing concurrency', () => {
    spider.updateConfig({ indexingConcurrency: 8 });
    // No direct way to check, but should not throw
    expect(spider.getCacheStats().dependencyCache.size).toBe(0);
  });

  it('should clear cache', async () => {
    const mainFile = path.join(fixturesPath, 'src/main.ts');
    await spider.analyze(mainFile);
    
    expect(spider.getCacheStats().dependencyCache.size).toBeGreaterThan(0);
    
    spider.clearCache();
    expect(spider.getCacheStats().dependencyCache.size).toBe(0);
  });

  it('should get cache statistics', async () => {
    const mainFile = path.join(fixturesPath, 'src/main.ts');
    await spider.analyze(mainFile);
    
    const stats = spider.getCacheStats();
    expect(stats.dependencyCache.size).toBeGreaterThan(0);
  });
});

describe('Spider - crawlFrom', () => {
  let spider: Spider;

  beforeEach(() => {
    spider = new SpiderBuilder()
      .withRootDir(fixturesPath)
      .withTsConfigPath(path.join(fixturesPath, 'tsconfig.json'))
      .build();
  });

  it('should discover new dependencies from a node', async () => {
    const mainFile = path.join(fixturesPath, 'src/main.ts');
    const existingNodes = new Set<string>();
    
    const result = await spider.crawlFrom(mainFile, existingNodes, 5);
    
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.edges.length).toBeGreaterThan(0);
  });

  it('should not rediscover already known nodes', async () => {
    const mainFile = path.join(fixturesPath, 'src/main.ts');
    const utilsFile = path.join(fixturesPath, 'src/utils.ts');
    
    // First crawl to discover utils
    const firstResult = await spider.crawlFrom(mainFile, new Set(), 5);
    expect(firstResult.nodes).toContain(np(utilsFile));
    
    // Second crawl with utils already known
    const existingNodes = new Set([np(mainFile), np(utilsFile)]);
    const secondResult = await spider.crawlFrom(mainFile, existingNodes, 5);
    
    // Should not include main and utils in new nodes
    expect(secondResult.nodes).not.toContain(np(mainFile));
    expect(secondResult.nodes).not.toContain(np(utilsFile));
  });

  it('should respect extra depth limit', async () => {
    const mainFile = path.join(fixturesPath, 'src/main.ts');
    
    // Crawl with very limited depth
    const result = await spider.crawlFrom(mainFile, new Set(), 0);
    
    // With depth 0, it still analyzes the start node (depth 0) 
    // but shouldn't recurse into children (depth 1)
    // main.ts has 2 immediate dependencies (utils, Button)
    expect(result.edges.length).toBe(2);
  });
});

describe('Spider - File Invalidation', () => {
  let spider: Spider;

  beforeEach(() => {
    spider = new SpiderBuilder()
      .withRootDir(fixturesPath)
      .withTsConfigPath(path.join(fixturesPath, 'tsconfig.json'))
      .withReverseIndex(true)
      .build();
  });

  it('should invalidate a single file from cache', async () => {
    const mainFile = path.join(fixturesPath, 'src/main.ts');
    
    // First analyze to populate cache
    await spider.analyze(mainFile);
    expect(spider.getCacheStats().dependencyCache.size).toBe(1);
    
    // Invalidate the file
    const wasInCache = spider.invalidateFile(mainFile);
    
    expect(wasInCache).toBe(true);
    expect(spider.getCacheStats().dependencyCache.size).toBe(0);
  });

  it('should return false when invalidating a file not in cache', () => {
    const mainFile = path.join(fixturesPath, 'src/main.ts');
    
    // Try to invalidate without analyzing first
    const wasInCache = spider.invalidateFile(mainFile);
    
    expect(wasInCache).toBe(false);
  });

  it('should invalidate multiple files', async () => {
    const mainFile = path.join(fixturesPath, 'src/main.ts');
    const utilsFile = path.join(fixturesPath, 'src/utils.ts');
    const buttonFile = path.join(fixturesPath, 'src/components/Button.tsx');
    
    // Analyze files to populate cache
    await spider.analyze(mainFile);
    await spider.analyze(utilsFile);
    expect(spider.getCacheStats().dependencyCache.size).toBe(2);
    
    // Invalidate multiple files (one not in cache)
    const invalidatedCount = spider.invalidateFiles([mainFile, utilsFile, buttonFile]);
    
    expect(invalidatedCount).toBe(2); // Only 2 were in cache
    expect(spider.getCacheStats().dependencyCache.size).toBe(0);
  });

  it('should re-analyze a file and update cache', async () => {
    const mainFile = path.join(fixturesPath, 'src/main.ts');
    
    // First analyze
    const deps1 = await spider.analyze(mainFile);
    expect(spider.getCacheStats().dependencyCache.size).toBe(1);
    
    // Re-analyze (should invalidate and re-populate)
    const deps2 = await spider.reanalyzeFile(mainFile);
    
    expect(deps2).toBeDefined();
    expect(deps2?.length).toBe(deps1.length);
    expect(spider.getCacheStats().dependencyCache.size).toBe(1);
  });

  it('should return null when re-analyzing non-existent file', async () => {
    const fakeFile = path.join(fixturesPath, 'src/does-not-exist.ts');
    
    const result = await spider.reanalyzeFile(fakeFile);
    
    expect(result).toBeNull();
  });

  it('should handle file deletion', async () => {
    const mainFile = path.join(fixturesPath, 'src/main.ts');
    
    // First analyze to populate cache
    await spider.analyze(mainFile);
    expect(spider.getCacheStats().dependencyCache.size).toBe(1);
    
    // Handle deletion
    spider.handleFileDeleted(mainFile);
    
    expect(spider.getCacheStats().dependencyCache.size).toBe(0);
  });

  it('should update reverse index when invalidating files', async () => {
    const mainFile = path.join(fixturesPath, 'src/main.ts');
    
    // Analyze to populate cache and reverse index
    await spider.analyze(mainFile);
    
    const statsBefore = spider.getCacheStats();
    expect(statsBefore.reverseIndexStats?.totalReferences).toBeGreaterThan(0);
    
    // Invalidate the file
    spider.invalidateFile(mainFile);
    
    const statsAfter = spider.getCacheStats();
    // Reverse index should have fewer references after invalidation
    expect(statsAfter.reverseIndexStats?.totalReferences).toBe(0);
  });
});

describe('Spider - Reverse Index Management', () => {
  let spider: Spider;

  beforeEach(() => {
    spider = new SpiderBuilder()
      .withRootDir(fixturesPath)
      .withTsConfigPath(path.join(fixturesPath, 'tsconfig.json'))
      .withReverseIndex(false) // Start without reverse index
      .build();
  });

  it('should enable reverse index', () => {
    expect(spider.hasReverseIndex()).toBe(false);
    
    const restored = spider.enableReverseIndex();
    
    expect(restored).toBe(false); // No serialized data provided
    expect(spider.hasReverseIndex()).toBe(false); // No entries yet
  });

  it('should enable reverse index with valid serialized data', async () => {
    // First, create a spider with reverse index and populate it
    const spiderWithIndex = new SpiderBuilder()
      .withRootDir(fixturesPath)
      .withTsConfigPath(path.join(fixturesPath, 'tsconfig.json'))
      .withReverseIndex(true)
      .build();
    
    const mainFile = path.join(fixturesPath, 'src/main.ts');
    await spiderWithIndex.analyze(mainFile);
    
    const serialized = spiderWithIndex.getSerializedReverseIndex();
    expect(serialized).not.toBeNull();
    
    // Now restore into a new spider
    const restored = spider.enableReverseIndex(serialized!);
    
    expect(restored).toBe(true);
    expect(spider.hasReverseIndex()).toBe(true);
  });

  it('should handle invalid serialized data gracefully', () => {
    const restored = spider.enableReverseIndex('invalid json {{{');
    
    expect(restored).toBe(false);
  });

  it('should disable reverse index', async () => {
    spider.enableReverseIndex();
    const mainFile = path.join(fixturesPath, 'src/main.ts');
    await spider.analyze(mainFile);
    
    spider.disableReverseIndex();
    
    expect(spider.hasReverseIndex()).toBe(false);
  });

  it('should get serialized reverse index', async () => {
    spider.enableReverseIndex();
    const mainFile = path.join(fixturesPath, 'src/main.ts');
    await spider.analyze(mainFile);
    
    const serialized = spider.getSerializedReverseIndex();
    
    expect(serialized).not.toBeNull();
    expect(typeof serialized).toBe('string');
    
    // Should be valid JSON
    const parsed = JSON.parse(serialized!);
    expect(parsed).toBeDefined();
  });

  it('should return null when getting serialized index without reverse index', () => {
    const serialized = spider.getSerializedReverseIndex();
    expect(serialized).toBeNull();
  });

  it('should validate reverse index', async () => {
    spider.enableReverseIndex();
    const mainFile = path.join(fixturesPath, 'src/main.ts');
    await spider.analyze(mainFile);
    
    const validation = await spider.validateReverseIndex();
    
    expect(validation).not.toBeNull();
    expect(validation?.isValid).toBe(true);
    expect(Array.isArray(validation?.staleFiles)).toBe(true);
    expect(Array.isArray(validation?.missingFiles)).toBe(true);
  });

  it('should return null when validating without reverse index', async () => {
    const validation = await spider.validateReverseIndex();
    expect(validation).toBeNull();
  });
});

describe('Spider - Index Status', () => {
  let spider: Spider;

  beforeEach(() => {
    spider = new SpiderBuilder()
      .withRootDir(fixturesPath)
      .withTsConfigPath(path.join(fixturesPath, 'tsconfig.json'))
      .build();
  });

  it('should get full index status', () => {
    const status = spider.getIndexStatus();
    
    expect(status.state).toBe('idle');
    expect(status.processed).toBe(0);
    expect(status.total).toBe(0);
    expect(status.cancelled).toBe(false);
  });

  it('should subscribe to index status changes', () => {
    const callbacks: Array<{ state: string }> = [];
    
    const unsubscribe = spider.subscribeToIndexStatus((snapshot) => {
      callbacks.push({ state: snapshot.state });
    });
    
    // Should be called immediately with current state
    expect(callbacks.length).toBe(1);
    expect(callbacks[0].state).toBe('idle');
    
    unsubscribe();
  });

  it('should cancel indexing', () => {
    // Just verify it doesn't throw
    expect(() => spider.cancelIndexing()).not.toThrow();
  });
});
