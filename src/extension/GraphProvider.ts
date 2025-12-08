import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Spider } from '../analyzer/Spider';
import { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../shared/types';
import { getExtensionLogger } from './logger';

/** Logger instance for GraphProvider */
const log = getExtensionLogger('GraphProvider');

/** Key for storing the reverse index in workspace state */
const REVERSE_INDEX_STORAGE_KEY = 'graph-it-live.reverseIndex';

/** Default delay before starting background indexing (ms) */
const DEFAULT_INDEXING_START_DELAY = 1000;

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

    /** Status bar item for showing indexing progress */
    private readonly _statusBarItem: vscode.StatusBarItem;

    /** File system watcher for source file changes (create/delete) */
    private _fileWatcher?: vscode.FileSystemWatcher;

    /** Currently displayed symbol view file (for auto-refresh on file change) */
    private _currentSymbolFilePath?: string;

    constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this._extensionUri = extensionUri;
        this._context = context;
        
        // Create status bar item for indexing progress (visible on the left side)
        this._statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        this._statusBarItem.name = 'Graph-It-Live Indexing';
        context.subscriptions.push(this._statusBarItem);
        
        this._initializeSpider();
        this._initializeFileWatcher();
        // Note: Indexing is now deferred until resolveWebviewView() is called
    }

    /**
     * Initialize file system watcher for source file changes
     * Handles file creation, modification, and deletion to keep the index up-to-date
     * This also catches external changes (git pull, external editors, scripts, etc.)
     */
    private _initializeFileWatcher(): void {
        // Watch for changes in supported source files
        this._fileWatcher = vscode.workspace.createFileSystemWatcher(
            '**/*.{ts,tsx,js,jsx,vue,svelte,gql,graphql}'
        );

        // Handle file creation - add to index
        this._fileWatcher.onDidCreate(async (uri) => {
            log.debug('File created:', uri.fsPath);
            if (this._spider) {
                await this._spider.reanalyzeFile(uri.fsPath);
                await this._persistIndex();
                
                // Refresh the appropriate view based on current mode
                if (this._currentSymbolFilePath) {
                    // In symbol view - always refresh to update reverse dependencies (Imported By list)
                    // even if the created file is different from the viewed one
                    await this.handleDrillDown(this._currentSymbolFilePath, true);
                } else {
                    // In file view - refresh the graph (preserve view mode)
                    this.updateGraph(true);
                }
            }
        });

        // Handle file modification (including external changes like git pull)
        this._fileWatcher.onDidChange(async (uri) => {
            log.debug('File changed externally:', uri.fsPath);
            if (this._spider) {
                // Invalidate and re-analyze the file
                await this._spider.reanalyzeFile(uri.fsPath);
                await this._persistIndex();
                
                // Refresh the appropriate view based on current mode
                if (this._currentSymbolFilePath) {
                    // In symbol view - always refresh to update reverse dependencies (Imported By list)
                    // even if the modified file is different from the viewed one
                    await this.handleDrillDown(this._currentSymbolFilePath, true);
                } else {
                    // In file view - refresh the graph (preserve view mode)
                    this.updateGraph(true);
                }
            }
        });

        // Handle file deletion - remove from index
        this._fileWatcher.onDidDelete(async (uri) => {
            log.debug('File deleted:', uri.fsPath);
            if (this._spider) {
                this._spider.handleFileDeleted(uri.fsPath);
                await this._persistIndex();
                
                // Handle view refresh based on current mode
                if (this._currentSymbolFilePath) {
                    // In symbol view
                    if (this._currentSymbolFilePath === uri.fsPath) {
                        // The file we're viewing was deleted - switch to file view
                        this._currentSymbolFilePath = undefined;
                        this.updateGraph();
                    } else {
                        // Otherwise, refresh the current view to update reverse dependencies
                        await this.handleDrillDown(this._currentSymbolFilePath, true);
                    }
                } else {
                    // In file view - refresh the graph (preserve view mode)
                    this.updateGraph(true);
                }
            }
        });

        // Add watcher to disposables
        this._context.subscriptions.push(this._fileWatcher);
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
        log.info('Scheduling indexing in', startDelay, 'ms');

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
            log.info('No persisted index found, starting fresh indexing');
            await this._startBackgroundIndexingWithProgress();
            return;
        }

        // Try to restore the index
        const restored = this._spider.enableReverseIndex(storedIndex);
        if (!restored) {
            log.info('Failed to restore index, starting fresh indexing');
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
                    log.info('Successfully restored and validated persisted index');
                } else {
                    const staleCount = validation ? validation.staleFiles.length + validation.missingFiles.length : 0;
                    log.info('Index is stale, re-indexing', staleCount, 'files');
                    
                    if (validation && validation.staleFiles.length > 0 && validation.missingFiles.length === 0) {
                        // Incremental update for stale files only
                        progress.report({ message: `Re-indexing ${validation.staleFiles.length} changed files...` });
                        await this._spider!.reindexStaleFiles(validation.staleFiles);
                        await this._persistIndex();
                        log.info('Incremental re-index complete');
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

        // Show status bar item with initial state
        this._statusBarItem.text = '$(sync~spin) Graph-It-Live: Counting files...';
        this._statusBarItem.tooltip = 'Indexing workspace for reverse dependency lookup';
        this._statusBarItem.show();

        try {
            // Subscribe to status updates for the status bar
            const unsubscribe = this._spider.subscribeToIndexStatus((snapshot) => {
                if (snapshot.state === 'counting') {
                    this._statusBarItem.text = '$(sync~spin) Graph-It-Live: Counting files...';
                } else if (snapshot.state === 'indexing') {
                    const percent = snapshot.percentage;
                    this._statusBarItem.text = `$(sync~spin) Graph-It-Live: ${percent}% (${snapshot.processed}/${snapshot.total})`;
                    this._statusBarItem.tooltip = `Indexing: ${snapshot.currentFile ?? 'processing...'}`;
                }
            });

            try {
                // Use worker thread for indexing to avoid blocking extension host
                const result = await this._spider.buildFullIndexInWorker(workerPath);

                if (result.cancelled) {
                    log.info('Indexing cancelled after', result.indexedFiles, 'files');
                    this._statusBarItem.text = '$(x) Graph-It-Live: Indexing cancelled';
                } else {
                    log.info('Indexed', result.indexedFiles, 'files in', result.duration, 'ms');
                    this._statusBarItem.text = `$(check) Graph-It-Live: ${result.indexedFiles} files indexed`;
                    // Persist the index if enabled
                    await this._persistIndex();
                }

                // Hide status bar after a short delay
                setTimeout(() => {
                    this._statusBarItem.hide();
                }, 3000);
            } finally {
                unsubscribe();
            }
        } catch (error) {
            log.error('Background indexing failed:', error);
            this._statusBarItem.text = '$(error) Graph-It-Live: Indexing failed';
            this._statusBarItem.tooltip = error instanceof Error ? error.message : 'Unknown error';
            
            // Hide after showing error
            setTimeout(() => {
                this._statusBarItem.hide();
            }, 5000);
            
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
            log.debug('Persisted reverse index to workspace state');
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
     * Handle a file being saved - invalidate cache, re-analyze, and refresh view
     * This ensures the index reflects the latest file content
     * Preserves the current view mode (file view or symbol view)
     * @param filePath Path to the saved file
     */
    public async onFileSaved(filePath: string): Promise<void> {
        if (!this._spider) {
            return;
        }

        // Only handle supported file types
        if (!/\.(ts|tsx|js|jsx|vue|svelte|gql|graphql)$/.test(filePath)) {
            return;
        }

        log.debug('Re-analyzing saved file:', filePath);
        
        // Re-analyze the file (invalidates cache and updates reverse index)
        await this._spider.reanalyzeFile(filePath);
        
        // Persist the updated index if enabled
        await this._persistIndex();
        
        // Refresh the appropriate view based on current mode
    if (this._currentSymbolFilePath) {
        // In symbol view - always refresh to update reverse dependencies (Imported By list)
        // even if the saved file is different from the viewed one
        await this.handleDrillDown(this._currentSymbolFilePath, true);
    } else {
        // In file view - refresh the graph (preserve view mode)
        this.updateGraph(true);
    }
    }

    /**
     * Handle active file change - update view for new file while preserving view type
     * If in symbol view, show symbols for new file
     * If in file view, show dependencies for new file
     */
    public async onActiveFileChanged(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (editor?.document.uri.scheme !== 'file') {
            return;
        }

        const newFilePath = editor.document.fileName;
        
        // Only handle supported file types
        if (!/\.(ts|tsx|js|jsx|vue|svelte|gql|graphql)$/.test(newFilePath)) {
            return;
        }

        log.debug('Active file changed to:', newFilePath);

        // Preserve the current view type
        if (this._currentSymbolFilePath) {
            // Was in symbol view - show symbols for the new file
            // Update tracking to new file and refresh symbol view
            await this.handleDrillDown(newFilePath, true);
        } else {
            // Was in file view - show dependencies for the new file
            this.updateGraph(true);
        }
    }

    /**
     * Parse a file path or symbol ID to extract the actual file path and optional symbol name
     * Handles both Unix and Windows paths, including Windows paths with symbol IDs
     */
    private parseFilePathAndSymbol(filePath: string): { actualFilePath: string; symbolName?: string } {
        const isWindowsAbsolutePath = /^[a-zA-Z]:[\\/]/.test(filePath);
        
        if (!isWindowsAbsolutePath && filePath.includes(':')) {
            const parts = filePath.split(':');
            return {
                actualFilePath: parts[0],
                symbolName: parts.slice(1).join(':')
            };
        }
        
        if (isWindowsAbsolutePath && filePath.lastIndexOf(':') > 1) {
            const lastColonIndex = filePath.lastIndexOf(':');
            return {
                actualFilePath: filePath.substring(0, lastColonIndex),
                symbolName: filePath.substring(lastColonIndex + 1)
            };
        }
        
        return { actualFilePath: filePath };
    }

    /**
     * Check if a path is absolute (Unix or Windows)
     */
    private isAbsolutePath(filePath: string): boolean {
        return filePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(filePath);
    }

    /**
     * Navigate editor to a specific line
     */
    private navigateToLine(editor: vscode.TextEditor, line: number): void {
        const position = new vscode.Position(line - 1, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(
            new vscode.Range(position, position),
            vscode.TextEditorRevealType.InCenter
        );
    }

    /**
     * Try to navigate to a symbol's definition in the editor
     */
    private async navigateToSymbol(
        editor: vscode.TextEditor,
        actualFilePath: string,
        symbolName: string,
        originalFilePath: string
    ): Promise<void> {
        if (!this._spider) return;
        
        try {
            const { symbols } = await this._spider.getSymbolGraph(actualFilePath);
            const symbol = symbols.find(s => s.name === symbolName || s.id === originalFilePath);
            
            if (symbol?.line) {
                this.navigateToLine(editor, symbol.line);
            }
        } catch (symbolError) {
            log.warn('Could not navigate to symbol', symbolError);
        }
    }

    /**
     * Handle openFile message
     * Supports both regular file paths and symbol IDs (filePath:symbolName)
     * @param filePath The file path or symbol ID
     * @param line Optional line number to navigate to (1-indexed)
     */
    private async handleOpenFile(filePath: string, line?: number): Promise<void> {
        try {
            const { actualFilePath, symbolName } = this.parseFilePathAndSymbol(filePath);
            
            if (symbolName) {
                log.debug('Opening symbol', symbolName, 'in file', actualFilePath);
            } else {
                log.debug('Opening file', actualFilePath);
            }
            
            // Handle relative paths - show message for external dependencies
            if (!this.isAbsolutePath(actualFilePath) && this._spider) {
                const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
                if (workspaceRoot && (actualFilePath.startsWith('.') || !actualFilePath.includes('/'))) {
                    vscode.window.showInformationMessage(
                        `Cannot open external dependency: ${actualFilePath}. This symbol is imported from outside the current file.`
                    );
                    return;
                }
            }
            
            const doc = await vscode.workspace.openTextDocument(actualFilePath);
            const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
            
            if (line && line > 0) {
                this.navigateToLine(editor, line);
            } else if (symbolName) {
                await this.navigateToSymbol(editor, actualFilePath, symbolName, filePath);
            }
        } catch (e) {
            log.error('Error opening file:', e);
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
            log.debug('Expanding node', nodeId);
            const knownNodesSet = new Set(knownNodes || []);
            const newGraphData = await this._spider.crawlFrom(nodeId, knownNodesSet, 10);
            
            const expandedMessage: ExtensionToWebviewMessage = {
                command: 'expandedGraph',
                nodeId: nodeId,
                data: newGraphData,
            };
            this._view?.webview.postMessage(expandedMessage);
        } catch (e) {
            log.error('Error expanding node:', e);
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
            log.debug('Finding referencing files for', nodeId);
            const referencingFiles = await this._spider.findReferencingFiles(nodeId);
            
            log.debug('Found', referencingFiles.length, 'referencing files');
            
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
            log.error('Error finding referencing files:', e);
        }
    }

    /**
     * Handle drillDown message (Symbol Analysis)
     * @param filePath The file to analyze
     * @param isRefresh If true, this is a refresh not navigation - don't push to history
     */
    private async handleDrillDown(filePath: string, isRefresh: boolean = false): Promise<void> {
        if (!this._spider || !this._view) {
            return;
        }
        
        // Track the current symbol view file for auto-refresh on file changes
        this._currentSymbolFilePath = filePath;
        
        try {
            log.debug(isRefresh ? 'Refreshing' : 'Drilling down into', filePath, 'for symbol analysis');
            const symbolData = await this._spider.getSymbolGraph(filePath);

            // Get referencing files to ensure atomic update of "Imported By" list
            const referencingDependency = await this._spider.findReferencingFiles(filePath);
            const referencingFiles = referencingDependency.map(d => d.path);
            
            // Build graph structure for symbol view
            // Nodes include: the file itself + all exported symbols + referenced symbols
            const nodes = new Set<string>();
            
            // Add the file node as the root
            nodes.add(filePath);
            
            // Add only top-level symbols (exclude child methods/properties that have a parent)
            // Child symbols will be shown in their parent's label
            symbolData.symbols
                .filter(s => !s.parentSymbolId) // Only add symbols without a parent
                .forEach(s => nodes.add(s.id));
            
            // Add referenced symbols (imported from other files)
            symbolData.dependencies.forEach(d => {
                // Only add the target if it's a different file
                // (internal references are already in symbols array)
                if (!d.targetSymbolId.startsWith(filePath)) {
                    nodes.add(d.targetSymbolId);
                }
            });
            
            // Build edges
            const edges: { source: string; target: string }[] = [];
            
            // 1. Containment edges: file → exported top-level symbols only
            // (Child methods are grouped under their parent class)
            symbolData.symbols
                .filter(s => s.isExported && !s.parentSymbolId)
                .forEach(s => {
                    edges.push({ source: filePath, target: s.id });
                });
            
            // 2. Dependency edges: symbol → symbol
            symbolData.dependencies.forEach(d => {
                edges.push({
                    source: d.sourceSymbolId,
                    target: d.targetSymbolId
                });
            });
            
            const response: ExtensionToWebviewMessage = {
                command: 'symbolGraph',
                filePath,
                isRefresh,
                data: {
                    nodes: Array.from(nodes),
                    edges,
                    symbolData,
                    referencingFiles
                }
            };
            
            this._view.webview.postMessage(response);
            log.debug('Sent symbol graph with', nodes.size, 'nodes and', edges.length, 'edges');
        } catch (error) {
            log.error('Error drilling down into symbols:', error);
            vscode.window.showErrorMessage(
                `Failed to analyze symbols: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (message: WebviewToExtensionMessage) => {
            log.debug('Received message', message.command);
            switch (message.command) {
                case 'openFile':
                    if (message.path) {
                        await this.handleOpenFile(message.path, message.line);
                    }
                    break;
                case 'expandNode':
                    if (message.nodeId) {
                        await this.handleExpandNode(message.nodeId, message.knownNodes);
                    }
                    break;
                case 'setExpandAll':
                    log.debug('Setting expandAll to', message.expandAll);
                    this._context.globalState.update('expandAll', message.expandAll);
                    break;
                case 'refreshGraph':
                    log.debug('Refreshing graph');
                    this.updateGraph();
                    break;
                case 'findReferencingFiles':
                    if (message.nodeId) {
                        await this.handleFindReferencingFiles(message.nodeId);
                    }
                    break;
                case 'drillDown':
                    if (message.filePath) {
                        await this.handleDrillDown(message.filePath);
                    }
                    break;
                case 'ready':
                    log.debug('Webview ready, sending initial graph');
                    this.updateGraph();
                    break;
                case 'switchMode':
                    log.debug('Switching to', message.mode, 'mode');
                    if (message.mode === 'file') {
                        // Clear symbol tracking and send file view
                        this._currentSymbolFilePath = undefined;
                        this.updateGraph();
                    } else if (message.mode === 'symbol') {
                        // Switch to symbol view for current file
                        const editor = vscode.window.activeTextEditor;
                        if (editor?.document.uri.scheme === 'file') {
                            await this.handleDrillDown(editor.document.fileName);
                        }
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

    /**
     * Update the file graph for the current active document
     * @param isRefresh If true, this is a refresh not navigation - preserve view mode
     */
    public async updateGraph(isRefresh: boolean = false) {
        if (!this._view || !this._spider) {
            log.debug('View or Spider not initialized');
            return;
        }

        // Only clear symbol view tracking if this is a navigation, not a refresh
        if (!isRefresh) {
            this._currentSymbolFilePath = undefined;
        }

        const editor = vscode.window.activeTextEditor;
        if (editor?.document.uri.scheme !== 'file') {
            log.debug('No active file editor');
            return;
        }

        const filePath = editor.document.fileName;
        log.debug(isRefresh ? 'Refreshing' : 'Updating', 'graph for', filePath);

        // Only analyze supported files
        if (!/\.(ts|tsx|js|jsx|vue|svelte|gql|graphql)$/.test(filePath)) {
            log.debug('Unsupported file type');
            return;
        }

        try {
            const graphData = await this._spider.crawl(filePath);
            log.debug('Found', graphData.nodes.length, 'nodes and', graphData.edges.length, 'edges');
            const expandAll = this._context.globalState.get<boolean>('expandAll', false);
            const message: ExtensionToWebviewMessage = {
                command: 'updateGraph',
                filePath,
                data: graphData,
                expandAll,
                isRefresh,
            };
            this._view.webview.postMessage(message);
        } catch (error) {
            log.error('Failed to analyze file:', error);
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
