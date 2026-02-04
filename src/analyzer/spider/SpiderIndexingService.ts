import { getLogger } from '../../shared/logger';
import { Cache } from '../Cache';
import { IndexerStatus } from '../IndexerStatus';
import { ReverseIndexManager } from '../ReverseIndexManager';
import { SourceFileCollector } from '../SourceFileCollector';
import type { Dependency, IndexingProgressCallback, SpiderConfig, SymbolDependency, SymbolInfo } from '../types';
import { normalizePath, SpiderError } from '../types';
import { YIELD_INTERVAL_MS } from '../utils/EventLoopYield';
import { SpiderDependencyAnalyzer } from './SpiderDependencyAnalyzer';
import { SpiderIndexingCancellation } from './SpiderIndexingCancellation';
import { SpiderWorkerManager } from './SpiderWorkerManager';

const log = getLogger('SpiderIndexingService');

/**
 * Single responsibility: build and maintain the reverse index (full and incremental),
 * including status reporting and cancellation.
 */
export class SpiderIndexingService {
  constructor(
    private readonly dependencyAnalyzer: SpiderDependencyAnalyzer,
    private readonly dependencyCache: Cache<Dependency[]>,
    private readonly reverseIndexManager: ReverseIndexManager,
    private readonly sourceFileCollector: SourceFileCollector,
    private readonly indexerStatus: IndexerStatus,
    private readonly workerManager: SpiderWorkerManager,
    private readonly cancellation: SpiderIndexingCancellation,
    private readonly getConfig: () => SpiderConfig,
    private readonly yieldToEventLoop: () => Promise<void>,
    private readonly getSymbolGraph?: (filePath: string) => Promise<{ symbols: SymbolInfo[]; dependencies: SymbolDependency[] }>
  ) {}

  cancel(): void {
    this.cancellation.cancel();
    this.workerManager.cancel();
  }

  disposeWorker(): void {
    this.workerManager.dispose();
  }

  /**
   * Analyze a single file and update the reverse index.
   * Handles both file dependencies and symbol dependencies.
   * @param filePath - Path to the file to analyze
   * @param processedCount - Number of files already processed (for symbol analysis limit)
   * @returns true if analysis succeeded, false otherwise
   */
  private async analyzeFileForIndex(filePath: string, processedCount: number): Promise<boolean> {
    try {
      await this.dependencyAnalyzer.analyze(filePath);

      // Also analyze symbols if getSymbolGraph is provided and within limit
      if (this.getSymbolGraph && processedCount < (this.getConfig().maxSymbolAnalyzerFiles ?? 100)) {
        try {
          const symbolGraph = await this.getSymbolGraph(filePath);
          if (symbolGraph.dependencies.length > 0) {
            this.reverseIndexManager.addSymbolDependencies(filePath, symbolGraph.dependencies);
          }
        } catch {
          // Skip files where symbol analysis fails (non-TypeScript/Python/Rust, etc.)
        }
      }
      return true;
    } catch {
      // Skip failed files (malformed/binary/inaccessible)
      return false;
    }
  }

  /**
   * Check if indexing was cancelled and update status accordingly.
   * @param processed - Number of files processed so far
   * @returns Indexing result if cancelled, undefined otherwise
   */
  private checkCancellation(processed: number): { indexedFiles: number; duration: number; cancelled: boolean } | undefined {
    if (!this.cancellation.isCancelled()) {
      return undefined;
    }

    this.indexerStatus.setCancelled();
    return {
      indexedFiles: processed,
      duration: Date.now() - (this.indexerStatus.getSnapshot().startTime ?? Date.now()),
      cancelled: true,
    };
  }

  async buildFullIndex(
    progressCallback?: IndexingProgressCallback
  ): Promise<{ indexedFiles: number; duration: number; cancelled: boolean }> {
    this.reverseIndexManager.ensure();
    this.cancellation.reset();

    this.indexerStatus.startCounting();
    const allFiles = await this.sourceFileCollector.collectAllSourceFiles(this.getConfig().rootDir);

    const cancellationResult = this.checkCancellation(0);
    if (cancellationResult) {
      return cancellationResult;
    }

    const totalFiles = allFiles.length;
    this.indexerStatus.setTotal(totalFiles);
    await this.yieldToEventLoop();

    this.indexerStatus.startIndexing();
    let processed = 0;
    let lastYieldTime = Date.now();

    try {
      for (const filePath of allFiles) {
        const cancellationResult = this.checkCancellation(processed);
        if (cancellationResult) {
          return cancellationResult;
        }

        await this.analyzeFileForIndex(filePath, processed);

        processed++;
        this.indexerStatus.updateProgress(processed, filePath);
        progressCallback?.(processed, totalFiles, filePath);

        const now = Date.now();
        if (now - lastYieldTime >= YIELD_INTERVAL_MS) {
          await this.yieldToEventLoop();
          lastYieldTime = Date.now();
        }
      }

      this.indexerStatus.complete();
      const snapshot = this.indexerStatus.getSnapshot();
      const duration = Date.now() - (snapshot.startTime ?? Date.now());

      return { indexedFiles: processed, duration, cancelled: false };
    } catch (error) {
      const spiderError = SpiderError.fromError(error);
      this.indexerStatus.setError(spiderError.toUserMessage());
      log.error('Indexing failed:', spiderError.toUserMessage(), spiderError.code);
      throw spiderError;
    }
  }

  async buildFullIndexInWorker(
    workerPath: string,
    progressCallback?: IndexingProgressCallback
  ): Promise<{ indexedFiles: number; duration: number; cancelled: boolean }> {
    const config = this.getConfig();
    return this.workerManager.buildFullIndexInWorker({
      workerPath,
      progressCallback,
      config: {
        rootDir: config.rootDir,
        excludeNodeModules: config.excludeNodeModules,
        tsConfigPath: config.tsConfigPath,
        progressInterval: config.indexingProgressInterval,
      },
    });
  }

  async reindexStaleFiles(staleFiles: string[], progressCallback?: IndexingProgressCallback): Promise<number> {
    if (!this.reverseIndexManager.isEnabled()) {
      return 0;
    }

    log.info(`Re-indexing ${staleFiles.length} stale files`);

    const concurrency = this.getConfig().indexingConcurrency ?? 8;
    let processed = 0;

    for (let i = 0; i < staleFiles.length; i += concurrency) {
      const batch = staleFiles.slice(i, i + concurrency);

      await Promise.all(
        batch.map(async (filePath) => {
          const normalized = normalizePath(filePath);
          log.debug(`Re-indexing stale file: ${filePath}`);
          try {
            this.reverseIndexManager.removeDependenciesFromSource(normalized);
            this.dependencyCache.delete(normalized);
            log.debug(`Deleted cache for ${filePath}, re-analyzing...`);
            await this.dependencyAnalyzer.analyze(filePath);
            log.debug(`Successfully re-analyzed ${filePath}`);
          } catch (error) {
            log.error(`Failed to re-index ${filePath}:`, error);
            this.reverseIndexManager.removeDependenciesFromSource(normalized);
          }
        })
      );

      processed += batch.length;
      progressCallback?.(processed, staleFiles.length, batch.at(-1));
      await this.yieldToEventLoop();
    }

    log.info(`Completed re-indexing ${processed} files`);
    return processed;
  }
}
