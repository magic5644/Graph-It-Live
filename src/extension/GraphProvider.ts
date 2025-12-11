import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Spider } from '../analyzer/Spider';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage, OpenFileMessage, ExpandNodeMessage, SetExpandAllMessage, FindReferencingFilesMessage, DrillDownMessage, SwitchModeMessage, WebviewLogMessage, SymbolInfo, SymbolDependency } from '../shared/types';
import { getExtensionLogger, extensionLoggerManager } from './logger';
import type { IndexerStatusSnapshot } from '../analyzer/IndexerStatus';

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
                    
                    // Refresh the current view to show parent counts now that indexing is complete
                    log.debug('Indexing complete, refreshing view to show parent counts');
                    if (this._currentSymbolFilePath) {
                        // In symbol view - refresh to update "Imported By" list
                        await this.handleDrillDown(this._currentSymbolFilePath, true);
                    } else {
                        // In file view - refresh to show parent counts on nodes
                        this.updateGraph(true);
                    }
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
            
            const parentCounts: Record<string, number> = {};
            // If reverse index is enabled, populate parent counts for the nodes we are about to send
            if (this._spider.hasReverseIndex()) {
                await Promise.all(nodes.map(async (n) => {
                    try {
                        const refs = await this._spider!.findReferencingFiles(n);
                        if (refs && refs.length > 0) parentCounts[n] = refs.length;
                    } catch (e) {
                        log.debug('Failed to compute parent counts for', n, e instanceof Error ? e.message : String(e));
                    }
                }));
            }

            const response: ExtensionToWebviewMessage = {
                command: 'referencingFiles',
                nodeId: nodeId,
                data: { nodes, edges, parentCounts: Object.keys(parentCounts).length > 0 ? parentCounts : undefined }
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
        
        // Don't eagerly set _currentSymbolFilePath yet - we need to resolve relative/module
        // specifiers first so the tracked file is always an absolute path.
        
        try {
            log.debug(isRefresh ? 'Refreshing' : 'Drilling down into', filePath, 'for symbol analysis');

            // Parse symbol ID (e.g. './utils:format') to separate file path from symbol name
            const { actualFilePath: requestedPath, symbolName } = this.parseFilePathAndSymbol(filePath);

            // Resolve the file path to an absolute path if needed
            const resolvedFilePath = await this._resolveDrillDownPath(requestedPath);
            if (!resolvedFilePath) return; // Messages already shown by resolver

            // Track the resolved (absolute) file we are viewing for refreshes
            this._currentSymbolFilePath = symbolName ? `${resolvedFilePath}:${symbolName}` : resolvedFilePath;

            const symbolData = await this._spider.getSymbolGraph(resolvedFilePath);

            // Get referencing files to ensure atomic update of "Imported By" list
            const referencingDependency = await this._spider.findReferencingFiles(resolvedFilePath);
            const referencingFiles = referencingDependency.map(d => d.path);

            const { nodes, edges, rootNodeId } = this._buildSymbolGraphPayload(symbolData, resolvedFilePath);
            
            const response: ExtensionToWebviewMessage = {
                command: 'symbolGraph',
                filePath: rootNodeId,
                isRefresh,
                data: {
                    nodes: Array.from(nodes),
                    edges,
                    symbolData,
                    referencingFiles,
                    parentCounts: referencingFiles.length > 0 ? { [rootNodeId]: referencingFiles.length } : undefined,
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

    /**
     * Resolve a user-provided drill down path into an absolute file path.
     * Returns undefined and shows a UI message if resolution fails.
     */
    private async _resolveDrillDownPath(requestedPath: string): Promise<string | undefined> {
        const resolvedFilePath = requestedPath;

        if (this.isAbsolutePath(resolvedFilePath)) {
            return resolvedFilePath;
        }

        // Determine a sensible base file to resolve module specifiers from
        const baseForResolve = (() => {
            if (this._currentSymbolFilePath && this.isAbsolutePath(this._currentSymbolFilePath)) {
                return this._currentSymbolFilePath;
            }
            const editor = vscode.window.activeTextEditor;
            if (editor?.document.uri.scheme === 'file') {
                return editor.document.fileName;
            }
            return undefined;
        })();

        if (!baseForResolve) {
            vscode.window.showInformationMessage(
                `Cannot drill into dependency: ${requestedPath} - no base file to resolve from.`
            );
            return undefined;
        }

        const resolved = await this._spider?.resolveModuleSpecifier(baseForResolve, resolvedFilePath);
        if (!resolved) {
            vscode.window.showInformationMessage(
                `Cannot drill into external dependency: ${requestedPath}. This symbol is imported from outside the current file.`
            );
            return undefined;
        }
        return resolved;
    }

    /** Build nodes and edges for a symbol-level graph payload */
    private _buildSymbolGraphPayload(symbolData: { symbols: SymbolInfo[]; dependencies: SymbolDependency[] }, resolvedFilePath: string) {
        // Build graph structure for symbol view: file node + exported symbols + referenced symbols
        const nodes = new Set<string>();
        const rootNodeId = this._currentSymbolFilePath ?? resolvedFilePath;
        nodes.add(rootNodeId);

        // Add top-level exported symbols (no parents)
        symbolData.symbols
            .filter((s: SymbolInfo) => !s.parentSymbolId)
            .forEach((s: SymbolInfo) => nodes.add(s.id));

        // Add referenced symbols from other files
        symbolData.dependencies.forEach((d: SymbolDependency) => {
            if (!d.targetSymbolId.startsWith(resolvedFilePath)) nodes.add(d.targetSymbolId);
        });

        // Create edges: containment + dependency edges
        const edges: { source: string; target: string }[] = [];
        symbolData.symbols
            .filter((s: SymbolInfo) => s.isExported && !s.parentSymbolId)
            .forEach((s: SymbolInfo) => edges.push({ source: rootNodeId, target: s.id }));
        symbolData.dependencies.forEach((d: SymbolDependency) => edges.push({ source: d.sourceSymbolId, target: d.targetSymbolId }));

        return { nodes, edges, rootNodeId };
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
            await this._handleWebviewMessage(message);
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

    /** Handle webview messages in a dedicated method to reduce cognitive complexity */
    private async _handleWebviewMessage(message: WebviewToExtensionMessage) {
        log.debug('Received message', message.command);

        type HandlerMap = {
            [K in WebviewToExtensionMessage['command']]?: (m: Extract<WebviewToExtensionMessage, { command: K }>) => Promise<void> | void
        };

        const handlers: HandlerMap = {
            openFile: async (m: OpenFileMessage) => { if (m.path) await this.handleOpenFile(m.path, m.line); },
            expandNode: async (m: ExpandNodeMessage) => { if (m.nodeId) await this.handleExpandNode(m.nodeId, m.knownNodes); },
            setExpandAll: async (m: SetExpandAllMessage) => { log.debug('Setting expandAll to', m.expandAll); this._context.globalState.update('expandAll', m.expandAll); },
            refreshGraph: async () => { log.debug('Refreshing graph'); this.updateGraph(); },
            findReferencingFiles: async (m: FindReferencingFilesMessage) => { if (m.nodeId) await this.handleFindReferencingFiles(m.nodeId); },
            drillDown: async (m: DrillDownMessage) => { if (m.filePath) await this.handleDrillDown(m.filePath); },
            ready: async () => { log.debug('Webview ready, sending initial graph'); this.updateGraph(); },
            webviewLog: async (m: WebviewLogMessage) => { await this._forwardWebviewLog(m); },
            switchMode: async (m: SwitchModeMessage) => {
                log.debug('Switching to', m.mode, 'mode');
                if (m.mode === 'file') {
                    this._currentSymbolFilePath = undefined;
                    this.updateGraph();
                } else if (m.mode === 'symbol') {
                    const editor = vscode.window.activeTextEditor;
                    if (editor?.document.uri.scheme === 'file') {
                        await this.handleDrillDown(editor.document.fileName);
                    }
                }
            }
        };

        const handler = handlers[message.command];
        if (handler) await (handler as (m: unknown) => Promise<void>)(message as unknown);
    }

    private async _forwardWebviewLog(message: WebviewLogMessage) {
        const level = message.level ?? 'info';
        const msg = message.message ?? '';
        const args = message.args ?? [];
        const webviewLogger = extensionLoggerManager.getLogger('Webview');
        switch (level) {
            case 'debug':
                webviewLogger.debug(msg, ...args);
                break;
            case 'info':
                webviewLogger.info(msg, ...args);
                break;
            case 'warn':
                webviewLogger.warn(msg, ...args);
                break;
            case 'error':
                webviewLogger.error(msg, ...args);
                break;
        }
    }

    /**
     * Force a full re-index immediately (useful for debugging / command palette)
     * Public wrapper so other components (or commands) can trigger indexing.
     */
    public async forceReindex(): Promise<void> {
        // Delegate to existing background indexing flow
        await this._startBackgroundIndexingWithProgress();
    }

    /**
     * Refresh the current graph view (preserves view mode)
     */
    public async refreshGraph(): Promise<void> {
        if (!this._view) {
            return;
        }

        log.info('Refreshing current graph view');
        
        // Refresh the appropriate view based on current mode
        if (this._currentSymbolFilePath) {
            // In symbol view - refresh symbol analysis
            await this.handleDrillDown(this._currentSymbolFilePath, true);
        } else {
            // In file view - refresh file dependencies
            this.updateGraph(true);
        }
    }

    /**
     * Toggle between file view and symbol view
     * @returns The new view mode
     */
    public async toggleViewMode(): Promise<{ mode: 'file' | 'symbol'; message: string }> {
        if (!this._view) {
            return { mode: 'file', message: 'View not initialized' };
        }

        const editor = vscode.window.activeTextEditor;
        if (editor?.document.uri.scheme !== 'file') {
            vscode.window.showWarningMessage('No active file to toggle view');
            return { mode: 'file', message: 'No active file' };
        }

        const filePath = editor.document.fileName;

        // Toggle based on current mode
        if (this._currentSymbolFilePath) {
            // Currently in symbol view → switch to file view
            log.info('Toggling from symbol view to file view');
            this._currentSymbolFilePath = undefined;
            this.updateGraph();
            return { mode: 'file', message: 'Switched to File View' };
        } else {
            // Currently in file view → switch to symbol view
            log.info('Toggling from file view to symbol view');
            await this.handleDrillDown(filePath);
            return { mode: 'symbol', message: 'Switched to Symbol View' };
        }
    }

    /**
     * Toggle expand/collapse all nodes in the current graph view
     * @returns The new state (true if expanded, false if collapsed)
     */
    public async expandAllNodes(): Promise<{ expanded: boolean; message: string }> {
        if (!this._view) {
            return { expanded: false, message: 'View not initialized' };
        }

        // Get current state and toggle it
        const currentExpandAll = this._context.globalState.get<boolean>('expandAll', false);
        const newExpandAll = !currentExpandAll;

        // Update state
        await this._context.globalState.update('expandAll', newExpandAll);

        // Send message to webview to toggle expand/collapse
        const message: ExtensionToWebviewMessage = {
            command: 'setExpandAll',
            expandAll: newExpandAll
        };
        
        log.info('Sending setExpandAll message to webview:', newExpandAll);
        this._view.webview.postMessage(message);
        log.debug('Toggled expandAll from', currentExpandAll, 'to', newExpandAll);

        return {
            expanded: newExpandAll,
            message: newExpandAll ? 'All nodes expanded' : 'All nodes collapsed'
        };
    }

    /**
     * Return current indexer status snapshot (or null if spider not initialized)
     */
    public getIndexStatus(): IndexerStatusSnapshot | null {
        if (!this._spider) return null;
        try {
            return this._spider.getIndexStatus();
        } catch {
            return null;
        }
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
            // Send empty state message to webview
            const message: ExtensionToWebviewMessage = {
                command: 'emptyState',
                reason: 'no-file-open',
                message: 'Open a source file to visualize its dependencies'
            };
            this._view.webview.postMessage(message);
            return;
        }

        const filePath = editor.document.fileName;
        log.debug(isRefresh ? 'Refreshing' : 'Updating', 'graph for', filePath);

        // Only analyze supported files
        if (!/\.(ts|tsx|js|jsx|vue|svelte|gql|graphql)$/.test(filePath)) {
            log.debug('Unsupported file type');
            return;
        }

        await this.expandOrCollapse(filePath, isRefresh);
    }

    private async expandOrCollapse(filePath: string, isRefresh: boolean) {
        if (!this._spider || !this._view) {
            return;
        }
        try {
            const graphData = await this._spider.crawl(filePath);
            log.info('Crawl completed:', graphData.nodes.length, 'nodes,', graphData.edges.length, 'edges');

            // Log details for debugging
            if (graphData.nodes.length === 0) {
                log.warn('No nodes found for', filePath);
            } else if (graphData.edges.length === 0) {
                log.warn('No edges found despite', graphData.nodes.length, 'nodes');
                log.debug('Nodes:', graphData.nodes);
            }

            const expandAll = this._context.globalState.get<boolean>('expandAll', false);
            // If reverse index is enabled, compute parent counts for all nodes so the webview
            // can decide which nodes show the 'Find references' toggle without additional network requests
            const enrichedData = { ...graphData } as { nodes: string[]; edges: { source: string; target: string }[]; nodeLabels?: Record<string, string>; parentCounts?: Record<string, number> };
            if (this._spider.hasReverseIndex()) {
                const parentCounts: Record<string, number> = {};
                await Promise.all(enrichedData.nodes.map(async (n) => {
                    try {
                        const refs = await this._spider!.findReferencingFiles(n);
                        if (refs && refs.length > 0) parentCounts[n] = refs.length;
                    } catch (err) {
                        // Ignore per-node failures but log at debug level for diagnostics
                        log.debug('Failed to compute parent count for', n, err instanceof Error ? err.message : String(err));
                    }
                }));
                if (Object.keys(parentCounts).length > 0) {
                    enrichedData.parentCounts = parentCounts;
                }
            }

            const message: ExtensionToWebviewMessage = {
                command: 'updateGraph',
                filePath,
                data: enrichedData,
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
