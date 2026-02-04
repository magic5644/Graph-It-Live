import * as vscode from 'vscode';
import type { VsCodeLogger } from '../extensionLogger';
import type { FileChangeScheduler } from './FileChangeScheduler';
import type { ProviderStateManager } from './ProviderStateManager';

export interface EditorEventsTarget {
  updateConfig(): void;
  notifyMcpServerOfConfigChange?: () => void;
  onActiveFileChanged(): Promise<void>;
  refreshCurrentGraphView(): Promise<void>;
  stateManager: ProviderStateManager;
}

interface EditorEventsServiceOptions {
  target: EditorEventsTarget;
  logger: VsCodeLogger;
  fileChangeScheduler: FileChangeScheduler;
}

/**
 * Centralizes editor/workspace event subscriptions so extension.ts stays lean.
 */
export class EditorEventsService {
  private readonly target: EditorEventsTarget;
  private readonly logger: VsCodeLogger;
  private readonly fileChangeScheduler: FileChangeScheduler;

  constructor(options: EditorEventsServiceOptions) {
    this.target = options.target;
    this.logger = options.logger;
    this.fileChangeScheduler = options.fileChangeScheduler;
  }

  register(): vscode.Disposable[] {
    return [
      this.registerConfigChangeListener(),
      this.registerActiveEditorListener(),
      this.registerSaveListener(),
      this.registerCursorPositionListener(),
    ];
  }

  private registerConfigChangeListener(): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('graph-it-live')) {
        this.target.updateConfig();
        this.target.notifyMcpServerOfConfigChange?.();
      }
    });
  }

  private registerActiveEditorListener(): vscode.Disposable {
    return vscode.window.onDidChangeActiveTextEditor((editor) => {
      this.logger.debug('Active editor changed:', editor?.document.fileName);
      this.target.onActiveFileChanged();
    });
  }

  private registerSaveListener(): vscode.Disposable {
    return vscode.workspace.onDidSaveTextDocument((doc) => {
      this.logger.debug('Document saved:', doc.fileName);
      // Delegate to scheduler instead of direct processing
      this.fileChangeScheduler.enqueue(doc.fileName, 'change');
    });
  }

  /**
   * Register listener for cursor position changes
   * Refreshes LSP analysis when user navigates within a symbol view
   */
  private registerCursorPositionListener(): vscode.Disposable {
    let debounceTimer: NodeJS.Timeout | undefined;
    let lastRefreshTime = 0;
    const MIN_REFRESH_INTERVAL = 1000; // Minimum 1 second between refreshes

    return vscode.window.onDidChangeTextEditorSelection((event) => {
      // Only process if currently viewing symbols
      const stateManager = this.target.stateManager;
      if (stateManager.viewMode !== 'symbol' || !stateManager.currentFilePath) {
        return;
      }

      // Don't refresh if we just refreshed recently
      const now = Date.now();
      if (now - lastRefreshTime < MIN_REFRESH_INTERVAL) {
        return;
      }

      // Debounce to avoid excessive LSP calls while user is navigating
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = setTimeout(() => {
        this.logger.debug(`Cursor position changed in ${event.textEditor.document.fileName}`);
        // Trigger refresh of symbol view to update LSP analysis
        lastRefreshTime = Date.now();
        this.target.refreshCurrentGraphView();
        debounceTimer = undefined;
      }, 500); // Wait 500ms after user stops moving cursor
    });
  }
}
