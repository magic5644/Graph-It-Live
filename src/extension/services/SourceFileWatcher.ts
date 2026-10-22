import * as vscode from 'vscode';
import { ARCHITECTURE_RULES_GLOB, WATCH_GLOB } from '../../shared/constants';
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
  private readonly watchers: vscode.FileSystemWatcher[];

  constructor(options: SourceFileWatcherOptions) {
    this.logger = options.logger;
    this.fileChangeScheduler = options.fileChangeScheduler;

    // Architecture rule files are JSON, outside the source glob, yet edits to them make the Architecture view stale.
    this.watchers = [WATCH_GLOB, ARCHITECTURE_RULES_GLOB].map((glob) => vscode.workspace.createFileSystemWatcher(glob));

    const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.vscode-test']);
    const isIgnored = (uri: vscode.Uri) => uri.fsPath.split(/[\\/]/).some(segment => ignoredDirectories.has(segment));

    for (const watcher of this.watchers) {
      watcher.onDidCreate((uri) => {
        if (isIgnored(uri)) return;
        this.logger.debug('File created (external):', uri.fsPath);
        this.fileChangeScheduler.enqueue(uri.fsPath, 'create');
      });

      watcher.onDidChange((uri) => {
        if (isIgnored(uri)) return;
        this.logger.debug('File changed (external):', uri.fsPath);
        this.fileChangeScheduler.enqueue(uri.fsPath, 'change');
      });

      watcher.onDidDelete((uri) => {
        if (isIgnored(uri)) return;
        this.logger.debug('File deleted (external):', uri.fsPath);
        this.fileChangeScheduler.enqueue(uri.fsPath, 'delete');
      });

      options.context.subscriptions.push(watcher);
    }
  }

  dispose(): void {
    for (const watcher of this.watchers) watcher.dispose();
  }
}
