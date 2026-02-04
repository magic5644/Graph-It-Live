import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VsCodeLogger } from '../../src/extension/extensionLogger';
import { EditorEventsService, type EditorEventsTarget } from '../../src/extension/services/EditorEventsService';
import type { FileChangeScheduler } from '../../src/extension/services/FileChangeScheduler';

type DisposeFn = () => void;

const configListeners: Array<(e: { affectsConfiguration: (s: string) => boolean }) => void> = [];
const activeEditorListeners: Array<(e: unknown) => void> = [];
const saveListeners: Array<(doc: { fileName: string }) => void> = [];
// Selection listeners mock - captures registered listeners for vscode.window.onDidChangeTextEditorSelection
// Not directly used in tests but required for complete VS Code API mocking
// eslint-disable-next-line @typescript-eslint/no-unused-vars
// NOSONAR: Mock array for VS Code API - required for test infrastructure
const _selectionListeners: Array<(e: unknown) => void> = [];

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
      onDidChangeTextEditorSelection: vi.fn((listener: (e: unknown) => void) => {
        _selectionListeners.push(listener);
        return createDisposable();
      }),
    },
  };
});

function createTargetMock(): EditorEventsTarget {
  return {
    updateConfig: vi.fn(),
    onActiveFileChanged: vi.fn(),
    refreshCurrentGraphView: vi.fn(),
    stateManager: {
      viewMode: 'file',
      currentFilePath: undefined,
    },
  } as unknown as EditorEventsTarget;
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
    _selectionListeners.length = 0;
  });

  it('wires configuration changes to provider and MCP notifier', async () => {
    const target = createTargetMock();
    const logger = createLoggerMock();
    const scheduler = createSchedulerMock();
    target.notifyMcpServerOfConfigChange = vi.fn();

    const service = new EditorEventsService({ target, logger, fileChangeScheduler: scheduler });
    service.register();

    expect(configListeners).toHaveLength(1);
    configListeners[0]({ affectsConfiguration: (s) => s === 'graph-it-live' });

    expect(target.updateConfig as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    expect(target.notifyMcpServerOfConfigChange as ReturnType<typeof vi.fn>).toHaveBeenCalled();

    // Irrelevant configuration should not trigger updates
    (target.updateConfig as ReturnType<typeof vi.fn>).mockClear();
    configListeners[0]({ affectsConfiguration: (s) => s === 'other' });
    expect(target.updateConfig as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('invokes active editor handler', async () => {
    const target = createTargetMock();
    const logger = createLoggerMock();
    const scheduler = createSchedulerMock();
    const service = new EditorEventsService({ target, logger, fileChangeScheduler: scheduler });
    service.register();

    expect(activeEditorListeners).toHaveLength(1);
    activeEditorListeners[0]({ document: { fileName: 'file.ts' } });
    expect(target.onActiveFileChanged as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
    expect(_selectionListeners).toHaveLength(1);
  });

  it('enqueues save events to scheduler instead of processing directly', () => {
    const target = createTargetMock();
    const logger = createLoggerMock();
    const scheduler = createSchedulerMock();
    const service = new EditorEventsService({ target, logger, fileChangeScheduler: scheduler });
    service.register();

    expect(saveListeners).toHaveLength(1);
    saveListeners[0]({ fileName: 'file.ts' });
    
    // Should enqueue to scheduler, not call provider directly
    expect(scheduler.enqueue).toHaveBeenCalledWith('file.ts', 'change');
    expect(logger.debug).toHaveBeenCalled();
  });
});
