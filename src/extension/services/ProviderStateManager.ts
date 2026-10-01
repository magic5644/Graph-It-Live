import * as vscode from 'vscode';
import type { BackgroundIndexingConfig } from './BackgroundIndexingManager';

export type UnusedDependencyMode = 'none' | 'hide' | 'dim';
export type PerformanceProfile = 'default' | 'low-memory' | 'high-performance' | 'custom';
export type ViewMode = 'file' | 'list' | 'symbol' | 'callgraph';

export interface ProviderConfigSnapshot extends BackgroundIndexingConfig {
  excludeNodeModules: boolean;
  maxDepth: number;
  indexingConcurrency: number;
  ignoreTypeImports: boolean;
  unusedDependencyMode: UnusedDependencyMode;
  unusedAnalysisConcurrency: number;
  unusedAnalysisMaxEdges: number;
  persistUnusedAnalysisCache: boolean;
  maxUnusedAnalysisCacheSize: number;
  maxCacheSize: number;
  maxSymbolCacheSize: number;
  performanceProfile: PerformanceProfile;
  showCommunities: boolean;
}

type ProfileTuning = Pick<
  ProviderConfigSnapshot,
  | 'indexingConcurrency'
  | 'unusedAnalysisConcurrency'
  | 'unusedAnalysisMaxEdges'
  | 'persistUnusedAnalysisCache'
  | 'maxUnusedAnalysisCacheSize'
  | 'maxCacheSize'
  | 'maxSymbolCacheSize'
>;

// The custom profile starts from the default values
const PROFILE_DEFAULTS: Record<Exclude<PerformanceProfile, 'custom'>, ProfileTuning> = {
  'low-memory': {
    indexingConcurrency: 2,
    unusedAnalysisConcurrency: 2,
    unusedAnalysisMaxEdges: 1000,
    persistUnusedAnalysisCache: false,
    maxUnusedAnalysisCacheSize: 100,
    maxCacheSize: 200,
    maxSymbolCacheSize: 100,
  },
  default: {
    indexingConcurrency: 4,
    unusedAnalysisConcurrency: 4,
    unusedAnalysisMaxEdges: 2000,
    persistUnusedAnalysisCache: false,
    maxUnusedAnalysisCacheSize: 200,
    maxCacheSize: 500,
    maxSymbolCacheSize: 200,
  },
  'high-performance': {
    indexingConcurrency: 8,
    unusedAnalysisConcurrency: 12,
    unusedAnalysisMaxEdges: 5000,
    persistUnusedAnalysisCache: false,
    maxUnusedAnalysisCacheSize: 500,
    maxCacheSize: 1500,
    maxSymbolCacheSize: 800,
  },
};

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
    const profileValues = PROFILE_DEFAULTS[profile as keyof typeof PROFILE_DEFAULTS] ?? PROFILE_DEFAULTS.default;
    // Only the custom profile reads the advanced override settings
    const tuning: ProfileTuning = profile === 'custom'
      ? {
          indexingConcurrency: config.get('indexingConcurrency', profileValues.indexingConcurrency),
          unusedAnalysisConcurrency: config.get('unusedAnalysisConcurrency', profileValues.unusedAnalysisConcurrency),
          unusedAnalysisMaxEdges: config.get('unusedAnalysisMaxEdges', profileValues.unusedAnalysisMaxEdges),
          persistUnusedAnalysisCache: config.get('persistUnusedAnalysisCache', profileValues.persistUnusedAnalysisCache),
          maxUnusedAnalysisCacheSize: config.get('maxUnusedAnalysisCacheSize', profileValues.maxUnusedAnalysisCacheSize),
          maxCacheSize: config.get('maxCacheSize', profileValues.maxCacheSize),
          maxSymbolCacheSize: config.get('maxSymbolCacheSize', profileValues.maxSymbolCacheSize),
        }
      : profileValues;

    return {
      excludeNodeModules: config.get<boolean>('excludeNodeModules', true),
      maxDepth: config.get<number>('maxDepth', 50),
      enableBackgroundIndexing: config.get<boolean>('enableBackgroundIndexing', true),
      indexingStartDelay: config.get<number>('indexingStartDelay', this.defaultIndexingDelay),
      ignoreTypeImports: config.get<boolean>('ignoreTypeImports', false),
      unusedDependencyMode: config.get<'none' | 'hide' | 'dim'>('unusedDependencyMode', 'none'),
      ...tuning,
      performanceProfile: profile,
      showCommunities: config.get<boolean>('showCommunities', true),
    };
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
