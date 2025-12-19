import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GraphProvider } from '../../src/extension/GraphProvider';
import type { VsCodeLogger } from '../../src/extension/extensionLogger';
import { EditorEventsService } from '../../src/extension/services/EditorEventsService';
import type { FileChangeScheduler } from '../../src/extension/services/FileChangeScheduler';

type DisposeFn = () => void;

const configListeners: Array<(e: { affectsConfiguration: (s: string) => boolean }) => void> = [];
const activeEditorListeners: Array<(e: unknown) => void> = [];
const saveListeners: Array<(doc: { fileName: string }) => void> = [];

const createDisposable = (callback: DisposeFn = () => {}) => ({ dispose: callback });

vi.mock('vscode', () => {
  return {
    workspace: {
      onDidChangeConfiguration: vi.fn((listener: (e: { affectsConfiguration: (s: string) => boolean }) => void) => {
        configListeners.push(listener);
        return createDisposable();
      }),
      onDidSaveTextDocument: vi.fn((listener: (doc: { fileName: string }) => void) => {
        saveListeners.push(listener);
        return createDisposable();
      }),
    },
    window: {
      onDidChangeActiveTextEditor: vi.fn((listener: (editor: unknown) => void) => {
        activeEditorListeners.push(listener);
        return createDisposable();
      }),
    },
  };
});

function createProviderMock(): GraphProvider & { notifyMcpServerOfConfigChange?: () => void } {
  return {
    updateConfig: vi.fn(),
    onActiveFileChanged: vi.fn(),
    onFileSaved: vi.fn(),
  } as unknown as GraphProvider;
}

function createLoggerMock(): VsCodeLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    level: 'info',
    show: vi.fn(),
  } as unknown as VsCodeLogger;
}

function createSchedulerMock(): FileChangeScheduler {
  return {
    enqueue: vi.fn(),
    dispose: vi.fn(),
    getPendingCount: vi.fn(() => 0),
  } as unknown as FileChangeScheduler;
}

describe('EditorEventsService', () => {
  beforeEach(() => {
    configListeners.length = 0;
    activeEditorListeners.length = 0;
    saveListeners.length = 0;
  });

  it('wires configuration changes to provider and MCP notifier', async () => {
    const provider = createProviderMock();
    const logger = createLoggerMock();
    const scheduler = createSchedulerMock();
    provider.notifyMcpServerOfConfigChange = vi.fn();

    const service = new EditorEventsService({ provider, logger, fileChangeScheduler: scheduler });
    service.register();

    expect(configListeners).toHaveLength(1);
    configListeners[0]({ affectsConfiguration: (s) => s === 'graph-it-live' });

    expect(provider.updateConfig as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    expect(provider.notifyMcpServerOfConfigChange as ReturnType<typeof vi.fn>).toHaveBeenCalled();

    // Irrelevant configuration should not trigger updates
    (provider.updateConfig as ReturnType<typeof vi.fn>).mockClear();
    configListeners[0]({ affectsConfiguration: (s) => s === 'other' });
    expect(provider.updateConfig as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('invokes active editor handler', async () => {
    const provider = createProviderMock();
    const logger = createLoggerMock();
    const scheduler = createSchedulerMock();
    const service = new EditorEventsService({ provider, logger, fileChangeScheduler: scheduler });
    service.register();

    expect(activeEditorListeners).toHaveLength(1);
    activeEditorListeners[0]({ document: { fileName: 'file.ts' } });
    expect(provider.onActiveFileChanged as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });

  it('enqueues save events to scheduler instead of processing directly', () => {
    const provider = createProviderMock();
    const logger = createLoggerMock();
    const scheduler = createSchedulerMock();
    const service = new EditorEventsService({ provider, logger, fileChangeScheduler: scheduler });
    service.register();

    expect(saveListeners).toHaveLength(1);
    saveListeners[0]({ fileName: 'file.ts' });
    
    // Should enqueue to scheduler, not call provider directly
    expect(scheduler.enqueue).toHaveBeenCalledWith('file.ts', 'change');
    expect(provider.onFileSaved as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });
});
