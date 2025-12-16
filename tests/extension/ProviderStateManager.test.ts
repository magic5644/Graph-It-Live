import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  const context = {
    workspaceState: {
      get: vi.fn(),
      update: vi.fn(),
    },
    globalState: {
      get: vi.fn((_, defaultValue) => defaultValue),
      update: vi.fn(),
    },
  } as unknown as import('vscode').ExtensionContext;

  beforeEach(() => {
    context.workspaceState.get.mockClear();
    context.workspaceState.update.mockClear();
    context.globalState.get.mockClear();
    context.globalState.update.mockClear();
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
