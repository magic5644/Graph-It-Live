import * as fs from 'node:fs/promises';
import { Parser } from './Parser';
import { PathResolver } from './PathResolver';
import { Cache } from './Cache';
import { ReverseIndex } from './ReverseIndex';
import { ReverseIndexManager } from './ReverseIndexManager';
import { IndexerStatus, IndexerStatusSnapshot } from './IndexerStatus';
import { Dependency, SpiderConfig, IndexingProgressCallback, normalizePath, SpiderError } from './types';
import { getLogger } from '../shared/logger';
import { IGNORED_DIRECTORIES } from '../shared/constants';
import { SpiderWorkerManager } from './SpiderWorkerManager';
import { SourceFileCollector } from './SourceFileCollector';

/** Logger instance for Spider */
const log = getLogger('Spider');

/**
 * Check if a file path is inside node_modules (cross-platform)
 */
function isInNodeModules(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return IGNORED_DIRECTORIES.some(dir => normalized.includes(`/${dir}/`) || normalized.includes(`/${dir}`));
}

import { SymbolAnalyzer } from './SymbolAnalyzer';

/**
 * Main analyzer class - "The Spider"
 * Crawls through files to extract and resolve dependencies
 * 
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 * Only Node.js built-in modules (fs, path) are permitted.
 */
export class Spider {
  private readonly parser: Parser;
  private readonly resolver: PathResolver;
  private readonly cache: Cache<Dependency[]>;
  private readonly config: SpiderConfig;
  private readonly symbolAnalyzer: SymbolAnalyzer;
  private readonly symbolCache: Cache<{ symbols: import('./types').SymbolInfo[]; dependencies: import('./types').SymbolDependency[] }>;

  /** Reverse index manager for O(1) reverse dependency lookups */
  private readonly reverseIndexManager: ReverseIndexManager;

  /** Indexer status tracker for progress monitoring */
  private readonly indexerStatus: IndexerStatus = new IndexerStatus();

  /** Handles worker-thread indexing orchestration */
  private readonly workerManager: SpiderWorkerManager;

  /** Collects source files for indexing and fallbacks */
  private readonly sourceFileCollector: SourceFileCollector;

  /** Flag to request cancellation of indexing */
  private indexingCancelled = false;

  constructor(config: SpiderConfig) {
    this.config = {
      maxDepth: 50, // Changed from 3 to 50
      excludeNodeModules: true,
      enableReverseIndex: false, // Changed default to false
      indexingConcurrency: 4, // Default to 4 for better event loop responsiveness
      maxCacheSize: 1000, // Default to 1000 entries
      maxSymbolCacheSize: 500, // Default to 500 entries
      maxSymbolAnalyzerFiles: 100, // Default to 100 files in memory
      ...config,
    };
    
    this.parser = new Parser();
    this.resolver = new PathResolver(
      config.tsConfigPath,
      this.config.excludeNodeModules, // Keep this as it was in original code
      config.rootDir // workspaceRoot for package.json discovery
    );
    this.cache = new Cache({ 
      maxSize: this.config.maxCacheSize, 
      enableLRU: true 
    });
    this.symbolCache = new Cache({ 
      maxSize: this.config.maxSymbolCacheSize, 
      enableLRU: true 
    });
    this.symbolAnalyzer = new SymbolAnalyzer({
      maxFiles: this.config.maxSymbolAnalyzerFiles
    });

    // Initialize reverse index if enabled
    this.reverseIndexManager = new ReverseIndexManager(this.config.rootDir);
    this.workerManager = new SpiderWorkerManager(
      this.indexerStatus,
      this.reverseIndexManager,
      this.cache
    );
    this.sourceFileCollector = new SourceFileCollector({
      excludeNodeModules: this.config.excludeNodeModules ?? true,
      yieldIntervalMs: Spider.YIELD_INTERVAL_MS,
      yieldCallback: () => this.yieldToEventLoop(),
      isCancelled: () => this.indexingCancelled,
    });

    if (config.enableReverseIndex) {
      this.enableReverseIndex(); // Use the new enableReverseIndex method
    }
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<SpiderConfig>) {
    this.config.excludeNodeModules = config.excludeNodeModules ?? this.config.excludeNodeModules;
    this.config.maxDepth = config.maxDepth ?? this.config.maxDepth;
    
    if (config.excludeNodeModules !== undefined) {
      this.resolver.updateConfig(config.excludeNodeModules);
      this.sourceFileCollector.updateOptions({ excludeNodeModules: config.excludeNodeModules });
    }

    // Handle reverse index enable/disable
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
    
    // Clear cache as config changed
    this.clearCache();
  }

  /**
   * Analyze a file and return its dependencies
   * @param filePath Absolute path to the file to analyze
   * @returns Array of dependencies
   */
  async analyze(filePath: string): Promise<Dependency[]> {
    // Use normalized key for cache and indexing consistency
    const key = normalizePath(filePath);

    // Check cache first
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }

    try {
      // Read file content
      const content = await fs.readFile(filePath, 'utf-8');

      // Parse imports
      const parsedImports = this.parser.parse(content, filePath);

      // Resolve paths
      const dependencies: Dependency[] = [];
      
      for (const imp of parsedImports) {
        const resolvedPath = await this.resolver.resolve(filePath, imp.module);
        
        if (resolvedPath) {
          dependencies.push({
            path: resolvedPath,
            type: imp.type,
            line: imp.line,
            module: imp.module,
          });
        }
      }

      // Cache results (use normalized key)
      this.cache.set(key, dependencies);

      // Update reverse index if enabled
      if (this.reverseIndexManager.isEnabled()) {
        const fileHash = await ReverseIndex.getFileHashFromDisk(filePath);
        if (fileHash) {
          this.reverseIndexManager.addDependencies(key, dependencies, fileHash);
        }
      }

      return dependencies;
    } catch (error) {
      // Wrap error with SpiderError for better diagnostics
      const spiderError = SpiderError.fromError(error, filePath);
      log.error('Analysis failed:', spiderError.toUserMessage(), spiderError.code);
      throw spiderError;
    }
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
    this.symbolCache.clear();
    this.reverseIndexManager.clear();
  }

  /**
   * Invalidate a single file from the cache and reverse index
   * Call this when a file has been modified to ensure fresh analysis
   * @param filePath Absolute path to the file to invalidate
   * @returns true if the file was in the cache, false otherwise
   */
  invalidateFile(filePath: string): boolean {
    const normalized = normalizePath(filePath);
    const wasInCache = this.cache.has(normalized);

    // Remove from dependency cache
    this.cache.delete(normalized);
    
    // Remove from symbol cache (for drill-down view)
    this.symbolCache.delete(normalized);
    
    // Remove from reverse index if enabled
    this.reverseIndexManager.removeDependenciesFromSource(normalized);
    
    return wasInCache;
  }

  /**
   * Invalidate multiple files from the cache and reverse index
   * @param filePaths Array of absolute file paths to invalidate
   * @returns Number of files that were actually in the cache
   */
  invalidateFiles(filePaths: string[]): number {
    let invalidatedCount = 0;
    
    for (const filePath of filePaths) {
      if (this.invalidateFile(filePath)) {
        invalidatedCount++;
      }
    }
    
    return invalidatedCount;
  }

  /**
   * Re-analyze a single file and update the cache and reverse index
   * Use this after a file has been modified
   * @param filePath Absolute path to the file to re-analyze
   * @returns The new dependencies, or null if the file couldn't be analyzed
   */
  async reanalyzeFile(filePath: string): Promise<Dependency[] | null> {
    // Invalidate first
    this.invalidateFile(filePath);
    
    try {
      // Re-analyze (this will update cache and reverse index)
      const dependencies = await this.analyze(filePath);
      return dependencies;
    } catch {
      // File may have been deleted, is unreadable, or is an external package
      return null;
    }
  }

  /**
   * Handle a file deletion - remove from cache and reverse index
   * @param filePath Absolute path to the deleted file
   */
  handleFileDeleted(filePath: string): void {
    const normalized = normalizePath(filePath);
    this.cache.delete(normalized);
    this.symbolCache.delete(normalized);
    this.reverseIndexManager.removeDependenciesFromSource(normalized);
  }

  /**
   * Enable reverse indexing and optionally restore from serialized data
   */
  enableReverseIndex(serializedData?: string): boolean {
    const restored = this.reverseIndexManager.enable(serializedData);
    this.config.enableReverseIndex = true;
    return restored;
  }

  /**
   * Disable reverse indexing and clear the index
   */
  disableReverseIndex(): void {
    this.config.enableReverseIndex = false;
    this.reverseIndexManager.disable();
  }

  /**
   * Get the serialized reverse index for persistence
   */
  getSerializedReverseIndex(): string | null {
    return this.reverseIndexManager.getSerialized();
  }

  /**
   * Validate the persisted index and check for stale files
   */
  async validateReverseIndex(staleThreshold = 0.2): Promise<{
    isValid: boolean;
    staleFiles: string[];
    stalePercentage: number;
    missingFiles: string[];
  } | null> {
    return this.reverseIndexManager.validate(staleThreshold);
  }

  /**
   * Get the current indexing state
   * @deprecated Use getIndexStatus() instead for full status information
   */
  getIndexingState(): IndexerStatusSnapshot['state'] {
    return this.indexerStatus.state;
  }

  /**
   * Get full indexer status snapshot
   * Provides state, progress, ETA, and other useful information
   */
  getIndexStatus(): IndexerStatusSnapshot {
    return this.indexerStatus.getSnapshot();
  }

  /**
   * Subscribe to indexer status changes
   * @param callback Function to call when status changes
   * @returns Unsubscribe function
   */
  subscribeToIndexStatus(callback: (snapshot: IndexerStatusSnapshot) => void): () => void {
    return this.indexerStatus.subscribe(callback);
  }

  /**
   * Check if reverse index is enabled and has entries
   */
  hasReverseIndex(): boolean {
    return this.reverseIndexManager.hasEntries();
  }

  /**
   * Get the number of callers referencing a given file when reverse index is available
   */
  getCallerCount(targetPath: string): number {
    if (!this.reverseIndexManager.hasEntries()) {
      return 0;
    }
    return this.reverseIndexManager.getCallerCount(targetPath);
  }

  /**
   * Cancel ongoing indexing operation (works for both main thread and worker)
   */
  cancelIndexing(): void {
    this.indexingCancelled = true;
    this.workerManager.cancel();
  }

  /** Maximum time in ms between yields to event loop (50ms = 20 yields/sec) */
  private static readonly YIELD_INTERVAL_MS = 50;

  /**
   * Build a full reverse index of the workspace
   * Processes files ONE BY ONE with yields to avoid blocking the event loop
   * @param progressCallback Optional callback for progress updates (legacy support)
   * @returns Statistics about the indexing operation
   */
  async buildFullIndex(
    progressCallback?: IndexingProgressCallback
  ): Promise<{
    indexedFiles: number;
    duration: number;
    cancelled: boolean;
  }> {
    this.reverseIndexManager.ensure();
    this.indexingCancelled = false;

    // Phase 1: Counting files (with yielding for large projects)
    this.indexerStatus.startCounting();
    
    const allFiles = await this.sourceFileCollector.collectAllSourceFiles(this.config.rootDir);
    
    if (this.indexingCancelled) {
      this.indexerStatus.setCancelled();
      return { indexedFiles: 0, duration: 0, cancelled: true };
    }
    
    const totalFiles = allFiles.length;
    this.indexerStatus.setTotal(totalFiles);

    // Yield after counting to let UI update
    await this.yieldToEventLoop();

    // Phase 2: Indexing files - with time-based yielding
    this.indexerStatus.startIndexing();
    let processed = 0;
    let lastYieldTime = Date.now();

    try {
      for (const filePath of allFiles) {
        // Check cancellation at each file
        if (this.indexingCancelled) {
          this.indexerStatus.setCancelled();
          return {
            indexedFiles: processed,
            duration: Date.now() - (this.indexerStatus.getSnapshot().startTime ?? Date.now()),
            cancelled: true,
          };
        }

        try {
          await this.analyze(filePath);
        } catch {
          // Silently skip failed files to avoid flooding logs on large projects
          // The file might be malformed, binary, or inaccessible
        }

        processed++;
        
        // Update status (throttled internally by IndexerStatus)
        this.indexerStatus.updateProgress(processed, filePath);
        progressCallback?.(processed, totalFiles, filePath);

        // Time-based yielding: yield if more than 50ms have passed
        // This ensures we never block the event loop for too long
        const now = Date.now();
        if (now - lastYieldTime >= Spider.YIELD_INTERVAL_MS) {
          await this.yieldToEventLoop();
          lastYieldTime = Date.now();
        }
      }

      this.indexerStatus.complete();
      const snapshot = this.indexerStatus.getSnapshot();
      const duration = Date.now() - (snapshot.startTime ?? Date.now());

      return {
        indexedFiles: processed,
        duration,
        cancelled: false,
      };
    } catch (error) {
      const spiderError = SpiderError.fromError(error);
      this.indexerStatus.setError(spiderError.toUserMessage());
      log.error('Indexing failed:', spiderError.toUserMessage(), spiderError.code);
      throw spiderError;
    }
  }

  /**
   * Build a full reverse index using a Worker Thread
   * This runs the CPU-intensive work in a separate thread to avoid blocking the extension host
   * @param workerPath Path to the compiled worker script (dist/indexerWorker.js)
   * @param progressCallback Optional callback for progress updates (legacy support)
   * @returns Statistics about the indexing operation
   */
  async buildFullIndexInWorker(
    workerPath: string,
    progressCallback?: IndexingProgressCallback
  ): Promise<{
    indexedFiles: number;
    duration: number;
    cancelled: boolean;
  }> {
    return this.workerManager.buildFullIndexInWorker({
      workerPath,
      progressCallback,
      config: {
        rootDir: this.config.rootDir,
        excludeNodeModules: this.config.excludeNodeModules,
        tsConfigPath: this.config.tsConfigPath,
      },
    });
  }

  /**
   * Dispose worker resources
   */
  disposeWorker(): void {
    this.workerManager.dispose();
  }

  /**
   * Yield control to the event loop to avoid blocking
   * Uses setTimeout(1) to guarantee a real delay and allow VS Code's
   * extension host watchdog to consider us responsive
   */
  private yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 1));
  }

  /**
   * Re-index stale files only (incremental update)
   * @param staleFiles Array of file paths that need re-indexing
   * @param progressCallback Optional callback for progress updates
   */
  async reindexStaleFiles(
    staleFiles: string[],
    progressCallback?: IndexingProgressCallback
  ): Promise<number> {
    if (!this.reverseIndexManager.isEnabled()) {
      return 0;
    }

    const concurrency = this.config.indexingConcurrency ?? 8;
    let processed = 0;

    for (let i = 0; i < staleFiles.length; i += concurrency) {
      const batch = staleFiles.slice(i, i + concurrency);
      
      await Promise.all(
        batch.map(async (filePath) => {
          try {
            // Remove old entries before re-analyzing
            this.reverseIndexManager.removeDependenciesFromSource(normalizePath(filePath));
            this.cache.delete(filePath);
            await this.analyze(filePath);
          } catch {
            // File may have been deleted, remove from index
            this.reverseIndexManager.removeDependenciesFromSource(normalizePath(filePath));
          }
        })
      );

      processed += batch.length;
      progressCallback?.(processed, staleFiles.length, batch.at(-1));
      await this.yieldToEventLoop();
    }

    return processed;
  }

  /**
   * Crawl the dependency graph starting from an entry file
   * @param entryFile Absolute path to the entry file
   * @returns Graph data (nodes and edges)
   */
  async crawl(startPath: string): Promise<{ nodes: string[]; edges: { source: string; target: string }[]; nodeLabels?: Record<string, string> }> {
    const nodes = new Set<string>();
    const edges: { source: string; target: string }[] = [];
    const visited = new Set<string>();
    const nodeLabels: Record<string, string> = {};

    const crawlRecursive = async (filePath: string, depth: number) => {
      // Normalize entry to ensure consistent node keys across platforms
      const normalizedFile = normalizePath(filePath);
      // Stop if max depth reached (use a safe default if undefined)
      const maxDepth = this.config.maxDepth ?? 3;
      if (depth > maxDepth) {
        return;
      }

      // Skip if already visited
      if (visited.has(normalizedFile)) {
        return;
      }

      visited.add(normalizedFile);
      nodes.add(normalizedFile);

      try {
        const dependencies = await this.analyze(filePath);

        // CRITICAL: Always update reverse index with current file's dependencies,
        // even if they came from cache. This ensures all import relationships
        // are tracked correctly, especially when navigating between files.
        // Without this, the reverse index would miss relationships for cached files,
        // causing parent references to disappear during navigation.
        if (this.reverseIndexManager.isEnabled() && dependencies.length > 0) {
          const fileHash = await ReverseIndex.getFileHashFromDisk(filePath);
          if (fileHash) {
            this.reverseIndexManager.addDependencies(normalizedFile, dependencies, fileHash);
          }
        }

        for (const dep of dependencies) {
          nodes.add(dep.path);
          edges.push({
            source: normalizedFile,
            target: dep.path,
          });

          // Store custom label for workspace packages (e.g., @bobbee/auth-lib)
          if (dep.module.startsWith('@') && dep.module.includes('/') && !dep.module.startsWith('@/')) {
            nodeLabels[dep.path] = dep.module;
          }

          // Recurse if not in node_modules (cross-platform check)
          if (!isInNodeModules(dep.path)) {
            await crawlRecursive(dep.path, depth + 1);
          }
        }
      } catch (error) {
        // Log error for debugging but continue crawling
        log.debug(`Failed to analyze ${normalizedFile}:`, error instanceof Error ? error.message : String(error));
      }
    };

    await crawlRecursive(startPath, 0);

    return {
      nodes: Array.from(nodes),
      edges,
      nodeLabels: Object.keys(nodeLabels).length > 0 ? nodeLabels : undefined,
    };
  }

  /**
   * Crawl from a specific node to discover new dependencies (on-demand scan)
   * @param startNode Node to start scanning from
   * @param existingNodes Nodes already known (to avoid re-scanning)
   * @param extraDepth Additional depth to scan from this node
   * @returns New graph data discovered (only new nodes and edges)
   */
  async crawlFrom(
    startNode: string, 
    existingNodes: Set<string>, 
    extraDepth: number = 10
  ): Promise<{ nodes: string[]; edges: { source: string; target: string }[]; nodeLabels?: Record<string, string> }> {
    const newNodes = new Set<string>();
    const newEdges: { source: string; target: string }[] = [];
    const visited = new Set<string>(Array.from(existingNodes).map(n => normalizePath(n))); // Don't revisit known nodes
    const nodeLabels: Record<string, string> = {};
    const normalizedExisting = new Set(Array.from(existingNodes).map(n => normalizePath(n)));
    const normalizedStartNode = normalizePath(startNode);

    const shouldSkipNode = (normalizedFile: string, depth: number): boolean => {
      if (depth > extraDepth) return true;
      if (normalizedFile === normalizedStartNode) return false; // Never skip start node
      return visited.has(normalizedFile);
    };

    const updateReverseIndexForFile = async (normalizedFile: string, dependencies: Dependency[]): Promise<void> => {
      if (!this.reverseIndexManager.isEnabled() || dependencies.length === 0) return;
      
      const fileHash = await ReverseIndex.getFileHashFromDisk(normalizedFile);
      if (fileHash) {
        this.reverseIndexManager.addDependencies(normalizedFile, dependencies, fileHash);
      }
    };

    const processNewNode = (normalizedFile: string): void => {
      if (!normalizedExisting.has(normalizedFile)) {
        newNodes.add(normalizedFile);
      }
    };

    const processDependency = (dep: Dependency, normalizedFile: string): void => {
      newEdges.push({ source: normalizedFile, target: dep.path });
      
      if (!visited.has(dep.path)) {
        newNodes.add(dep.path);
      }

      // Store custom label for workspace packages (e.g., @bobbee/auth-lib)
      if (dep.module.startsWith('@') && dep.module.includes('/') && !dep.module.startsWith('@/')) {
        nodeLabels[dep.path] = dep.module;
      }
    };

    const crawlRecursive = async (filePath: string, depth: number): Promise<void> => {
      const normalizedFile = normalizePath(filePath);
      
      if (shouldSkipNode(normalizedFile, depth)) {
        return;
      }

      visited.add(normalizedFile);
      processNewNode(normalizedFile);

      try {
        const dependencies = await this.analyze(filePath);

        // CRITICAL: Always update reverse index with current file's dependencies,
        // even if they came from cache. This ensures all import relationships
        // are tracked correctly during node expansion.
        await updateReverseIndexForFile(normalizedFile, dependencies);

        for (const dep of dependencies) {
          processDependency(dep, normalizedFile);

          // Recurse if not in node_modules (cross-platform check)
          if (!isInNodeModules(dep.path)) {
            await crawlRecursive(dep.path, depth + 1);
          }
        }
      } catch {
        // File may be an external package or unreadable - skip silently
      }
    };

    await crawlRecursive(startNode, 0);

    return {
      nodes: Array.from(newNodes),
      edges: newEdges,
      nodeLabels: Object.keys(nodeLabels).length > 0 ? nodeLabels : undefined,
    };
  }


  /**
   * Check if a dependency's target file path matches a given absolute path
   * @param dep The symbol dependency to check
   * @param sourceFilePath The file containing the dependency
   * @param targetFilePath The absolute path to match against
   * @returns true if the dependency targets the given file
   */
  private async doesDependencyTargetFile(
    dep: import('./types').SymbolDependency,
    sourceFilePath: string,
    targetFilePath: string
  ): Promise<boolean> {
    if (dep.targetFilePath === targetFilePath) {
      return true;
    }
    const resolved = await this.resolver.resolve(sourceFilePath, dep.targetFilePath);
    return resolved === targetFilePath;
  }

  /**
   * Extract symbol name from a symbol ID (format: "path:symbolName")
   */
  private extractSymbolName(symbolId: string): string {
    return symbolId.split(':').pop() || '';
  }

  /**
   * Extract the basename (without extension) from a file path
   */
  private extractBasename(filePath: string): string | undefined {
    return filePath.split(/[/\\]/).pop()?.replace(/\.[^/.]+$/, '');
  }

  /**
   * Check if a file contains a reference to the target and return the dependency if found
   * @param filePath Source file to check for references
   * @param targetPath Normalized target path to find references for
   * @param targetBasename Basename of the target file (for quick content check)
   */
  private async findReferenceInFile(
    filePath: string,
    targetPath: string,
    targetBasename: string
  ): Promise<Dependency | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      if (!content.includes(targetBasename)) {
        return null;
      }

      const dependencies = await this.analyze(filePath);
      // Compare normalized paths to ensure cross-platform consistency
      // Note: dep.path is already normalized by PathResolver.resolve()
      const matchingDep = dependencies.find(dep => normalizePath(dep.path) === targetPath);
      
      if (matchingDep) {
        return {
          path: normalizePath(filePath),
          type: matchingDep.type,
          line: matchingDep.line,
          module: matchingDep.module
        };
      }
    } catch {
      // File may be an external package or unreadable - skip silently
    }
    return null;
  }

  /**
   * Find files that reference the given file (reverse dependency lookup)
   * Uses the reverse index for O(1) lookup if available, otherwise falls back to directory scan
   * @param targetPath Absolute path to the file to find references for
   * @returns Array of dependencies pointing to the target file
   */
  async findReferencingFiles(targetPath: string): Promise<Dependency[]> {
    // Use reverse index if available (O(1) lookup)
    if (this.reverseIndexManager.hasEntries()) {
      return this.reverseIndexManager.getReferencingFiles(targetPath);
    }

    // Fallback to directory scan (O(n) but parallelized)
    return this.findReferencingFilesFallback(targetPath);
  }

  /**
   * Get the symbol graph for a specific file (Drill Down)
   * @param filePath Absolute path to the file to analyze
   */
  async getSymbolGraph(filePath: string): Promise<{
    symbols: import('./types').SymbolInfo[];
    dependencies: import('./types').SymbolDependency[];
  }> {
    // Try to be defensive: if callers accidentally pass a module specifier or
    // non-absolute path (e.g. './utils'), attempt to resolve it relative to
    // the workspace root before proceeding. This makes the analyzer more
    // robust when the caller (extension/webview) fails to normalize first.
    if (!filePath.startsWith('/') && !/^[a-zA-Z]:\//.test(filePath)) {
      try {
        // Use workspace root as the base file for resolving module specifiers.
        // PathResolver.resolve expects the first parameter to be the "from" file,
        // so we pass the configured root directory here.
        const maybeResolved = await this.resolveModuleSpecifier(this.config.rootDir, filePath);
        if (maybeResolved) {
          filePath = maybeResolved;
        }
      } catch {
        // Ignore resolution errors - we'll handle file-not-found below normally
      }
    }

    // Use normalized key for symbol cache and analysis consistency
    const key = normalizePath(filePath);

    // Check cache first
    const cached = this.symbolCache.get(key);
    if (cached) {
      return cached;
    }

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      // Pass normalized file path into the symbol analyzer to keep symbol IDs stable
      const result = this.symbolAnalyzer.analyzeFile(key, content);
      this.symbolCache.set(key, result);
      return result;
    } catch (error) {
      const spiderError = SpiderError.fromError(error, filePath);
      log.error('Symbol analysis failed:', spiderError.toUserMessage());
      // Return empty result for recoverable errors (file not found, etc.)
      if (spiderError.isRecoverable()) {
        return { symbols: [], dependencies: [] };
      }
      throw spiderError;
    }
  }

  /**
   * Resolve a module specifier (e.g. './utils' or '@/components/Button') to an absolute
   * normalized file path using the internal PathResolver.
   * Public helper so external callers (like the extension host) can resolve module
   * specifiers before passing values into other Spider APIs that expect absolute paths.
   * @param fromFilePath File which is doing the import (used as base for relative imports)
   * @param moduleSpecifier Module specifier exactly as written in source
   */
  async resolveModuleSpecifier(fromFilePath: string, moduleSpecifier: string): Promise<string | null> {
    try {
      const resolved = await this.resolver.resolve(fromFilePath, moduleSpecifier);
      return resolved;
    } catch {
      // Resolver may throw on weird inputs, treat as unresolved (null) for callers to handle
      return null;
    }
  }

  /**
   * Find exported symbols that are unused in the project
   * @param filePath Absolute path to the file to check
   */
  async findUnusedSymbols(filePath: string): Promise<import('./types').SymbolInfo[]> {
    try {
      const { symbols } = await this.getSymbolGraph(filePath);
      const exportedSymbols = symbols.filter(s => s.isExported);
      
      if (exportedSymbols.length === 0) {
        return [];
      }

      const normalizedTarget = normalizePath(filePath);
      const referencingFiles = await this.findReferencingFiles(normalizedTarget);
      const usedSymbolIds = await this.collectUsedSymbolIds(referencingFiles, normalizedTarget);

      return exportedSymbols.filter(s => !usedSymbolIds.has(s.id));
    } catch (error) {
      const spiderError = SpiderError.fromError(error, filePath);
      log.error('Find unused symbols failed:', spiderError.toUserMessage());
      return [];
    }
  }

  /**
   * Collect all symbol IDs used from referencing files
   */
  private async collectUsedSymbolIds(
    referencingFiles: Dependency[],
    targetFilePath: string
  ): Promise<Set<string>> {
    const usedSymbolIds = new Set<string>();
    
    for (const ref of referencingFiles) {
      const { dependencies } = await this.getSymbolGraph(ref.path);
      
      for (const dep of dependencies) {
        const isMatch = await this.doesDependencyTargetFile(dep, ref.path, targetFilePath);
        if (isMatch) {
          const symbolName = this.extractSymbolName(dep.targetSymbolId);
          // Ensure we record used symbol IDs using the same normalized target path
          usedSymbolIds.add(`${normalizePath(targetFilePath)}:${symbolName}`);
        }
      }
    }
    
    return usedSymbolIds;
  }

  /**
   * Get dependents of a specific symbol (Reverse Lookup)
   * @param filePath File containing the symbol
   * @param symbolName Name of the symbol
   */
  async getSymbolDependents(filePath: string, symbolName: string): Promise<import('./types').SymbolDependency[]> {
    const referencingFiles = await this.findReferencingFiles(filePath);
    return this.collectSymbolDependents(referencingFiles, filePath, symbolName);
  }

  /**
   * Collect dependents of a specific symbol from referencing files
   */
  private async collectSymbolDependents(
    referencingFiles: Dependency[],
    targetFilePath: string,
    symbolName: string
  ): Promise<import('./types').SymbolDependency[]> {
    const dependents: import('./types').SymbolDependency[] = [];
    const normalizedTarget = normalizePath(targetFilePath);
    
    for (const ref of referencingFiles) {
      const { dependencies } = await this.getSymbolGraph(ref.path);
      
      for (const dep of dependencies) {
        const isMatch = await this.doesDependencyTargetFile(dep, ref.path, normalizedTarget);
        if (isMatch && this.extractSymbolName(dep.targetSymbolId) === symbolName) {
          dependents.push(dep);
        }
      }
    }
    
    return dependents;
  }

  /**
   * Trace the full execution chain from a root symbol
   * This provides a deep call graph starting from a specific function/method
   * @param filePath File containing the root symbol
   * @param symbolName Name of the root symbol
   * @param maxDepth Maximum depth to trace (default: 10)
   */
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
    const rootId = `${filePath}:${symbolName}`;
    const callChain: Array<{
      depth: number;
      callerSymbolId: string;
      calledSymbolId: string;
      calledFilePath: string;
      resolvedFilePath: string | null;
    }> = [];
    const visitedSymbols = new Set<string>();
    let maxDepthReached = false;

    const trace = async (
      currentFilePath: string,
      currentSymbolName: string,
      depth: number
    ): Promise<void> => {
      if (depth > maxDepth) {
        maxDepthReached = true;
        return;
      }

      const currentId = `${currentFilePath}:${currentSymbolName}`;
      if (visitedSymbols.has(currentId)) {
        return; // Already traced this symbol (avoid cycles)
      }
      visitedSymbols.add(currentId);

      try {
        const { symbols, dependencies } = await this.getSymbolGraph(currentFilePath);
        
        // Find the current symbol
        const currentSymbol = symbols.find(s => s.name === currentSymbolName);
        if (!currentSymbol) {
          return;
        }

        // Get dependencies from this symbol
        const symbolDeps = dependencies.filter(d => d.sourceSymbolId === currentSymbol.id);

        for (const dep of symbolDeps) {
          // Resolve the target file path
          let resolvedFilePath: string | null = null;
          try {
            resolvedFilePath = await this.resolver.resolve(currentFilePath, dep.targetFilePath);
          } catch {
            // Could not resolve, keep as null
          }

          const targetSymbolName = dep.targetSymbolId.split(':').pop() || '';

          callChain.push({
            depth,
            callerSymbolId: currentId,
            calledSymbolId: dep.targetSymbolId,
            calledFilePath: dep.targetFilePath,
            resolvedFilePath,
          });

          // Recursively trace if we have a resolved path
          if (resolvedFilePath && !isInNodeModules(resolvedFilePath)) {
            await trace(resolvedFilePath, targetSymbolName, depth + 1);
          }
        }
      } catch (error) {
        const spiderError = SpiderError.fromError(error, currentFilePath);
        log.error('Trace execution failed:', currentId, spiderError.toUserMessage());
      }
    };

    await trace(filePath, symbolName, 1);

    return {
      rootSymbol: { id: rootId, filePath, symbolName },
      callChain,
      visitedSymbols: Array.from(visitedSymbols),
      maxDepthReached,
    };
  }

  /**
   * Fallback method for finding referencing files via directory scan
   * Used when reverse index is not available
   */
  private async findReferencingFilesFallback(targetPath: string): Promise<Dependency[]> {
    // Normalize target path for consistent comparison across platforms
    const normalizedTargetPath = normalizePath(targetPath);
    const targetBasename = this.extractBasename(normalizedTargetPath);
    
    if (!targetBasename) {
      return [];
    }

    log.debug('findReferencingFilesFallback for', normalizedTargetPath, 'basename:', targetBasename);

    // Use parallelized directory walk
    const allFiles = await this.sourceFileCollector.collectAllSourceFiles(this.config.rootDir);
    const referencingFiles: Dependency[] = [];
    const concurrency = this.config.indexingConcurrency ?? 8;

    for (let i = 0; i < allFiles.length; i += concurrency) {
      const batch = allFiles.slice(i, i + concurrency);
      
      const results = await Promise.all(
        batch
          // Normalize paths before comparison to ensure cross-platform consistency
          .filter(filePath => normalizePath(filePath) !== normalizedTargetPath)
          .map(filePath => this.findReferenceInFile(filePath, normalizedTargetPath, targetBasename))
      );

      for (const result of results) {
        if (result) {
          referencingFiles.push(result);
        }
      }
    }

    log.debug('findReferencingFilesFallback found', referencingFiles.length, 'referencing files');
    return referencingFiles;
  }

  /**
   * Get comprehensive cache statistics for monitoring
   * @returns Cache statistics including hits, misses, evictions
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
      symbolAnalyzerFileCount: this.symbolAnalyzer.getFileCount(),
      reverseIndexStats: this.reverseIndexManager.getStats(),
    };
  }
}
