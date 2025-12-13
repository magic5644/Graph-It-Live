import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GraphProvider } from '../../src/extension/GraphProvider';
import type { VsCodeLogger } from '../../src/extension/extensionLogger';
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
  showInformationMessage,
  showErrorMessage,
  registerCommand,
} = (vscode as unknown as { __mocks: {
  registeredHandlers: Map<string, (...args: unknown[]) => unknown>;
  executeCommand: ReturnType<typeof vi.fn>;
  showInformationMessage: ReturnType<typeof vi.fn>;
  showErrorMessage: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
} }).__mocks;

function createProviderMock(): GraphProvider {
  return {
    forceReindex: vi.fn(),
    expandAllNodes: vi.fn(),
    refreshGraph: vi.fn(),
    toggleViewMode: vi.fn(),
    getIndexStatus: vi.fn(),
  } as unknown as GraphProvider;
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
    showInformationMessage.mockReset();
    showErrorMessage.mockReset();
    registerCommand.mockClear();
  });

  it('registers all Graph-It-Live commands', () => {
    const provider = createProviderMock();
    const logger = createLoggerMock();
    const service = new CommandRegistrationService({ provider, logger });

    const disposables = service.registerAll();

    expect(disposables).toHaveLength(6);
    expect(registerCommand).toHaveBeenCalledTimes(6);
    expect(registeredHandlers.has('graph-it-live.showGraph')).toBe(true);
    expect(registeredHandlers.has('graph-it-live.forceReindex')).toBe(true);
    expect(registeredHandlers.has('graph-it-live.expandAllNodes')).toBe(true);
    expect(registeredHandlers.has('graph-it-live.refreshGraph')).toBe(true);
    expect(registeredHandlers.has('graph-it-live.toggleViewMode')).toBe(true);
    expect(registeredHandlers.has('graph-it-live.showIndexStatus')).toBe(true);
  });

  it('focuses the view when showGraph is executed', async () => {
    const provider = createProviderMock();
    const logger = createLoggerMock();
    const service = new CommandRegistrationService({ provider, logger });

    service.registerAll();
    const handler = registeredHandlers.get('graph-it-live.showGraph');
    expect(handler).toBeDefined();

    await handler?.();
    expect(executeCommand).toHaveBeenCalledWith('graph-it-live.graphView.focus');
  });

  it('executes provider commands and reports success', async () => {
    const provider = createProviderMock();
    const logger = createLoggerMock();
    const service = new CommandRegistrationService({ provider, logger });

    service.registerAll();
    const forceReindexHandler = registeredHandlers.get('graph-it-live.forceReindex');
    expect(forceReindexHandler).toBeDefined();

    await forceReindexHandler?.();
    expect((provider.forceReindex as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect(showInformationMessage).toHaveBeenCalledWith('Graph-It-Live: Re-index triggered');
  });

  it('logs and shows errors when commands fail', async () => {
    const provider = createProviderMock();
    (provider.refreshGraph as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));
    const logger = createLoggerMock();
    const service = new CommandRegistrationService({ provider, logger });

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
    (provider.getIndexStatus as ReturnType<typeof vi.fn>).mockReturnValue({
      state: 'indexing',
      processed: 1,
      total: 10,
      percentage: 10,
    });
    const logger = createLoggerMock();
    const service = new CommandRegistrationService({ provider, logger });

    service.registerAll();
    const handler = registeredHandlers.get('graph-it-live.showIndexStatus');
    expect(handler).toBeDefined();

    await handler?.();
    expect(showInformationMessage).toHaveBeenCalledWith('Indexer: indexing 1/10 (10%)');
  });
});
