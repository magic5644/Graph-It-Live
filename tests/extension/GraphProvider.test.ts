import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { Spider } from "../../src/analyzer/Spider";
import { normalizePath } from "../../src/analyzer/types";
import { GraphProvider } from "../../src/extension/GraphProvider";

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
    ((provider as any)["_spider"].crawl as any).mockResolvedValue(
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

    const spiderMock = (provider as any)["_spider"];
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
    const spiderMock = (provider as any)["_spider"];
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
    const spiderMock = (provider as any)["_spider"];
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

  it("should switch from symbol view to file view even without an active file editor", async () => {
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
    const spiderMock = (provider as any)["_spider"];
    (spiderMock.crawl as any).mockResolvedValue({
      nodes: [np(mainTsPath)],
      edges: [],
    });

    // Simulate symbol view for a symbol in main.ts
    (provider as any)["_stateManager"].currentSymbol = `${mainTsPath}:foo`;

    // And simulate no active file editor (eg. output panel focused)
    (vscode.window as any).activeTextEditor = {
      document: { uri: { scheme: "output" }, fileName: "extension-output" },
    };

    await provider.toggleViewMode();

    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "updateGraph",
        filePath: mainTsPath,
        isRefresh: false,
      }),
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
    const spiderMock = (provider as any)["_spider"];
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

    const service = {
      expandNode: vi.fn(
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
      ),
    };
    (provider as any)["_nodeInteractionService"] = service;

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
    const spiderMock = (provider as any)["_spider"];
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
});
