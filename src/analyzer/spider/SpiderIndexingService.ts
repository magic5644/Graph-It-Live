import type { Dependency, IndexingProgressCallback, SpiderConfig } from '../types';
import { normalizePath, SpiderError } from '../types';
import { getLogger } from '../../shared/logger';
import { ReverseIndexManager } from '../ReverseIndexManager';
import { SourceFileCollector } from '../SourceFileCollector';
import { IndexerStatus } from '../IndexerStatus';
import { SpiderWorkerManager } from './SpiderWorkerManager';
import { Cache } from '../Cache';
import { SpiderDependencyAnalyzer } from './SpiderDependencyAnalyzer';
import { YIELD_INTERVAL_MS } from '../utils/EventLoopYield';
import { SpiderIndexingCancellation } from './SpiderIndexingCancellation';

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
    private readonly yieldToEventLoop: () => Promise<void>
  ) {}

  cancel(): void {
    this.cancellation.cancel();
    this.workerManager.cancel();
  }

  disposeWorker(): void {
    this.workerManager.dispose();
  }

  async buildFullIndex(
    progressCallback?: IndexingProgressCallback
  ): Promise<{ indexedFiles: number; duration: number; cancelled: boolean }> {
    this.reverseIndexManager.ensure();
    this.cancellation.reset();

    this.indexerStatus.startCounting();
    const allFiles = await this.sourceFileCollector.collectAllSourceFiles(this.getConfig().rootDir);

    if (this.cancellation.isCancelled()) {
      this.indexerStatus.setCancelled();
      return { indexedFiles: 0, duration: 0, cancelled: true };
    }

    const totalFiles = allFiles.length;
    this.indexerStatus.setTotal(totalFiles);
    await this.yieldToEventLoop();

    this.indexerStatus.startIndexing();
    let processed = 0;
    let lastYieldTime = Date.now();

    try {
      for (const filePath of allFiles) {
        if (this.cancellation.isCancelled()) {
          this.indexerStatus.setCancelled();
          return {
            indexedFiles: processed,
            duration: Date.now() - (this.indexerStatus.getSnapshot().startTime ?? Date.now()),
            cancelled: true,
          };
        }

        try {
          await this.dependencyAnalyzer.analyze(filePath);
        } catch {
          // Skip failed files (malformed/binary/inaccessible)
        }

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

