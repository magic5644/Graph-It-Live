import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { GraphProvider } from '../../src/extension/GraphProvider';
import { Spider } from '../../src/analyzer/Spider';

// Mock vscode
vi.mock('vscode', () => {
    const mockStatusBarItem = {
        text: '',
        tooltip: '',
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn(),
    };
    
    return {
        Uri: {
            file: (path: string) => ({ fsPath: path }),
            joinPath: (...args: any[]) => ({ fsPath: args.join('/') }),
        },
        workspace: {
            workspaceFolders: [{ uri: { fsPath: '/root' } }],
            getConfiguration: () => ({
                get: () => true,
            }),
            openTextDocument: vi.fn(),
        },
        window: {
            showTextDocument: vi.fn(),
            showErrorMessage: vi.fn(),
            createStatusBarItem: vi.fn().mockReturnValue(mockStatusBarItem),
            withProgress: vi.fn().mockImplementation(async (_options: any, task: any) => {
                // Execute the task with a mock progress reporter
                const mockProgress = { report: vi.fn() };
                const mockToken = { isCancellationRequested: false, onCancellationRequested: vi.fn() };
                return task(mockProgress, mockToken);
            }),
            activeTextEditor: {
                document: {
                    uri: { scheme: 'file' },
                    fileName: '/root/src/main.ts',
                },
            },
        },
        ViewColumn: { One: 1 },
        WebviewViewProvider: class {},
        ExtensionMode: { Production: 1, Development: 2, Test: 3 },
        ProgressLocation: { Window: 10, Notification: 15 },
        StatusBarAlignment: { Left: 1, Right: 2 },
    };
});

// Mock Spider
vi.mock('../../src/analyzer/Spider', () => {
    const SpiderMock = vi.fn();
    SpiderMock.mockImplementation(function () {
        return {
            analyze: vi.fn().mockResolvedValue(['/root/src/utils.ts']),
            crawl: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
            updateConfig: vi.fn(),
            // New methods for reverse index
            buildFullIndex: vi.fn().mockResolvedValue({ indexedFiles: 0, duration: 0, cancelled: false }),
            buildFullIndexInWorker: vi.fn().mockResolvedValue({ indexedFiles: 0, duration: 0, cancelled: false }),
            enableReverseIndex: vi.fn().mockReturnValue(false),
            disableReverseIndex: vi.fn(),
            disposeWorker: vi.fn(),
            hasReverseIndex: vi.fn().mockReturnValue(false),
            validateReverseIndex: vi.fn().mockResolvedValue(null),
            getSerializedReverseIndex: vi.fn().mockReturnValue(null),
            reindexStaleFiles: vi.fn().mockResolvedValue(0),
            cancelIndexing: vi.fn(),
            // IndexerStatus subscription
            subscribeToIndexStatus: vi.fn().mockReturnValue(() => {}),
            getIndexStatus: vi.fn().mockReturnValue({
                state: 'idle',
                processed: 0,
                total: 0,
                currentFile: undefined,
                percentage: 0,
                startTime: undefined,
                errorMessage: undefined,
            }),
        };
    });
    return { Spider: SpiderMock };
});

describe('GraphProvider', () => {
    let provider: GraphProvider;
    let extensionUri: vscode.Uri;
    let mockContext: vscode.ExtensionContext;

    beforeEach(() => {
        vi.clearAllMocks();
        extensionUri = { fsPath: '/extension' } as vscode.Uri;
        mockContext = {
            extensionUri,
            subscriptions: [],
            workspaceState: {
                get: vi.fn(),
                update: vi.fn(),
            },
            globalState: {
                get: vi.fn(),
                update: vi.fn(),
                setKeysForSync: vi.fn(),
            },
            secrets: {
                get: vi.fn(),
                store: vi.fn(),
                delete: vi.fn(),
                onDidChange: vi.fn(),
            },
            extensionMode: vscode.ExtensionMode.Test,
            asAbsolutePath: vi.fn(),
            storageUri: undefined,
            globalStorageUri: undefined,
            logUri: undefined,
            environmentVariableCollection: {} as any,
        } as unknown as vscode.ExtensionContext;
        
        provider = new GraphProvider(extensionUri, mockContext);
    });

    it('should initialize Spider on creation', () => {
        expect(Spider).toHaveBeenCalledWith(expect.objectContaining({
            rootDir: '/root',
            excludeNodeModules: true,
        }));
    });

    it('should update graph when updateGraph is called', async () => {
        const webview = {
            postMessage: vi.fn(),
            asWebviewUri: vi.fn(),
            options: {},
            html: '',
            onDidReceiveMessage: vi.fn(),
            cspSource: 'test-csp',
        };
        const view = { 
            webview,
            onDidDispose: vi.fn(),
        };

        // Resolve the view first
        provider.resolveWebviewView(view as any, {} as any, {} as any);

        // Setup mock return
        const mockGraphData = {
            nodes: ['/root/src/main.ts'],
            edges: []
        };
        ((provider as any)['_spider'].crawl as any).mockResolvedValue(mockGraphData);

        await provider.updateGraph();

        expect(webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            command: 'updateGraph',
            filePath: '/root/src/main.ts',
            data: mockGraphData,
            expandAll: undefined // globalState.get returns undefined by default mock
        }));
    });
});
