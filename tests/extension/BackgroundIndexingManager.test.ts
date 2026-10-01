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

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { IndexCache } from '../../src/analyzer/cache/IndexCache';
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

let workspaceRoot: string;

const createSpider = () => ({
    workspaceRoot,
    getSerializedReverseIndex: vi.fn(() => 'SERIALIZED'),
    cancelIndexing: vi.fn(),
    disableReverseIndex: vi.fn(),
    enableReverseIndex: vi.fn(() => true),
    validateReverseIndex: vi.fn(async () => ({ isValid: true, staleFiles: [], missingFiles: [], stalePercentage: 0 })),
    reindexStaleFiles: vi.fn(async () => 0),
    buildFullIndexInWorker: vi.fn(async () => ({ indexedFiles: 1, duration: 0, cancelled: false })),
    subscribeToIndexStatus: vi.fn(() => () => {}),
});

const baseConfig: BackgroundIndexingConfig = {
    enableBackgroundIndexing: true,
    indexingStartDelay: 1,
    excludeNodeModules: true,
    ignoreTypeImports: false,
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
    const onIndexingComplete = vi.fn();

    const manager = new BackgroundIndexingManager({
        context: context as unknown as vscode.ExtensionContext,
        extensionUri: { fsPath: '/extension' } as vscode.Uri,
        spider: spider as unknown as Spider,
        logger,
        onIndexingComplete,
        initialConfig: { ...baseConfig, ...config },
    });
    managers.push(manager);
    /** Runs what scheduleDeferredIndexing() starts once its delay elapses. */
    const restore = () => (manager as unknown as { tryRestoreIndex(): Promise<void> }).tryRestoreIndex();

    return { manager, context, spider, restore, onIndexingComplete };
};

const managers: BackgroundIndexingManager[] = [];
const cacheDir = () => path.join(workspaceRoot, '.graph-it', 'cache');
const cachedIndex = () => fs.readFileSync(path.join(cacheDir(), 'reverse-index.json'), 'utf-8');
const openCache = () => IndexCache.open(workspaceRoot);
const options = { excludeNodeModules: true, ignoreTypeImports: false };

describe('BackgroundIndexingManager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graph-it-bim-')));
        fs.writeFileSync(path.join(workspaceRoot, 'package.json'), '{}');
        fs.writeFileSync(path.join(workspaceRoot, 'a.ts'), 'export const a = 1;\n');
    });

    afterEach(async () => {
        await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
        vi.clearAllTimers();
        vi.useRealTimers();
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    it('builds the index and writes it to the cache shared with the CLI and MCP server', async () => {
        const { restore, spider, context, onIndexingComplete } = createManager();

        await restore();

        expect(spider.buildFullIndexInWorker).toHaveBeenCalledOnce();
        expect(onIndexingComplete).toHaveBeenCalled();
        expect(cachedIndex()).toBe('SERIALIZED');
        expect(fs.readFileSync(path.join(workspaceRoot, '.graph-it', '.gitignore'), 'utf-8')).toBe('*\n');
        // The copy older versions kept in workspaceState is dropped.
        expect(context.workspaceState.update).toHaveBeenCalledWith('graph-it-live.reverseIndex', undefined);
    });

    it('restores an index another process wrote instead of indexing again', async () => {
        (await openCache()).save({ reverseIndex: { data: 'FROM_CLI', options } });
        const { restore, spider } = createManager();

        await restore();

        expect(spider.enableReverseIndex).toHaveBeenCalledWith('FROM_CLI');
        expect(spider.buildFullIndexInWorker).not.toHaveBeenCalled();
    });

    it('rebuilds when the cached index was built with other options', async () => {
        (await openCache()).save({ reverseIndex: { data: 'FROM_CLI', options } });
        const { restore, spider } = createManager({ excludeNodeModules: false });

        await restore();

        expect(spider.enableReverseIndex).not.toHaveBeenCalled();
        expect(spider.buildFullIndexInWorker).toHaveBeenCalledOnce();
    });

    it('re-indexes only the changed files of a restored index, then writes it back', async () => {
        (await openCache()).save({ reverseIndex: { data: 'FROM_CLI', options } });
        const { restore, spider } = createManager();
        spider.validateReverseIndex.mockResolvedValue({ isValid: false, staleFiles: ['/w/a.ts'], missingFiles: [], stalePercentage: 0.1 });

        await restore();

        expect(spider.reindexStaleFiles).toHaveBeenCalledWith(['/w/a.ts']);
        expect(spider.buildFullIndexInWorker).not.toHaveBeenCalled();
        expect(cachedIndex()).toBe('SERIALIZED');
    });

    it('waits for a process indexing right now, then restores its result', async () => {
        fs.mkdirSync(cacheDir(), { recursive: true });
        const lockPath = path.join(cacheDir(), 'index.lock');
        fs.writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, acquiredAt: Date.now() }));
        const { restore, spider } = createManager();

        const restoring = restore();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(spider.enableReverseIndex).not.toHaveBeenCalled();
        (await openCache()).save({ reverseIndex: { data: 'FROM_MCP', options } });
        fs.rmSync(lockPath);
        await restoring;

        expect(spider.enableReverseIndex).toHaveBeenCalledWith('FROM_MCP');
        expect(spider.buildFullIndexInWorker).not.toHaveBeenCalled();
    });

    it('writes the index once more on dispose', async () => {
        const { manager, restore, spider } = createManager();
        await restore();
        spider.getSerializedReverseIndex.mockReturnValue('AFTER_EDITS');

        await manager.dispose();

        expect(cachedIndex()).toBe('AFTER_EDITS');
    });

    it('skips persistence while another process holds the lock', async () => {
        const { manager, restore, spider } = createManager();
        await restore();
        fs.writeFileSync(path.join(cacheDir(), 'index.lock'), JSON.stringify({ pid: process.ppid, acquiredAt: Date.now() }));
        spider.getSerializedReverseIndex.mockReturnValue('AFTER_EDITS');

        await manager.persistIndex();

        expect(cachedIndex()).toBe('SERIALIZED');
    });

    it('skips persistence before any indexing opened the cache', async () => {
        const { manager } = createManager();

        await manager.persistIndex();

        expect(fs.existsSync(cacheDir())).toBe(false);
    });

    it('starts the restore once the configured delay has elapsed', async () => {
        const { manager, spider } = createManager({ indexingStartDelay: 5 });

        manager.scheduleDeferredIndexing();
        await vi.waitFor(() => expect(spider.buildFullIndexInWorker).toHaveBeenCalledOnce());
    });

    it('schedules nothing when background indexing is off', async () => {
        const { manager, spider } = createManager({ enableBackgroundIndexing: false, indexingStartDelay: 1 });

        manager.scheduleDeferredIndexing();
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(spider.buildFullIndexInWorker).not.toHaveBeenCalled();
    });

    it('builds on a config update without an index, and disables when turned off', async () => {
        const { manager, spider } = createManager();
        await manager.handleConfigUpdate(false);
        expect(spider.buildFullIndexInWorker).toHaveBeenCalledOnce();

        manager.updateConfiguration({ ...baseConfig, enableBackgroundIndexing: false });
        await manager.handleConfigUpdate(true);
        expect(spider.disableReverseIndex).toHaveBeenCalled();
    });

    it('does not write a cancelled build', async () => {
        const { manager, spider, onIndexingComplete } = createManager();
        spider.buildFullIndexInWorker.mockResolvedValue({ indexedFiles: 0, duration: 0, cancelled: true });

        await manager.forceReindex();

        expect(onIndexingComplete).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(cacheDir(), 'reverse-index.json'))).toBe(false);
    });

    it('reports a failed build and releases the lock', async () => {
        const { manager, spider } = createManager();
        spider.buildFullIndexInWorker.mockRejectedValue(new Error('worker crashed'));

        await manager.forceReindex();

        const vscodeMock = await import('vscode');
        expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('worker crashed'));
        expect(fs.existsSync(path.join(cacheDir(), 'index.lock'))).toBe(false);
    });

    it('rebuilds a restored index whose files were deleted', async () => {
        (await openCache()).save({ reverseIndex: { data: 'FROM_CLI', options } });
        const { restore, spider } = createManager();
        spider.validateReverseIndex.mockResolvedValue({ isValid: false, staleFiles: [], missingFiles: ['/w/gone.ts'], stalePercentage: 0.1 });

        await restore();

        expect(spider.buildFullIndexInWorker).toHaveBeenCalledOnce();
    });

    it('disables indexing by cancelling timers and resetting spider', async () => {
        vi.useFakeTimers();
        const { manager, spider } = createManager();

        (manager as any).indexingStartTimer = setTimeout(() => {}, 1000);

        await manager.disableBackgroundIndexing();

        expect(spider.cancelIndexing).toHaveBeenCalled();
        expect(spider.disableReverseIndex).toHaveBeenCalled();
    });
});
