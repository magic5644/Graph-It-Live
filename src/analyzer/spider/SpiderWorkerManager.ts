import { Cache } from '../Cache';
import { IndexerStatus } from '../IndexerStatus';
import { IndexerWorkerHost, IndexingResult } from '../IndexerWorkerHost';
import { ReverseIndexManager } from '../ReverseIndexManager';
import { Dependency, IndexingProgressCallback, normalizePath } from '../types';

interface WorkerBuildOptions {
  workerPath: string;
  config: {
    rootDir: string;
    excludeNodeModules?: boolean;
    tsConfigPath?: string;
    progressInterval?: number;
    extensionPath?: string;
  };
  progressCallback?: IndexingProgressCallback;
}

interface BuildIndexResult {
  indexedFiles: number;
  duration: number;
  cancelled: boolean;
}

/**
 * Encapsulates the worker host lifecycle and mirrors worker updates to Spider state.
 */
export class SpiderWorkerManager {
  private workerHost: IndexerWorkerHost | null = null;

  constructor(
    private readonly indexerStatus: IndexerStatus,
    private readonly reverseIndexManager: ReverseIndexManager,
    private readonly dependencyCache: Cache<Dependency[]>
  ) {}

  /**
   * Run reverse indexing inside a Worker Thread and import the result locally.
   */
  async buildFullIndexInWorker(options: WorkerBuildOptions): Promise<BuildIndexResult> {
    const { workerPath, config, progressCallback } = options;

    this.workerHost ??= new IndexerWorkerHost(workerPath);
    this.reverseIndexManager.ensure();

    const unsubscribe = this.workerHost.subscribeToStatus((snapshot) => {
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

      if (progressCallback && snapshot.state === 'indexing') {
        progressCallback(snapshot.processed, snapshot.total, snapshot.currentFile);
      }
    });

    try {
      const result = await this.workerHost.startIndexing({
        rootDir: config.rootDir,
        excludeNodeModules: config.excludeNodeModules,
        tsConfigPath: config.tsConfigPath,
        extensionPath: config.extensionPath,
      });

      this.importWorkerResult(result);

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
   * Cancel any in-flight worker job.
   */
  cancel(): void {
    this.workerHost?.cancel();
  }

  /**
   * Dispose and release the worker resources.
   */
  dispose(): void {
    this.workerHost?.dispose();
    this.workerHost = null;
  }

  private importWorkerResult(result: IndexingResult): void {
    for (const fileData of result.data) {
      const normalizedPath = normalizePath(fileData.filePath);
      this.dependencyCache.set(normalizedPath, fileData.dependencies);
      this.reverseIndexManager.addDependencies(
        normalizedPath,
        fileData.dependencies,
        { mtime: fileData.mtime, size: fileData.size }
      );
    }
  }
}

