import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderStateManager } from '../../src/extension/services/ProviderStateManager';

const configValues: Record<string, unknown> = {
  excludeNodeModules: false,
  maxDepth: 25,
  enableBackgroundIndexing: true,
  indexingConcurrency: 8,
  indexingStartDelay: 2000,
  persistIndex: true,
};

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: <T>(key: string, defaultValue: T) =>
        (configValues[key] as T | undefined) ?? defaultValue,
    })),
  },
}));

describe('ProviderStateManager', () => {
  const workspaceStateGet = vi.fn();
  const workspaceStateUpdate = vi.fn();
  const globalStateGet = vi.fn((_, defaultValue) => defaultValue);
  const globalStateUpdate = vi.fn();

  const context = {
    workspaceState: {
      get: workspaceStateGet,
      update: workspaceStateUpdate,
    },
    globalState: {
      get: globalStateGet,
      update: globalStateUpdate,
    },
  } as unknown as import('vscode').ExtensionContext;

  beforeEach(() => {
    workspaceStateGet.mockClear();
    workspaceStateUpdate.mockClear();
    globalStateGet.mockClear();
    globalStateUpdate.mockClear();
  });

  it('loads configuration with workspace overrides', () => {
    const manager = new ProviderStateManager(context, 1000);
    const snapshot = manager.loadConfiguration();

    expect(snapshot.excludeNodeModules).toBe(false);
    expect(snapshot.maxDepth).toBe(25);
    expect(snapshot.enableBackgroundIndexing).toBe(true);
    expect(snapshot.indexingStartDelay).toBe(2000);
  });

  it('tracks current symbol path', () => {
    const manager = new ProviderStateManager(context, 1000);
    manager.currentSymbol = '/workspace/src/app.ts:foo';
    expect(manager.currentSymbol).toBe('/workspace/src/app.ts:foo');
  });

  it('viewMode getter returns correct mode', () => {
    const manager = new ProviderStateManager(context, 1000);
    // Default should be 'file'
    expect(manager.viewMode).toBe('file');
  });

  it('viewMode setter updates mode and persists to globalState', async () => {
    const manager = new ProviderStateManager(context, 1000);
    await manager.setViewMode('list');
    expect(manager.viewMode).toBe('list');
    expect(context.globalState.update).toHaveBeenCalledWith('viewMode', 'list');

    await manager.setViewMode('symbol');
    expect(manager.viewMode).toBe('symbol');
    expect(context.globalState.update).toHaveBeenCalledWith('viewMode', 'symbol');
  });

  it('currentFilePath getter/setter works correctly', async () => {
    const manager = new ProviderStateManager(context, 1000);
    await manager.setCurrentFilePath('/workspace/src/main.ts');
    expect(manager.currentFilePath).toBe('/workspace/src/main.ts');
    expect(context.workspaceState.update).toHaveBeenCalledWith(
      'currentFilePath',
      '/workspace/src/main.ts'
    );
  });

  it('selectedSymbolId getter/setter works correctly', () => {
    const manager = new ProviderStateManager(context, 1000);
    manager.selectedSymbolId = 'MyClass';
    expect(manager.selectedSymbolId).toBe('MyClass');
  });

  it('symbolReferencingFilesCache: get/set/invalidate/clear', () => {
    const manager = new ProviderStateManager(context, 1000);

    // Set cache for a symbol
    const files = new Set(['/workspace/src/a.ts', '/workspace/src/b.ts']);
    manager.setSymbolReferencingFiles('MyClass', files);

    // Get cache
    const cached = manager.getSymbolReferencingFiles('MyClass');
    expect(cached).toEqual(files);

    // Invalidate specific symbol
    manager.invalidateSymbolCache('MyClass');
    expect(manager.getSymbolReferencingFiles('MyClass')).toBeUndefined();

    // Set again and clear all
    manager.setSymbolReferencingFiles('MyClass', files);
    manager.setSymbolReferencingFiles('OtherClass', new Set(['/workspace/src/c.ts']));
    manager.clearSymbolCache();
    expect(manager.getSymbolReferencingFiles('MyClass')).toBeUndefined();
    expect(manager.getSymbolReferencingFiles('OtherClass')).toBeUndefined();
  });

  it('currentSymbol backward compatibility: setting symbolId switches to symbol mode', async () => {
    const manager = new ProviderStateManager(context, 1000);

    // Initially in file mode
    expect(manager.viewMode).toBe('file');
    expect(manager.currentSymbol).toBeUndefined();

    // Set currentSymbol (backward compatibility)
    manager.currentSymbol = '/workspace/src/app.ts:foo';

    // Should now be in symbol mode with selectedSymbolId set
    expect(manager.viewMode).toBe('symbol');
    expect(manager.selectedSymbolId).toBe('/workspace/src/app.ts:foo');
    expect(manager.currentSymbol).toBe('/workspace/src/app.ts:foo');
  });

  it('currentSymbol backward compatibility: clearing symbolId switches to file mode', async () => {
    const manager = new ProviderStateManager(context, 1000);

    // Set symbol mode
    manager.currentSymbol = '/workspace/src/app.ts:foo';
    expect(manager.viewMode).toBe('symbol');

    // Clear currentSymbol
    manager.currentSymbol = undefined;

    // Should switch back to file mode
    expect(manager.viewMode).toBe('file');
    expect(manager.selectedSymbolId).toBeUndefined();
    expect(manager.currentSymbol).toBeUndefined();
  });

  it('currentSymbol getter returns selectedSymbolId when in symbol mode', () => {
    const manager = new ProviderStateManager(context, 1000);

    // Set symbol mode with selectedSymbolId
    manager.currentSymbol = '/workspace/src/app.ts:bar';

    // Getter should return selectedSymbolId
    expect(manager.currentSymbol).toBe('/workspace/src/app.ts:bar');
    expect(manager.selectedSymbolId).toBe('/workspace/src/app.ts:bar');
  });

  it('currentSymbol getter returns undefined when not in symbol mode', () => {
    const manager = new ProviderStateManager(context, 1000);

    // Ensure we're in file mode
    expect(manager.viewMode).toBe('file');

    // Getter should return undefined
    expect(manager.currentSymbol).toBeUndefined();
  });

  it('persists expandAll state via globalState', async () => {
    const manager = new ProviderStateManager(context, 1000);
    await manager.setExpandAll(true);
    expect(context.globalState.update).toHaveBeenCalledWith('expandAll', true);
  });

  it('tracks last active file path via workspaceState', async () => {
    const manager = new ProviderStateManager(context, 1000);
    await manager.setLastActiveFilePath('/workspace/src/main.ts');
    expect(manager.getLastActiveFilePath()).toBe('/workspace/src/main.ts');
    expect(context.workspaceState.update).toHaveBeenCalledWith('lastActiveFilePath', '/workspace/src/main.ts');
  });
});
