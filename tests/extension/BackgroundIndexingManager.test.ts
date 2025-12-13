import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('vscode', () => {
    const statusBarItem = {
        name: '',
        text: '',
        tooltip: '',
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn(),
    };

    return {
        window: {
            createStatusBarItem: vi.fn(() => statusBarItem),
            showErrorMessage: vi.fn(),
            withProgress: vi.fn((_options, task) => task({ report: vi.fn() })),
        },
        workspace: {
            workspaceFolders: [],
        },
        ProgressLocation: { Window: 1 },
        StatusBarAlignment: { Left: 1, Right: 2 },
        Uri: {
            file: (fsPath: string) => ({ fsPath }),
        },
    };
});

import type * as vscode from 'vscode';
import { BackgroundIndexingManager, type BackgroundIndexingConfig } from '../../src/extension/services/BackgroundIndexingManager';
import type { Spider } from '../../src/analyzer/Spider';

type MockContext = {
    workspaceState: { update: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
    subscriptions: vscode.Disposable[];
};

const createContext = (): MockContext => ({
    workspaceState: {
        update: vi.fn(),
        get: vi.fn(),
    },
    subscriptions: [],
});

const createSpider = () => ({
    getSerializedReverseIndex: vi.fn(() => 'SERIALIZED'),
    cancelIndexing: vi.fn(),
    disableReverseIndex: vi.fn(),
    enableReverseIndex: vi.fn(() => true),
    validateReverseIndex: vi.fn(),
    reindexStaleFiles: vi.fn(),
    buildFullIndexInWorker: vi.fn(async () => ({ indexedFiles: 0, duration: 0, cancelled: true, data: [] })),
    subscribeToIndexStatus: vi.fn(() => () => {}),
}) as unknown as Spider;

const baseConfig: BackgroundIndexingConfig = {
    enableBackgroundIndexing: true,
    indexingStartDelay: 1,
    persistIndex: true,
};

const createManager = (config: Partial<BackgroundIndexingConfig> = {}) => {
    const context = createContext();
    const spider = createSpider();
    const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    };

    const manager = new BackgroundIndexingManager({
        context: context as unknown as vscode.ExtensionContext,
        extensionUri: { fsPath: '/workspace' } as vscode.Uri,
        spider,
        logger,
        onIndexingComplete: vi.fn(),
        initialConfig: { ...baseConfig, ...config },
    });

    return { manager, context, spider };
};

describe('BackgroundIndexingManager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('persists reverse index when persistence is enabled', async () => {
        const { manager, context, spider } = createManager({ persistIndex: true });
        (spider.getSerializedReverseIndex as ReturnType<typeof vi.fn>).mockReturnValue('SERIALIZED_INDEX');

        await manager.persistIndexIfEnabled();

        expect(context.workspaceState.update).toHaveBeenCalledWith(
            'graph-it-live.reverseIndex',
            'SERIALIZED_INDEX'
        );
    });

    it('skips persistence when persistIndex is disabled', async () => {
        const { manager, context } = createManager({ persistIndex: false });

        await manager.persistIndexIfEnabled();

        expect(context.workspaceState.update).not.toHaveBeenCalled();
    });

    it('disables indexing by cancelling timers, clearing state, and resetting spider', async () => {
        vi.useFakeTimers();
        const { manager, context, spider } = createManager();

        (manager as any).indexingStartTimer = setTimeout(() => {}, 1000);

        await manager.disableBackgroundIndexing();

        expect(spider.cancelIndexing).toHaveBeenCalled();
        expect(spider.disableReverseIndex).toHaveBeenCalled();
        expect(context.workspaceState.update).toHaveBeenCalledWith('graph-it-live.reverseIndex', undefined);
    });
});
