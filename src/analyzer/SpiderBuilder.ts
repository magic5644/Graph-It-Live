import { AstWorkerHost } from './ast/AstWorkerHost';
import { Cache } from './Cache';
import { FileReader } from './FileReader';
import { IndexerStatus } from './IndexerStatus';
import { LanguageService } from './LanguageService';
import { ReferencingFilesFinder } from './ReferencingFilesFinder';
import { ReverseIndexManager } from './ReverseIndexManager';
import { SourceFileCollector } from './SourceFileCollector';
import { Spider, type SpiderServices } from './Spider';
import { SpiderCacheCoordinator } from './spider/SpiderCacheCoordinator';
import { SpiderDependencyAnalyzer } from './spider/SpiderDependencyAnalyzer';
import { SpiderGraphCrawler } from './spider/SpiderGraphCrawler';
import { SpiderIndexingCancellation } from './spider/SpiderIndexingCancellation';
import { SpiderIndexingService } from './spider/SpiderIndexingService';
import { SpiderReferenceLookup } from './spider/SpiderReferenceLookup';
import { SpiderSymbolService } from './spider/SpiderSymbolService';
import { SpiderWorkerManager } from './spider/SpiderWorkerManager';
import { SymbolDependencyHelper } from './SymbolDependencyHelper';
import type { Dependency, SpiderConfig, SymbolInfo, SymbolDependency } from './types';
import { YIELD_INTERVAL_MS, yieldToEventLoop } from './utils/EventLoopYield';
import { PathResolver } from './utils/PathResolver';

/**
 * Builder for constructing Spider instances with a fluent API.
 * 
 * SpiderBuilder provides a type-safe, progressive configuration approach for creating Spider instances.
 * It handles complex service initialization, dependency ordering, and circular dependencies automatically.
 * 
 * ## Configuration Options
 * 
 * ### Required
 * - `rootDir` - Project root directory (must be set via `withRootDir()`)
 * 
 * ### Optional (with defaults)
 * - `maxDepth` - Maximum crawl depth (default: 50)
 * - `excludeNodeModules` - Exclude node_modules from analysis (default: true)
 * - `enableReverseIndex` - Enable O(1) reverse dependency lookups (default: false)
 * - `indexingConcurrency` - Number of parallel indexing workers (default: 4)
 * - `maxCacheSize` - Dependency cache size (default: 500)
 * - `maxSymbolCacheSize` - Symbol cache size (default: 200)
 * - `maxSymbolAnalyzerFiles` - Symbol analyzer file limit (default: 100)
 * - `tsConfigPath` - Path to tsconfig.json (optional)
 * - `indexingProgressInterval` - Progress callback interval in ms (optional)
 * 
 * ## Basic Usage
 * 
 * @example Minimal configuration
 * ```typescript
 * import { SpiderBuilder } from './SpiderBuilder';
 * 
 * // Only rootDir is required - all other options use sensible defaults
 * const spider = new SpiderBuilder()
 *   .withRootDir('/path/to/project')
 *   .build();
 * 
 * // Analyze a file
 * const dependencies = await spider.analyze('src/index.ts');
 * 
 * // Clean up when done
 * await spider.dispose();
 * ```
 * 
 * @example Standard configuration
 * ```typescript
 * const spider = new SpiderBuilder()
 *   .withRootDir('/path/to/project')
 *   .withMaxDepth(50)
 *   .withReverseIndex(true)
 *   .withIndexingConcurrency(4)
 *   .build();
 * 
 * // Crawl dependency graph
 * const graph = await spider.crawl('src/app.ts');
 * console.log(`Found ${graph.nodes.length} files, ${graph.edges.length} dependencies`);
 * ```
 * 
 * ## Advanced Configuration
 * 
 * @example High-performance configuration
 * ```typescript
 * const spider = new SpiderBuilder()
 *   .withRootDir('/path/to/large-project')
 *   .withTsConfigPath('./tsconfig.json')
 *   .withMaxDepth(100)
 *   .withExcludeNodeModules(true)
 *   .withReverseIndex(true)
 *   .withIndexingConcurrency(8)
 *   .withCacheConfig({
 *     maxCacheSize: 2000,
 *     maxSymbolCacheSize: 1000,
 *     maxSymbolAnalyzerFiles: 500
 *   })
 *   .build();
 * 
 * // Build full index with progress tracking
 * await spider.buildFullIndex((progress) => {
 *   console.log(`Progress: ${progress.completed}/${progress.total} files`);
 * });
 * ```
 * 
 * @example Low-memory configuration
 * ```typescript
 * const spider = new SpiderBuilder()
 *   .withRootDir('/path/to/project')
 *   .withMaxDepth(30)
 *   .withReverseIndex(false)
 *   .withIndexingConcurrency(2)
 *   .withCacheConfig({
 *     maxCacheSize: 100,
 *     maxSymbolCacheSize: 50,
 *     maxSymbolAnalyzerFiles: 25
 *   })
 *   .build();
 * ```
 * 
 * @example Bulk configuration from SpiderConfig
 * ```typescript
 * const config: SpiderConfig = {
 *   rootDir: '/path/to/project',
 *   maxDepth: 50,
 *   enableReverseIndex: true,
 *   indexingConcurrency: 4
 * };
 * 
 * const spider = new SpiderBuilder()
 *   .withConfig(config)
 *   .build();
 * ```
 * 
 * ## Testing Scenarios
 * 
 * @example Unit testing with mock services
 * ```typescript
 * import { vi } from 'vitest';
 * 
 * const mockCache = new Cache({ maxSize: 10 });
 * const mockLanguageService = {
 *   getLanguage: vi.fn().mockReturnValue('typescript'),
 *   // ... other methods
 * };
 * 
 * const spider = new SpiderBuilder()
 *   .withRootDir('/test/project')
 *   .withCache(mockCache)
 *   .withLanguageService(mockLanguageService)
 *   .build();
 * 
 * // Test with controlled dependencies
 * await spider.analyze('test.ts');
 * expect(mockLanguageService.getLanguage).toHaveBeenCalled();
 * ```
 * 
 * @example Integration testing with minimal setup
 * ```typescript
 * const spider = new SpiderBuilder()
 *   .withRootDir('/test/fixtures/sample-project')
 *   .withMaxDepth(10)
 *   .withExcludeNodeModules(true)
 *   .build();
 * 
 * const graph = await spider.crawl('src/index.ts');
 * expect(graph.nodes).toContain('src/utils.ts');
 * 
 * await spider.dispose();
 * ```
 * 
 * @example Testing with custom cache for verification
 * ```typescript
 * const cache = new Cache({ maxSize: 100 });
 * 
 * const spider = new SpiderBuilder()
 *   .withRootDir('/test/project')
 *   .withCache(cache)
 *   .build();
 * 
 * await spider.analyze('file1.ts');
 * await spider.analyze('file1.ts'); // Should hit cache
 * 
 * const stats = cache.getStats();
 * expect(stats.hits).toBe(1);
 * expect(stats.misses).toBe(1);
 * ```
 * 
 * ## Migration Guide
 * 
 * ### From Direct Spider Constructor
 * 
 * **Before (legacy approach):**
 * ```typescript
 * const spider = new Spider({
 *   rootDir: '/path/to/project',
 *   maxDepth: 50,
 *   enableReverseIndex: true,
 *   indexingConcurrency: 4
 * });
 * ```
 * 
 * **After (recommended approach):**
 * ```typescript
 * const spider = new SpiderBuilder()
 *   .withRootDir('/path/to/project')
 *   .withMaxDepth(50)
 *   .withReverseIndex(true)
 *   .withIndexingConcurrency(4)
 *   .build();
 * ```
 * 
 * ### Benefits of Migration
 * 
 * 1. **Type Safety**: Fluent API provides better IDE autocomplete and type checking
 * 2. **Validation**: Configuration errors caught before service initialization
 * 3. **Testability**: Easy dependency injection via `with*` methods
 * 4. **Clarity**: Self-documenting configuration with method names
 * 5. **Flexibility**: Mix fluent API with bulk configuration as needed
 * 
 * ### Gradual Migration
 * 
 * You can migrate gradually by using `withConfig()` with existing SpiderConfig objects:
 * 
 * ```typescript
 * // Step 1: Use existing config with builder
 * const spider = new SpiderBuilder()
 *   .withConfig(existingConfig)
 *   .build();
 * 
 * // Step 2: Gradually replace with fluent API
 * const spider = new SpiderBuilder()
 *   .withConfig(existingConfig)
 *   .withMaxDepth(100) // Override specific options
 *   .build();
 * 
 * // Step 3: Full fluent API
 * const spider = new SpiderBuilder()
 *   .withRootDir(existingConfig.rootDir)
 *   .withMaxDepth(100)
 *   .withReverseIndex(true)
 *   .build();
 * ```
 * 
 * ## Error Handling
 * 
 * @example Validation errors
 * ```typescript
 * try {
 *   const spider = new SpiderBuilder()
 *     // Missing rootDir
 *     .withMaxDepth(50)
 *     .build();
 * } catch (error) {
 *   console.error(error.message); // "rootDir is required"
 * }
 * 
 * try {
 *   const spider = new SpiderBuilder()
 *     .withRootDir('/path/to/project')
 *     .withMaxDepth(-10) // Invalid value
 *     .build();
 * } catch (error) {
 *   console.error(error.message); // "maxDepth must be non-negative"
 * }
 * ```
 * 
 * @see {@link Spider} for the main analyzer class
 * @see {@link SpiderConfig} for configuration options
 */
export class SpiderBuilder {
  // Configuration state
  private rootDir?: string;
  private tsConfigPath?: string;
  private extensionPath?: string;
  private maxDepth: number = 50;
  private excludeNodeModules: boolean = true;
  private enableReverseIndex: boolean = false;
  private indexingConcurrency: number = 4;
  private maxCacheSize: number = 500;
  private maxSymbolCacheSize: number = 200;
  private maxSymbolAnalyzerFiles: number = 100;
  private indexingProgressInterval?: number;

  // Service overrides (for testing)
  private customCache?: Cache<Dependency[]>;
  private customSymbolCache?: Cache<{ symbols: SymbolInfo[]; dependencies: SymbolDependency[] }>;
  private customLanguageService?: LanguageService;
  private customPathResolver?: PathResolver;
  private customAstWorkerHost?: AstWorkerHost;
  private customReverseIndexManager?: ReverseIndexManager;

  /**
   * Set the root directory (required).
   * 
   * This is the only required configuration option. All file paths will be resolved relative to this directory.
   * 
   * @param rootDir - Absolute path to the project root directory
   * @returns This builder instance for method chaining
   * 
   * @example
   * ```typescript
   * const spider = new SpiderBuilder()
   *   .withRootDir('/path/to/project')
   *   .build();
   * ```
   */
  withRootDir(rootDir: string): this {
    this.rootDir = rootDir;
    return this;
  }

  /**
   * Set the TypeScript config path (optional).
   * 
   * If provided, Spider will use this tsconfig.json for module resolution and path mapping.
   * If not provided, Spider will attempt to find tsconfig.json in the root directory.
   * 
   * @param tsConfigPath - Path to tsconfig.json (absolute or relative to rootDir)
   * @returns This builder instance for method chaining
   * 
   * @example
   * ```typescript
   * const spider = new SpiderBuilder()
   *   .withRootDir('/path/to/project')
   *   .withTsConfigPath('./tsconfig.json')
   *   .build();
   * ```
   */
  withTsConfigPath(tsConfigPath: string): this {
    this.tsConfigPath = tsConfigPath;
    return this;
  }

  /**
   * Set the extension path (optional, required for WASM parsers).
   * 
   * The extension path is used to locate WASM files for Python and Rust parsers.
   * This should be the VS Code extension's installation directory (context.extensionPath).
   * 
   * @param extensionPath - Absolute path to the extension directory
   * @returns This builder instance for method chaining
   * 
   * @example
   * ```typescript
   * const spider = new SpiderBuilder()
   *   .withRootDir('/path/to/project')
   *   .withExtensionPath(context.extensionPath)
   *   .build();
   * ```
   */
  withExtensionPath(extensionPath: string): this {
    this.extensionPath = extensionPath;
    return this;
  }

  /**
   * Set maximum crawl depth (default: 50).
   * 
   * Controls how deep the dependency graph traversal will go. Higher values allow deeper analysis
   * but may impact performance on large projects.
   * 
   * @param maxDepth - Maximum depth for graph traversal (must be non-negative)
   * @returns This builder instance for method chaining
   * 
   * @example
   * ```typescript
   * const spider = new SpiderBuilder()
   *   .withRootDir('/path/to/project')
   *   .withMaxDepth(100) // Allow deeper traversal
   *   .build();
   * ```
   */
  withMaxDepth(maxDepth: number): this {
    this.maxDepth = maxDepth;
    return this;
  }

  /**
   * Set whether to exclude node_modules (default: true).
   * 
   * When true, files in node_modules directories are excluded from analysis.
   * Set to false if you need to analyze dependencies within node_modules.
   * 
   * @param exclude - Whether to exclude node_modules from analysis
   * @returns This builder instance for method chaining
   * 
   * @example
   * ```typescript
   * const spider = new SpiderBuilder()
   *   .withRootDir('/path/to/project')
   *   .withExcludeNodeModules(false) // Include node_modules
   *   .build();
   * ```
   */
  withExcludeNodeModules(exclude: boolean): this {
    this.excludeNodeModules = exclude;
    return this;
  }

  /**
   * Enable or disable reverse index (default: false).
   * 
   * When enabled, Spider maintains an O(1) reverse index for finding files that reference a target file.
   * This enables fast "find references" operations but uses additional memory.
   * 
   * @param enabled - Whether to enable reverse index
   * @returns This builder instance for method chaining
   * 
   * @example
   * ```typescript
   * const spider = new SpiderBuilder()
   *   .withRootDir('/path/to/project')
   *   .withReverseIndex(true) // Enable fast reverse lookups
   *   .build();
   * 
   * // Find all files that import 'utils.ts'
   * const refs = await spider.findReferencingFiles('src/utils.ts');
   * ```
   */
  withReverseIndex(enabled: boolean): this {
    this.enableReverseIndex = enabled;
    return this;
  }

  /**
   * Set indexing concurrency (default: 4).
   * 
   * Controls how many files are analyzed in parallel during background indexing.
   * Higher values improve indexing speed but use more CPU and memory.
   * 
   * @param concurrency - Number of parallel workers (must be at least 1)
   * @returns This builder instance for method chaining
   * 
   * @example
   * ```typescript
   * const spider = new SpiderBuilder()
   *   .withRootDir('/path/to/project')
   *   .withIndexingConcurrency(8) // Use 8 parallel workers
   *   .build();
   * ```
   */
  withIndexingConcurrency(concurrency: number): this {
    this.indexingConcurrency = concurrency;
    return this;
  }

  /**
   * Set cache configuration.
   * 
   * Controls the size of various caches used by Spider. Larger caches improve performance
   * but use more memory. Adjust based on your project size and available resources.
   * 
   * @param config - Cache configuration options
   * @param config.maxCacheSize - Dependency cache size (default: 500)
   * @param config.maxSymbolCacheSize - Symbol cache size (default: 200)
   * @param config.maxSymbolAnalyzerFiles - Symbol analyzer file limit (default: 100)
   * @returns This builder instance for method chaining
   * 
   * @example High-performance caching
   * ```typescript
   * const spider = new SpiderBuilder()
   *   .withRootDir('/path/to/project')
   *   .withCacheConfig({
   *     maxCacheSize: 2000,
   *     maxSymbolCacheSize: 1000,
   *     maxSymbolAnalyzerFiles: 500
   *   })
   *   .build();
   * ```
   * 
   * @example Low-memory caching
   * ```typescript
   * const spider = new SpiderBuilder()
   *   .withRootDir('/path/to/project')
   *   .withCacheConfig({
   *     maxCacheSize: 100,
   *     maxSymbolCacheSize: 50,
   *     maxSymbolAnalyzerFiles: 25
   *   })
   *   .build();
   * ```
   */
  withCacheConfig(config: {
    maxCacheSize?: number;
    maxSymbolCacheSize?: number;
    maxSymbolAnalyzerFiles?: number;
  }): this {
    if (config.maxCacheSize !== undefined) {
      this.maxCacheSize = config.maxCacheSize;
    }
    if (config.maxSymbolCacheSize !== undefined) {
      this.maxSymbolCacheSize = config.maxSymbolCacheSize;
    }
    if (config.maxSymbolAnalyzerFiles !== undefined) {
      this.maxSymbolAnalyzerFiles = config.maxSymbolAnalyzerFiles;
    }
    return this;
  }

  /**
   * Set indexing progress interval (optional).
   * 
   * Controls how often progress callbacks are invoked during indexing operations.
   * Lower values provide more frequent updates but may impact performance.
   * 
   * @param interval - Progress callback interval in milliseconds
   * @returns This builder instance for method chaining
   * 
   * @example
   * ```typescript
   * const spider = new SpiderBuilder()
   *   .withRootDir('/path/to/project')
   *   .withIndexingProgressInterval(100) // Update every 100ms
   *   .build();
   * ```
   */
  withIndexingProgressInterval(interval: number): this {
    this.indexingProgressInterval = interval;
    return this;
  }

  /**
   * Bulk configuration from SpiderConfig.
   * 
   * Allows setting multiple configuration options at once from a SpiderConfig object.
   * Individual options can still be overridden by calling specific `with*` methods after this.
   * 
   * @param config - SpiderConfig object with configuration options
   * @returns This builder instance for method chaining
   * 
   * @example
   * ```typescript
   * const config: SpiderConfig = {
   *   rootDir: '/path/to/project',
   *   maxDepth: 50,
   *   enableReverseIndex: true
   * };
   * 
   * const spider = new SpiderBuilder()
   *   .withConfig(config)
   *   .build();
   * ```
   * 
   * @example Override specific options
   * ```typescript
   * const spider = new SpiderBuilder()
   *   .withConfig(baseConfig)
   *   .withMaxDepth(100) // Override maxDepth from config
   *   .build();
   * ```
   */
  withConfig(config: SpiderConfig): this {
    this.rootDir = config.rootDir;
    if (config.tsConfigPath !== undefined) {
      this.tsConfigPath = config.tsConfigPath;
    }
    if (config.extensionPath !== undefined) {
      this.extensionPath = config.extensionPath;
    }
    if (config.maxDepth !== undefined) {
      this.maxDepth = config.maxDepth;
    }
    if (config.excludeNodeModules !== undefined) {
      this.excludeNodeModules = config.excludeNodeModules;
    }
    if (config.enableReverseIndex !== undefined) {
      this.enableReverseIndex = config.enableReverseIndex;
    }
    if (config.indexingConcurrency !== undefined) {
      this.indexingConcurrency = config.indexingConcurrency;
    }
    if (config.maxCacheSize !== undefined) {
      this.maxCacheSize = config.maxCacheSize;
    }
    if (config.maxSymbolCacheSize !== undefined) {
      this.maxSymbolCacheSize = config.maxSymbolCacheSize;
    }
    if (config.maxSymbolAnalyzerFiles !== undefined) {
      this.maxSymbolAnalyzerFiles = config.maxSymbolAnalyzerFiles;
    }
    if (config.indexingProgressInterval !== undefined) {
      this.indexingProgressInterval = config.indexingProgressInterval;
    }
    return this;
  }

  /**
   * Override cache for testing.
   * 
   * Allows injecting a custom cache instance for testing purposes. The provided cache
   * will be used instead of creating a new one during Spider initialization.
   * 
   * @param cache - Custom cache instance for dependency analysis results
   * @returns This builder instance for method chaining
   * 
   * @example
   * ```typescript
   * const mockCache = new Cache({ maxSize: 10 });
   * 
   * const spider = new SpiderBuilder()
   *   .withRootDir('/test/project')
   *   .withCache(mockCache)
   *   .build();
   * 
   * // Verify cache usage in tests
   * await spider.analyze('test.ts');
   * expect(mockCache.getStats().misses).toBe(1);
   * ```
   */
  withCache(cache: Cache<Dependency[]>): this {
    this.customCache = cache;
    return this;
  }

  /**
   * Override symbol cache for testing.
   * 
   * Allows injecting a custom symbol cache instance for testing purposes.
   * 
   * @param cache - Custom cache instance for symbol analysis results
   * @returns This builder instance for method chaining
   * 
   * @example
   * ```typescript
   * const mockSymbolCache = new Cache({ maxSize: 10 });
   * 
   * const spider = new SpiderBuilder()
   *   .withRootDir('/test/project')
   *   .withSymbolCache(mockSymbolCache)
   *   .build();
   * ```
   */
  withSymbolCache(cache: Cache<{ symbols: SymbolInfo[]; dependencies: SymbolDependency[] }>): this {
    this.customSymbolCache = cache;
    return this;
  }

  /**
   * Override language service for testing.
   * 
   * Allows injecting a custom language service instance for testing purposes.
   * Useful for mocking language detection and TypeScript analysis.
   * 
   * @param service - Custom language service instance
   * @returns This builder instance for method chaining
   * 
   * @example
   * ```typescript
   * const mockLanguageService = {
   *   getLanguage: vi.fn().mockReturnValue('typescript'),
   *   // ... other methods
   * };
   * 
   * const spider = new SpiderBuilder()
   *   .withRootDir('/test/project')
   *   .withLanguageService(mockLanguageService)
   *   .build();
   * ```
   */
  withLanguageService(service: LanguageService): this {
    this.customLanguageService = service;
    return this;
  }

  /**
   * Override path resolver for testing.
   * 
   * Allows injecting a custom path resolver instance for testing purposes.
   * Useful for mocking module resolution behavior.
   * 
   * @param resolver - Custom path resolver instance
   * @returns This builder instance for method chaining
   * 
   * @example
   * ```typescript
   * const mockResolver = {
   *   resolve: vi.fn().mockResolvedValue('/resolved/path.ts'),
   *   // ... other methods
   * };
   * 
   * const spider = new SpiderBuilder()
   *   .withRootDir('/test/project')
   *   .withPathResolver(mockResolver)
   *   .build();
   * ```
   */
  withPathResolver(resolver: PathResolver): this {
    this.customPathResolver = resolver;
    return this;
  }

  /**
   * Override AST worker host for testing.
   * 
   * Allows injecting a custom AST worker host instance for testing purposes.
   * Useful for mocking ts-morph operations.
   * 
   * @param host - Custom AST worker host instance
   * @returns This builder instance for method chaining
   * 
   * @example
   * ```typescript
   * const mockAstWorkerHost = {
   *   getSymbols: vi.fn().mockResolvedValue([]),
   *   // ... other methods
   * };
   * 
   * const spider = new SpiderBuilder()
   *   .withRootDir('/test/project')
   *   .withAstWorkerHost(mockAstWorkerHost)
   *   .build();
   * ```
   */
  withAstWorkerHost(host: AstWorkerHost): this {
    this.customAstWorkerHost = host;
    return this;
  }

  /**
   * Override reverse index manager for testing.
   * 
   * Allows injecting a custom reverse index manager instance for testing purposes.
   * Useful for mocking reverse dependency lookups.
   * 
   * @param manager - Custom reverse index manager instance
   * @returns This builder instance for method chaining
   * 
   * @example
   * ```typescript
   * const mockReverseIndexManager = {
   *   getCallerCount: vi.fn().mockReturnValue(5),
   *   // ... other methods
   * };
   * 
   * const spider = new SpiderBuilder()
   *   .withRootDir('/test/project')
   *   .withReverseIndexManager(mockReverseIndexManager)
   *   .build();
   * ```
   */
  withReverseIndexManager(manager: ReverseIndexManager): this {
    this.customReverseIndexManager = manager;
    return this;
  }

  /**
   * Build and return the Spider instance.
   * 
   * Validates configuration, initializes all services in the correct dependency order,
   * and constructs a fully initialized Spider instance.
   * 
   * @returns Fully initialized Spider instance
   * @throws Error if required configuration is missing (rootDir)
   * @throws Error if configuration values are invalid (negative depths, etc.)
   * 
   * @example
   * ```typescript
   * const spider = new SpiderBuilder()
   *   .withRootDir('/path/to/project')
   *   .withMaxDepth(50)
   *   .build();
   * 
   * // Spider is ready to use
   * const deps = await spider.analyze('src/index.ts');
   * ```
   */
  build(): Spider {
    // Validate configuration
    this.validate();

    // Initialize services in dependency order
    const services = this.initializeServices();

    // Construct Spider with initialized services
    return new Spider(services);
  }

  /**
   * Initialize all services in correct dependency order
   * @private
   */
  private initializeServices(): SpiderServices {
    // Build configuration object
    const config = this.buildConfig();

    // Phase 1: Core services (no dependencies)
    const languageService = this.customLanguageService ?? 
      new LanguageService(this.rootDir!, this.tsConfigPath, this.extensionPath);
    
    const resolver = this.customPathResolver ?? 
      new PathResolver(this.tsConfigPath, this.excludeNodeModules, this.rootDir!);
    
    const cache = this.customCache ?? 
      new Cache<Dependency[]>({ maxSize: this.maxCacheSize, enableLRU: true });
    
    const symbolCache = this.customSymbolCache ?? 
      new Cache<{ symbols: SymbolInfo[]; dependencies: SymbolDependency[] }>({ 
        maxSize: this.maxSymbolCacheSize, 
        enableLRU: true 
      });
    
    const astWorkerHost = this.customAstWorkerHost ?? new AstWorkerHost(undefined, this.extensionPath);
    
    const reverseIndexManager = this.customReverseIndexManager ?? 
      new ReverseIndexManager(this.rootDir!);
    
    const fileReader = new FileReader();
    const indexerStatus = new IndexerStatus();
    const cancellation = new SpiderIndexingCancellation();

    // Phase 2: Dependency services
    const workerManager = new SpiderWorkerManager(indexerStatus, reverseIndexManager, cache);
    
    const dependencyAnalyzer = new SpiderDependencyAnalyzer(
      languageService,
      resolver,
      cache,
      reverseIndexManager
    );
    
    const sourceFileCollector = new SourceFileCollector({
      excludeNodeModules: this.excludeNodeModules,
      yieldIntervalMs: YIELD_INTERVAL_MS,
      yieldCallback: () => yieldToEventLoop(),
      isCancelled: () => cancellation.isCancelled(),
    });

    // Phase 3: Lookup services (handle circular dependency)
    const referenceLookup = new SpiderReferenceLookup(
      reverseIndexManager,
      dependencyAnalyzer,
      fileReader
    );
    
    const referencingFilesFinder = new ReferencingFilesFinder({
      sourceFileCollector,
      getRootDir: () => this.rootDir!,
      getConcurrency: () => this.indexingConcurrency,
      findReferenceInFile: (filePath, normalizedTargetPath, targetBasename) =>
        referenceLookup.findReferenceInFile(filePath, normalizedTargetPath, targetBasename),
    });
    
    // Wire circular dependency
    referenceLookup.setFallbackFinder(referencingFilesFinder);

    // Phase 4: Analysis services
    const symbolDependencyHelper = new SymbolDependencyHelper({
      resolve: async (from, to) => {
        try {
          return await resolver.resolve(from, to);
        } catch {
          return null;
        }
      },
    });
    
    const symbolService = new SpiderSymbolService(
      astWorkerHost,
      symbolCache,
      fileReader,
      resolver,
      symbolDependencyHelper,
      () => config,
      (targetPath) => referenceLookup.findReferencingFiles(targetPath),
      languageService
    );
    
    const graphCrawler = new SpiderGraphCrawler(dependencyAnalyzer, () => config);
    
    const indexingService = new SpiderIndexingService(
      dependencyAnalyzer,
      cache,
      reverseIndexManager,
      sourceFileCollector,
      indexerStatus,
      workerManager,
      cancellation,
      () => config,
      () => yieldToEventLoop(),
      (filePath) => symbolService.getSymbolGraph(filePath)
    );

    // Phase 5: Coordinator
    const cacheCoordinator = new SpiderCacheCoordinator(cache, symbolCache, reverseIndexManager);

    // Enable reverse index if configured
    if (this.enableReverseIndex) {
      reverseIndexManager.enable();
    }

    return {
      config,
      languageService,
      resolver,
      cache,
      symbolCache,
      fileReader,
      astWorkerHost,
      reverseIndexManager,
      indexerStatus,
      workerManager,
      cancellation,
      sourceFileCollector,
      referencingFilesFinder,
      symbolDependencyHelper,
      dependencyAnalyzer,
      referenceLookup,
      symbolService,
      graphCrawler,
      indexingService,
      cacheCoordinator,
    };
  }

  /**
   * Validate configuration before building
   * @private
   */
  private validate(): void {
    if (!this.rootDir) {
      throw new Error('rootDir is required');
    }
    if (this.maxDepth < 0) {
      throw new Error('maxDepth must be non-negative');
    }
    if (this.indexingConcurrency < 1) {
      throw new Error('indexingConcurrency must be at least 1');
    }
    if (this.maxCacheSize < 0) {
      throw new Error('maxCacheSize must be non-negative');
    }
    if (this.maxSymbolCacheSize < 0) {
      throw new Error('maxSymbolCacheSize must be non-negative');
    }
    if (this.maxSymbolAnalyzerFiles < 0) {
      throw new Error('maxSymbolAnalyzerFiles must be non-negative');
    }
  }

  /**
   * Build SpiderConfig from current state
   * @private
   */
  private buildConfig(): SpiderConfig {
    return {
      rootDir: this.rootDir!,
      tsConfigPath: this.tsConfigPath,
      extensionPath: this.extensionPath,
      maxDepth: this.maxDepth,
      excludeNodeModules: this.excludeNodeModules,
      enableReverseIndex: this.enableReverseIndex,
      indexingConcurrency: this.indexingConcurrency,
      maxCacheSize: this.maxCacheSize,
      maxSymbolCacheSize: this.maxSymbolCacheSize,
      maxSymbolAnalyzerFiles: this.maxSymbolAnalyzerFiles,
      indexingProgressInterval: this.indexingProgressInterval,
    };
  }
}
