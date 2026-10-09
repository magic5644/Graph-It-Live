import * as vscode from 'vscode';
import * as path from 'node:path';
import { IndexCache, type ReverseIndexOptions } from '../../analyzer/cache/IndexCache';
import { Spider } from '../../analyzer/Spider';
import { reportOutOfRootImports } from '../../analyzer/utils/workspaceBoundary';

type Logger = {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
  debug: (message: string, ...args: unknown[]) => void;
};

export interface BackgroundIndexingConfig extends ReverseIndexOptions {
  enableBackgroundIndexing: boolean;
  indexingStartDelay: number;
}

interface BackgroundIndexingManagerOptions {
  context: vscode.ExtensionContext;
  extensionUri: vscode.Uri;
  spider: Spider;
  logger: Logger;
  onIndexingComplete: () => Promise<void>;
  initialConfig: BackgroundIndexingConfig;
}

/** Where versions before the shared .graph-it/cache/ kept the index; cleared on start. */
const LEGACY_REVERSE_INDEX_STORAGE_KEY = 'graph-it-live.reverseIndex';
const WORKER_SCRIPT_PATH = 'dist/indexerWorker.js';

export class BackgroundIndexingManager {
  private readonly context: vscode.ExtensionContext;
  private readonly extensionUri: vscode.Uri;
  private readonly spider: Spider;
  private readonly log: Logger;
  private readonly onIndexingComplete: () => Promise<void>;
  private _statusBarItem: vscode.StatusBarItem | null = null;
  private config: BackgroundIndexingConfig;
  private indexingStartTimer?: ReturnType<typeof setTimeout>;
  private hideStatusTimer?: ReturnType<typeof setTimeout>;
  private restoreTask: Promise<void> | null = null;
  private indexingTask: Promise<void> | null = null;
  private disposed = false;
  private disposeTask: Promise<void> | null = null;
  private cacheTask: Promise<IndexCache> | null = null;
  private outOfRootWarned = false;
  /** Set once a build finished or a restore validated: only then is the in-memory index worth writing. */
  private indexComplete = false;

  constructor(options: BackgroundIndexingManagerOptions) {
    this.context = options.context;
    this.extensionUri = options.extensionUri;
    this.spider = options.spider;
    this.log = options.logger;
    this.onIndexingComplete = options.onIndexingComplete;
    this.config = options.initialConfig;
  }

  /** Lazily creates the status bar item on first use to reduce activation overhead. */
  private get statusBarItem(): vscode.StatusBarItem {
    if (!this._statusBarItem) {
      this._statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100,
      );
      this._statusBarItem.name = 'Graph-It-Live Indexing';
      this.context.subscriptions.push(this._statusBarItem);
    }
    return this._statusBarItem;
  }

  updateConfiguration(config: BackgroundIndexingConfig): void {
    this.config = config;
  }

  scheduleDeferredIndexing(): void {
    if (this.disposed || !this.config.enableBackgroundIndexing) {
      return;
    }
    this.clearScheduledIndexing();
    this.log.info('Scheduling indexing in', this.config.indexingStartDelay, 'ms');
    this.indexingStartTimer = setTimeout(() => {
      this.indexingStartTimer = undefined;
      const task = this.tryRestoreIndex();
      this.restoreTask = task;
      void task.finally(() => {
        if (this.restoreTask === task) this.restoreTask = null;
      }).catch(() => {});
    }, this.config.indexingStartDelay);
  }

  cancelScheduledIndexing(): void {
    this.clearScheduledIndexing();
  }

  async handleConfigUpdate(hasReverseIndex: boolean): Promise<void> {
    if (this.disposed) return;
    if (!this.config.enableBackgroundIndexing) {
      await this.disableBackgroundIndexing();
      return;
    }

    if (!hasReverseIndex) {
      await this.startBackgroundIndexingWithProgress();
    }
  }

  /**
   * Write the reverse index to the shared .graph-it/cache/. Skipped while another
   * process holds the lock: it is indexing and writes a fresher index itself.
   * Also skipped while the index is partial (build cancelled, e.g. on shutdown).
   */
  async persistIndex(): Promise<void> {
    if (!this.cacheTask || !this.indexComplete) return;
    const serialized = this.spider.getSerializedReverseIndex();
    if (!serialized) return;
    const cache = await this.cacheTask;
    const release = cache.tryLock();
    if (!release) return;
    try {
      if (cache.save({ reverseIndex: { data: serialized, options: this.reverseIndexOptions() } })) {
        this.log.debug('Persisted reverse index to', cache.dir);
      }
    } finally {
      release();
    }
  }

  async disableBackgroundIndexing(): Promise<void> {
    this.cancelScheduledIndexing();
    this.spider.cancelIndexing();
    this.spider.disableReverseIndex();
    this.statusBarItem.hide();
  }

  async forceReindex(): Promise<void> {
    await this.startBackgroundIndexingWithProgress();
  }

  dispose(): Promise<void> {
    this.disposeTask ??= this.disposeResources();
    return this.disposeTask;
  }

  private async disposeResources(): Promise<void> {
    this.disposed = true;
    this.cancelScheduledIndexing();
    this.spider.cancelIndexing();
    if (this.hideStatusTimer) {
      clearTimeout(this.hideStatusTimer);
      this.hideStatusTimer = undefined;
    }
    // Only dispose if the status bar item was actually created (lazy initialization)
    this._statusBarItem?.dispose();
    await Promise.allSettled([this.restoreTask, this.indexingTask].filter((task): task is Promise<void> => task !== null));
    // Saved once on shutdown rather than on every file save: the next reader
    // re-validates file mtimes and re-indexes only what changed since.
    await this.persistIndex().catch((error: unknown) => this.log.warn('Could not persist index:', error));
  }

  /**
   * Says once per session that imports were skipped by the folder boundary, so
   * a sub-package folder does not look like the whole monorepo.
   */
  private warnOutOfRootImports(): void {
    if (this.outOfRootWarned) return;
    const { warning } = reportOutOfRootImports(this.spider.getOutOfRootImports(), this.spider.workspaceRoot);
    if (!warning) return;
    this.outOfRootWarned = true;
    this.log.warn(warning);
  }

  private clearScheduledIndexing(): void {
    if (this.indexingStartTimer) {
      clearTimeout(this.indexingStartTimer);
      this.indexingStartTimer = undefined;
    }
  }

  private reverseIndexOptions(): ReverseIndexOptions {
    return {
      excludeNodeModules: this.config.excludeNodeModules,
      ignoreTypeImports: this.config.ignoreTypeImports,
    };
  }

  private getCache(): Promise<IndexCache> {
    this.cacheTask ??= IndexCache.open(this.spider.workspaceRoot);
    return this.cacheTask;
  }

  /**
   * Restore the index the CLI, the MCP server or a previous session wrote.
   * Holds the cache lock throughout, so a process indexing right now is waited
   * for and its result restored instead of indexing the workspace a second time.
   */
  private async tryRestoreIndex(): Promise<void> {
    if (this.disposed || !this.config.enableBackgroundIndexing) {
      return;
    }
    await this.context.workspaceState.update(LEGACY_REVERSE_INDEX_STORAGE_KEY, undefined);

    const cache = await this.getCache();
    if (this.disposed) return;
    let waited = false;
    const release = await cache.lock((holderPid) => {
      waited = true;
      this.statusBarItem.text = '$(sync~spin) Graph-It-Live: Waiting for index...';
      this.statusBarItem.tooltip = `Another process (${holderPid ?? 'unknown'}) is indexing this workspace`;
      this.statusBarItem.show();
    });
    if (waited) this._statusBarItem?.hide();
    try {
      await this.restoreIndex(cache);
    } finally {
      release();
    }
  }

  private async restoreIndex(cache: IndexCache): Promise<void> {
    if (this.disposed) return;
    const storedIndex = cache.readReverseIndex(this.reverseIndexOptions());
    if (!storedIndex) {
      this.log.info('No persisted index found, starting fresh indexing');
      await this.startBackgroundIndexingWithProgress();
      return;
    }

    const restored = this.spider.enableReverseIndex(storedIndex);
    if (!restored) {
      this.log.info('Failed to restore index, starting fresh indexing');
      await this.startBackgroundIndexingWithProgress();
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'Graph-It-Live',
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: 'Validating index...' });
        // Files on disk the index never saw count as stale: an index persisted
        // mid-build otherwise validates against its own few entries only.
        const validation = await this.spider.validateReverseIndex(undefined, cache.sourceFiles);

        if (this.disposed) return;

        if (!validation || (!validation.isValid && validation.missingFiles.length > 0)) {
          this.log.info('Index is stale, re-indexing the workspace');
          await this.startBackgroundIndexingWithProgress();
          return;
        }

        const { staleFiles, missingFiles } = validation;
        if (staleFiles.length === 0 && missingFiles.length === 0) {
          this.indexComplete = true;
          this.log.info('Successfully restored and validated persisted index');
          this.warnOutOfRootImports();
          return;
        }

        progress.report({ message: `Re-indexing ${staleFiles.length} changed files...` });
        for (const deleted of missingFiles) {
          this.spider.handleFileDeleted(deleted);
        }
        await this.spider.reindexStaleFiles(staleFiles);
        if (this.disposed) return;
        this.indexComplete = true;
        await this.persistIndex();
        this.log.info('Incremental re-index complete:', staleFiles.length, 'changed,', missingFiles.length, 'deleted');
        this.warnOutOfRootImports();
      }
    );
  }

  private startBackgroundIndexingWithProgress(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.indexingTask) return this.indexingTask;
    const task = this.runBackgroundIndexingWithProgress();
    const wrappedTask = task.finally(() => {
      this.indexingTask = null;
    });
    this.indexingTask = wrappedTask;
    return wrappedTask;
  }

  private async runBackgroundIndexingWithProgress(): Promise<void> {
    if (this.disposed) return;
    const release = await (await this.getCache()).lock();
    try {
      await this.buildIndexWithProgress();
    } finally {
      release();
    }
  }

  private async buildIndexWithProgress(): Promise<void> {
    if (this.disposed) return;

    const workerPath = path.join(this.extensionUri.fsPath, WORKER_SCRIPT_PATH);

    this.statusBarItem.text = '$(sync~spin) Graph-It-Live: Counting files...';
    this.statusBarItem.tooltip = 'Indexing workspace for reverse dependency lookup';
    this.statusBarItem.show();

    const unsubscribe = this.spider.subscribeToIndexStatus((snapshot) => {
      if (this.disposed || !this._statusBarItem) return;
      if (snapshot.state === 'counting') {
        this.statusBarItem.text = '$(sync~spin) Graph-It-Live: Counting files...';
      } else if (snapshot.state === 'indexing') {
        const percent = snapshot.percentage;
        this.statusBarItem.text = `$(sync~spin) Graph-It-Live: ${percent}% (${snapshot.processed}/${snapshot.total})`;
        this.statusBarItem.tooltip = `Indexing: ${snapshot.currentFile ?? 'processing...'}`;
      }
    });

    try {
      // A build replaces the index: until it finishes, what is in memory is partial.
      this.indexComplete = false;
      const result = await this.spider.buildFullIndexInWorker(workerPath);

      if (this.disposed) return;

      if (result.cancelled) {
        this.log.info('Indexing cancelled after', result.indexedFiles, 'files');
        this.statusBarItem.text = '$(x) Graph-It-Live: Indexing cancelled';
      } else {
        this.log.info('Indexed', result.indexedFiles, 'files in', result.duration, 'ms');
        this.statusBarItem.text = `$(check) Graph-It-Live: ${result.indexedFiles} files indexed`;
        this.warnOutOfRootImports();
        this.indexComplete = true;
        await this.persistIndex();
        if (this.disposed) return;
        await this.onIndexingComplete();
        if (this.disposed) return;
      }

      if (this.hideStatusTimer) {
        clearTimeout(this.hideStatusTimer);
      }
      this.hideStatusTimer = setTimeout(() => {
        this.hideStatusTimer = undefined;
        if (!this.disposed) this.statusBarItem.hide();
      }, 3000);
    } catch (error) {
      if (this.disposed) return;
      this.log.error('Background indexing failed:', error);
      this.statusBarItem.text = '$(error) Graph-It-Live: Indexing failed';
      this.statusBarItem.tooltip = error instanceof Error ? error.message : 'Unknown error';
      if (this.hideStatusTimer) {
        clearTimeout(this.hideStatusTimer);
      }
      this.hideStatusTimer = setTimeout(() => {
        this.hideStatusTimer = undefined;
        if (!this.disposed) this.statusBarItem.hide();
      }, 5000);
      vscode.window.showErrorMessage(
        `Graph-It-Live: Indexing failed - ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } finally {
      unsubscribe();
    }
  }
}
