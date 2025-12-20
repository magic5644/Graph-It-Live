import * as vscode from 'vscode';
import {WATCH_GLOB} from '../../shared/constants';
import type { FileChangeScheduler } from './FileChangeScheduler';

type Logger = {
  debug: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
};

interface SourceFileWatcherOptions {
  context: vscode.ExtensionContext;
  logger: Logger;
  fileChangeScheduler: FileChangeScheduler;
}


export class SourceFileWatcher {
  private readonly logger: Logger;
  private readonly fileChangeScheduler: FileChangeScheduler;
  private readonly watcher: vscode.FileSystemWatcher;

  constructor(options: SourceFileWatcherOptions) {
    this.logger = options.logger;
    this.fileChangeScheduler = options.fileChangeScheduler;

    this.watcher = vscode.workspace.createFileSystemWatcher(WATCH_GLOB);

    this.watcher.onDidCreate((uri) => {
      this.logger.debug('File created (external):', uri.fsPath);
      this.fileChangeScheduler.enqueue(uri.fsPath, 'create');
    });

    this.watcher.onDidChange((uri) => {
      this.logger.debug('File changed (external):', uri.fsPath);
      this.fileChangeScheduler.enqueue(uri.fsPath, 'change');
    });

    this.watcher.onDidDelete((uri) => {
      this.logger.debug('File deleted (external):', uri.fsPath);
      this.fileChangeScheduler.enqueue(uri.fsPath, 'delete');
    });

    options.context.subscriptions.push(this.watcher);
  }

  dispose(): void {
    this.watcher.dispose();
  }
}
