import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { GraphProvider } from '../../src/extension/GraphProvider';
import { Spider } from '../../src/analyzer/Spider';

// Mock vscode
vi.mock('vscode', () => {
    const postMessage = vi.fn();
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
    };
});

// Mock Spider
// Mock Spider
vi.mock('../../src/analyzer/Spider', () => {
    const SpiderMock = vi.fn();
    SpiderMock.mockImplementation(function () {
        return {
            analyze: vi.fn().mockResolvedValue(['/root/src/utils.ts']),
            crawl: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
            updateConfig: vi.fn(),
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
        const view = { webview };

        // Resolve the view first
        provider.resolveWebviewView(view as any, {} as any, {} as any);

        // Setup mock return
        const mockGraphData = {
            nodes: ['/root/src/main.ts'],
            edges: []
        };
        (provider['_spider'].crawl as any).mockResolvedValue(mockGraphData);

        await provider.updateGraph();

        expect(webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            command: 'updateGraph',
            filePath: '/root/src/main.ts',
            data: mockGraphData,
            expandAll: undefined // globalState.get returns undefined by default mock
        }));
    });
});
