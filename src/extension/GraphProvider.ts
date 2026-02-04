import * as path from "node:path";
import * as vscode from "vscode";
import type { IndexerStatusSnapshot } from "../analyzer/IndexerStatus";
import { Spider } from "../analyzer/Spider";
import { SUPPORTED_SOURCE_FILE_REGEX } from "../shared/constants";
import type {
  ExtensionToWebviewMessage,
  SetExpandAllMessage,
  SwitchModeMessage,
  WebviewLogMessage,
  WebviewToExtensionMessage,
} from "../shared/types";
import { extensionLoggerManager, getExtensionLogger } from "./extensionLogger";
import { BackgroundIndexingManager } from "./services/BackgroundIndexingManager";
import { EditorNavigationService } from "./services/EditorNavigationService";
import type { EventType } from "./services/FileChangeScheduler";
import { FileChangeScheduler } from "./services/FileChangeScheduler";
import { GraphViewService } from "./services/GraphViewService";
import { NodeInteractionService } from "./services/NodeInteractionService";
import {
  ProviderConfigSnapshot,
  ProviderStateManager,
} from "./services/ProviderStateManager";
import { SourceFileWatcher } from "./services/SourceFileWatcher";
import { SymbolViewService } from "./services/SymbolViewService";
import { UnusedAnalysisCache } from "./services/UnusedAnalysisCache";
import { WebviewMessageRouter } from "./services/WebviewMessageRouter";
import { WebviewManager } from "./WebviewManager";

/** Logger instance for GraphProvider */
const log = getExtensionLogger("GraphProvider");

/** Default delay before starting background indexing (ms) */
const DEFAULT_INDEXING_START_DELAY = 1000;

export class GraphProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "graph-it-live.graphView";

  private _view?: vscode.WebviewView;
  private _spider?: Spider;
  private readonly _webviewManager: WebviewManager;
  private readonly _indexingManager?: BackgroundIndexingManager;
  private readonly _sourceFileWatcher?: SourceFileWatcher;
  private readonly _fileChangeScheduler?: FileChangeScheduler;
  private _configSnapshot: ProviderConfigSnapshot;
  private readonly _messageRouter: WebviewMessageRouter;
  private readonly _graphViewService?: GraphViewService;
  private readonly _symbolViewService?: SymbolViewService;
  private readonly _nodeInteractionService?: NodeInteractionService;
  private readonly _navigationService?: EditorNavigationService;
  private readonly _stateManager: ProviderStateManager;
  private _reverseDependenciesVisible = false; // Track reverse dependencies visibility state
  private readonly _activeExpansionControllers = new Map<
    string,
    AbortController
  >();
  private readonly _unusedAnalysisCache?: UnusedAnalysisCache;
  private readonly _fileSaveListener?: vscode.Disposable;
  private _fileSaveDebounceTimer?: NodeJS.Timeout;
  /**
   * Optional callback used by EditorEventsService to notify MCP server.
   * Populated by extension activation if MCP server is registered.
   */
  public notifyMcpServerOfConfigChange?: () => void;

  /**
   * Get the file change scheduler for use by EditorEventsService
   */
  public get fileChangeScheduler(): FileChangeScheduler | undefined {
    return this._fileChangeScheduler;
  }

  /**
   * Get the state manager for configuration management
   */
  public get stateManager(): ProviderStateManager {
    return this._stateManager;
  }

  /**
   * Flush unused analysis cache to disk (called on deactivation)
   */
  public async flushCaches(): Promise<void> {
    await this._unusedAnalysisCache?.flush();
  }

  private _initializeFilterContext(): void {
    void vscode.commands.executeCommand(
      "setContext",
      "graph-it-live.unusedFilterActive",
      this._stateManager.getUnusedFilterActive(),
    );
    // Initialize viewMode context key
    void vscode.commands.executeCommand(
      "setContext",
      "graph-it-live.viewMode",
      this._stateManager.viewMode,
    );
    // Initialize reverseDependenciesVisible context key
    void vscode.commands.executeCommand(
      "setContext",
      "graph-it-live.reverseDependenciesVisible",
      false,
    );
  }

  /**
   * Update the viewMode context key based on current state
   */
  private async _updateViewModeContext(): Promise<void> {
    const mode = this._stateManager.viewMode;
    await vscode.commands.executeCommand(
      "setContext",
      "graph-it-live.viewMode",
      mode,
    );
    log.debug(`Updated viewMode context to: ${mode}`);
  }

  constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
    this._webviewManager = new WebviewManager(extensionUri);
    this._stateManager = new ProviderStateManager(
      context,
      DEFAULT_INDEXING_START_DELAY,
    );
    this._configSnapshot = this._stateManager.loadConfiguration();

    this._initializeSpider(this._configSnapshot);

    // Initialize context for toggle button (async operation moved after init)
    this._initializeFilterContext();

    if (this._spider) {
      this._unusedAnalysisCache = new UnusedAnalysisCache(
        context,
        this._configSnapshot.persistUnusedAnalysisCache,
        this._configSnapshot.maxUnusedAnalysisCacheSize,
      );

      this._graphViewService = new GraphViewService(
        this._spider,
        log,
        {
          unusedAnalysisConcurrency:
            this._configSnapshot.unusedAnalysisConcurrency,
          unusedAnalysisMaxEdges: this._configSnapshot.unusedAnalysisMaxEdges,
        },
        this._unusedAnalysisCache,
      );
      this._symbolViewService = new SymbolViewService(this._spider, log);
      this._nodeInteractionService = new NodeInteractionService(
        this._spider,
        log,
      );
      this._navigationService = new EditorNavigationService(this._spider, log);
      this._indexingManager = new BackgroundIndexingManager({
        context,
        extensionUri,
        spider: this._spider,
        logger: log,
        onIndexingComplete: () => this._refreshAfterIndexing(),
        initialConfig: this._configSnapshot,
      });

      // Initialize FileChangeScheduler with unified handler
      this._fileChangeScheduler = new FileChangeScheduler({
        processHandler: async (filePath: string, eventType: EventType) => {
          await this.handleFileChange(filePath, eventType);
        },
        debounceDelay: 300, // 300ms debounce
      });

      this._sourceFileWatcher = new SourceFileWatcher({
        context,
        logger: log,
        fileChangeScheduler: this._fileChangeScheduler,
      });

      // T075: Add file save listener for live updates (User Story 5)
      this._fileSaveListener = vscode.workspace.onDidSaveTextDocument(
        (document) => this._handleFileSave(document),
      );
      context.subscriptions.push(this._fileSaveListener);
    }

    this._messageRouter = new WebviewMessageRouter({
      logger: log,
      handlers: {
        openFile: async (m) => {
          if (m.path) await this.handleOpenFile(m.path, m.line);
        },
        expandNode: async (m) => {
          if (m.nodeId) await this.handleExpandNode(m.nodeId, m.knownNodes);
        },
        cancelExpandNode: async (m) => {
          await this.handleCancelExpandNode(m.nodeId);
        },
        setExpandAll: async (m) => {
          await this._handleSetExpandAllMessage(m);
        },
        refreshGraph: async () => {
          await this.refreshGraph();
        },
        findReferencingFiles: async (m) => {
          if (m.nodeId) await this.handleFindReferencingFiles(m.nodeId);
        },
        drillDown: async (m) => {
          if (m.filePath) await this.handleDrillDown(m.filePath);
        },
        ready: async () => {
          log.debug("Webview ready, sending initial graph");
          await this.updateGraph();
        },
        webviewLog: async (m) => {
          await this._forwardWebviewLog(m);
        },
        switchMode: async (m) => {
          await this._handleSwitchModeMessage(m);
        },
        enableUnusedFilter: async () => {
          if (!this.getUnusedFilterActive()) {
            await this.toggleUnusedFilter();
          }
        },
        disableUnusedFilter: async () => {
          if (this.getUnusedFilterActive()) {
            await this.toggleUnusedFilter();
          }
        },
        selectSymbol: async (m) => {
          await this.handleSelectSymbol(m.symbolId);
        },
        navigateToSymbol: async (m) => {
          if (m.filePath && m.line) {
            await this.handleOpenFile(m.filePath, m.line);
          }
        },
      },
    });
    // Note: Indexing is now deferred until resolveWebviewView() is called
  }

  private async _refreshAfterIndexing(): Promise<void> {
    if (this._stateManager.currentSymbol) {
      await this.handleDrillDown(this._stateManager.currentSymbol, true);
    } else {
      await this.updateGraph(true, "indexing");
    }
  }

  private async _handleSetExpandAllMessage(
    message: SetExpandAllMessage,
  ): Promise<void> {
    log.debug("Setting expandAll to", message.expandAll);
    await this._stateManager.setExpandAll(message.expandAll);
  }

  private async _handleSwitchModeMessage(
    message: SwitchModeMessage,
  ): Promise<void> {
    log.debug("Switching to", message.mode, "mode");
    if (message.mode === "file") {
      const previousSymbolId = this._stateManager.selectedSymbolId;
      await this._stateManager.setViewMode("file");
      this._stateManager.selectedSymbolId = undefined;

      // Switching back to file view should not depend on an active text editor,
      // otherwise clicking "File View" from the Symbol view can get stuck when
      // the active editor is an output/virtual document.
      const fallbackLastFile = this._stateManager.getLastActiveFilePath();
      const candidate = previousSymbolId
        ? this._navigationService?.parseFilePathAndSymbol(previousSymbolId)
            .actualFilePath
        : undefined;
      const targetFilePath = candidate || fallbackLastFile;

      if (targetFilePath && SUPPORTED_SOURCE_FILE_REGEX.test(targetFilePath)) {
        await this._sendGraphUpdate(targetFilePath, false);
        return;
      }

      this.updateGraph();
    } else if (message.mode === "symbol") {
      const editor = vscode.window.activeTextEditor;
      if (editor?.document.uri.scheme === "file") {
        await this.handleDrillDown(editor.document.fileName);
      }
    }
  }

  private _initializeSpider(config: ProviderConfigSnapshot) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    if (workspaceRoot) {
      this._spider = new Spider({
        rootDir: workspaceRoot,
        tsConfigPath: path.join(workspaceRoot, "tsconfig.json"),
        excludeNodeModules: config.excludeNodeModules,
        maxDepth: config.maxDepth,
        enableReverseIndex: config.enableBackgroundIndexing,
        indexingConcurrency: config.indexingConcurrency,
        maxCacheSize: config.maxCacheSize,
        maxSymbolCacheSize: config.maxSymbolCacheSize,
      });

      // Don't start indexing here - it will be deferred until view is resolved
    }
  }

  public updateConfig() {
    if (this._spider) {
      this._configSnapshot = this._stateManager.loadConfiguration();

      this._spider.updateConfig({
        excludeNodeModules: this._configSnapshot.excludeNodeModules,
        maxDepth: this._configSnapshot.maxDepth,
        enableReverseIndex: this._configSnapshot.enableBackgroundIndexing,
        indexingConcurrency: this._configSnapshot.indexingConcurrency,
      });

      if (this._indexingManager) {
        this._indexingManager.updateConfiguration(this._configSnapshot);
        void this._indexingManager.handleConfigUpdate(
          this._spider.hasReverseIndex(),
        );
      }

      // Notify webview of the updated filter configuration
      // This ensures the webview has the correct unusedDependencyMode
      // when the user toggles the filter after changing settings
      if (this._view) {
        const filterActive = this._stateManager.getUnusedFilterActive();
        const effectiveMode = filterActive
          ? this._configSnapshot.unusedDependencyMode
          : "none";
        this._view.webview.postMessage({
          command: "updateFilter",
          filterUnused: filterActive,
          unusedDependencyMode: effectiveMode,
        });
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
    if (!SUPPORTED_SOURCE_FILE_REGEX.test(filePath)) {
      return;
    }

    log.debug("Re-analyzing saved file:", filePath);

    // Invalidate unused analysis cache for this file
    this._unusedAnalysisCache?.invalidate([filePath]);

    // TASK-016: Invalidate symbol cache for this file
    this._stateManager.invalidateSymbolCache(filePath);

    // Re-analyze the file (invalidates cache and updates reverse index)
    await this._spider.reanalyzeFile(filePath);

    // Persist the updated index if enabled
    await this._indexingManager?.persistIndexIfEnabled();

    // Refresh the appropriate view based on current mode
    if (this._stateManager.currentSymbol) {
      // In symbol view - always refresh to update reverse dependencies (Imported By list)
      // even if the saved file is different from the viewed one
      await this.handleDrillDown(this._stateManager.currentSymbol, true);
    } else {
      // In file view - refresh the graph (preserve view mode)
      await this.updateGraph(true, "fileSaved");
    }
  }

  /**
   * T076-T078: Handle file save events with 500ms debounce
   * Automatically refreshes symbol graph when viewing a file that was edited
   * @param document The saved text document
   */
  private _handleFileSave(document: vscode.TextDocument): void {
    // T082: Only process files in the workspace
    if (document.uri.scheme !== "file") {
      return;
    }

    const filePath = document.uri.fsPath;

    // T082: Optimization - only re-analyze if currently viewing this file
    const currentFilePath = this._stateManager.currentSymbol
      ? this._navigationService?.parseFilePathAndSymbol(
          this._stateManager.currentSymbol,
        ).actualFilePath
      : this._stateManager.getLastActiveFilePath();

    const shouldRefresh =
      currentFilePath &&
      path.normalize(currentFilePath) === path.normalize(filePath);

    if (!shouldRefresh) {
      log.debug(
        `File saved but not currently viewing: ${filePath}, skipping refresh`,
      );
      return;
    }

    // T076: Clear existing debounce timer if any
    if (this._fileSaveDebounceTimer) {
      clearTimeout(this._fileSaveDebounceTimer);
    }

    // T076: Debounce for 500ms to avoid excessive re-analysis during rapid edits
    this._fileSaveDebounceTimer = setTimeout(() => {
      log.debug(`Debounce complete, refreshing view for: ${filePath}`);
      
      // T081: Send refreshing message to show loading indicator
      if (this._view) {
        this._view.webview.postMessage({ command: 'refreshing' });
      }
      
      // T077-T078: Trigger re-analysis and refresh
      this.onFileSaved(filePath).catch((error: unknown) => {
        log.error(
          "Error refreshing view after file save",
          error instanceof Error ? error : new Error(String(error)),
        );
      });
      this._fileSaveDebounceTimer = undefined;
    }, 500);
  }

  /**
   * Handle active file change - update view for new file while preserving view type
   * If in symbol view, show symbols for new file
   * If in file view, show dependencies for new file
   */
  public async onActiveFileChanged(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme !== "file") {
      return;
    }

    const newFilePath = editor.document.fileName;

    // Only handle supported file types
    if (!SUPPORTED_SOURCE_FILE_REGEX.test(newFilePath)) {
      return;
    }

    log.debug("Active file changed to:", newFilePath);

    // Preserve the current view type
    if (this._stateManager.currentSymbol) {
      // Was in symbol view - show symbols for the new file
      // Update tracking to new file and refresh symbol view
      await this.handleDrillDown(newFilePath, true);
    } else {
      // Was in file view - show dependencies for the new file
      await this.updateGraph(true, "navigation");
    }
  }

  /**
   * Unified handler for file changes from both editor saves and file system watcher.
   * Called by FileChangeScheduler after debouncing and event coalescence.
   * @param filePath Normalized file path
   * @param eventType Type of event (create, change, delete)
   */
  public async handleFileChange(
    filePath: string,
    eventType: EventType,
  ): Promise<void> {
    if (!this._spider) {
      return;
    }

    // Only handle supported file types
    if (!SUPPORTED_SOURCE_FILE_REGEX.test(filePath)) {
      return;
    }

    log.debug(`Processing ${eventType} event for:`, filePath);

    switch (eventType) {
      case "create":
      case "change":
        // Re-analyze file and update index
        await this._spider.reanalyzeFile(filePath);
        await this._indexingManager?.persistIndexIfEnabled();
        await this._refreshByCurrentView();
        break;

      case "delete":
        // Remove file from cache and index
        this._spider.handleFileDeleted(filePath);
        await this._indexingManager?.persistIndexIfEnabled();
        await this._handleDeletedFileRefresh(filePath);
        break;
    }
  }

  /**
   * Refresh the appropriate view based on current mode
   * Private helper for unified file change handling
   */
  private async _refreshByCurrentView(): Promise<void> {
    if (this._stateManager.currentSymbol) {
      // In symbol view - refresh symbol analysis
      await this.handleDrillDown(this._stateManager.currentSymbol, true);
    } else {
      // In file view - refresh dependency graph
      await this.updateGraph(true, "fileChange");
    }
  }

  /**
   * Handle refresh when a file is deleted
   * If the deleted file is the currently viewed symbol, clear symbol view
   * Private helper for unified file change handling
   */
  private async _handleDeletedFileRefresh(deletedPath: string): Promise<void> {
    if (this._stateManager.selectedSymbolId === deletedPath) {
      // The currently viewed file was deleted - switch to file view
      await this._stateManager.setViewMode("file");
      this._stateManager.selectedSymbolId = undefined;
      await this.updateGraph();
    } else {
      // Some other file was deleted - refresh current view
      await this._refreshByCurrentView();
    }
  }

  /**
   * Handle openFile message
   * Supports both regular file paths and symbol IDs (filePath:symbolName)
   * @param filePath The file path or symbol ID
   * @param line Optional line number to navigate to (1-indexed)
   */
  private async handleOpenFile(filePath: string, line?: number): Promise<void> {
    if (!this._navigationService) {
      return;
    }
    try {
      await this._navigationService.openFile(filePath, line);
    } catch (e) {
      log.error("Error opening file:", e);
      vscode.window.showErrorMessage(`Could not open file: ${filePath}`);
    }
  }

  /**
   * Handle expandNode message
   */
  private async handleExpandNode(
    nodeId: string,
    knownNodes: string[] | undefined,
  ): Promise<void> {
    if (!this._nodeInteractionService || !this._view) {
      return;
    }

    // Cancel only the previous expansion for the same node.
    // Cancelling across different nodes makes fast user interactions unreliable.
    this._activeExpansionControllers.get(nodeId)?.abort();
    const abortController = new AbortController();
    this._activeExpansionControllers.set(nodeId, abortController);

    const sendProgress = (
      status: "started" | "in-progress" | "completed" | "cancelled" | "error",
      processed?: number,
      total?: number,
      message?: string,
    ): void => {
      this._view?.webview.postMessage({
        command: "expansionProgress",
        nodeId,
        status,
        processed,
        total,
        message,
      });
    };

    sendProgress("started");

    try {
      const result = await this._nodeInteractionService.expandNode(
        nodeId,
        knownNodes,
        {
          signal: abortController.signal,
          onBatch: async (batch, totals) => {
            if (!this._view) return;
            this._view.webview.postMessage({
              command: "expandedGraph",
              nodeId,
              data: batch,
            });
            sendProgress("in-progress", totals.nodes);
          },
        },
      );

      if (abortController.signal.aborted) {
        sendProgress("cancelled", undefined, undefined, "Cancelled");
        return;
      }

      this._view.webview.postMessage(result);
      sendProgress("completed", result.data.nodes.length);
    } catch (e) {
      if (abortController.signal.aborted) {
        sendProgress("cancelled", undefined, undefined, "Cancelled");
        return;
      }
      log.error("Error expanding node:", e);
      sendProgress(
        "error",
        undefined,
        undefined,
        e instanceof Error ? e.message : "Unknown error",
      );
    } finally {
      const current = this._activeExpansionControllers.get(nodeId);
      if (current === abortController)
        this._activeExpansionControllers.delete(nodeId);
    }
  }

  /**
   * Handle cancel expansion message
   */
  private async handleCancelExpandNode(nodeId?: string): Promise<void> {
    if (!nodeId) {
      for (const controller of this._activeExpansionControllers.values()) {
        controller.abort();
      }
      this._activeExpansionControllers.clear();
      return;
    }

    const controller = this._activeExpansionControllers.get(nodeId);
    controller?.abort();
  }

  /**
   * Handle findReferencingFiles message
   */
  private async handleFindReferencingFiles(nodeId: string): Promise<void> {
    if (!this._nodeInteractionService || !this._view) {
      return;
    }
    try {
      const result =
        await this._nodeInteractionService.getReferencingFiles(nodeId);
      this._view.webview.postMessage(result);
    } catch (e) {
      log.error("Error finding referencing files:", e);
    }
  }

  /**
   * TASK-014: Handle selectSymbol message
   * Sets the selected symbol and filters the graph to show only files that reference it
   * @param symbolId The symbol ID to filter by, or undefined to clear the filter
   */
  public async handleSelectSymbol(symbolId: string | undefined): Promise<void> {
    log.debug("Selecting symbol:", symbolId);

    // Update the selected symbol in state manager
    this._stateManager.selectedSymbolId = symbolId;

    if (symbolId && this._spider) {
      // Get referencing files from SymbolReverseIndex
      const referencingFiles = this._spider.getSymbolReferencingFiles(symbolId);
      this._stateManager.setSymbolReferencingFiles(symbolId, referencingFiles);

      log.debug(`Symbol ${symbolId} selected - ${referencingFiles.size} referencing files found`);
    } else {
      // Clear the filter
      log.debug("Symbol filter cleared");
    }

    // Refresh the graph with the updated filter
    await this.updateGraph(true, "usage-analysis");
  }

  /**
   * Handle drillDown message (Symbol Analysis)
   * @param filePath The file to analyze
   * @param isRefresh If true, this is a refresh not navigation - don't push to history
   * @param targetViewMode Optional target view mode to pass to webview
   */
  private async handleDrillDown(
    filePath: string,
    isRefresh: boolean = false,
    targetViewMode?: "symbol" | "list",
  ): Promise<void> {
    log.info(
      `[GraphProvider] handleDrillDown ENTRY: filePath=${filePath}, isRefresh=${isRefresh}`,
    );
    if (!this._symbolViewService || !this._view || !this._navigationService) {
      log.warn(
        `[GraphProvider] handleDrillDown ABORT: Missing services (symbolView=${!!this._symbolViewService}, view=${!!this._view}, navigation=${!!this._navigationService})`,
      );
      return;
    }

    // Don't eagerly set current symbol yet - we need to resolve relative/module
    // specifiers first so the tracked file is always an absolute path.

    try {
      log.info(
        isRefresh ? "Refreshing" : "Drilling down into",
        filePath,
        "for symbol analysis",
      );

      // Parse symbol ID (e.g. './utils:format') to separate file path from symbol name
      const { actualFilePath: requestedPath, symbolName } =
        this._navigationService.parseFilePathAndSymbol(filePath);

      // Resolve the file path to an absolute path if needed
      const resolvedFilePath =
        await this._navigationService.resolveDrillDownPath(
          requestedPath,
          this._stateManager.currentSymbol,
        );
      if (!resolvedFilePath) return; // Messages already shown by resolver

      await this._stateManager.setLastActiveFilePath(resolvedFilePath);
      await this._stateManager.setCurrentFilePath(resolvedFilePath);

      // Track the resolved (absolute) file we are viewing for refreshes
      const rootNodeId = symbolName
        ? `${resolvedFilePath}:${symbolName}`
        : resolvedFilePath;

      // Update state - set mode explicitly if targetViewMode provided
      if (targetViewMode) {
        await this._stateManager.setViewMode(targetViewMode);
      } else {
        // Default to symbol mode for backward compatibility
        await this._stateManager.setViewMode("symbol");
      }
      this._stateManager.selectedSymbolId = rootNodeId;

      // Update context key for toolbar visibility
      this._updateViewModeContext();

      // Read call hierarchy settings from configuration
      const config = vscode.workspace.getConfiguration("graph-it-live");
      const enableCallHierarchy = config.get<boolean>(
        "enableCallHierarchy",
        false,
      );
      const enableIncomingCalls = config.get<boolean>(
        "enableIncomingCalls",
        true,
      );
      const callHierarchyMaxFileSize = config.get<number>(
        "callHierarchyMaxFileSize",
        5000,
      );

      log.info(
        `[GraphProvider] Building symbol graph for ${resolvedFilePath}, enableCallHierarchy=${enableCallHierarchy}`,
      );

      const symbolGraph = await this._symbolViewService.buildSymbolGraph(
        resolvedFilePath,
        rootNodeId,
        {
          includeCallHierarchy: enableCallHierarchy,
          maxFileLines: callHierarchyMaxFileSize,
          callHierarchyOptions: {
            includeIncoming: enableIncomingCalls,
          },
        },
      );

      log.info(
        `[GraphProvider] Symbol graph built: ${symbolGraph.symbolData.symbols.length} symbols, ${symbolGraph.symbolData.dependencies.length} dependencies`,
      );

      const response: ExtensionToWebviewMessage = {
        command: "symbolGraph",
        filePath: rootNodeId,
        isRefresh,
        targetViewMode,
        graph: symbolGraph.graph || {
          filePath: rootNodeId,
          nodes: [],
          edges: [],
          hasCycle: false,
        },
        breadcrumb: {
          segments: [rootNodeId.split("/").pop() || rootNodeId],
          filePath: rootNodeId,
        },
        data: {
          nodes: symbolGraph.nodes,
          edges: symbolGraph.edges,
          symbolData: symbolGraph.symbolData,
          incomingDependencies: symbolGraph.incomingDependencies,
          referencingFiles: symbolGraph.referencingFiles,
          parentCounts: symbolGraph.parentCounts,
        },
      };

      log.debug(
        `[GraphProvider] Sending symbolGraph message: ${symbolGraph.symbolData.symbols.length} symbols, ${symbolGraph.symbolData.dependencies.length} dependencies, ${symbolGraph.edges.length} edges`,
      );
      log.info(
        `[GraphProvider-WEBVIEW] Message content: nodes=${symbolGraph.nodes.length}, edges=${symbolGraph.edges.length}, incomingDeps=${symbolGraph.incomingDependencies?.length ?? 0}`,
      );
      log.info(
        `[GraphProvider-WEBVIEW] Incoming dependency types: ${symbolGraph.incomingDependencies?.map(d => d.relationType).join(', ') || 'none'}`,
      );
      log.debug(
        `[GraphProvider] Sample dependency:`,
        symbolGraph.symbolData.dependencies[0],
      );

      this._view.webview.postMessage(response);

      // Log metadata about the analysis
      const metadata = symbolGraph.metadata;
      if (metadata) {
        log.debug(
          "Symbol graph analysis:",
          symbolGraph.nodes.length,
          "nodes,",
          symbolGraph.edges.length,
          "edges,",
          "LSP used:",
          metadata.lspUsed,
          "call edges:",
          metadata.callEdgesCount,
        );
        if (metadata.warnings.length > 0) {
          log.warn("Analysis warnings:", metadata.warnings.join(", "));
        }
      } else {
        log.debug(
          "Sent symbol graph with",
          symbolGraph.nodes.length,
          "nodes and",
          symbolGraph.edges.length,
          "edges",
        );
      }
    } catch (error) {
      log.error("Error drilling down into symbols:", error);
      vscode.window.showErrorMessage(
        `Failed to analyze symbols: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Refresh the current graph view (used when user navigates in symbol view)
   * Re-runs LSP analysis to update call hierarchy
   */
  public async refreshCurrentGraphView(): Promise<void> {
    const stateManager = this._stateManager;
    const currentFilePath = stateManager.currentFilePath;
    const currentMode = stateManager.viewMode;

    // Check if view is available - if not, skip refresh
    if (!this._view) {
      log.debug('View not available, skipping refresh');
      return;
    }

    if (!currentFilePath || currentMode !== 'symbol') {
      return; // Only refresh in symbol mode
    }

    log.info(`Refreshing current graph view: mode=${currentMode}, file=${currentFilePath}`);

    // Get current symbol if any
    const currentSymbol = stateManager.currentSymbol;
    const filePath = currentSymbol || currentFilePath;

    // Call handleDrillDown with isRefresh=true to re-run LSP analysis
    log.info(`Calling handleDrillDown for refresh in ${currentMode} mode`);
    await this.handleDrillDown(filePath, true, currentMode);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = this._webviewManager.getWebviewOptions();
    webviewView.webview.html = this._webviewManager.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      async (message: WebviewToExtensionMessage) => {
        await this._messageRouter.handle(message);
      },
    );

    // Clean up timer and worker when view is disposed
    webviewView.onDidDispose(() => {
      this._indexingManager?.cancelScheduledIndexing();
      this._sourceFileWatcher?.dispose();
      this._fileChangeScheduler?.dispose();
      this._fileSaveListener?.dispose();
      if (this._fileSaveDebounceTimer) {
        clearTimeout(this._fileSaveDebounceTimer);
        this._fileSaveDebounceTimer = undefined;
      }
      // Also clean up the worker if running
      this._spider?.disposeWorker();
      // Dispose Spider and its AstWorkerHost
      this._spider
        ?.dispose()
        .then()
        .catch((error: unknown) => {
          log.error(
            "Error disposing Spider",
            error instanceof Error ? error : new Error(String(error)),
          );
        });
    });

    // Schedule deferred indexing now that view is ready
    this._indexingManager?.scheduleDeferredIndexing();

    // Initial update if we have an active editor
    this.updateGraph();
  }

  private async _forwardWebviewLog(message: WebviewLogMessage) {
    const level = message.level ?? "info";
    const msg = message.message ?? "";
    const args = message.args ?? [];
    const webviewLogger = extensionLoggerManager.getLogger("Webview");
    switch (level) {
      case "debug":
        webviewLogger.debug(msg, ...args);
        break;
      case "info":
        webviewLogger.info(msg, ...args);
        break;
      case "warn":
        webviewLogger.warn(msg, ...args);
        break;
      case "error":
        webviewLogger.error(msg, ...args);
        break;
    }
  }

  /**
   * Force a full re-index immediately (useful for debugging / command palette)
   * Public wrapper so other components (or commands) can trigger indexing.
   */
  public async forceReindex(): Promise<void> {
    await this._indexingManager?.forceReindex();
  }

  /**
   * Refresh the current graph view (preserves view mode)
   */
  public async refreshGraph(): Promise<void> {
    if (!this._view) {
      log.warn("Cannot refresh: view not initialized");
      return;
    }

    try {
      const currentMode = this._stateManager.viewMode;
      const currentFilePath = this._stateManager.currentFilePath;

      log.info(`Refreshing current graph view: mode=${currentMode}, file=${currentFilePath}`);
      log.info(`currentSymbol=${this._stateManager.currentSymbol}`);

      // Refresh based on current view mode
      if (currentMode === "symbol" || currentMode === "list") {
        // In symbol/list view - refresh symbol analysis
        if (currentFilePath) {
          log.info(`Calling handleDrillDown for refresh in ${currentMode} mode`);
          await this.handleDrillDown(currentFilePath, true, currentMode);
          log.info("handleDrillDown completed successfully");
        } else {
          log.warn("Cannot refresh symbol view: no current file path");
        }
      } else {
      // In file view - behave like "re-open current file":
      // reset state in the webview and cancel any ongoing expansions.
        log.info("Refreshing file view");
        for (const controller of this._activeExpansionControllers.values()) {
          controller.abort();
        }
        this._activeExpansionControllers.clear();
        await this.updateGraph(false, "manual");
      }
    } catch (error) {
      log.error("Error during refresh:", error);
      throw error;
    }
  }





  /**
   * Cycle through view modes: file → list → symbol → file
   * Kept for backward compatibility
   * @returns The new view mode
   */
  public async toggleViewMode(): Promise<{
    mode: "file" | "list" | "symbol";
    message: string;
  }> {
    const currentMode = this._stateManager.viewMode;

    // Cycle: file → list → symbol → file
    if (currentMode === "file") {
      await this.setViewModeList();
      return { mode: "list", message: "Switched to List View" };
    } else if (currentMode === "list") {
      await this.setViewModeSymbol();
      return { mode: "symbol", message: "Switched to Symbol View" };
    } else {
      // currentMode === "symbol"
      await this.setViewModeFile();
      return { mode: "file", message: "Switched to File View" };
    }
  }

  /**
   * Switch directly to file view mode
   */
  public async setViewModeFile(): Promise<void> {
    if (!this._view) {
      vscode.window.showWarningMessage("View not initialized");
      return;
    }

    log.info("Switching to file view mode");
    await this._stateManager.setViewMode("file");
    await this._updateViewModeContext();

    // Switch to current file in file mode
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme === "file") {
      await this._sendGraphUpdate(editor.document.fileName, false);
    } else {
      const filePath = this._stateManager.getLastActiveFilePath();
      if (filePath) {
        await this._sendGraphUpdate(filePath, false);
      } else {
        await this.updateGraph();
      }
    }
  }

  /**
   * Switch directly to list view mode
   */
  public async setViewModeList(): Promise<void> {
    if (!this._view) {
      vscode.window.showWarningMessage("View not initialized");
      return;
    }

    log.info("Switching to list view mode");
    await this._stateManager.setViewMode("list");
    await this._updateViewModeContext();

    // Switch to current file in list mode
    const editor = vscode.window.activeTextEditor;
    const filePath =
      editor?.document.uri.scheme === "file"
        ? editor.document.fileName
        : this._stateManager.getLastActiveFilePath();

    if (filePath) {
      await this.handleDrillDown(filePath, false, "list");
    } else {
      vscode.window.showWarningMessage("No active file for list view");
    }
  }

  /**
   * Switch directly to symbol view mode
   */
  public async setViewModeSymbol(): Promise<void> {
    if (!this._view) {
      vscode.window.showWarningMessage("View not initialized");
      return;
    }

    log.info("Switching to symbol view mode");
    await this._stateManager.setViewMode("symbol");
    await this._updateViewModeContext();

    // Switch to current file in symbol mode
    const editor = vscode.window.activeTextEditor;
    const filePath =
      editor?.document.uri.scheme === "file"
        ? editor.document.fileName
        : this._stateManager.getLastActiveFilePath();

    if (filePath) {
      await this.handleDrillDown(filePath, false, "symbol");
    } else {
      vscode.window.showWarningMessage("No active file for symbol view");
    }
  }

  /**
   * Toggle incoming calls visibility in symbol view
   */
  public async toggleIncomingCalls(): Promise<{
    enabled: boolean;
    message: string;
  }> {
    const config = vscode.workspace.getConfiguration("graph-it-live");
    const currentValue = config.get<boolean>("enableIncomingCalls", false);
    const newValue = !currentValue;

    await config.update(
      "enableIncomingCalls",
      newValue,
      vscode.ConfigurationTarget.Global,
    );

    // Refresh symbol view if in symbol mode
    const currentMode = this._stateManager.viewMode;
    const currentSymbolId = this._stateManager.selectedSymbolId;

    if (currentMode === "symbol" && currentSymbolId) {
      // Refresh with explicit target mode to prevent mode switching
      await this.handleDrillDown(currentSymbolId, true, "symbol");
    }

    return {
      enabled: newValue,
      message: newValue
        ? "Incoming calls enabled (green dashed edges)"
        : "Incoming calls disabled",
    };
  }

  /**
   * Show reverse dependencies (which files import/reference the current file)
   */
  public async showReverseDependencies(): Promise<void> {
    if (!this._view) {
      vscode.window.showWarningMessage("View not initialized");
      return;
    }

    const editor = vscode.window.activeTextEditor;
    const filePath =
      editor?.document.uri.scheme === "file"
        ? editor.document.fileName
        : this._stateManager.getLastActiveFilePath();

    if (!filePath) {
      vscode.window.showWarningMessage(
        "No active file to show reverse dependencies",
      );
      return;
    }

    log.info(`Showing reverse dependencies for: ${filePath}`);

    // Use the existing getReferencingFiles functionality
    const result = await this._nodeInteractionService?.getReferencingFiles(filePath);

    if (result && this._view) {
      await this._view.webview.postMessage(result);
    }

    // Set context to indicate reverse dependencies are visible
    this._reverseDependenciesVisible = true;
    await vscode.commands.executeCommand(
      "setContext",
      "graph-it-live.reverseDependenciesVisible",
      true,
    );

    vscode.window.showInformationMessage(
      "Showing files that import this file",
    );
  }

  /**
   * Hide reverse dependencies overlay
   */
  public async hideReverseDependencies(): Promise<void> {
    if (!this._view) {
      vscode.window.showWarningMessage("View not initialized");
      return;
    }

    log.info("Hiding reverse dependencies");

    // Post message to webview to clear reverse dependencies
    await this._view.webview.postMessage({
      command: "clearReverseDependencies",
    });

    // Clear context to indicate reverse dependencies are hidden
    this._reverseDependenciesVisible = false;
    await vscode.commands.executeCommand(
      "setContext",
      "graph-it-live.reverseDependenciesVisible",
      false,
    );
  }

  /**
   * Toggle expand/collapse all nodes in the current graph view
   * @returns The new state (true if expanded, false if collapsed)
   */
  public async expandAllNodes(): Promise<{
    expanded: boolean;
    message: string;
  }> {
    if (!this._view) {
      return { expanded: false, message: "View not initialized" };
    }

    // Get current state and toggle it
    const currentExpandAll = this._stateManager.getExpandAll();
    const newExpandAll = !currentExpandAll;

    // Update state
    await this._stateManager.setExpandAll(newExpandAll);

    // Send message to webview to toggle expand/collapse
    const message: ExtensionToWebviewMessage = {
      command: "setExpandAll",
      expandAll: newExpandAll,
    };

    log.info("Sending setExpandAll message to webview:", newExpandAll);
    this._view.webview.postMessage(message);
    log.debug("Toggled expandAll from", currentExpandAll, "to", newExpandAll);
    // Notify webview to show progress overlay when expanding a large graph
    if (newExpandAll) {
      this._view.webview.postMessage({
        command: "expansionProgress",
        nodeId: "expandAll",
        status: "started",
      });
    }

    return {
      expanded: newExpandAll,
      message: newExpandAll ? "All nodes expanded" : "All nodes collapsed",
    };
  }

  /**
   * Get current unused dependency filter state
   */
  public getUnusedFilterActive(): boolean {
    return this._stateManager.getUnusedFilterActive();
  }

  /**
   * Get current view mode
   * @returns Current view mode ('file', 'list', or 'symbol')
   */
  public getViewMode(): 'file' | 'list' | 'symbol' {
    return this._stateManager.viewMode;
  }

  /**
   * Get reverse dependencies visibility state
   * @returns True if reverse dependencies are visible
   */
  public getReverseDependenciesVisible(): boolean {
    return this._reverseDependenciesVisible;
  }

  /**
   * Toggle unused dependency filter
   */
  public async toggleUnusedFilter(): Promise<void> {
    const currentState = this._stateManager.getUnusedFilterActive();
    const newState = !currentState;

    log.info(`Toggling unused filter: ${currentState} -> ${newState}`);

    await this._stateManager.setUnusedFilterActive(newState);
    await vscode.commands.executeCommand(
      "setContext",
      "graph-it-live.unusedFilterActive",
      newState,
    );

    log.info("Context key graph-it-live.unusedFilterActive set to", newState);

    // When activating the filter, rebuild the graph to ensure unusedEdges data is available
    // When deactivating, just update the filter state (no rebuild needed)
    if (newState) {
      // Activating filter - rebuild graph with usage analysis
      log.debug("Filter activated - rebuilding graph with usage analysis");
      await this.updateGraph(true, "usage-analysis");
    } else {
      // Deactivating filter - just update filter state in webview
      log.debug("Filter deactivated - updating filter state only");
      if (this._view) {
        this._view.webview.postMessage({
          command: "updateFilter",
          filterUnused: false,
          unusedDependencyMode: "none",
        });
      }
    }
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
  public async updateGraph(
    isRefresh: boolean = false,
    refreshReason:
      | "manual"
      | "indexing"
      | "fileSaved"
      | "navigation"
      | "fileChange"
      | "usage-analysis"
      | "unknown" = "unknown",
  ) {
    if (!this._view || !this._spider || !this._graphViewService) {
      log.debug("View or Spider not initialized");
      return;
    }

    // Do NOT clear currentSymbol here. View-mode transitions (setViewModeFile/setViewModeList/setViewModeSymbol)
    // are responsible for resetting symbol state. Clearing it on a plain update would
    // silently push the context key back to "file", breaking symbol-mode workflows.

    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme !== "file") {
      const lastFilePath = this._stateManager.getLastActiveFilePath();
      if (lastFilePath && SUPPORTED_SOURCE_FILE_REGEX.test(lastFilePath)) {
        log.debug(
          "No active file editor, using last active file",
          lastFilePath,
        );
        await this._sendGraphUpdate(lastFilePath, isRefresh, refreshReason);
        return;
      }
      log.debug("No active file editor");
      // Send empty state message to webview
      const message: ExtensionToWebviewMessage = {
        command: "emptyState",
        reason: "no-file-open",
        message: "Open a source file to visualize its dependencies",
      };
      this._view.webview.postMessage(message);
      return;
    }

    const filePath = editor.document.fileName;
    log.debug(isRefresh ? "Refreshing" : "Updating", "graph for", filePath);

    // Only analyze supported files
    if (!SUPPORTED_SOURCE_FILE_REGEX.test(filePath)) {
      log.debug("Unsupported file type");
      return;
    }

    await this._stateManager.setLastActiveFilePath(filePath);
    await this._sendGraphUpdate(filePath, isRefresh, refreshReason);
  }

  private async _sendGraphUpdate(
    filePath: string,
    isRefresh: boolean,
    refreshReason:
      | "manual"
      | "indexing"
      | "fileSaved"
      | "fileChange"
      | "navigation"
      | "usage-analysis"
      | "unknown" = "unknown",
  ): Promise<void> {
    if (!this._graphViewService || !this._view) {
      return;
    }

    try {
      // Step 1: Send immediate graph (fast, no usage check)
      const filterActive = this._stateManager.getUnusedFilterActive();
      // Effective mode is 'none' if filter is inactive, otherwise the configured mode ('hide' or 'dim')
      // Note: If configured mode is 'none' (which we removed from UI but config might lag), treat as 'none'.
      // Actually package.json update removed 'none' from enum but users might have stale config.
      const configuredMode = this._configSnapshot.unusedDependencyMode;
      const effectiveMode = filterActive ? configuredMode : "none";

      const checkUsage = effectiveMode !== "none";

      // Get the referencing files for filtering (if a symbol is selected)
      const selectedSymbol = this._stateManager.selectedSymbolId;
      const referencingFiles = selectedSymbol
        ? this._stateManager.getSymbolReferencingFiles(selectedSymbol)
        : undefined;

      // Always build without check first to show something quickly
      const initialGraphData = await this._graphViewService.buildGraphData(
        filePath,
        false,
        undefined,
        referencingFiles,
      );

      const expandAll = this._stateManager.getExpandAll();

      // If checking usage is enabled, we'll send a second update.
      // If NOT checking usage, this is the only update.
      // If checking usage, we still send this one first so the user sees the graph immediately.

      const initialMessage: ExtensionToWebviewMessage = {
        command: "updateGraph",
        filePath,
        data: initialGraphData,
        expandAll,
        isRefresh,
        refreshReason,
        unusedDependencyMode: effectiveMode,
        filterUnused: filterActive,
      };
      this._view.webview.postMessage(initialMessage);

      // Step 2: If usage check is required, perform it and send update
      if (checkUsage) {
        log.debug("Performing background usage analysis for", filePath);
        // Reuse the nodes/edges from initial data to avoid re-crawling (optimized)
        const enrichedGraphData = await this._graphViewService.buildGraphData(
          filePath,
          true,
          initialGraphData,
          referencingFiles,
        );

        // Only send update if unused edges were found (or if we need to confirm they are empty?)
        // Actually, we should confirm if they are computed.
        // Using the specific 'done' state or just replacing the data.

        // Verify if we actually found different data or if we just added unusedEdges (which might be empty).
        // Ensure we don't trigger unnecessary re-renders if nothing changed.
        // But unusedEdges property presence is the change.

        const enrichedMessage: ExtensionToWebviewMessage = {
          command: "updateGraph",
          filePath,
          data: enrichedGraphData,
          expandAll, // Keep same expansion state
          isRefresh: true, // Treat as refresh to avoid internal navigation reset?
          // Actually, if we send isRefresh=true, it merges.
          refreshReason: "usage-analysis",
          unusedDependencyMode: effectiveMode,
          filterUnused: filterActive,
        };

        this._view.webview.postMessage(enrichedMessage);
      }
    } catch (error) {
      log.error("Failed to analyze file:", error);
    }
  }
}
