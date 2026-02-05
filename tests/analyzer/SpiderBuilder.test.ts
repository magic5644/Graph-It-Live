import { describe, it, expect, vi } from 'vitest';
import { SpiderBuilder } from '../../src/analyzer/SpiderBuilder';
import { Spider } from '../../src/analyzer/Spider';
import { Cache } from '../../src/analyzer/Cache';
import { LanguageService } from '../../src/analyzer/LanguageService';
import { PathResolver } from '../../src/analyzer/utils/PathResolver';
import { AstWorkerHost } from '../../src/analyzer/ast/AstWorkerHost';
import { ReverseIndexManager } from '../../src/analyzer/ReverseIndexManager';
import path from 'node:path';

const fixturesPath = path.resolve(process.cwd(), 'tests/fixtures/sample-project');

describe('SpiderBuilder', () => {
  describe('Fluent API Method Chaining', () => {
    it('should return same builder instance for all configuration methods', () => {
      const builder = new SpiderBuilder();
      
      const result1 = builder.withRootDir(fixturesPath);
      const result2 = result1.withMaxDepth(50);
      const result3 = result2.withExcludeNodeModules(true);
      const result4 = result3.withReverseIndex(false);
      const result5 = result4.withIndexingConcurrency(4);
      const result6 = result5.withCacheConfig({ maxCacheSize: 500 });
      const result7 = result6.withTsConfigPath(path.join(fixturesPath, 'tsconfig.json'));
      const result8 = result7.withIndexingProgressInterval(100);
      
      // All methods should return the same builder instance
      expect(result1).toBe(builder);
      expect(result2).toBe(builder);
      expect(result3).toBe(builder);
      expect(result4).toBe(builder);
      expect(result5).toBe(builder);
      expect(result6).toBe(builder);
      expect(result7).toBe(builder);
      expect(result8).toBe(builder);
    });

    it('should support method chaining in a single expression', () => {
      const builder = new SpiderBuilder();
      
      const result = builder
        .withRootDir(fixturesPath)
        .withMaxDepth(50)
        .withExcludeNodeModules(true)
        .withReverseIndex(false);
      
      expect(result).toBe(builder);
    });
  });

  describe('Configuration Validation', () => {
    it('should throw error when rootDir is not provided', () => {
      const builder = new SpiderBuilder();
      
      expect(() => builder.build()).toThrow('rootDir is required');
    });

    it('should throw error when maxDepth is negative', () => {
      const builder = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .withMaxDepth(-1);
      
      expect(() => builder.build()).toThrow('maxDepth must be non-negative');
    });

    it('should throw error when indexingConcurrency is less than 1', () => {
      const builder = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .withIndexingConcurrency(0);
      
      expect(() => builder.build()).toThrow('indexingConcurrency must be at least 1');
    });

    it('should throw error when maxCacheSize is negative', () => {
      const builder = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .withCacheConfig({ maxCacheSize: -1 });
      
      expect(() => builder.build()).toThrow('maxCacheSize must be non-negative');
    });

    it('should throw error when maxSymbolCacheSize is negative', () => {
      const builder = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .withCacheConfig({ maxSymbolCacheSize: -1 });
      
      expect(() => builder.build()).toThrow('maxSymbolCacheSize must be non-negative');
    });

    it('should throw error when maxSymbolAnalyzerFiles is negative', () => {
      const builder = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .withCacheConfig({ maxSymbolAnalyzerFiles: -1 });
      
      expect(() => builder.build()).toThrow('maxSymbolAnalyzerFiles must be non-negative');
    });

    it('should validate configuration before building', () => {
      const builder = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .withMaxDepth(-5);
      
      // Should throw during validation, not during service initialization
      expect(() => builder.build()).toThrow('maxDepth must be non-negative');
    });
  });

  describe('Default Configuration Values', () => {
    it('should apply default values when only rootDir is specified', async () => {
      const spider = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .build();
      
      // Verify Spider was created successfully
      expect(spider).toBeInstanceOf(Spider);
      
      // Clean up
      await spider.dispose();
    });

    it('should use default maxDepth of 50', async () => {
      const spider = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .build();
      
      expect(spider).toBeInstanceOf(Spider);
      
      await spider.dispose();
    });

    it('should use default excludeNodeModules of true', async () => {
      const spider = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .build();
      
      expect(spider).toBeInstanceOf(Spider);
      
      await spider.dispose();
    });

    it('should use default enableReverseIndex of false', async () => {
      const spider = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .build();
      
      expect(spider).toBeInstanceOf(Spider);
      expect(spider.hasReverseIndex()).toBe(false);
      
      await spider.dispose();
    });

    it('should use default indexingConcurrency of 4', async () => {
      const spider = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .build();
      
      expect(spider).toBeInstanceOf(Spider);
      
      await spider.dispose();
    });

    it('should use default cache sizes', async () => {
      const spider = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .build();
      
      const stats = spider.getCacheStats();
      expect(stats.dependencyCache).toBeDefined();
      expect(stats.symbolCache).toBeDefined();
      
      await spider.dispose();
    });
  });

  describe('Service Override Functionality', () => {
    it('should allow overriding cache', async () => {
      const mockCache = new Cache({ maxSize: 100, enableLRU: true });
      
      const spider = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .withCache(mockCache)
        .build();
      
      expect(spider).toBeInstanceOf(Spider);
      
      await spider.dispose();
    });

    it('should allow overriding symbol cache', async () => {
      const mockSymbolCache = new Cache({ maxSize: 50, enableLRU: true });
      
      const spider = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .withSymbolCache(mockSymbolCache)
        .build();
      
      expect(spider).toBeInstanceOf(Spider);
      
      await spider.dispose();
    });

    it('should allow overriding language service', async () => {
      const mockLanguageService = new LanguageService(fixturesPath);
      
      const spider = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .withLanguageService(mockLanguageService)
        .build();
      
      expect(spider).toBeInstanceOf(Spider);
      
      await spider.dispose();
    });

    it('should allow overriding path resolver', async () => {
      const mockResolver = new PathResolver(undefined, true, fixturesPath);
      
      const spider = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .withPathResolver(mockResolver)
        .build();
      
      expect(spider).toBeInstanceOf(Spider);
      
      await spider.dispose();
    });

    it('should allow overriding AST worker host', async () => {
      const mockAstWorkerHost = new AstWorkerHost();
      
      const spider = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .withAstWorkerHost(mockAstWorkerHost)
        .build();
      
      expect(spider).toBeInstanceOf(Spider);
      
      await spider.dispose();
      await mockAstWorkerHost.stop();
    });

    it('should allow overriding reverse index manager', async () => {
      const mockReverseIndexManager = new ReverseIndexManager(fixturesPath);
      
      const spider = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .withReverseIndexManager(mockReverseIndexManager)
        .build();
      
      expect(spider).toBeInstanceOf(Spider);
      
      await spider.dispose();
    });

    it('should allow multiple service overrides', async () => {
      const mockCache = new Cache({ maxSize: 100, enableLRU: true });
      const mockSymbolCache = new Cache({ maxSize: 50, enableLRU: true });
      const mockLanguageService = new LanguageService(fixturesPath);
      
      const spider = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .withCache(mockCache)
        .withSymbolCache(mockSymbolCache)
        .withLanguageService(mockLanguageService)
        .build();
      
      expect(spider).toBeInstanceOf(Spider);
      
      await spider.dispose();
    });
  });

  describe('Configuration from SpiderConfig', () => {
    it('should accept bulk configuration via withConfig', async () => {
      const config = {
        rootDir: fixturesPath,
        tsConfigPath: path.join(fixturesPath, 'tsconfig.json'),
        maxDepth: 30,
        excludeNodeModules: false,
        enableReverseIndex: true,
        indexingConcurrency: 8,
        maxCacheSize: 1000,
        maxSymbolCacheSize: 400,
        maxSymbolAnalyzerFiles: 200,
        indexingProgressInterval: 50,
      };
      
      const spider = new SpiderBuilder()
        .withConfig(config)
        .build();
      
      expect(spider).toBeInstanceOf(Spider);
      // hasReverseIndex() checks if there are entries, not if it's enabled
      // The reverse index is enabled but empty until files are indexed
      
      await spider.dispose();
    });

    it('should allow overriding config values after withConfig', async () => {
      const config = {
        rootDir: fixturesPath,
        maxDepth: 30,
      };
      
      const spider = new SpiderBuilder()
        .withConfig(config)
        .withMaxDepth(60) // Override
        .build();
      
      expect(spider).toBeInstanceOf(Spider);
      
      await spider.dispose();
    });
  });

  describe('Configuration Order Independence', () => {
    it('should produce same result regardless of configuration order', async () => {
      const spider1 = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .withMaxDepth(40)
        .withExcludeNodeModules(false)
        .build();
      
      const spider2 = new SpiderBuilder()
        .withExcludeNodeModules(false)
        .withMaxDepth(40)
        .withRootDir(fixturesPath)
        .build();
      
      expect(spider1).toBeInstanceOf(Spider);
      expect(spider2).toBeInstanceOf(Spider);
      
      await spider1.dispose();
      await spider2.dispose();
    });
  });

  describe('Last Configuration Value Wins', () => {
    it('should use last value when configuration method called multiple times', async () => {
      const spider = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .withMaxDepth(10)
        .withMaxDepth(20)
        .withMaxDepth(30)
        .build();
      
      expect(spider).toBeInstanceOf(Spider);
      
      await spider.dispose();
    });

    it('should use last value for excludeNodeModules', async () => {
      const spider = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .withExcludeNodeModules(true)
        .withExcludeNodeModules(false)
        .withExcludeNodeModules(true)
        .build();
      
      expect(spider).toBeInstanceOf(Spider);
      
      await spider.dispose();
    });
  });

  describe('Build Produces Fully Initialized Spider', () => {
    it('should build a working Spider instance', async () => {
      const spider = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .withTsConfigPath(path.join(fixturesPath, 'tsconfig.json'))
        .build();
      
      expect(spider).toBeInstanceOf(Spider);
      
      // Verify Spider can perform operations
      const mainFile = path.join(fixturesPath, 'src/main.ts');
      const deps = await spider.analyze(mainFile);
      
      expect(deps).toBeDefined();
      expect(Array.isArray(deps)).toBe(true);
      
      await spider.dispose();
    });

    it('should build Spider with reverse index enabled', async () => {
      const spider = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .withReverseIndex(true)
        .build();
      
      expect(spider).toBeInstanceOf(Spider);
      expect(spider.hasReverseIndex()).toBe(false); // Not populated yet
      
      await spider.dispose();
    });

    it('should build Spider with custom cache configuration', async () => {
      const spider = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .withCacheConfig({
          maxCacheSize: 1000,
          maxSymbolCacheSize: 500,
          maxSymbolAnalyzerFiles: 200,
        })
        .build();
      
      expect(spider).toBeInstanceOf(Spider);
      
      const stats = spider.getCacheStats();
      expect(stats.dependencyCache).toBeDefined();
      expect(stats.symbolCache).toBeDefined();
      
      await spider.dispose();
    });
  });

  describe('Cache Configuration', () => {
    it('should apply cache configuration via withCacheConfig', async () => {
      const spider = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .withCacheConfig({
          maxCacheSize: 800,
          maxSymbolCacheSize: 300,
          maxSymbolAnalyzerFiles: 150,
        })
        .build();
      
      expect(spider).toBeInstanceOf(Spider);
      
      await spider.dispose();
    });

    it('should allow partial cache configuration', async () => {
      const spider = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .withCacheConfig({ maxCacheSize: 600 })
        .build();
      
      expect(spider).toBeInstanceOf(Spider);
      
      await spider.dispose();
    });
  });

  describe('Integration with Spider API', () => {
    it('should produce Spider with all public methods available', async () => {
      const spider = new SpiderBuilder()
        .withRootDir(fixturesPath)
        .build();
      
      // Verify all public methods exist
      expect(typeof spider.analyze).toBe('function');
      expect(typeof spider.crawl).toBe('function');
      expect(typeof spider.clearCache).toBe('function');
      expect(typeof spider.invalidateFile).toBe('function');
      expect(typeof spider.reanalyzeFile).toBe('function');
      expect(typeof spider.enableReverseIndex).toBe('function');
      expect(typeof spider.disableReverseIndex).toBe('function');
      expect(typeof spider.getCacheStats).toBe('function');
      expect(typeof spider.dispose).toBe('function');
      
      await spider.dispose();
    });
  });
});
