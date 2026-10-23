import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphProvider } from '../../src/extension/GraphProvider';
import type { VsCodeLogger } from '../../src/extension/extensionLogger';
import type { CommandCoordinator } from '../../src/extension/services/CommandCoordinator';
import { CommandRegistrationService } from '../../src/extension/services/CommandRegistrationService';

vi.mock('vscode', () => {
  const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const executeCommand = vi.fn();
  const showInformationMessage = vi.fn();
  const showErrorMessage = vi.fn();
  const registerCommand = vi.fn((commandId: string, handler: (...args: unknown[]) => unknown) => {
    registeredHandlers.set(commandId, handler);
    return { dispose: vi.fn() };
  });

  return {
    commands: {
      registerCommand,
      executeCommand,
    },
    window: {
      showInformationMessage,
      showErrorMessage,
    },
    Disposable: {
      from: (...disposables: { dispose: () => unknown }[]) => ({
        dispose: () => disposables.forEach((d) => d.dispose()),
      }),
    },
    __mocks: {
      registeredHandlers,
      executeCommand,
      showInformationMessage,
      showErrorMessage,
      registerCommand,
    },
  };
});

import * as vscode from 'vscode';
const {
  registeredHandlers,
  executeCommand,
  showErrorMessage,
  registerCommand,
} = (vscode as unknown as { __mocks: {
  registeredHandlers: Map<string, (...args: unknown[]) => unknown>;
  executeCommand: ReturnType<typeof vi.fn>;
  showErrorMessage: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
} }).__mocks;

function createProviderMock(): GraphProvider {
  return {
    getViewMode: vi.fn().mockReturnValue('file'), // E2E test helper
    getReverseDependenciesVisible: vi.fn().mockReturnValue(false),
    showReviewCallGraph: vi.fn(),
    getCallGraphRenderCount: vi.fn().mockReturnValue(1),
    getCallGraphNodeCount: vi.fn().mockReturnValue(2),
    getCallGraphEdgeCount: vi.fn().mockReturnValue(3),
    getCallGraphCycleCount: vi.fn().mockReturnValue(4),
    getFileGraphNodeMetadata: vi.fn().mockReturnValue({}),
    getFileGraphRoot: vi.fn().mockReturnValue(undefined),
    getArchitectureE2EState: vi.fn().mockReturnValue({
      buildCount: 2, renderCount: 3, groupCount: 20, groupEdgeCount: 6, revision: 'r1', communityMode: 'path', stale: true,
      overlappingGroups: 1, overflowingLabels: 2, positions: 'path:ui@0,0', resizeCount: 4, viewSize: { width: 320, height: 200 },
      interactionCount: 5, interaction: { highlightedGroups: 2 }, matrixCount: 6, matrix: { rows: 11 }, rendered: { headerHeightPx: 90 },
    }),
    setArchitectureControls: vi.fn(),
  } as unknown as GraphProvider;
}

function createCommandCoordinatorMock(): CommandCoordinator {
  return {
    handleForceReindex: vi.fn(),
    handleExpandAll: vi.fn(),
    handleRefreshGraph: vi.fn(),
    handleToggleViewMode: vi.fn(),
    handleSetViewModeFile: vi.fn(),
    handleSetViewModeList: vi.fn(),
    handleSetViewModeSymbol: vi.fn(),
    handleSetViewModeArchitecture: vi.fn(),
    handleShowReverseDependencies: vi.fn(),
    handleHideReverseDependencies: vi.fn(),
    handleEnableUnusedFilter: vi.fn(),
    handleDisableUnusedFilter: vi.fn(),
    handleShowIndexStatus: vi.fn(),
  } as unknown as CommandCoordinator;
}

function createLoggerMock(): VsCodeLogger {
  return {
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    setLevel: vi.fn(),
    level: 'info',
    show: vi.fn(),
  } as unknown as VsCodeLogger;
}

describe('CommandRegistrationService', () => {
  beforeEach(() => {
    registeredHandlers.clear();
    executeCommand.mockReset();
    showErrorMessage.mockReset();
    registerCommand.mockClear();
  });

  it('registers all Graph-it-Live commands', () => {
    const provider = createProviderMock();
    const commandCoordinator = createCommandCoordinatorMock();
    const logger = createLoggerMock();
    const service = new CommandRegistrationService({ provider, commandCoordinator, logger });

    const disposables = service.registerAll();

    expect(disposables).toHaveLength(16); // getContext is shared; filter commands share one disposable
    expect(registerCommand).toHaveBeenCalledTimes(17);
    expect(registeredHandlers.has('graph-it-live.showGraph')).toBe(true);
    expect(registeredHandlers.has('graph-it-live.forceReindex')).toBe(true);
    expect(registeredHandlers.has('graph-it-live.expandAllNodes')).toBe(true);
    expect(registeredHandlers.has('graph-it-live.refreshGraph')).toBe(true);
    expect(registeredHandlers.has('graph-it-live.toggleViewMode')).toBe(true); // Backward compat
    expect(registeredHandlers.has('graph-it-live.setViewModeFile')).toBe(true);
    expect(registeredHandlers.has('graph-it-live.setViewModeList')).toBe(true);
    expect(registeredHandlers.has('graph-it-live.setViewModeSymbol')).toBe(true);
    expect(registeredHandlers.has('graph-it-live.setViewModeArchitecture')).toBe(true);
    expect(registeredHandlers.has('getContext')).toBe(true); // E2E test helper
    expect(registeredHandlers.has('graph-it-live.showReverseDependencies')).toBe(true);
    expect(registeredHandlers.has('graph-it-live.hideReverseDependencies')).toBe(true);
    expect(registeredHandlers.has('graph-it-live.enableUnusedFilter')).toBe(true);
    expect(registeredHandlers.has('graph-it-live.disableUnusedFilter')).toBe(true);
    expect(registeredHandlers.has('graph-it-live.showIndexStatus')).toBe(true);
    expect(registeredHandlers.has('graph-it-live.reviewCallGraph')).toBe(true);
  });

  it('switches to the architecture view and exposes its E2E state through getContext', async () => {
    const provider = createProviderMock();
    const commandCoordinator = createCommandCoordinatorMock();
    const service = new CommandRegistrationService({ provider, commandCoordinator, logger: createLoggerMock() });
    service.registerAll();

    await registeredHandlers.get('graph-it-live.setViewModeArchitecture')?.();
    expect(commandCoordinator.handleSetViewModeArchitecture).toHaveBeenCalled();

    const getContext = registeredHandlers.get('getContext')!;
    expect(await getContext('graph-it-live.viewMode')).toBe('file');
    expect(await getContext('graph-it-live.architectureRenderCount')).toBe(3);
    expect(await getContext('graph-it-live.architectureGroupCount')).toBe(20);
    expect(await getContext('graph-it-live.architectureGroupEdgeCount')).toBe(6);
    expect(await getContext('graph-it-live.architectureRevision')).toBe('r1');
    expect(await getContext('graph-it-live.architectureBuildCount')).toBe(2);
    expect(await getContext('graph-it-live.architectureCommunityMode')).toBe('path');
    expect(await getContext('graph-it-live.architectureStale')).toBe(true);
    expect(await getContext('graph-it-live.architectureOverlappingGroups')).toBe(1);
    expect(await getContext('graph-it-live.architectureOverflowingLabels')).toBe(2);
    expect(await getContext('graph-it-live.architecturePositions')).toBe('path:ui@0,0');
    expect(await getContext('graph-it-live.architectureResizeCount')).toBe(4);
    expect(await getContext('graph-it-live.architectureViewSize')).toEqual({ width: 320, height: 200 });
    expect(await getContext('graph-it-live.architectureInteractionCount')).toBe(5);
    expect(await getContext('graph-it-live.architectureInteraction')).toEqual({ highlightedGroups: 2 });
    expect(await getContext('graph-it-live.architectureMatrixCount')).toBe(6);
    expect(await getContext('graph-it-live.architectureMatrix')).toEqual({ rows: 11 });
    expect(await getContext('graph-it-live.architectureRendered')).toEqual({ headerHeightPx: 90 });

    await registeredHandlers.get('graph-it-live.e2eArchitectureControls')?.({ find: 'ui', minImports: 2 });
    expect(provider.setArchitectureControls).toHaveBeenCalledWith({ find: 'ui', minImports: 2 });
    expect(await getContext('graph-it-live.unknown')).toBeUndefined();
    expect(await getContext('graph-it-live.reverseDependenciesVisible')).toBe(false);
    expect([
      await getContext('graph-it-live.callGraphRenderCount'),
      await getContext('graph-it-live.callGraphNodeCount'),
      await getContext('graph-it-live.callGraphEdgeCount'),
      await getContext('graph-it-live.callGraphCycleCount'),
      await getContext('graph-it-live.fileGraphNodeMetadata'),
    ]).toEqual([1, 2, 3, 4, {}]);

    (provider.getArchitectureE2EState as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    expect(await getContext('graph-it-live.architectureRenderCount')).toBe(0);
    expect(await getContext('graph-it-live.architectureGroupCount')).toBe(0);
    expect(await getContext('graph-it-live.architectureGroupEdgeCount')).toBe(0);
    expect(await getContext('graph-it-live.architectureBuildCount')).toBe(0);
    expect(await getContext('graph-it-live.architectureStale')).toBe(false);
    expect(await getContext('graph-it-live.architectureResizeCount')).toBe(0);
    expect(await getContext('graph-it-live.architectureOverlappingGroups')).toBe(0);
    expect(await getContext('graph-it-live.architectureOverflowingLabels')).toBe(0);
    expect(await getContext('graph-it-live.architecturePositions')).toBeUndefined();
    expect(await getContext('graph-it-live.architectureViewSize')).toBeUndefined();
    expect(await getContext('graph-it-live.architectureInteractionCount')).toBe(0);
    expect(await getContext('graph-it-live.architectureInteraction')).toBeUndefined();
    expect(await getContext('graph-it-live.architectureMatrixCount')).toBe(0);
    expect(await getContext('graph-it-live.architectureMatrix')).toBeUndefined();
    expect(await getContext('graph-it-live.architectureRendered')).toBeUndefined();
  });

  it.each([
    ['graph-it-live.forceReindex', 'handleForceReindex'],
    ['graph-it-live.expandAllNodes', 'handleExpandAll'],
    ['graph-it-live.refreshGraph', 'handleRefreshGraph'],
    ['graph-it-live.toggleViewMode', 'handleToggleViewMode'],
    ['graph-it-live.setViewModeFile', 'handleSetViewModeFile'],
    ['graph-it-live.setViewModeList', 'handleSetViewModeList'],
    ['graph-it-live.setViewModeSymbol', 'handleSetViewModeSymbol'],
    ['graph-it-live.showReverseDependencies', 'handleShowReverseDependencies'],
    ['graph-it-live.hideReverseDependencies', 'handleHideReverseDependencies'],
    ['graph-it-live.enableUnusedFilter', 'handleEnableUnusedFilter'],
    ['graph-it-live.disableUnusedFilter', 'handleDisableUnusedFilter'],
    ['graph-it-live.showIndexStatus', 'handleShowIndexStatus'],
  ] as const)('%s runs CommandCoordinator.%s', async (commandId, handler) => {
    const commandCoordinator = createCommandCoordinatorMock();
    new CommandRegistrationService({ provider: createProviderMock(), commandCoordinator, logger: createLoggerMock() }).registerAll();

    await registeredHandlers.get(commandId)?.();

    expect(commandCoordinator[handler]).toHaveBeenCalledOnce();
  });

  it('focuses the view when showGraph is executed', async () => {
    const provider = createProviderMock();
    const commandCoordinator = createCommandCoordinatorMock();
    const logger = createLoggerMock();
    const service = new CommandRegistrationService({ provider, commandCoordinator, logger });

    service.registerAll();
    const handler = registeredHandlers.get('graph-it-live.showGraph');
    expect(handler).toBeDefined();

    await handler?.();
    expect(executeCommand).toHaveBeenCalledWith('graph-it-live.graphView.focus');
  });

  it('executes provider commands and reports success', async () => {
    const provider = createProviderMock();
    const commandCoordinator = createCommandCoordinatorMock();
    const logger = createLoggerMock();
    const service = new CommandRegistrationService({ provider, commandCoordinator, logger });

    service.registerAll();
    const forceReindexHandler = registeredHandlers.get('graph-it-live.forceReindex');
    expect(forceReindexHandler).toBeDefined();

    await forceReindexHandler?.();
    expect((commandCoordinator.handleForceReindex as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('logs and shows errors when commands fail', async () => {
    const provider = createProviderMock();
    const commandCoordinator = createCommandCoordinatorMock();
    (commandCoordinator.handleRefreshGraph as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));
    const logger = createLoggerMock();
    const service = new CommandRegistrationService({ provider, commandCoordinator, logger });

    service.registerAll();
    const refreshHandler = registeredHandlers.get('graph-it-live.refreshGraph');
    expect(refreshHandler).toBeDefined();

    await refreshHandler?.();
    expect(logger.error).toHaveBeenCalledWith(
      'graph-it-live.refreshGraph failed:',
      expect.any(Error)
    );
    expect(showErrorMessage).toHaveBeenCalledWith('Graph-It-Live: Refresh failed');
  });

  it('shows indexer information when available', async () => {
    const provider = createProviderMock();
    const commandCoordinator = createCommandCoordinatorMock();
    const logger = createLoggerMock();
    const service = new CommandRegistrationService({ provider, commandCoordinator, logger });

    service.registerAll();
    const handler = registeredHandlers.get('graph-it-live.showIndexStatus');
    expect(handler).toBeDefined();

    await handler?.();
    expect((commandCoordinator.handleShowIndexStatus as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('forwards only validated review call graph targets', async () => {
    const provider = createProviderMock();
    const service = new CommandRegistrationService({ provider, commandCoordinator: createCommandCoordinatorMock(), logger: createLoggerMock() });
    service.registerAll();
    const handler = registeredHandlers.get('graph-it-live.reviewCallGraph');

    await handler?.({ file: 'src/api.ts', symbol: 'greet', depth: 3 });
    expect(provider.showReviewCallGraph).toHaveBeenCalledWith('src/api.ts', 'greet', 3);

    for (const target of [undefined, null, 'src/api.ts', {}, { file: '' }, { file: '/tmp/api.ts' }, { file: 'src/api.ts', symbol: '' }, { file: 'src/api.ts', depth: '3' }, { file: 'src/api.ts', depth: Number.NaN }]) {
      await handler?.(target);
    }
    expect(showErrorMessage).toHaveBeenCalledTimes(9);
    expect(showErrorMessage).toHaveBeenLastCalledWith('Graph-It-Live: Invalid review link');
    expect(provider.showReviewCallGraph).toHaveBeenCalledTimes(1);
  });

  it('reports provider failures for valid review call graph targets', async () => {
    const provider = createProviderMock();
    const logger = createLoggerMock();
    (provider.showReviewCallGraph as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('graph unavailable'));
    new CommandRegistrationService({ provider, commandCoordinator: createCommandCoordinatorMock(), logger }).registerAll();

    await registeredHandlers.get('graph-it-live.reviewCallGraph')?.({ file: 'src/api.ts', depth: 1 });

    expect(logger.error).toHaveBeenCalledWith('graph-it-live.reviewCallGraph failed:', expect.any(Error));
    expect(showErrorMessage).toHaveBeenCalledWith('Graph-It-Live: Invalid review link');
  });
});
