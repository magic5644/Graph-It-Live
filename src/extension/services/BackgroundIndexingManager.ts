import * as vscode from 'vscode';
import * as path from 'node:path';
import { Spider } from '../../analyzer/Spider';

type Logger = {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
  debug: (message: string, ...args: unknown[]) => void;
};

export interface BackgroundIndexingConfig {
  enableBackgroundIndexing: boolean;
  indexingStartDelay: number;
  persistIndex: boolean;
}

interface BackgroundIndexingManagerOptions {
  context: vscode.ExtensionContext;
  extensionUri: vscode.Uri;
  spider: Spider;
  logger: Logger;
  onIndexingComplete: () => Promise<void>;
  initialConfig: BackgroundIndexingConfig;
}

const REVERSE_INDEX_STORAGE_KEY = 'graph-it-live.reverseIndex';
const WORKER_SCRIPT_PATH = 'dist/indexerWorker.js';

export class BackgroundIndexingManager {
  private readonly context: vscode.ExtensionContext;
  private readonly extensionUri: vscode.Uri;
  private readonly spider: Spider;
  private readonly log: Logger;
  private readonly onIndexingComplete: () => Promise<void>;
  private readonly statusBarItem: vscode.StatusBarItem;
  private config: BackgroundIndexingConfig;
  private isIndexing = false;
  private indexingStartTimer?: ReturnType<typeof setTimeout>;

  constructor(options: BackgroundIndexingManagerOptions) {
    this.context = options.context;
    this.extensionUri = options.extensionUri;
    this.spider = options.spider;
    this.log = options.logger;
    this.onIndexingComplete = options.onIndexingComplete;
    this.config = options.initialConfig;

    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.name = 'Graph-It-Live Indexing';
    this.context.subscriptions.push(this.statusBarItem);
  }

  updateConfiguration(config: BackgroundIndexingConfig): void {
    this.config = config;
  }

  scheduleDeferredIndexing(): void {
    if (!this.config.enableBackgroundIndexing) {
      return;
    }
    this.clearScheduledIndexing();
    this.log.info('Scheduling indexing in', this.config.indexingStartDelay, 'ms');
    this.indexingStartTimer = setTimeout(() => {
      void this.tryRestoreIndex();
    }, this.config.indexingStartDelay);
  }

  cancelScheduledIndexing(): void {
    this.clearScheduledIndexing();
  }

  async handleConfigUpdate(hasReverseIndex: boolean): Promise<void> {
    if (!this.config.enableBackgroundIndexing) {
      await this.disableBackgroundIndexing();
      return;
    }

    if (!hasReverseIndex) {
      await this.startBackgroundIndexingWithProgress();
    }
  }

  async persistIndexIfEnabled(): Promise<void> {
    if (!this.config.persistIndex) {
      return;
    }
    const serialized = this.spider.getSerializedReverseIndex();
    if (serialized) {
      await this.context.workspaceState.update(REVERSE_INDEX_STORAGE_KEY, serialized);
      this.log.debug('Persisted reverse index to workspace state');
    }
  }

  async disableBackgroundIndexing(): Promise<void> {
    this.cancelScheduledIndexing();
    this.spider.cancelIndexing();
    this.spider.disableReverseIndex();
    await this.context.workspaceState.update(REVERSE_INDEX_STORAGE_KEY, undefined);
    this.statusBarItem.hide();
  }

  async forceReindex(): Promise<void> {
    await this.startBackgroundIndexingWithProgress();
  }

  dispose(): void {
    this.cancelScheduledIndexing();
    this.statusBarItem.dispose();
  }

  private clearScheduledIndexing(): void {
    if (this.indexingStartTimer) {
      clearTimeout(this.indexingStartTimer);
      this.indexingStartTimer = undefined;
    }
  }

  private async tryRestoreIndex(): Promise<void> {
    if (!this.config.enableBackgroundIndexing) {
      return;
    }

    if (!this.config.persistIndex) {
      await this.startBackgroundIndexingWithProgress();
      return;
    }

    const storedIndex = this.context.workspaceState.get<string>(REVERSE_INDEX_STORAGE_KEY);
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
        const validation = await this.spider.validateReverseIndex();

        if (validation?.isValid) {
          this.log.info('Successfully restored and validated persisted index');
          return;
        }

        const staleCount = validation ? validation.staleFiles.length + validation.missingFiles.length : 0;
        this.log.info('Index is stale, re-indexing', staleCount, 'files');

        if (validation && validation.staleFiles.length > 0 && validation.missingFiles.length === 0) {
          progress.report({ message: `Re-indexing ${validation.staleFiles.length} changed files...` });
          await this.spider.reindexStaleFiles(validation.staleFiles);
          await this.persistIndexIfEnabled();
          this.log.info('Incremental re-index complete');
        } else {
          await this.startBackgroundIndexingWithProgress();
        }
      }
    );
  }

  private async startBackgroundIndexingWithProgress(): Promise<void> {
    if (this.isIndexing) {
      return;
    }
    this.isIndexing = true;

    const workerPath = path.join(this.extensionUri.fsPath, WORKER_SCRIPT_PATH);

    this.statusBarItem.text = '$(sync~spin) Graph-It-Live: Counting files...';
    this.statusBarItem.tooltip = 'Indexing workspace for reverse dependency lookup';
    this.statusBarItem.show();

    const unsubscribe = this.spider.subscribeToIndexStatus((snapshot) => {
      if (snapshot.state === 'counting') {
        this.statusBarItem.text = '$(sync~spin) Graph-It-Live: Counting files...';
      } else if (snapshot.state === 'indexing') {
        const percent = snapshot.percentage;
        this.statusBarItem.text = `$(sync~spin) Graph-It-Live: ${percent}% (${snapshot.processed}/${snapshot.total})`;
        this.statusBarItem.tooltip = `Indexing: ${snapshot.currentFile ?? 'processing...'}`;
      }
    });

    try {
      const result = await this.spider.buildFullIndexInWorker(workerPath);

      if (result.cancelled) {
        this.log.info('Indexing cancelled after', result.indexedFiles, 'files');
        this.statusBarItem.text = '$(x) Graph-It-Live: Indexing cancelled';
      } else {
        this.log.info('Indexed', result.indexedFiles, 'files in', result.duration, 'ms');
        this.statusBarItem.text = `$(check) Graph-It-Live: ${result.indexedFiles} files indexed`;
        await this.persistIndexIfEnabled();
        await this.onIndexingComplete();
      }

      setTimeout(() => {
        this.statusBarItem.hide();
      }, 3000);
    } catch (error) {
      this.log.error('Background indexing failed:', error);
      this.statusBarItem.text = '$(error) Graph-It-Live: Indexing failed';
      this.statusBarItem.tooltip = error instanceof Error ? error.message : 'Unknown error';
      setTimeout(() => this.statusBarItem.hide(), 5000);
      vscode.window.showErrorMessage(
        `Graph-It-Live: Indexing failed - ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } finally {
      unsubscribe();
      this.isIndexing = false;
    }
  }
}
