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

}
