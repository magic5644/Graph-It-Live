import { LanguageService } from './LanguageService';
import { PathResolver } from './utils/PathResolver';
import { Cache } from './Cache';
import { ReverseIndexManager } from './ReverseIndexManager';
import { IndexerStatus, type IndexerStatusSnapshot } from './IndexerStatus';
import type { Dependency, IndexingProgressCallback, SpiderConfig } from './types';
import { SourceFileCollector } from './SourceFileCollector';
import { ReferencingFilesFinder } from './ReferencingFilesFinder';
import { SymbolDependencyHelper } from './SymbolDependencyHelper';
import { AstWorkerHost } from './ast/AstWorkerHost';
import { FileReader } from './FileReader';
import { yieldToEventLoop, YIELD_INTERVAL_MS } from './utils/EventLoopYield';
import { SpiderCacheCoordinator } from './spider/SpiderCacheCoordinator';
import { SpiderDependencyAnalyzer } from './spider/SpiderDependencyAnalyzer';
import { SpiderGraphCrawler } from './spider/SpiderGraphCrawler';
import { SpiderIndexingCancellation } from './spider/SpiderIndexingCancellation';
import { SpiderIndexingService } from './spider/SpiderIndexingService';
import { SpiderReferenceLookup } from './spider/SpiderReferenceLookup';
import { SpiderSymbolService } from './spider/SpiderSymbolService';
import { SpiderWorkerManager } from './spider/SpiderWorkerManager';

/**
 * Main analyzer class - "The Spider"
 *
 * This class is a thin facade that composes multiple single-responsibility services.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 * Only Node.js built-in modules (fs, path) are permitted (indirectly via services).
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
  private readonly fileReader = new FileReader();
  private readonly astWorkerHost: AstWorkerHost;

  private readonly reverseIndexManager: ReverseIndexManager;
  private readonly indexerStatus = new IndexerStatus();
  private readonly workerManager: SpiderWorkerManager;
  private readonly cancellation = new SpiderIndexingCancellation();

  private readonly sourceFileCollector: SourceFileCollector;
  private readonly referencingFilesFinder: ReferencingFilesFinder;
  private readonly symbolDependencyHelper: SymbolDependencyHelper;

  private readonly dependencyAnalyzer: SpiderDependencyAnalyzer;
  private readonly referenceLookup: SpiderReferenceLookup;
  private readonly symbolService: SpiderSymbolService;
  private readonly graphCrawler: SpiderGraphCrawler;
  private readonly indexingService: SpiderIndexingService;
  private readonly cacheCoordinator: SpiderCacheCoordinator;

  constructor(config: SpiderConfig) {
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

    this.languageService = new LanguageService(config.rootDir, config.tsConfigPath);

    this.resolver = new PathResolver(
      config.tsConfigPath,
      this.config.excludeNodeModules,
      config.rootDir
    );

    this.cache = new Cache({ maxSize: this.config.maxCacheSize, enableLRU: true });
    this.symbolCache = new Cache({ maxSize: this.config.maxSymbolCacheSize, enableLRU: true });
    this.astWorkerHost = new AstWorkerHost();

    this.reverseIndexManager = new ReverseIndexManager(this.config.rootDir);
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
      () => yieldToEventLoop()
    );

    this.cacheCoordinator = new SpiderCacheCoordinator(this.cache, this.symbolCache, this.reverseIndexManager);

    if (config.enableReverseIndex) {
      this.enableReverseIndex();
    }

    // Note: AstWorker starts lazily on first use
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
