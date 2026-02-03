import * as vscode from 'vscode';
import type { BackgroundIndexingConfig } from './BackgroundIndexingManager';

export type UnusedDependencyMode = 'none' | 'hide' | 'dim';
export type PerformanceProfile = 'default' | 'low-memory' | 'high-performance' | 'custom';
export type ViewMode = 'file' | 'list' | 'symbol';

export interface ProviderConfigSnapshot extends BackgroundIndexingConfig {
  excludeNodeModules: boolean;
  maxDepth: number;
  indexingConcurrency: number;
  unusedDependencyMode: UnusedDependencyMode;
  unusedAnalysisConcurrency: number;
  unusedAnalysisMaxEdges: number;
  persistUnusedAnalysisCache: boolean;
  maxUnusedAnalysisCacheSize: number;
  maxCacheSize: number;
  maxSymbolCacheSize: number;
  performanceProfile: PerformanceProfile;
}

export class ProviderStateManager {
  private _viewMode: ViewMode = 'file';
  private _currentFilePath?: string;
  private lastActiveFilePath?: string;
  private _selectedSymbolId?: string;
  private readonly symbolReferencingFilesCache = new Map<string, Set<string>>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly defaultIndexingDelay: number
  ) {
    this.lastActiveFilePath = this.context.workspaceState?.get('lastActiveFilePath');
    this._viewMode = this.context.globalState.get('viewMode', 'file');
    this._currentFilePath = this.context.workspaceState?.get('currentFilePath');
  }

  loadConfiguration(): ProviderConfigSnapshot {
    const config = vscode.workspace.getConfiguration('graph-it-live');
    const profile = config.get<PerformanceProfile>('performanceProfile', 'default');
    
    // Apply performance profile defaults
    const profileDefaults = this.getProfileDefaults(profile);
    
    // For non-custom profiles, use profile defaults regardless of config values
    // For custom profile, use actual config values
    const isCustomProfile = profile === 'custom';
    
    return {
      excludeNodeModules: config.get<boolean>('excludeNodeModules', true),
      maxDepth: config.get<number>('maxDepth', 50),
      enableBackgroundIndexing: config.get<boolean>('enableBackgroundIndexing', true),
      indexingConcurrency: isCustomProfile 
        ? config.get<number>('indexingConcurrency', profileDefaults.indexingConcurrency)
        : profileDefaults.indexingConcurrency,
      indexingStartDelay: config.get<number>('indexingStartDelay', this.defaultIndexingDelay),
      persistIndex: config.get<boolean>('persistIndex', false),
      unusedDependencyMode: config.get<'none' | 'hide' | 'dim'>('unusedDependencyMode', 'none'),
      unusedAnalysisConcurrency: isCustomProfile
        ? config.get<number>('unusedAnalysisConcurrency', profileDefaults.unusedAnalysisConcurrency)
        : profileDefaults.unusedAnalysisConcurrency,
      unusedAnalysisMaxEdges: isCustomProfile
        ? config.get<number>('unusedAnalysisMaxEdges', profileDefaults.unusedAnalysisMaxEdges)
        : profileDefaults.unusedAnalysisMaxEdges,
      persistUnusedAnalysisCache: config.get<boolean>('persistUnusedAnalysisCache', false),
      maxUnusedAnalysisCacheSize: config.get<number>('maxUnusedAnalysisCacheSize', 200),
      maxCacheSize: isCustomProfile
        ? config.get<number>('maxCacheSize', profileDefaults.maxCacheSize)
        : profileDefaults.maxCacheSize,
      maxSymbolCacheSize: isCustomProfile
        ? config.get<number>('maxSymbolCacheSize', profileDefaults.maxSymbolCacheSize)
        : profileDefaults.maxSymbolCacheSize,
      performanceProfile: profile,
    };
  }

  private getProfileDefaults(profile: PerformanceProfile): {
    indexingConcurrency: number;
    unusedAnalysisConcurrency: number;
    unusedAnalysisMaxEdges: number;
    maxCacheSize: number;
    maxSymbolCacheSize: number;
  } {
    switch (profile) {
      case 'low-memory':
        return {
          indexingConcurrency: 2,
          unusedAnalysisConcurrency: 2,
          unusedAnalysisMaxEdges: 1000,
          maxCacheSize: 200,
          maxSymbolCacheSize: 100,
        };
      case 'high-performance':
        return {
          indexingConcurrency: 8,
          unusedAnalysisConcurrency: 12,
          unusedAnalysisMaxEdges: 5000,
          maxCacheSize: 1500,
          maxSymbolCacheSize: 800,
        };
      case 'custom':
      case 'default':
      default:
        return {
          indexingConcurrency: 4,
          unusedAnalysisConcurrency: 4,
          unusedAnalysisMaxEdges: 2000,
          maxCacheSize: 500,
          maxSymbolCacheSize: 200,
        };
    }
  }

  /**
   * Apply performance profile settings to VS Code configuration
   * This is called when a user selects a preset profile to update the settings UI
   */
  async applyProfileSettings(profile: PerformanceProfile): Promise<void> {
    if (profile === 'custom') {
      // Don't override settings for custom profile
      return;
    }

    const defaults = this.getProfileDefaults(profile);
    const config = vscode.workspace.getConfiguration('graph-it-live');
    
    // Update all performance-related settings
    await Promise.all([
      config.update('indexingConcurrency', defaults.indexingConcurrency, vscode.ConfigurationTarget.Global),
      config.update('unusedAnalysisConcurrency', defaults.unusedAnalysisConcurrency, vscode.ConfigurationTarget.Global),
      config.update('unusedAnalysisMaxEdges', defaults.unusedAnalysisMaxEdges, vscode.ConfigurationTarget.Global),
      config.update('maxCacheSize', defaults.maxCacheSize, vscode.ConfigurationTarget.Global),
      config.update('maxSymbolCacheSize', defaults.maxSymbolCacheSize, vscode.ConfigurationTarget.Global),
    ]);
  }

  get currentSymbol(): string | undefined {
    // Backward compatibility: return selectedSymbolId when in symbol mode
    return this._viewMode === 'symbol' ? this._selectedSymbolId : undefined;
  }

  set currentSymbol(value: string | undefined) {
    // Backward compatibility: automatically switch mode based on value
    // Note: Prefer using setViewMode + selectedSymbolId for new code
    this._selectedSymbolId = value;

    // Auto-switch mode for backward compatibility
    if (value === undefined) {
      this._viewMode = 'file';
    } else {
      this._viewMode = 'symbol';
    }
  }

  get viewMode(): ViewMode {
    return this._viewMode;
  }

  async setViewMode(mode: ViewMode): Promise<void> {
    this._viewMode = mode;
    await this.context.globalState.update('viewMode', mode);
  }

  get currentFilePath(): string | undefined {
    return this._currentFilePath;
  }

  async setCurrentFilePath(filePath: string | undefined): Promise<void> {
    this._currentFilePath = filePath;
    await this.context.workspaceState?.update('currentFilePath', filePath);
  }

  get selectedSymbolId(): string | undefined {
    return this._selectedSymbolId;
  }

  set selectedSymbolId(value: string | undefined) {
    this._selectedSymbolId = value;
  }

  getSymbolReferencingFiles(symbolId: string): Set<string> | undefined {
    return this.symbolReferencingFilesCache.get(symbolId);
  }

  setSymbolReferencingFiles(symbolId: string, files: Set<string>): void {
    this.symbolReferencingFilesCache.set(symbolId, files);
  }

  invalidateSymbolCache(filePath: string): void {
    // Invalidate all cache entries that may have been affected by this file change
    for (const symbolId of this.symbolReferencingFilesCache.keys()) {
      // If the symbolId starts with the filePath, it's from this file
      if (symbolId.startsWith(filePath)) {
        this.symbolReferencingFilesCache.delete(symbolId);
      }
    }
  }

  clearSymbolCache(): void {
    this.symbolReferencingFilesCache.clear();
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

  getUnusedFilterActive(): boolean {
    return this.context.globalState.get('unusedFilterActive', false);
  }

  async setUnusedFilterActive(value: boolean): Promise<void> {
    await this.context.globalState.update('unusedFilterActive', value);
  }
}
