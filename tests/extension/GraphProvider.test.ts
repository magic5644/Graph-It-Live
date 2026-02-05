import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { Spider } from "../../src/analyzer/Spider";
import { normalizePath } from "../../src/analyzer/types";
import { GraphProvider } from "../../src/extension/GraphProvider";
import { graphProviderServiceTokens } from "../../src/extension/services/graphProviderServiceContainer";

const testRootDir = path.resolve(process.cwd(), "temp-test-root");
const np = (p: string) => normalizePath(p);

// Mock vscode
vi.mock("vscode", () => {
  const mockStatusBarItem = {
    text: "",
    tooltip: "",
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  };

  const mockFileSystemWatcher = {
    onDidCreate: vi.fn(),
    onDidDelete: vi.fn(),
    onDidChange: vi.fn(),
    dispose: vi.fn(),
  };

  const mockOutputChannel = {
    appendLine: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  };

  const mockRootDir = path.resolve(process.cwd(), "temp-test-root");
  return {
    Uri: {
      file: (p: string) => ({ fsPath: p }),
      joinPath: (...args: any[]) => ({ fsPath: args.join("/") }),
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: mockRootDir } }],
      getConfiguration: () => ({
        get: () => true,
      }),
      openTextDocument: vi.fn(),
      createFileSystemWatcher: vi.fn().mockReturnValue(mockFileSystemWatcher),
      onDidSaveTextDocument: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    },
    window: {
      showTextDocument: vi.fn(),
      showErrorMessage: vi.fn(),
      createStatusBarItem: vi.fn().mockReturnValue(mockStatusBarItem),
      createOutputChannel: vi.fn().mockReturnValue(mockOutputChannel),
      withProgress: vi
        .fn()
        .mockImplementation(async (_options: any, task: any) => {
          // Execute the task with a mock progress reporter
          const mockProgress = { report: vi.fn() };
          const mockToken = {
            isCancellationRequested: false,
            onCancellationRequested: vi.fn(),
          };
          return task(mockProgress, mockToken);
        }),
      activeTextEditor: {
        document: {
          uri: { scheme: "file" },
          fileName: path.join(mockRootDir, "src", "main.ts"),
        },
      },
    },
    commands: {
      executeCommand: vi.fn(),
    },
    ViewColumn: { One: 1 },
    WebviewViewProvider: class {}, //NOSONAR
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    ProgressLocation: { Window: 10, Notification: 15 },
    StatusBarAlignment: { Left: 1, Right: 2 },
  };
});

// Mock Spider
vi.mock("../../src/analyzer/Spider", () => {
  const spiderRootDir = path.resolve(process.cwd(), "temp-test-root");
  const SpiderMock = vi.fn();
  SpiderMock.mockImplementation(function () {
    return {
      analyze: vi
        .fn()
        .mockResolvedValue([path.join(spiderRootDir, "src", "utils.ts")]),
      crawl: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
      updateConfig: vi.fn(),
      // New methods for reverse index
      buildFullIndex: vi
        .fn()
        .mockResolvedValue({ indexedFiles: 0, duration: 0, cancelled: false }),
      buildFullIndexInWorker: vi
        .fn()
        .mockResolvedValue({ indexedFiles: 0, duration: 0, cancelled: false }),
      enableReverseIndex: vi.fn().mockReturnValue(false),
      disableReverseIndex: vi.fn(),
      disposeWorker: vi.fn(),
      hasReverseIndex: vi.fn().mockReturnValue(false),
      validateReverseIndex: vi.fn().mockResolvedValue(null),
      getSerializedReverseIndex: vi.fn().mockReturnValue(null),
      reindexStaleFiles: vi.fn().mockResolvedValue(0),
      cancelIndexing: vi.fn(),
      // New methods for file invalidation
      invalidateFile: vi.fn().mockReturnValue(true),
      invalidateFiles: vi.fn().mockReturnValue(0),
      reanalyzeFile: vi.fn().mockResolvedValue([]),
      handleFileDeleted: vi.fn(),
      // IndexerStatus subscription
      subscribeToIndexStatus: vi.fn().mockReturnValue(() => {}),
      getIndexStatus: vi.fn().mockReturnValue({
        state: "idle",
        processed: 0,
        total: 0,
        currentFile: undefined,
        percentage: 0,
        startTime: undefined,
        errorMessage: undefined,
      }),
      findReferencingFiles: vi.fn().mockResolvedValue([]),
      resolveModuleSpecifier: vi
        .fn()
        .mockResolvedValue(path.join(spiderRootDir, "src", "utils.ts")),
    };
  });
  return { Spider: SpiderMock };
});

describe("GraphProvider", () => {
  let provider: GraphProvider;
  let extensionUri: vscode.Uri;
  let mockContext: vscode.ExtensionContext;

  const getService = <T,>(token: symbol): T =>
    (provider as any)._container.get(token);

  beforeEach(() => {
    vi.clearAllMocks();
    extensionUri = { fsPath: "/extension" } as vscode.Uri;
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
      globalStorageUri: {
        fsPath: path.join(process.cwd(), ".test-storage"),
      } as vscode.Uri,
      logUri: undefined,
      environmentVariableCollection: {} as any,
    } as unknown as vscode.ExtensionContext;

    provider = new GraphProvider(extensionUri, mockContext);
  });

  it("should initialize Spider on creation", () => {
    expect(Spider).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDir: testRootDir,
        excludeNodeModules: true,
      }),
    );
  });

  it("should update graph when updateGraph is called", async () => {
    const webview = {
      postMessage: vi.fn(),
      asWebviewUri: vi.fn(),
      options: {},
      html: "",
      onDidReceiveMessage: vi.fn(),
      cspSource: "test-csp",
    };
    const view = {
      webview,
      onDidDispose: vi.fn(),
    };

    // Resolve the view first
    provider.resolveWebviewView(view as any, {} as any, {} as any);

    // Setup mock return
    const mainTsPath = path.join(testRootDir, "src", "main.ts");
    const mockGraphData = {
      nodes: [mainTsPath],
      edges: [],
    };
    const spiderMock = getService<any>(graphProviderServiceTokens.spider);
    (spiderMock.crawl as any).mockResolvedValue(
      mockGraphData,
    );

    await provider.updateGraph();

    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "updateGraph",
        filePath: mainTsPath,
        data: mockGraphData,
        expandAll: undefined, // globalState.get returns undefined by default mock
      }),
    );
  });

  it("should resolve module specifiers when drilling down", async () => {
    const webview = {
      postMessage: vi.fn(),
      asWebviewUri: vi.fn(),
      options: {},
      html: "",
      onDidReceiveMessage: vi.fn(),
      cspSource: "test-csp",
    };
    const view = {
      webview,
      onDidDispose: vi.fn(),
    };

    // Resolve the view first
    provider.resolveWebviewView(view as any, {} as any, {} as any);

    const spiderMock = getService<any>(graphProviderServiceTokens.spider);
    // ensure getSymbolGraph returns something useful
    spiderMock.getSymbolGraph = vi.fn().mockResolvedValue({
      symbols: [
        {
          name: "format",
          id: path.join(testRootDir, "src", "utils.ts") + ":format",
          isExported: true,
        },
      ],
      dependencies: [],
    });

    // Call the private handler with a module specifier + symbol
    await (provider as any).handleDrillDown("./utils:format");

    // We expect resolveModuleSpecifier to have been invoked using the active editor as base
    expect(spiderMock.resolveModuleSpecifier).toHaveBeenCalled();

    // And the webview should have seen a symbolGraph message for the resolved absolute path with symbol
    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "symbolGraph",
        filePath: expect.stringContaining("utils.ts:format"),
      }),
    );
  });

  it("should trigger force reindex", async () => {
    // Ensure spider mock has a worker call available
    const spiderMock = getService<any>(graphProviderServiceTokens.spider);
    spiderMock.buildFullIndexInWorker = vi.fn().mockResolvedValue({
      indexedFiles: 1,
      duration: 10,
      cancelled: false,
      data: [],
    });

    await provider.forceReindex();

    expect(spiderMock.buildFullIndexInWorker).toHaveBeenCalled();
  });

  it("should return index status", () => {
    const spiderMock = getService<any>(graphProviderServiceTokens.spider);
    spiderMock.getIndexStatus = vi.fn().mockReturnValue({
      state: "idle",
      processed: 0,
      total: 0,
      currentFile: undefined,
      percentage: 0,
      startTime: undefined,
      cancelled: false,
    });

    const status = provider.getIndexStatus();
    expect(status).toBeTruthy();
    expect(spiderMock.getIndexStatus).toHaveBeenCalled();
  });

  it("should set view mode to file", async () => {
    const webview = {
      postMessage: vi.fn(),
      asWebviewUri: vi.fn(),
      options: {},
      html: "",
      onDidReceiveMessage: vi.fn(),
      cspSource: "test-csp",
    };
    const view = {
      webview,
      onDidDispose: vi.fn(),
    };

    provider.resolveWebviewView(view as any, {} as any, {} as any);

    const mainTsPath = path.join(testRootDir, "src", "main.ts");
    const spiderMock = getService<any>(graphProviderServiceTokens.spider);
    (spiderMock.crawl as any).mockResolvedValue({
      nodes: [np(mainTsPath)],
      edges: [],
    });

    // Set up active editor
    (vscode.window as any).activeTextEditor = {
      document: { uri: { scheme: "file" }, fileName: mainTsPath },
    };

    await provider.setViewModeFile();

    // Verify mode was set to "file"
    expect((provider as any)["_stateManager"].viewMode).toBe("file");

    // Verify context key was updated
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "graph-it-live.viewMode",
      "file",
    );

    // Verify graph was updated
    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "updateGraph",
        filePath: mainTsPath,
        isRefresh: false,
      }),
    );
  });

  it("should set view mode to list", async () => {
    const webview = {
      postMessage: vi.fn(),
      asWebviewUri: vi.fn(),
      options: {},
      html: "",
      onDidReceiveMessage: vi.fn(),
      cspSource: "test-csp",
    };
    const view = {
      webview,
      onDidDispose: vi.fn(),
    };

    provider.resolveWebviewView(view as any, {} as any, {} as any);

    const mainTsPath = path.join(testRootDir, "src", "main.ts");
    const spiderMock = getService<any>(graphProviderServiceTokens.spider);
    spiderMock.getSymbolGraph = vi.fn().mockResolvedValue({
      symbols: [],
      dependencies: [],
    });

    // Set up active editor
    (vscode.window as any).activeTextEditor = {
      document: { uri: { scheme: "file" }, fileName: mainTsPath },
    };

    await provider.setViewModeList();

    // Verify mode was set to "list"
    expect((provider as any)["_stateManager"].viewMode).toBe("list");

    // Verify context key was updated
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "graph-it-live.viewMode",
      "list",
    );
  });

  it("should set view mode to symbol", async () => {
    const webview = {
      postMessage: vi.fn(),
      asWebviewUri: vi.fn(),
      options: {},
      html: "",
      onDidReceiveMessage: vi.fn(),
      cspSource: "test-csp",
    };
    const view = {
      webview,
      onDidDispose: vi.fn(),
    };

    provider.resolveWebviewView(view as any, {} as any, {} as any);

    const mainTsPath = path.join(testRootDir, "src", "main.ts");
    const spiderMock = getService<any>(graphProviderServiceTokens.spider);
    spiderMock.getSymbolGraph = vi.fn().mockResolvedValue({
      symbols: [],
      dependencies: [],
    });

    // Set up active editor
    (vscode.window as any).activeTextEditor = {
      document: { uri: { scheme: "file" }, fileName: mainTsPath },
    };

    await provider.setViewModeSymbol();

    // Verify mode was set to "symbol"
    expect((provider as any)["_stateManager"].viewMode).toBe("symbol");

    // Verify context key was updated
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "graph-it-live.viewMode",
      "symbol",
    );
  });

  it("should show reverse dependencies", async () => {
    const webview = {
      postMessage: vi.fn(),
      asWebviewUri: vi.fn(),
      options: {},
      html: "",
      onDidReceiveMessage: vi.fn(),
      cspSource: "test-csp",
    };
    const view = {
      webview,
      onDidDispose: vi.fn(),
    };

    provider.resolveWebviewView(view as any, {} as any, {} as any);

    // Mock showInformationMessage
    (vscode.window as any).showInformationMessage = vi.fn();

    const mainTsPath = path.join(testRootDir, "src", "main.ts");

    // Set up active editor
    (vscode.window as any).activeTextEditor = {
      document: { uri: { scheme: "file" }, fileName: mainTsPath },
    };

    // Mock the node interaction service
    const mockService = getService<any>(
      graphProviderServiceTokens.nodeInteractionService,
    );
    mockService.getReferencingFiles = vi.fn().mockResolvedValue({
      command: "referencingFiles",
      files: [],
    });

    await provider.showReverseDependencies();

    // Verify service was called
    expect(mockService.getReferencingFiles).toHaveBeenCalledWith(mainTsPath);

    // Verify context key was set to true
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "graph-it-live.reverseDependenciesVisible",
      true,
    );
  });

  it("should hide reverse dependencies", async () => {
    const webview = {
      postMessage: vi.fn(),
      asWebviewUri: vi.fn(),
      options: {},
      html: "",
      onDidReceiveMessage: vi.fn(),
      cspSource: "test-csp",
    };
    const view = {
      webview,
      onDidDispose: vi.fn(),
    };

    provider.resolveWebviewView(view as any, {} as any, {} as any);

    await provider.hideReverseDependencies();

    // Verify message was posted to webview
    expect(webview.postMessage).toHaveBeenCalledWith({
      command: "clearReverseDependencies",
    });

    // Verify context key was set to false
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "graph-it-live.reverseDependenciesVisible",
      false,
    );
  });

  it("should refresh using last active file when active editor is not a file (eg. after indexing)", async () => {
    const webview = {
      postMessage: vi.fn(),
      asWebviewUri: vi.fn(),
      options: {},
      html: "",
      onDidReceiveMessage: vi.fn(),
      cspSource: "test-csp",
    };
    const view = {
      webview,
      onDidDispose: vi.fn(),
    };

    provider.resolveWebviewView(view as any, {} as any, {} as any);

    const mainTsPath = path.join(testRootDir, "src", "main.ts");
    const spiderMock = getService<any>(graphProviderServiceTokens.spider);
    (spiderMock.crawl as any).mockResolvedValue({
      nodes: [np(mainTsPath)],
      edges: [],
    });

    await (provider as any)["_stateManager"].setLastActiveFilePath(mainTsPath);
    (vscode.window as any).activeTextEditor = {
      document: { uri: { scheme: "output" }, fileName: "extension-output" },
    };

    await provider.updateGraph(true, "indexing");

    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "updateGraph",
        filePath: mainTsPath,
        isRefresh: true,
        refreshReason: "indexing",
      }),
    );
  });

  it("should not cancel expansion when expanding a different node", async () => {
    const webview = {
      postMessage: vi.fn(),
      asWebviewUri: vi.fn(),
      options: {},
      html: "",
      onDidReceiveMessage: vi.fn(),
      cspSource: "test-csp",
    };
    const view = {
      webview,
      onDidDispose: vi.fn(),
    };

    provider.resolveWebviewView(view as any, {} as any, {} as any);

    const pending: Array<() => void> = [];
    const createDeferred = () =>
      new Promise<void>((resolve) => pending.push(resolve));

    const service = getService<any>(
      graphProviderServiceTokens.nodeInteractionService,
    );
    service.expandNode = vi.fn(
      async (_nodeId: string, _known: string[] | undefined, opts?: any) => {
        await createDeferred();
        // ensure we can observe the abort signal state when it resolves
        if (opts?.signal?.aborted) throw new Error("aborted");
        return {
          command: "expandedGraph",
          nodeId: _nodeId,
          data: { nodes: [], edges: [] },
        };
      },
    );

    const p1 = (provider as any).handleExpandNode("/a", []);
    const p2 = (provider as any).handleExpandNode("/b", []);

    // Resolve both expansions
    pending.splice(0).forEach((r) => r());
    await Promise.all([p1, p2]);

    expect(service.expandNode).toHaveBeenCalledTimes(2);
    // Both should have produced progress messages, not immediate cancelled.
    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "expansionProgress",
        status: "started",
      }),
    );
  });

  it("refreshGraph should behave like reopen (isRefresh=false) and use lastActiveFilePath when needed", async () => {
    const webview = {
      postMessage: vi.fn(),
      asWebviewUri: vi.fn(),
      options: {},
      html: "",
      onDidReceiveMessage: vi.fn(),
      cspSource: "test-csp",
    };
    const view = {
      webview,
      onDidDispose: vi.fn(),
    };

    provider.resolveWebviewView(view as any, {} as any, {} as any);

    const mainTsPath = path.join(testRootDir, "src", "main.ts");
    const spiderMock = getService<any>(graphProviderServiceTokens.spider);
    (spiderMock.crawl as any).mockResolvedValue({
      nodes: [np(mainTsPath)],
      edges: [],
    });

    await (provider as any)["_stateManager"].setLastActiveFilePath(mainTsPath);
    (vscode.window as any).activeTextEditor = {
      document: { uri: { scheme: "output" }, fileName: "extension-output" },
    };

    await provider.refreshGraph();

    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "updateGraph",
        filePath: mainTsPath,
        isRefresh: false,
        refreshReason: "manual",
      }),
    );
  });

  // T083: Unit tests for debounce logic (Phase 5 - Live Updates)
  describe("File Save Debounce Logic", () => {
    let webview: any;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.clearAllMocks();

      extensionUri = { fsPath: "/extension" } as vscode.Uri;
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
        globalStorageUri: {
          fsPath: path.join(process.cwd(), ".test-storage"),
        } as vscode.Uri,
        logUri: undefined,
        environmentVariableCollection: {} as any,
      } as unknown as vscode.ExtensionContext;

      provider = new GraphProvider(extensionUri, mockContext);

      // Clear the periodic cleanup timer from UnusedAnalysisCache to avoid fake timer issues
      const cache = getService<any>(
        graphProviderServiceTokens.unusedAnalysisCache,
      );
      if (cache && cache.cleanupTimer) {
        clearInterval(cache.cleanupTimer);
        cache.cleanupTimer = undefined;
      }

      // Setup webview
      webview = {
        postMessage: vi.fn(),
        asWebviewUri: vi.fn(),
        options: {},
        html: "",
        onDidReceiveMessage: vi.fn(),
        cspSource: "test-csp",
      };
      const view = {
        webview,
        onDidDispose: vi.fn(),
      };
      provider.resolveWebviewView(view as any, {} as any, {} as any);
    });

    afterEach(() => {
      // Clean up provider's timers
      const eventHub = getService<any>(graphProviderServiceTokens.eventHub);
      const debounceTimer = eventHub?.fileSaveDebounceTimer;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      vi.clearAllTimers();
      vi.useRealTimers();
    });

    it("should debounce file save events with 500ms delay", async () => {
      const mainTsPath = np(path.join(testRootDir, "src", "main.ts"));
      await (provider as any)["_stateManager"].setLastActiveFilePath(
        mainTsPath,
      );

      // Mock document
      const document = {
        uri: { fsPath: mainTsPath, scheme: "file" },
      };

      // Spy on onFileSaved
      const onFileSavedSpy = vi.spyOn(provider as any, "onFileSaved");
      onFileSavedSpy.mockResolvedValue(undefined);

      // Trigger file save
      await (provider as any)._handleFileSave(document);

      // Should not call onFileSaved immediately
      expect(onFileSavedSpy).not.toHaveBeenCalled();

      // Fast-forward 499ms (not yet triggered)
      vi.advanceTimersByTime(499);
      expect(onFileSavedSpy).not.toHaveBeenCalled();

      // Fast-forward 1ms more (500ms total - should trigger)
      vi.advanceTimersByTime(1);
      await vi.runOnlyPendingTimersAsync();

      expect(onFileSavedSpy).toHaveBeenCalledTimes(1);
      expect(onFileSavedSpy).toHaveBeenCalledWith(mainTsPath);
    });

    it("should reset debounce timer on rapid edits", async () => {
      const mainTsPath = np(path.join(testRootDir, "src", "main.ts"));
      await (provider as any)["_stateManager"].setLastActiveFilePath(
        mainTsPath,
      );

      const document = {
        uri: { fsPath: mainTsPath, scheme: "file" },
      };

      const onFileSavedSpy = vi.spyOn(provider as any, "onFileSaved");
      onFileSavedSpy.mockResolvedValue(undefined);

      // First save
      await (provider as any)._handleFileSave(document);
      vi.advanceTimersByTime(300);

      // Second save before 500ms (should reset timer)
      await (provider as any)._handleFileSave(document);
      vi.advanceTimersByTime(300);

      // Third save before 500ms (should reset timer again)
      await (provider as any)._handleFileSave(document);

      // Should not have called yet
      expect(onFileSavedSpy).not.toHaveBeenCalled();

      // Fast-forward 500ms from last save
      vi.advanceTimersByTime(500);
      await vi.runOnlyPendingTimersAsync();

      // Should only call once despite multiple saves
      expect(onFileSavedSpy).toHaveBeenCalledTimes(1);
    });

    it("should skip refresh if saved file is not currently viewed", async () => {
      const mainTsPath = np(path.join(testRootDir, "src", "main.ts"));
      const otherFilePath = np(path.join(testRootDir, "src", "other.ts"));

      // Set current file to main.ts
      await (provider as any)["_stateManager"].setLastActiveFilePath(
        mainTsPath,
      );

      // Save different file
      const document = {
        uri: { fsPath: otherFilePath, scheme: "file" },
      };

      const onFileSavedSpy = vi.spyOn(provider as any, "onFileSaved");

      await (provider as any)._handleFileSave(document);
      vi.advanceTimersByTime(500);
      await vi.runOnlyPendingTimersAsync();

      // Should NOT call onFileSaved for unrelated file
      expect(onFileSavedSpy).not.toHaveBeenCalled();
    });

    it("should skip non-file scheme documents", async () => {
      // Mock non-file document (e.g., git diff, output channel)
      const document = {
        uri: { fsPath: "output:extension-output", scheme: "output" },
      };

      const onFileSavedSpy = vi.spyOn(provider as any, "onFileSaved");

      await (provider as any)._handleFileSave(document);
      vi.advanceTimersByTime(500);
      await vi.runOnlyPendingTimersAsync();

      expect(onFileSavedSpy).not.toHaveBeenCalled();
    });

    it("should handle errors during refresh gracefully", async () => {
      const mainTsPath = np(path.join(testRootDir, "src", "main.ts"));
      await (provider as any)["_stateManager"].setLastActiveFilePath(
        mainTsPath,
      );

      const document = {
        uri: { fsPath: mainTsPath, scheme: "file" },
      };

      // Mock onFileSaved to throw error
      const onFileSavedSpy = vi.spyOn(provider as any, "onFileSaved");
      onFileSavedSpy.mockRejectedValue(new Error("Re-analysis failed"));

      await (provider as any)._handleFileSave(document);
      vi.advanceTimersByTime(500);
      await vi.runOnlyPendingTimersAsync();

      // Should have attempted to call onFileSaved
      expect(onFileSavedSpy).toHaveBeenCalled();
      // Error should be caught and logged (not thrown)
      expect(webview.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ command: "error" }),
      );
    });
  });
});
