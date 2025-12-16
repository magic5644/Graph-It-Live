import * as vscode from 'vscode';
import type { BackgroundIndexingConfig } from './BackgroundIndexingManager';

export interface ProviderConfigSnapshot extends BackgroundIndexingConfig {
  excludeNodeModules: boolean;
  maxDepth: number;
  indexingConcurrency: number;
}

export class ProviderStateManager {
  private currentSymbolFilePath?: string;
  private lastActiveFilePath?: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly defaultIndexingDelay: number
  ) {
    this.lastActiveFilePath = this.context.workspaceState?.get('lastActiveFilePath');
  }

  loadConfiguration(): ProviderConfigSnapshot {
    const config = vscode.workspace.getConfiguration('graph-it-live');
    return {
      excludeNodeModules: config.get<boolean>('excludeNodeModules', true),
      maxDepth: config.get<number>('maxDepth', 50),
      enableBackgroundIndexing: config.get<boolean>('enableBackgroundIndexing', true),
      indexingConcurrency: config.get<number>('indexingConcurrency', 4),
      indexingStartDelay: config.get<number>('indexingStartDelay', this.defaultIndexingDelay),
      persistIndex: config.get<boolean>('persistIndex', false),
    };
  }

  get currentSymbol(): string | undefined {
    return this.currentSymbolFilePath;
  }

  set currentSymbol(value: string | undefined) {
    this.currentSymbolFilePath = value;
  }

  getLastActiveFilePath(): string | undefined {
    return this.lastActiveFilePath;
  }

  async setLastActiveFilePath(filePath: string | undefined): Promise<void> {
    this.lastActiveFilePath = filePath;
    await this.context.workspaceState?.update('lastActiveFilePath', filePath);
  }

  getExpandAll(): boolean {
    return this.context.globalState.get('expandAll', false);
  }

  async setExpandAll(value: boolean): Promise<void> {
    await this.context.globalState.update('expandAll', value);
  }
}
