import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Spider } from '../analyzer/Spider';
import { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../shared/types';

/** Key for storing the reverse index in workspace state */
const REVERSE_INDEX_STORAGE_KEY = 'graph-it-live.reverseIndex';

/** Default delay before starting background indexing (ms) */
const DEFAULT_INDEXING_START_DELAY = 5000;

/** Path to the worker script relative to extension root */
const WORKER_SCRIPT_PATH = 'dist/indexerWorker.js';

export class GraphProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'graph-it-live.graphView';

    private _view?: vscode.WebviewView;
    private _spider?: Spider;
    private readonly _extensionUri: vscode.Uri;
    private readonly _context: vscode.ExtensionContext;
    
    /** Flag indicating if background indexing is in progress */
    private _isIndexing = false;

    /** Timer handle for deferred indexing start */
    private _indexingStartTimer?: ReturnType<typeof setTimeout>;

    /** Flag to track if view has been resolved */
    private _viewResolved = false;

    constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this._extensionUri = extensionUri;
        this._context = context;
        this._initializeSpider();
        // Note: Indexing is now deferred until resolveWebviewView() is called
    }

    private _initializeSpider() {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (workspaceRoot) {
            const config = vscode.workspace.getConfiguration('graph-it-live');
            const excludeNodeModules = config.get<boolean>('excludeNodeModules', true);
            const maxDepth = config.get<number>('maxDepth', 50);
            const enableBackgroundIndexing = config.get<boolean>('enableBackgroundIndexing', false);
            const indexingConcurrency = config.get<number>('indexingConcurrency', 4);

            this._spider = new Spider({
                rootDir: workspaceRoot,
                tsConfigPath: path.join(workspaceRoot, 'tsconfig.json'),
                excludeNodeModules,
                maxDepth,
                enableReverseIndex: enableBackgroundIndexing,
                indexingConcurrency,
            });

            // Don't start indexing here - it will be deferred until view is resolved
        }
    }

    /**
     * Schedule deferred indexing start
     * Called after view is resolved to ensure VS Code has finished startup
     */
    private _scheduleDeferredIndexing(): void {
        const config = vscode.workspace.getConfiguration('graph-it-live');
        const enableBackgroundIndexing = config.get<boolean>('enableBackgroundIndexing', false);
        
        if (!enableBackgroundIndexing) {
            return;
        }

        // Clear any existing timer
        if (this._indexingStartTimer) {
            clearTimeout(this._indexingStartTimer);
        }

        const startDelay = config.get<number>('indexingStartDelay', DEFAULT_INDEXING_START_DELAY);
        console.log(`GraphProvider: Scheduling indexing in ${startDelay}ms`);

        this._indexingStartTimer = setTimeout(() => {
            this._tryRestoreIndex();
        }, startDelay);
    }

    /**
     * Try to restore the reverse index from workspace state
     */
    private async _tryRestoreIndex(): Promise<void> {
        if (!this._spider) {
            return;
        }

        const config = vscode.workspace.getConfiguration('graph-it-live');
        const persistIndex = config.get<boolean>('persistIndex', false);

        if (!persistIndex) {
            // Start fresh indexing without persistence
            await this._startBackgroundIndexingWithProgress();
            return;
        }

        const storedIndex = this._context.workspaceState.get<string>(REVERSE_INDEX_STORAGE_KEY);
        if (!storedIndex) {
            console.log('GraphProvider: No persisted index found, starting fresh indexing');
            await this._startBackgroundIndexingWithProgress();
            return;
        }

        // Try to restore the index
        const restored = this._spider.enableReverseIndex(storedIndex);
        if (!restored) {
            console.log('GraphProvider: Failed to restore index, starting fresh indexing');
            await this._startBackgroundIndexingWithProgress();
            return;
        }

        // Validate the restored index with progress
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Window,
                title: 'Graph-It-Live',
                cancellable: false,
            },
            async (progress) => {
                progress.report({ message: 'Validating index...' });
                const validation = await this._spider!.validateReverseIndex();

                if (validation?.isValid) {
                    console.log('GraphProvider: Successfully restored and validated persisted index');
                } else {
                    const staleCount = validation ? validation.staleFiles.length + validation.missingFiles.length : 0;
                    console.log(`GraphProvider: Index is stale (${staleCount} files changed), re-indexing`);
                    
                    if (validation && validation.staleFiles.length > 0 && validation.missingFiles.length === 0) {
                        // Incremental update for stale files only
                        progress.report({ message: `Re-indexing ${validation.staleFiles.length} changed files...` });
                        await this._spider!.reindexStaleFiles(validation.staleFiles);
                        await this._persistIndex();
                        console.log('GraphProvider: Incremental re-index complete');
                    } else {
                        // Full re-index if files are missing (significant changes)
                        await this._startBackgroundIndexingWithProgress();
                    }
                }
            }
        );
    }

    /**
     * Start background indexing with VS Code native progress UI
     * Uses a Worker Thread to avoid blocking the extension host
     */
    private async _startBackgroundIndexingWithProgress(): Promise<void> {
        if (!this._spider || this._isIndexing) {
            return;
        }

        this._isIndexing = true;

        // Get the path to the worker script
        const workerPath = path.join(this._extensionUri.fsPath, WORKER_SCRIPT_PATH);

        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Window,
                    title: 'Graph-It-Live: Indexing',
                    cancellable: true,
                },
                async (progress, token) => {
                    // Set up cancellation
                    token.onCancellationRequested(() => {
                        console.log('GraphProvider: Indexing cancelled by user');
                        this._spider?.cancelIndexing();
                    });

                    // Subscribe to status updates
                    const unsubscribe = this._spider!.subscribeToIndexStatus((snapshot) => {
                        if (snapshot.state === 'counting') {
                            progress.report({ message: 'Counting files...' });
                        } else if (snapshot.state === 'indexing') {
                            const message = snapshot.total > 0
                                ? `${snapshot.processed}/${snapshot.total} files (${snapshot.percentage}%)`
                                : `${snapshot.processed} files...`;
                            progress.report({ 
                                message,
                                increment: snapshot.total > 0 ? (100 / snapshot.total) : undefined
                            });
                        }
                    });

                    try {
                        // Use worker thread for indexing to avoid blocking extension host
                        const result = await this._spider!.buildFullIndexInWorker(workerPath);

                        if (result.cancelled) {
                            console.log(`GraphProvider: Indexing cancelled after ${result.indexedFiles} files`);
                        } else {
                            console.log(`GraphProvider: Indexed ${result.indexedFiles} files in ${result.duration}ms`);
                            // Persist the index if enabled
                            await this._persistIndex();
                        }
                    } finally {
                        unsubscribe();
                    }
                }
            );
        } catch (error) {
            console.error('GraphProvider: Background indexing failed:', error);
            vscode.window.showErrorMessage(
                `Graph-It-Live: Indexing failed - ${error instanceof Error ? error.message : 'Unknown error'}`
            );
        } finally {
            this._isIndexing = false;
        }
    }

    /**
     * Persist the reverse index to workspace state
     */
    private async _persistIndex(): Promise<void> {
        if (!this._spider) {
            return;
        }

        const config = vscode.workspace.getConfiguration('graph-it-live');
        const persistIndex = config.get<boolean>('persistIndex', false);

        if (!persistIndex) {
            return;
        }

        const serialized = this._spider.getSerializedReverseIndex();
        if (serialized) {
            await this._context.workspaceState.update(REVERSE_INDEX_STORAGE_KEY, serialized);
            console.log('GraphProvider: Persisted reverse index to workspace state');
        }
    }

    public updateConfig() {
        if (this._spider) {
            const config = vscode.workspace.getConfiguration('graph-it-live');
            const excludeNodeModules = config.get<boolean>('excludeNodeModules', true);
            const maxDepth = config.get<number>('maxDepth', 50);
            const enableBackgroundIndexing = config.get<boolean>('enableBackgroundIndexing', false);
            const indexingConcurrency = config.get<number>('indexingConcurrency', 4);

            this._spider.updateConfig({ 
                excludeNodeModules, 
                maxDepth,
                enableReverseIndex: enableBackgroundIndexing,
                indexingConcurrency,
            });

            // Handle indexing state changes
            if (enableBackgroundIndexing && !this._spider.hasReverseIndex()) {
                this._startBackgroundIndexingWithProgress();
            } else if (!enableBackgroundIndexing) {
                // Cancel any pending indexing
                if (this._indexingStartTimer) {
                    clearTimeout(this._indexingStartTimer);
                    this._indexingStartTimer = undefined;
                }
                this._spider.cancelIndexing();
                this._spider.disableReverseIndex();
                // Clear persisted index
                this._context.workspaceState.update(REVERSE_INDEX_STORAGE_KEY, undefined);
            }

            this.updateGraph();
        }
    }

    /**
     * Handle openFile message
     */
    private async handleOpenFile(filePath: string): Promise<void> {
        try {
            console.log('GraphProvider: Opening file', filePath);
            const doc = await vscode.workspace.openTextDocument(filePath);
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        } catch (e) {
            console.error('GraphProvider: Error opening file', e);
            vscode.window.showErrorMessage(`Could not open file: ${filePath}`);
        }
    }

    /**
     * Handle expandNode message
     */
    private async handleExpandNode(nodeId: string, knownNodes: string[] | undefined): Promise<void> {
        if (!this._spider) {
            return;
        }
        try {
            console.log(`GraphProvider: Expanding node ${nodeId}`);
            const knownNodesSet = new Set(knownNodes || []);
            const newGraphData = await this._spider.crawlFrom(nodeId, knownNodesSet, 10);
            
            const expandedMessage: ExtensionToWebviewMessage = {
                command: 'expandedGraph',
                nodeId: nodeId,
                data: newGraphData,
            };
            this._view?.webview.postMessage(expandedMessage);
        } catch (e) {
            console.error('GraphProvider: Error expanding node', e);
        }
    }

    /**
     * Handle findReferencingFiles message
     */
    private async handleFindReferencingFiles(nodeId: string): Promise<void> {
        if (!this._spider) {
            return;
        }
        try {
            console.log(`GraphProvider: Finding referencing files for ${nodeId}`);
            const referencingFiles = await this._spider.findReferencingFiles(nodeId);
            
            const nodes = referencingFiles.map(d => d.path);
            const edges = referencingFiles.map(d => ({
                source: d.path,
                target: nodeId
            }));
            
            const response: ExtensionToWebviewMessage = {
                command: 'referencingFiles',
                nodeId: nodeId,
                data: { nodes, edges }
            };
            this._view?.webview.postMessage(response);
        } catch (e) {
            console.error('GraphProvider: Error finding referencing files', e);
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        this._viewResolved = true;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (message: WebviewToExtensionMessage) => {
            console.log('GraphProvider: Received message', message);
            switch (message.command) {
                case 'openFile':
                    if (message.path) {
                        await this.handleOpenFile(message.path);
                    }
                    break;
                case 'expandNode':
                    if (message.nodeId) {
                        await this.handleExpandNode(message.nodeId, message.knownNodes);
                    }
                    break;
                case 'setExpandAll':
                    console.log(`GraphProvider: Setting expandAll to ${message.expandAll}`);
                    this._context.globalState.update('expandAll', message.expandAll);
                    break;
                case 'refreshGraph':
                    console.log('GraphProvider: Refreshing graph');
                    this.updateGraph();
                    break;
                case 'findReferencingFiles':
                    if (message.nodeId) {
                        await this.handleFindReferencingFiles(message.nodeId);
                    }
                    break;
            }
        });

        // Clean up timer and worker when view is disposed
        webviewView.onDidDispose(() => {
            if (this._indexingStartTimer) {
                clearTimeout(this._indexingStartTimer);
                this._indexingStartTimer = undefined;
            }
            // Also clean up the worker if running
            this._spider?.disposeWorker();
        });

        // Schedule deferred indexing now that view is ready
        this._scheduleDeferredIndexing();

        // Initial update if we have an active editor
        this.updateGraph();
    }

    public async updateGraph() {
        if (!this._view || !this._spider) {
            console.log('GraphProvider: View or Spider not initialized');
            return;
        }

        const editor = vscode.window.activeTextEditor;
        if (editor?.document.uri.scheme !== 'file') {
            console.log('GraphProvider: No active file editor');
            return;
        }

        const filePath = editor.document.fileName;
        console.log(`GraphProvider: Analyzing ${filePath}`);

        // Only analyze supported files
        if (!/\.(ts|tsx|js|jsx|vue|svelte)$/.test(filePath)) {
            console.log('GraphProvider: Unsupported file type');
            return;
        }

        try {
            const graphData = await this._spider.crawl(filePath);
            console.log(`GraphProvider: Found ${graphData.nodes.length} nodes and ${graphData.edges.length} edges`);
            const expandAll = this._context.globalState.get<boolean>('expandAll', false);
            const message: ExtensionToWebviewMessage = {
                command: 'updateGraph',
                filePath,
                data: graphData,
                expandAll,
            };
            this._view.webview.postMessage(message);
        } catch (error) {
            console.error('GraphProvider: Failed to analyze file:', error);
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview.js'));
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Graph-It-Live</title>
    <style>
        html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
        body { font-family: var(--vscode-font-family); }
        #root {
            height: 100%;
            margin: 0;
            padding: 0;
            overflow: hidden;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
        .control-btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 2px;
            width: 24px;
            height: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
        }
        .control-btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .react-flow__attribution { display: none; }
    </style>
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce() {
    // Use cryptographically secure random bytes instead of Math.random (S224)
    return randomBytes(16).toString('hex'); // 32 hex chars
}
