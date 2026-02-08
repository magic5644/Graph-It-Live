import * as path from "node:path";
import * as vscode from "vscode";
import { Spider } from "../../analyzer/Spider";
import { SpiderBuilder } from "../../analyzer/SpiderBuilder";
import type { VsCodeLogger } from "../extensionLogger";
import { WebviewManager } from "../WebviewManager";
import { BackgroundIndexingManager } from "./BackgroundIndexingManager";
import { EditorNavigationService } from "./EditorNavigationService";
import type { GraphRefreshReason } from "./ExtensionEventHub";
import { ExtensionEventHub } from "./ExtensionEventHub";
import type { EventType } from "./FileChangeScheduler";
import { FileChangeScheduler } from "./FileChangeScheduler";
import { GraphState } from "./GraphState";
import { GraphViewService } from "./GraphViewService";
import { MessageDispatcher } from "./MessageDispatcher";
import { NodeInteractionService } from "./NodeInteractionService";
import {
  ProviderConfigSnapshot,
  ProviderStateManager,
} from "./ProviderStateManager";
import { SourceFileWatcher } from "./SourceFileWatcher";
import { SymbolViewService } from "./SymbolViewService";
import { UnusedAnalysisCache } from "./UnusedAnalysisCache";
import { ServiceContainer, ServiceToken } from "./ServiceContainer";

export const graphProviderServiceTokens = {
  spider: Symbol("Spider") as ServiceToken<Spider>,
  webviewManager: Symbol("WebviewManager") as ServiceToken<WebviewManager>,
  stateManager: Symbol("ProviderStateManager") as ServiceToken<ProviderStateManager>,
  graphState: Symbol("GraphState") as ServiceToken<GraphState>,
  unusedAnalysisCache: Symbol("UnusedAnalysisCache") as ServiceToken<UnusedAnalysisCache>,
  graphViewService: Symbol("GraphViewService") as ServiceToken<GraphViewService>,
  symbolViewService: Symbol("SymbolViewService") as ServiceToken<SymbolViewService>,
  nodeInteractionService: Symbol("NodeInteractionService") as ServiceToken<NodeInteractionService>,
  navigationService: Symbol("EditorNavigationService") as ServiceToken<EditorNavigationService>,
  indexingManager: Symbol("BackgroundIndexingManager") as ServiceToken<BackgroundIndexingManager>,
  fileChangeScheduler: Symbol("FileChangeScheduler") as ServiceToken<FileChangeScheduler>,
  sourceFileWatcher: Symbol("SourceFileWatcher") as ServiceToken<SourceFileWatcher>,
  eventHub: Symbol("ExtensionEventHub") as ServiceToken<ExtensionEventHub>,
  messageDispatcher: Symbol("MessageDispatcher") as ServiceToken<MessageDispatcher>,
} as const;

export interface MessageDispatcherCallbacks {
  getUnusedFilterActive(): boolean;
  toggleUnusedFilter(): Promise<void>;
  handleOpenFile(filePath: string, line?: number): Promise<void>;
  handleExpandNode(nodeId: string, knownNodes?: string[]): Promise<void>;
  handleCancelExpandNode(nodeId?: string): Promise<void>;
  handleFindReferencingFiles(nodeId: string): Promise<void>;
  handleDrillDown(
    filePath: string,
    isRefresh?: boolean,
    targetMode?: "symbol" | "list",
  ): Promise<void>;
  updateGraph(): Promise<void>;
  refreshGraph(): Promise<void>;
  handleSelectSymbol(symbolId: string | undefined): Promise<void>;
  sendGraphUpdate(filePath: string, isRefresh?: boolean): Promise<void>;
  setViewMode(mode: "file" | "list" | "symbol"): Promise<void>;
  getViewMode(): "file" | "list" | "symbol";
  getSelectedSymbolId(): string | undefined;
  setSelectedSymbolId(symbolId: string | undefined): void;
  getLastActiveFilePath(): string | undefined;
  parseFilePathAndSymbol(
    symbolId: string,
  ): { actualFilePath: string } | undefined;
  getActiveEditorFilePath(): string | undefined;
}

export interface GraphProviderServiceContainerOptions {
  extensionUri: vscode.Uri;
  context: vscode.ExtensionContext;
  defaultIndexingStartDelay: number;
  logger: VsCodeLogger;
  callbacks: MessageDispatcherCallbacks;
  onIndexingComplete: () => Promise<void>;
  viewProvider: () => vscode.WebviewView | undefined;
  updateGraph: (isRefresh?: boolean, refreshReason?: GraphRefreshReason) => Promise<void>;
  handleDrillDown: (
    filePathOrSymbolId: string,
    isRefresh?: boolean,
    targetMode?: "list" | "symbol",
  ) => Promise<void>;
  handleFileChange: (filePath: string, eventType: EventType) => Promise<void>;
}

export interface GraphProviderServiceContainerResult {
  container: ServiceContainer;
  configSnapshot: ProviderConfigSnapshot;
}

export function createGraphProviderServiceContainer(
  options: GraphProviderServiceContainerOptions,
): GraphProviderServiceContainerResult {
  const container = new ServiceContainer();

  container.register(
    graphProviderServiceTokens.stateManager,
    () => new ProviderStateManager(options.context, options.defaultIndexingStartDelay),
  );
  container.register(
    graphProviderServiceTokens.graphState,
    () => new GraphState(container.get(graphProviderServiceTokens.stateManager)),
  );
  container.register(
    graphProviderServiceTokens.webviewManager,
    () => new WebviewManager(options.extensionUri),
  );

  const stateManager = container.get(graphProviderServiceTokens.stateManager);
  const configSnapshot = stateManager.loadConfiguration();

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const hasWorkspace = Boolean(workspaceRoot);

  if (hasWorkspace && workspaceRoot) {
    container.register(graphProviderServiceTokens.spider, () => {
      return new SpiderBuilder()
        .withRootDir(workspaceRoot)
        .withTsConfigPath(path.join(workspaceRoot, "tsconfig.json"))
        .withExtensionPath(options.context.extensionPath)
        .withExcludeNodeModules(configSnapshot.excludeNodeModules)
        .withMaxDepth(configSnapshot.maxDepth)
        .withReverseIndex(configSnapshot.enableBackgroundIndexing)
        .withIndexingConcurrency(configSnapshot.indexingConcurrency)
        .withCacheConfig({
          maxCacheSize: configSnapshot.maxCacheSize,
          maxSymbolCacheSize: configSnapshot.maxSymbolCacheSize,
        })
        .build();
    });

    container.register(
      graphProviderServiceTokens.unusedAnalysisCache,
      () =>
        new UnusedAnalysisCache(
          options.context,
          configSnapshot.persistUnusedAnalysisCache,
          configSnapshot.maxUnusedAnalysisCacheSize,
        ),
    );

    container.register(graphProviderServiceTokens.graphViewService, () => {
      return new GraphViewService(
        container.get(graphProviderServiceTokens.spider),
        options.logger,
        {
          unusedAnalysisConcurrency: configSnapshot.unusedAnalysisConcurrency,
          unusedAnalysisMaxEdges: configSnapshot.unusedAnalysisMaxEdges,
        },
        container.get(graphProviderServiceTokens.unusedAnalysisCache),
      );
    });

    container.register(
      graphProviderServiceTokens.symbolViewService,
      () => new SymbolViewService(container.get(graphProviderServiceTokens.spider), options.logger),
    );

    container.register(
      graphProviderServiceTokens.nodeInteractionService,
      () => new NodeInteractionService(container.get(graphProviderServiceTokens.spider), options.logger),
    );

    container.register(
      graphProviderServiceTokens.navigationService,
      () => new EditorNavigationService(container.get(graphProviderServiceTokens.spider), options.logger),
    );

    container.register(
      graphProviderServiceTokens.indexingManager,
      () =>
        new BackgroundIndexingManager({
          context: options.context,
          extensionUri: options.extensionUri,
          spider: container.get(graphProviderServiceTokens.spider),
          logger: options.logger,
          onIndexingComplete: options.onIndexingComplete,
          initialConfig: configSnapshot,
        }),
    );

    container.register(
      graphProviderServiceTokens.fileChangeScheduler,
      () =>
        new FileChangeScheduler({
          processHandler: options.handleFileChange,
          debounceDelay: 300,
        }),
    );

    container.register(
      graphProviderServiceTokens.sourceFileWatcher,
      () =>
        new SourceFileWatcher({
          context: options.context,
          logger: options.logger,
          fileChangeScheduler: container.get(graphProviderServiceTokens.fileChangeScheduler),
        }),
    );

    container.register(
      graphProviderServiceTokens.eventHub,
      () =>
        new ExtensionEventHub({
          spider: container.get(graphProviderServiceTokens.spider),
          indexingManager: container.get(graphProviderServiceTokens.indexingManager),
          unusedAnalysisCache: container.get(graphProviderServiceTokens.unusedAnalysisCache),
          stateManager: container.get(graphProviderServiceTokens.stateManager),
          navigationService: container.get(graphProviderServiceTokens.navigationService),
          viewProvider: options.viewProvider,
          updateGraph: options.updateGraph,
          handleDrillDown: options.handleDrillDown,
          logger: options.logger,
        }),
    );
  }

  container.register(
    graphProviderServiceTokens.messageDispatcher,
    () =>
      new MessageDispatcher({
        graphState: container.get(graphProviderServiceTokens.graphState),
        getUnusedFilterActive: options.callbacks.getUnusedFilterActive,
        toggleUnusedFilter: options.callbacks.toggleUnusedFilter,
        handleOpenFile: options.callbacks.handleOpenFile,
        handleExpandNode: options.callbacks.handleExpandNode,
        handleCancelExpandNode: options.callbacks.handleCancelExpandNode,
        handleFindReferencingFiles: options.callbacks.handleFindReferencingFiles,
        handleDrillDown: options.callbacks.handleDrillDown,
        updateGraph: options.callbacks.updateGraph,
        refreshGraph: options.callbacks.refreshGraph,
        handleSelectSymbol: options.callbacks.handleSelectSymbol,
        sendGraphUpdate: options.callbacks.sendGraphUpdate,
        setViewMode: options.callbacks.setViewMode,
        getViewMode: options.callbacks.getViewMode,
        getSelectedSymbolId: options.callbacks.getSelectedSymbolId,
        setSelectedSymbolId: options.callbacks.setSelectedSymbolId,
        getLastActiveFilePath: options.callbacks.getLastActiveFilePath,
        parseFilePathAndSymbol: options.callbacks.parseFilePathAndSymbol,
        getActiveEditorFilePath: options.callbacks.getActiveEditorFilePath,
        logger: options.logger,
      }),
  );

  return { container, configSnapshot };
}
