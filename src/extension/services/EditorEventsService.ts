import * as vscode from 'vscode';
import type { GraphProvider } from '../GraphProvider';
import type { VsCodeLogger } from '../extensionLogger';

interface EditorEventsServiceOptions {
  provider: GraphProvider;
  logger: VsCodeLogger;
}

/**
 * Centralizes editor/workspace event subscriptions so extension.ts stays lean.
 */
export class EditorEventsService {
  private readonly provider: GraphProvider;
  private readonly logger: VsCodeLogger;

  constructor(options: EditorEventsServiceOptions) {
    this.provider = options.provider;
    this.logger = options.logger;
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
        this.provider.updateConfig();
        this.provider.notifyMcpServerOfConfigChange?.();
      }
    });
  }

  private registerActiveEditorListener(): vscode.Disposable {
    return vscode.window.onDidChangeActiveTextEditor((editor) => {
      this.logger.debug('Active editor changed:', editor?.document.fileName);
      this.provider.onActiveFileChanged();
    });
  }

  private registerSaveListener(): vscode.Disposable {
    return vscode.workspace.onDidSaveTextDocument(async (doc) => {
      this.logger.debug('Document saved:', doc.fileName);
      await this.provider.onFileSaved(doc.fileName);
    });
  }
}
