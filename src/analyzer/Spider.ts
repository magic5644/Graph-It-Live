import { AstWorkerHost } from './ast/AstWorkerHost';
import { Cache } from './Cache';
import { FileReader } from './FileReader';
import { IndexerStatus, type IndexerStatusSnapshot } from './IndexerStatus';
import { LanguageService } from './LanguageService';
import { ReferencingFilesFinder } from './ReferencingFilesFinder';
import { ReverseIndexManager } from './ReverseIndexManager';
import { SourceFileCollector } from './SourceFileCollector';
import { SpiderCacheCoordinator } from './spider/SpiderCacheCoordinator';
import { SpiderDependencyAnalyzer } from './spider/SpiderDependencyAnalyzer';
import { SpiderGraphCrawler } from './spider/SpiderGraphCrawler';
import { SpiderIndexingCancellation } from './spider/SpiderIndexingCancellation';
import { SpiderIndexingService } from './spider/SpiderIndexingService';
import { SpiderReferenceLookup } from './spider/SpiderReferenceLookup';
import { SpiderSymbolService } from './spider/SpiderSymbolService';
import { SpiderWorkerManager } from './spider/SpiderWorkerManager';
import { SymbolDependencyHelper } from './SymbolDependencyHelper';
import type { Dependency, IndexingProgressCallback, SpiderConfig } from './types';
import { YIELD_INTERVAL_MS, yieldToEventLoop } from './utils/EventLoopYield';
import { PathResolver } from './utils/PathResolver';

/**
 * Internal interface defining all services required by Spider.
 * This interface is used by SpiderBuilder to pass fully initialized services to Spider's constructor.
 * 
 * @internal
 */
export interface SpiderServices {
  /** Spider configuration object */
  config: SpiderConfig;
  
  /** Language service for TypeScript/JavaScript analysis */
  languageService: LanguageService;
  
  /** Path resolver for module resolution */
  resolver: PathResolver;
  
  /** Cache for dependency analysis results */
  cache: Cache<Dependency[]>;
  
  /** Cache for symbol analysis results */
  symbolCache: Cache<{
    symbols: import('./types').SymbolInfo[];
    dependencies: import('./types').SymbolDependency[];
  }>;
  
  /** File reader utility */
  fileReader: FileReader;
  
  /** AST worker host for isolated ts-morph operations */
  astWorkerHost: AstWorkerHost;
  
  /** Reverse index manager for O(1) reverse dependency lookups */
  reverseIndexManager: ReverseIndexManager;
  
  /** Indexer status tracker */
  indexerStatus: IndexerStatus;
  
  /** Worker manager for background indexing */
  workerManager: SpiderWorkerManager;
  
  /** Cancellation token for indexing operations */
  cancellation: SpiderIndexingCancellation;
  
  /** Source file collector for finding project files */
  sourceFileCollector: SourceFileCollector;
  
  /** Finder for files that reference a target file */
  referencingFilesFinder: ReferencingFilesFinder;
  
  /** Helper for resolving symbol dependencies */
  symbolDependencyHelper: SymbolDependencyHelper;
  
  /** Core dependency analyzer */
  dependencyAnalyzer: SpiderDependencyAnalyzer;
  
  /** Reference lookup service (handles circular dependency with referencingFilesFinder) */
  referenceLookup: SpiderReferenceLookup;
  
  /** Symbol analysis service */
  symbolService: SpiderSymbolService;
  
  /** Graph crawler for dependency graph traversal */
  graphCrawler: SpiderGraphCrawler;
  
  /** Indexing service for background analysis */
  indexingService: SpiderIndexingService;
  
  /** Cache coordinator for managing all caches */
  cacheCoordinator: SpiderCacheCoordinator;
}

/**
 * Main analyzer class - "The Spider"
 *
 * This class is a thin facade that composes multiple single-responsibility services
 * for dependency analysis, symbol extraction, and graph traversal.
 *
 * **IMPORTANT:** Use {@link SpiderBuilder} to construct Spider instances. The builder provides
 * a fluent, type-safe API for configuration and handles complex service initialization automatically.
 *
 * @example Basic usage with SpiderBuilder
 * ```typescript
 * import { SpiderBuilder } from './SpiderBuilder';
 * 
 * const spider = new SpiderBuilder()
 *   .withRootDir('/path/to/project')
 *   .withMaxDepth(50)
 *   .withReverseIndex(true)
 *   .build();
 * 
 * // Analyze a file
 * const deps = await spider.analyze('src/index.ts');
 * 
 * // Crawl dependency graph
 * const graph = await spider.crawl('src/index.ts');
 * 
 * // Clean up
 * await spider.dispose();
 * ```
 *
 * @example Advanced configuration
 * ```typescript
 * const spider = new SpiderBuilder()
 *   .withRootDir('/path/to/project')
 *   .withTsConfigPath('./tsconfig.json')
 *   .withMaxDepth(100)
 *   .withExcludeNodeModules(true)
 *   .withReverseIndex(true)
 *   .withIndexingConcurrency(8)
 *   .withCacheConfig({
 *     maxCacheSize: 1000,
 *     maxSymbolCacheSize: 500,
 *     maxSymbolAnalyzerFiles: 200
 *   })
 *   .build();
 * ```
 *
 * @example Testing with custom services
 * ```typescript
 * const mockCache = new Cache({ maxSize: 10 });
 * const mockLanguageService = createMockLanguageService();
 * 
 * const spider = new SpiderBuilder()
 *   .withRootDir('/test/project')
 *   .withCache(mockCache)
 *   .withLanguageService(mockLanguageService)
 *   .build();
 * ```
 *
 * @example Symbol-level analysis
 * ```typescript
 * const spider = new SpiderBuilder()
 *   .withRootDir('/path/to/project')
 *   .build();
 * 
 * // Get symbol graph for a file
 * const { symbols, dependencies } = await spider.getSymbolGraph('src/utils.ts');
 * 
 * // Find unused symbols
 * const unused = await spider.findUnusedSymbols('src/utils.ts');
 * 
 * // Trace function execution
 * const trace = await spider.traceFunctionExecution('src/app.ts', 'handleRequest', 10);
 * ```
 *
 * @example Background indexing
 * ```typescript
 * const spider = new SpiderBuilder()
 *   .withRootDir('/path/to/project')
 *   .withReverseIndex(true)
 *   .withIndexingConcurrency(4)
 *   .build();
 * 
 * // Build full index with progress callback
 * const result = await spider.buildFullIndex((progress) => {
 *   console.log(`Indexed ${progress.completed}/${progress.total} files`);
 * });
 * 
 * console.log(`Indexed ${result.indexedFiles} files in ${result.duration}ms`);
 * ```
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 * Only Node.js built-in modules (fs, path) are permitted (indirectly via services).
 *
 * @see {@link SpiderBuilder} for the recommended way to construct Spider instances
 */
export class Spider {
  private readonly config: SpiderConfig;

  private readonly languageService: LanguageService;
  private readonly resolver: PathResolver;

  // Kept as `cache` for backward compatibility (some tests/tools access it dynamically).
  private readonly cache: Cache<Dependency[]>;
  private readonly symbolCache: Cache<{
    symbols: import('./types').SymbolInfo[];
    dependencies: import('./types').SymbolDependency[];
  }>;
  private readonly fileReader: FileReader;
  private readonly astWorkerHost: AstWorkerHost;

  private readonly reverseIndexManager: ReverseIndexManager;
  private readonly indexerStatus: IndexerStatus;
  private readonly workerManager: SpiderWorkerManager;
  private readonly cancellation: SpiderIndexingCancellation;

  private readonly sourceFileCollector: SourceFileCollector;
  private readonly referencingFilesFinder: ReferencingFilesFinder;
  private readonly symbolDependencyHelper: SymbolDependencyHelper;

  private readonly dependencyAnalyzer: SpiderDependencyAnalyzer;
  private readonly referenceLookup: SpiderReferenceLookup;
  private readonly symbolService: SpiderSymbolService;
  private readonly graphCrawler: SpiderGraphCrawler;
  private readonly indexingService: SpiderIndexingService;
  private readonly cacheCoordinator: SpiderCacheCoordinator;

  /**
   * Construct a Spider instance.
   * 
   * **IMPORTANT:** This constructor is internal and should not be called directly.
   * Use {@link SpiderBuilder} instead for a fluent, type-safe configuration API.
   * 
   * @internal
   * 
   * @example Recommended approach (use SpiderBuilder)
   * ```typescript
   * import { SpiderBuilder } from './SpiderBuilder';
   * 
   * const spider = new SpiderBuilder()
   *   .withRootDir('/path/to/project')
   *   .withMaxDepth(50)
   *   .withReverseIndex(true)
   *   .build();
   * ```
   * 
   * @example Legacy approach (backward compatibility only)
   * ```typescript
   * // Direct construction is supported for backward compatibility
   * // but SpiderBuilder is strongly recommended for new code
   * const spider = new Spider({
   *   rootDir: '/path/to/project',
   *   maxDepth: 50,
   *   enableReverseIndex: true
   * });
   * ```
   * 
   * @param configOrServices - Either a SpiderConfig (legacy) or fully initialized SpiderServices (used by SpiderBuilder)
   */
  constructor(configOrServices: SpiderConfig | SpiderServices) {
    // Check if we received SpiderServices (has dependencyAnalyzer property) or SpiderConfig
    if ('dependencyAnalyzer' in configOrServices) {
      // SpiderServices path (used by SpiderBuilder)
      const services = configOrServices;
      this.config = services.config;
      this.languageService = services.languageService;
      this.resolver = services.resolver;
      this.cache = services.cache;
      this.symbolCache = services.symbolCache;
      this.fileReader = services.fileReader;
      this.astWorkerHost = services.astWorkerHost;
      this.reverseIndexManager = services.reverseIndexManager;
      this.indexerStatus = services.indexerStatus;
      this.workerManager = services.workerManager;
      this.cancellation = services.cancellation;
      this.sourceFileCollector = services.sourceFileCollector;
      this.referencingFilesFinder = services.referencingFilesFinder;
      this.symbolDependencyHelper = services.symbolDependencyHelper;
      this.dependencyAnalyzer = services.dependencyAnalyzer;
      this.referenceLookup = services.referenceLookup;
      this.symbolService = services.symbolService;
      this.graphCrawler = services.graphCrawler;
      this.indexingService = services.indexingService;
      this.cacheCoordinator = services.cacheCoordinator;
    } else {
      // SpiderConfig path (backward compatibility - initialize services inline)
      const config = configOrServices;
      
      // Apply defaults
      this.config = {
        maxDepth: 50,
        excludeNodeModules: true,
        enableReverseIndex: false,
        indexingConcurrency: 4,
        maxCacheSize: 500,
        maxSymbolCacheSize: 200,
        maxSymbolAnalyzerFiles: 100,
        ...config,
      };

      // Initialize services in dependency order
      this.languageService = new LanguageService(
        config.rootDir,
        config.tsConfigPath,
        config.extensionPath
      );
      this.resolver = new PathResolver(config.tsConfigPath, this.config.excludeNodeModules, config.rootDir);
      this.cache = new Cache({ maxSize: this.config.maxCacheSize, enableLRU: true });
      this.symbolCache = new Cache({ maxSize: this.config.maxSymbolCacheSize, enableLRU: true });
      this.astWorkerHost = new AstWorkerHost(undefined, config.extensionPath);
      this.reverseIndexManager = new ReverseIndexManager(this.config.rootDir);
      this.fileReader = new FileReader();
      this.indexerStatus = new IndexerStatus();
      this.cancellation = new SpiderIndexingCancellation();

      this.workerManager = new SpiderWorkerManager(this.indexerStatus, this.reverseIndexManager, this.cache);
      this.dependencyAnalyzer = new SpiderDependencyAnalyzer(
        this.languageService,
        this.resolver,
        this.cache,
        this.reverseIndexManager
      );
      this.sourceFileCollector = new SourceFileCollector({
        excludeNodeModules: this.config.excludeNodeModules ?? true,
        yieldIntervalMs: YIELD_INTERVAL_MS,
        yieldCallback: () => yieldToEventLoop(),
        isCancelled: () => this.cancellation.isCancelled(),
      });

      this.referenceLookup = new SpiderReferenceLookup(this.reverseIndexManager, this.dependencyAnalyzer, this.fileReader);
      this.referencingFilesFinder = new ReferencingFilesFinder({
        sourceFileCollector: this.sourceFileCollector,
        getRootDir: () => this.config.rootDir,
        getConcurrency: () => this.config.indexingConcurrency,
        findReferenceInFile: (filePath, normalizedTargetPath, targetBasename) =>
          this.referenceLookup.findReferenceInFile(filePath, normalizedTargetPath, targetBasename),
      });
      this.referenceLookup.setFallbackFinder(this.referencingFilesFinder);

      this.symbolDependencyHelper = new SymbolDependencyHelper({
        resolve: async (from, to) => {
          try {
            return await this.resolver.resolve(from, to);
          } catch {
            return null;
          }
        },
      });

      this.symbolService = new SpiderSymbolService(
        this.astWorkerHost,
        this.symbolCache,
        this.fileReader,
        this.resolver,
        this.symbolDependencyHelper,
        () => this.config,
        (targetPath) => this.findReferencingFiles(targetPath),
        this.languageService
      );

      this.graphCrawler = new SpiderGraphCrawler(this.dependencyAnalyzer, () => this.config);

      this.indexingService = new SpiderIndexingService(
        this.dependencyAnalyzer,
        this.cache,
        this.reverseIndexManager,
        this.sourceFileCollector,
        this.indexerStatus,
        this.workerManager,
        this.cancellation,
        () => this.config,
        () => yieldToEventLoop(),
        (filePath) => this.symbolService.getSymbolGraph(filePath)
      );

      this.cacheCoordinator = new SpiderCacheCoordinator(this.cache, this.symbolCache, this.reverseIndexManager);

      if (config.enableReverseIndex) {
        this.enableReverseIndex();
      }
    }
  }

  /**
   * Stop the Spider and clean up resources
   */
  async dispose(): Promise<void> {
    await this.astWorkerHost.stop();
  }

  updateConfig(config: Partial<SpiderConfig>) {
    this.config.excludeNodeModules = config.excludeNodeModules ?? this.config.excludeNodeModules;
    this.config.maxDepth = config.maxDepth ?? this.config.maxDepth;

    if (config.excludeNodeModules !== undefined) {
      this.resolver.updateConfig(config.excludeNodeModules);
      this.sourceFileCollector.updateOptions({ excludeNodeModules: config.excludeNodeModules });
    }

    if (config.enableReverseIndex !== undefined) {
      this.config.enableReverseIndex = config.enableReverseIndex;
      if (config.enableReverseIndex) {
        this.reverseIndexManager.enable();
      } else {
        this.reverseIndexManager.disable();
      }
    }

    if (config.indexingConcurrency !== undefined) {
      this.config.indexingConcurrency = config.indexingConcurrency;
    }

    this.clearCache();
  }

  async analyze(filePath: string): Promise<Dependency[]> {
    return this.dependencyAnalyzer.analyze(filePath);
  }

  clearCache(): void {
    this.cacheCoordinator.clearAll();
  }

  invalidateFile(filePath: string): boolean {
    return this.cacheCoordinator.invalidateFile(filePath);
  }

  invalidateFiles(filePaths: string[]): number {
    return this.cacheCoordinator.invalidateFiles(filePaths);
  }

  async reanalyzeFile(filePath: string): Promise<Dependency[] | null> {
    this.invalidateFile(filePath);
    try {
      return await this.analyze(filePath);
    } catch {
      return null;
    }
  }

  handleFileDeleted(filePath: string): void {
    this.cacheCoordinator.handleFileDeleted(filePath);
  }

  enableReverseIndex(serializedData?: string): boolean {
    const restored = this.reverseIndexManager.enable(serializedData);
    this.config.enableReverseIndex = true;
    return restored;
  }

  disableReverseIndex(): void {
    this.config.enableReverseIndex = false;
    this.reverseIndexManager.disable();
  }

  getSerializedReverseIndex(): string | null {
    return this.reverseIndexManager.getSerialized();
  }

  async validateReverseIndex(staleThreshold = 0.2): Promise<{
    isValid: boolean;
    staleFiles: string[];
    stalePercentage: number;
    missingFiles: string[];
  } | null> {
    return this.reverseIndexManager.validate(staleThreshold);
  }

  getIndexStatus(): IndexerStatusSnapshot {
    return this.indexerStatus.getSnapshot();
  }

  subscribeToIndexStatus(callback: (snapshot: IndexerStatusSnapshot) => void): () => void {
    return this.indexerStatus.subscribe(callback);
  }

  hasReverseIndex(): boolean {
    return this.reverseIndexManager.hasEntries();
  }

  getCallerCount(targetPath: string): number {
    if (!this.reverseIndexManager.hasEntries()) {
      return 0;
    }
    return this.reverseIndexManager.getCallerCount(targetPath);
  }

  cancelIndexing(): void {
    this.indexingService.cancel();
  }

  async buildFullIndex(
    progressCallback?: IndexingProgressCallback
  ): Promise<{ indexedFiles: number; duration: number; cancelled: boolean }> {
    return this.indexingService.buildFullIndex(progressCallback);
  }

  async buildFullIndexInWorker(
    workerPath: string,
    progressCallback?: IndexingProgressCallback
  ): Promise<{ indexedFiles: number; duration: number; cancelled: boolean }> {
    return this.indexingService.buildFullIndexInWorker(workerPath, progressCallback);
  }

  disposeWorker(): void {
    this.indexingService.disposeWorker();
  }

  async reindexStaleFiles(staleFiles: string[], progressCallback?: IndexingProgressCallback): Promise<number> {
    return this.indexingService.reindexStaleFiles(staleFiles, progressCallback);
  }

  async crawl(
    startPath: string
  ): Promise<{ nodes: string[]; edges: { source: string; target: string }[]; nodeLabels?: Record<string, string> }> {
    return this.graphCrawler.crawl(startPath);
  }

  async crawlFrom(
    startNode: string,
    existingNodes: Set<string>,
    extraDepth: number = 10,
    options?: {
      onBatch?: (batch: { nodes: string[]; edges: { source: string; target: string }[]; nodeLabels?: Record<string, string> }) => Promise<void> | void;
      batchSize?: number;
      signal?: AbortSignal;
      totalHint?: number;
    }
  ): Promise<{ nodes: string[]; edges: { source: string; target: string }[]; nodeLabels?: Record<string, string> }> {
    return this.graphCrawler.crawlFrom(startNode, existingNodes, extraDepth, options);
  }

  async findReferencingFiles(targetPath: string): Promise<Dependency[]> {
    return this.referenceLookup.findReferencingFiles(targetPath);
  }

  /**
   * Get files that reference a specific exported symbol
   * @param symbolId Symbol ID in format "filePath:symbolName" (e.g., "src/utils.ts:formatDate")
   * @returns Set of file paths that import/reference the symbol
   */
  getSymbolReferencingFiles(symbolId: string): Set<string> {
    if (!this.reverseIndexManager.hasEntries()) {
      return new Set();
    }
    const files = this.reverseIndexManager.getSymbolReferencingFiles(symbolId);
    return new Set(files);
  }

  async getSymbolGraph(filePath: string): Promise<{
    symbols: import('./types').SymbolInfo[];
    dependencies: import('./types').SymbolDependency[];
  }> {
    return this.symbolService.getSymbolGraph(filePath);
  }

  async resolveModuleSpecifier(fromFilePath: string, moduleSpecifier: string): Promise<string | null> {
    return this.dependencyAnalyzer.resolveModuleSpecifier(fromFilePath, moduleSpecifier);
  }

  async findUnusedSymbols(filePath: string): Promise<import('./types').SymbolInfo[]> {
    return this.symbolService.findUnusedSymbols(filePath);
  }

  async verifyDependencyUsage(sourceFile: string, targetFile: string): Promise<boolean> {
    return this.symbolService.verifyDependencyUsage(sourceFile, targetFile);
  }

  async verifyDependencyUsageBatch(sourceFile: string, targetFiles: string[]): Promise<Map<string, boolean>> {
    return this.symbolService.verifyDependencyUsageBatch(sourceFile, targetFiles);
  }

  async getSymbolDependents(filePath: string, symbolName: string): Promise<import('./types').SymbolDependency[]> {
    return this.symbolService.getSymbolDependents(filePath, symbolName);
  }

  async traceFunctionExecution(
    filePath: string,
    symbolName: string,
    maxDepth: number = 10
  ): Promise<{
    rootSymbol: { id: string; filePath: string; symbolName: string };
    callChain: Array<{
      depth: number;
      callerSymbolId: string;
      calledSymbolId: string;
      calledFilePath: string;
      resolvedFilePath: string | null;
    }>;
    visitedSymbols: string[];
    maxDepthReached: boolean;
  }> {
    return this.symbolService.traceFunctionExecution(filePath, symbolName, maxDepth);
  }

  /**
   * Get cache stats (synchronous, file count may be 0 if worker not queried yet)
   */
  getCacheStats(): {
    dependencyCache: import('./Cache').CacheStats;
    symbolCache: import('./Cache').CacheStats;
    symbolAnalyzerFileCount: number;
    reverseIndexStats?: { indexedFiles: number; targetFiles: number; totalReferences: number };
  } {
    return {
      dependencyCache: this.cache.getStats(),
      symbolCache: this.symbolCache.getStats(),
      symbolAnalyzerFileCount: 0, // Use getCacheStatsAsync() for accurate count
      reverseIndexStats: this.reverseIndexManager.getStats(),
    };
  }

  /**
   * Get cache stats with accurate AST worker file count (async)
   */
  async getCacheStatsAsync(): Promise<{
    dependencyCache: import('./Cache').CacheStats;
    symbolCache: import('./Cache').CacheStats;
    symbolAnalyzerFileCount: number;
    reverseIndexStats?: { indexedFiles: number; targetFiles: number; totalReferences: number };
  }> {
    // Get file count from worker (returns 0 if worker not started yet)
    let fileCount = 0;
    try {
      fileCount = await this.astWorkerHost.getFileCount();
    } catch {
      // Worker not started yet or error - return 0
    }
    
    return {
      dependencyCache: this.cache.getStats(),
      symbolCache: this.symbolCache.getStats(),
      symbolAnalyzerFileCount: fileCount,
      reverseIndexStats: this.reverseIndexManager.getStats(),
    };
  }
}
