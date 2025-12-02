import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Parser } from './Parser';
import { PathResolver } from './PathResolver';
import { Cache } from './Cache';
import { ReverseIndex } from './ReverseIndex';
import { IndexerStatus, IndexerStatusSnapshot } from './IndexerStatus';
import { IndexerWorkerHost } from './IndexerWorkerHost';
import { Dependency, SpiderConfig, IndexingProgressCallback } from './types';

/**
 * Check if a file path is inside node_modules (cross-platform)
 */
function isInNodeModules(filePath: string): boolean {
  // Normalize separators for cross-platform check
  const normalized = filePath.split(path.sep).join('/');
  return normalized.includes('/node_modules/') || normalized.includes('/node_modules');
}

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

  /** Reverse index for O(1) reverse dependency lookups */
  private reverseIndex: ReverseIndex | null = null;

  /** Indexer status tracker for progress monitoring */
  private readonly indexerStatus: IndexerStatus = new IndexerStatus();

  /** Worker host for background indexing (optional, used when useWorkerThread is true) */
  private workerHost: IndexerWorkerHost | null = null;

  /** Flag to request cancellation of indexing */
  private indexingCancelled = false;

  constructor(config: SpiderConfig) {
    this.config = {
      maxDepth: 3,
      excludeNodeModules: true,
      indexingConcurrency: 4, // Default to 4 for better event loop responsiveness
      ...config,
    };
    
    this.parser = new Parser();
    this.resolver = new PathResolver(
      config.tsConfigPath,
      this.config.excludeNodeModules,
      config.rootDir // workspaceRoot for package.json discovery
    );
    this.cache = new Cache();

    // Initialize reverse index if enabled
    if (config.enableReverseIndex) {
      this.reverseIndex = new ReverseIndex(config.rootDir);
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
    }

    // Handle reverse index enable/disable
    if (config.enableReverseIndex !== undefined) {
      this.config.enableReverseIndex = config.enableReverseIndex;
      if (config.enableReverseIndex && !this.reverseIndex) {
        this.reverseIndex = new ReverseIndex(this.config.rootDir);
      } else if (!config.enableReverseIndex) {
        this.reverseIndex?.clear();
        this.reverseIndex = null;
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
    // Check cache first
    const cached = this.cache.get(filePath);
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

      // Cache results
      this.cache.set(filePath, dependencies);

      // Update reverse index if enabled
      if (this.reverseIndex) {
        const fileHash = await ReverseIndex.getFileHashFromDisk(filePath);
        if (fileHash) {
          this.reverseIndex.addDependencies(filePath, dependencies, fileHash);
        }
      }

      return dependencies;
    } catch (error) {
      // Re-throw with more context
      if (error instanceof Error) {
        throw new Error(`Failed to analyze ${filePath}: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
    this.reverseIndex?.clear();
  }

  /**
   * Invalidate a single file from the cache and reverse index
   * Call this when a file has been modified to ensure fresh analysis
   * @param filePath Absolute path to the file to invalidate
   * @returns true if the file was in the cache, false otherwise
   */
  invalidateFile(filePath: string): boolean {
    const wasInCache = this.cache.has(filePath);
    
    // Remove from cache
    this.cache.delete(filePath);
    
    // Remove from reverse index if enabled
    this.reverseIndex?.removeDependenciesFromSource(filePath);
    
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
    this.cache.delete(filePath);
    this.reverseIndex?.removeDependenciesFromSource(filePath);
  }

  /**
   * Enable reverse indexing and optionally restore from serialized data
   */
  enableReverseIndex(serializedData?: string): boolean {
    this.reverseIndex ??= new ReverseIndex(this.config.rootDir);
    this.config.enableReverseIndex = true;

    if (serializedData) {
      try {
        const data = JSON.parse(serializedData);
        const restored = ReverseIndex.deserialize(data, this.config.rootDir);
        if (restored) {
          this.reverseIndex = restored;
          return true;
        }
      } catch {
        // Failed to restore reverse index, will rebuild
      }
    }
    return false;
  }

  /**
   * Disable reverse indexing and clear the index
   */
  disableReverseIndex(): void {
    this.config.enableReverseIndex = false;
    this.reverseIndex?.clear();
    this.reverseIndex = null;
  }

  /**
   * Get the serialized reverse index for persistence
   */
  getSerializedReverseIndex(): string | null {
    if (!this.reverseIndex) {
      return null;
    }
    return JSON.stringify(this.reverseIndex.serialize());
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
    if (!this.reverseIndex) {
      return null;
    }
    return this.reverseIndex.validateIndex(staleThreshold);
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
    return this.reverseIndex?.hasEntries() ?? false;
  }

  /**
   * Cancel ongoing indexing operation (works for both main thread and worker)
   */
  cancelIndexing(): void {
    this.indexingCancelled = true;
    this.workerHost?.cancel();
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
    this.reverseIndex ??= new ReverseIndex(this.config.rootDir);
    this.indexingCancelled = false;

    // Phase 1: Counting files (with yielding for large projects)
    this.indexerStatus.startCounting();
    
    const allFiles = await this.collectAllSourceFiles(this.config.rootDir);
    
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
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.indexerStatus.setError(message);
      throw error;
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
    // Create worker host if not already created
    this.workerHost ??= new IndexerWorkerHost(workerPath);
    
    // Ensure reverse index exists
    this.reverseIndex ??= new ReverseIndex(this.config.rootDir);

    // Subscribe to worker status updates and forward to our indexerStatus
    const unsubscribe = this.workerHost.subscribeToStatus((snapshot) => {
      // Mirror state to our internal indexerStatus for consistency
      switch (snapshot.state) {
        case 'counting':
          this.indexerStatus.startCounting();
          break;
        case 'indexing':
          if (snapshot.total > 0) {
            this.indexerStatus.setTotal(snapshot.total);
            this.indexerStatus.startIndexing();
          }
          this.indexerStatus.updateProgress(snapshot.processed, snapshot.currentFile);
          break;
        case 'complete':
          this.indexerStatus.complete();
          break;
        case 'error':
          this.indexerStatus.setError(snapshot.errorMessage ?? 'Unknown error');
          break;
      }

      // Call legacy progress callback if provided
      if (progressCallback && snapshot.state === 'indexing') {
        progressCallback(snapshot.processed, snapshot.total, snapshot.currentFile);
      }
    });

    try {
      const result = await this.workerHost.startIndexing({
        rootDir: this.config.rootDir,
        excludeNodeModules: this.config.excludeNodeModules,
        tsConfigPath: this.config.tsConfigPath,
      });

      // Import the indexed data into our reverse index
      
      for (const fileData of result.data) {
        // Cache the dependencies
        this.cache.set(fileData.filePath, fileData.dependencies);
        
        // Add to reverse index with file hash
        this.reverseIndex.addDependencies(
          fileData.filePath,
          fileData.dependencies,
          { mtime: fileData.mtime, size: fileData.size }
        );
      }

      return {
        indexedFiles: result.indexedFiles,
        duration: result.duration,
        cancelled: result.cancelled,
      };
    } finally {
      unsubscribe();
    }
  }

  /**
   * Dispose worker resources
   */
  disposeWorker(): void {
    this.workerHost?.dispose();
    this.workerHost = null;
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
   * Collect all supported source files in a directory tree
   * Yields to event loop periodically based on time to avoid blocking on large projects
   */
  private async collectAllSourceFiles(dir: string): Promise<string[]> {
    const files: string[] = [];
    let lastYieldTime = Date.now();
    
    const walkDir = async (currentDir: string): Promise<void> => {
      // Check cancellation
      if (this.indexingCancelled) {
        return;
      }

      // Time-based yielding during traversal
      const now = Date.now();
      if (now - lastYieldTime >= Spider.YIELD_INTERVAL_MS) {
        await this.yieldToEventLoop();
        lastYieldTime = Date.now();
      }

      try {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        
        for (const entry of entries) {
          // Check cancellation inside the loop for responsiveness
          if (this.indexingCancelled) {
            return;
          }

          const fullPath = path.join(currentDir, entry.name);
          
          if (entry.isDirectory()) {
            if (!this.shouldSkipDirectory(entry.name)) {
              await walkDir(fullPath);
            }
          } else if (entry.isFile() && this.isSupportedSourceFile(entry.name)) {
            files.push(fullPath);
          }
        }
      } catch (error) {
        console.error(`[Spider] Error reading directory ${currentDir}:`, error);
      }
    };

    await walkDir(dir);
    return files;
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
    if (!this.reverseIndex) {
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
            this.reverseIndex!.removeDependenciesFromSource(filePath);
            this.cache.delete(filePath);
            await this.analyze(filePath);
          } catch {
            // File may have been deleted, remove from index
            this.reverseIndex!.removeDependenciesFromSource(filePath);
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
      // Stop if max depth reached (use a safe default if undefined)
      const maxDepth = this.config.maxDepth ?? 3;
      if (depth > maxDepth) {
        return;
      }

      // Skip if already visited
      if (visited.has(filePath)) {
        return;
      }

      visited.add(filePath);
      nodes.add(filePath);

      try {
        const dependencies = await this.analyze(filePath);

        for (const dep of dependencies) {
          nodes.add(dep.path);
          edges.push({
            source: filePath,
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
      } catch {
        // File may be an external package or unreadable - skip silently
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
    const visited = new Set<string>(existingNodes); // Don't revisit known nodes
    const nodeLabels: Record<string, string> = {};

    const crawlRecursive = async (filePath: string, depth: number) => {
      if (depth > extraDepth) {
        return;
      }
      if (visited.has(filePath) && filePath !== startNode) {
        // Skip already visited nodes, EXCEPT the start node itself
        return;
      }

      visited.add(filePath);
      
      // Only add to newNodes if it wasn't in existingNodes
      if (!existingNodes.has(filePath)) {
        newNodes.add(filePath);
      }

      try {
        const dependencies = await this.analyze(filePath);

        for (const dep of dependencies) {
          const edge = { source: filePath, target: dep.path };
          
          // Only add edge if it's truly new
          newEdges.push(edge);
          
          if (!visited.has(dep.path)) {
            newNodes.add(dep.path);
          }

          // Store custom label for workspace packages (e.g., @bobbee/auth-lib)
          if (dep.module.startsWith('@') && dep.module.includes('/') && !dep.module.startsWith('@/')) {
            nodeLabels[dep.path] = dep.module;
          }

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
   * Check if a directory should be skipped during traversal
   */
  private shouldSkipDirectory(entryName: string): boolean {
    if (this.config.excludeNodeModules && entryName === 'node_modules') {
      return true;
    }
    return entryName.startsWith('.');
  }

  /**
   * Check if a file is a supported source file
   */
  private isSupportedSourceFile(fileName: string): boolean {
    return /\.(ts|tsx|js|jsx|vue|svelte|gql|graphql)$/.test(fileName);
  }

  /**
   * Extract the basename (without extension) from a file path
   */
  private extractBasename(filePath: string): string | undefined {
    return filePath.split(/[/\\]/).pop()?.replace(/\.[^/.]+$/, '');
  }

  /**
   * Check if a file contains a reference to the target and return the dependency if found
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
      const matchingDep = dependencies.find(dep => dep.path === targetPath);
      
      if (matchingDep) {
        return {
          path: filePath,
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
    if (this.reverseIndex?.hasEntries()) {
      return this.reverseIndex.getReferencingFiles(targetPath);
    }

    // Fallback to directory scan (O(n) but parallelized)
    return this.findReferencingFilesFallback(targetPath);
  }

  /**
   * Fallback method for finding referencing files via directory scan
   * Used when reverse index is not available
   */
  private async findReferencingFilesFallback(targetPath: string): Promise<Dependency[]> {
    const targetBasename = this.extractBasename(targetPath);
    
    if (!targetBasename) {
      return [];
    }

    // Use parallelized directory walk
    const allFiles = await this.collectAllSourceFiles(this.config.rootDir);
    const referencingFiles: Dependency[] = [];
    const concurrency = this.config.indexingConcurrency ?? 8;

    for (let i = 0; i < allFiles.length; i += concurrency) {
      const batch = allFiles.slice(i, i + concurrency);
      
      const results = await Promise.all(
        batch
          .filter(filePath => filePath !== targetPath)
          .map(filePath => this.findReferenceInFile(filePath, targetPath, targetBasename))
      );

      for (const result of results) {
        if (result) {
          referencingFiles.push(result);
        }
      }
    }

    return referencingFiles;
  }

  /**
   * Get cache statistics
   * @returns Cache statistics
   */
  getCacheStats(): { size: number; reverseIndexStats?: { indexedFiles: number; targetFiles: number; totalReferences: number } } {
    return {
      size: this.cache.size,
      reverseIndexStats: this.reverseIndex?.getStats(),
    };
  }
}
