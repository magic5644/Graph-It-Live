import * as vscode from 'vscode';
import {WATCH_GLOB} from '../../shared/constants';
import { Spider } from '../../analyzer/Spider';

type Logger = {
  debug: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
};

interface SymbolViewController {
  getCurrent: () => string | undefined;
  refresh: (filePath: string) => Promise<void>;
  clear: () => void;
}

interface SourceFileWatcherOptions {
  context: vscode.ExtensionContext;
  spider: Spider;
  logger: Logger;
  symbolView: SymbolViewController;
  refreshFileView: () => void;
  persistIndex: () => Promise<void>;
}


export class SourceFileWatcher {
  private readonly spider: Spider;
  private readonly logger: Logger;
  private readonly symbolView: SymbolViewController;
  private readonly refreshFileView: () => void;
  private readonly persistIndex: () => Promise<void>;
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly debounceDelay = 200;

  constructor(options: SourceFileWatcherOptions) {
    this.spider = options.spider;
    this.logger = options.logger;
    this.symbolView = options.symbolView;
    this.refreshFileView = options.refreshFileView;
    this.persistIndex = options.persistIndex;

    this.watcher = vscode.workspace.createFileSystemWatcher(WATCH_GLOB);

    this.watcher.onDidCreate((uri) => {
      this.scheduleScan('create', uri.fsPath);
    });

    this.watcher.onDidChange((uri) => {
      this.scheduleScan('change', uri.fsPath);
    });

    this.watcher.onDidDelete((uri) => {
      this.scheduleScan('delete', uri.fsPath);
    });

    options.context.subscriptions.push(this.watcher);
  }

  dispose(): void {
    this.watcher.dispose();
    for (const timeout of this.pending.values()) {
      clearTimeout(timeout);
    }
    this.pending.clear();
  }

  private scheduleScan(event: 'create' | 'change' | 'delete', filePath: string): void {
    const existing = this.pending.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }

    const timeout = setTimeout(() => {
      this.pending.delete(filePath);
      void this.processEvent(event, filePath);
    }, this.debounceDelay);

    this.pending.set(filePath, timeout);
  }

  private async processEvent(event: 'create' | 'change' | 'delete', filePath: string): Promise<void> {
    switch (event) {
      case 'create':
        await this.handleCreate(filePath);
        break;
      case 'change':
        await this.handleChange(filePath);
        break;
      case 'delete':
        await this.handleDelete(filePath);
        break;
    }
  }

  private async handleCreate(filePath: string): Promise<void> {
    this.logger.debug('File created:', filePath);
    await this.spider.reanalyzeFile(filePath);
    await this.persistIndex();
    await this.refreshByCurrentView();
  }

  private async handleChange(filePath: string): Promise<void> {
    this.logger.debug('File changed externally:', filePath);
    await this.spider.reanalyzeFile(filePath);
    await this.persistIndex();
    await this.refreshByCurrentView();
  }

  private async handleDelete(filePath: string): Promise<void> {
    this.logger.debug('File deleted:', filePath);
    this.spider.handleFileDeleted(filePath);
    await this.persistIndex();

    const currentSymbol = this.symbolView.getCurrent();
    if (currentSymbol) {
      if (currentSymbol === filePath) {
        this.symbolView.clear();
        this.refreshFileView();
      } else {
        await this.symbolView.refresh(currentSymbol);
      }
      return;
    }

    this.refreshFileView();
  }

  private async refreshByCurrentView(): Promise<void> {
    const currentSymbol = this.symbolView.getCurrent();
    if (currentSymbol) {
      await this.symbolView.refresh(currentSymbol);
    } else {
      this.refreshFileView();
    }
  }
}
