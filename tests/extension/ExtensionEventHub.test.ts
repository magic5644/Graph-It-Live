import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventHubOptions } from "../../src/extension/services/ExtensionEventHub";
import { ExtensionEventHub } from "../../src/extension/services/ExtensionEventHub";
import type { EventType } from "../../src/extension/services/FileChangeScheduler";

const vscodeWindow = vi.hoisted(() => ({ activeTextEditor: undefined as unknown }));

vi.mock("vscode", () => ({
  window: vscodeWindow,
}));

const fileDocument = (fsPath: string, scheme = "file") => ({ uri: { scheme, fsPath } }) as unknown as import("vscode").TextDocument;

function createOptions(overrides: Partial<EventHubOptions> = {}): EventHubOptions {
  const spider = {
    reanalyzeFile: vi.fn(),
    reanalyzeUnresolvedImporters: vi.fn(),
    handleResolverConfigChange: vi.fn(),
    handleFileDeleted: vi.fn(),
  };
  const stateManager = {
    currentSymbol: undefined,
    selectedSymbolId: undefined,
    invalidateSymbolCache: vi.fn(),
    getLastActiveFilePath: vi.fn().mockReturnValue("/workspace/src/index.ts"),
    setViewMode: vi.fn(),
  } as unknown as EventHubOptions["stateManager"];

  return {
    spider: spider as unknown as EventHubOptions["spider"],
    unusedAnalysisCache: { invalidate: vi.fn() } as unknown as EventHubOptions["unusedAnalysisCache"],
    stateManager,
    navigationService: undefined,
    viewProvider: () => undefined,
    updateGraph: vi.fn(),
    handleDrillDown: vi.fn(),
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      setLevel: vi.fn(),
      level: "info",
      show: vi.fn(),
    } as unknown as EventHubOptions["logger"],
    ...overrides,
  };
}

describe("ExtensionEventHub", () => {
  it("reanalyzes and refreshes on file save", async () => {
    const options = createOptions();
    const hub = new ExtensionEventHub(options);

    await hub.handleFileSaved("/workspace/src/index.ts");

    expect(options.unusedAnalysisCache?.invalidate).toHaveBeenCalled();
    expect(options.stateManager.invalidateSymbolCache).toHaveBeenCalled();
    expect(options.spider?.reanalyzeFile).toHaveBeenCalled();
    expect(options.updateGraph).toHaveBeenCalledWith(true, "fileSaved");
  });

  it("handles file change events", async () => {
    const options = createOptions();
    const hub = new ExtensionEventHub(options);

    await hub.handleFileChange("/workspace/src/index.ts", "change" as EventType);

    expect(options.spider?.reanalyzeFile).toHaveBeenCalled();
    expect(options.spider?.reanalyzeUnresolvedImporters).not.toHaveBeenCalled();
  });

  // #387: importers of a file that did not exist yet never change themselves.
  it("re-analyses the importers waiting on a created file", async () => {
    const options = createOptions();
    const hub = new ExtensionEventHub(options);

    await hub.handleFileChange("/workspace/src/new.ts", "create" as EventType);

    expect(options.spider?.reanalyzeFile).toHaveBeenCalledWith("/workspace/src/new.ts");
    expect(options.spider?.reanalyzeUnresolvedImporters).toHaveBeenCalledWith("/workspace/src/new.ts");
  });

  // #419: a tsconfig / package.json change moves no importer's mtime.
  it.each(["tsconfig.json", "tsconfig.app.json", "package.json"])("re-indexes the workspace when %s is deleted", async (name) => {
    const options = createOptions();
    const hub = new ExtensionEventHub(options);

    await hub.handleFileChange(`C:\\workspace\\pkg\\${name}`, "delete" as EventType);

    expect(options.spider?.handleResolverConfigChange).toHaveBeenCalledTimes(1);
    expect(options.spider?.handleFileDeleted).not.toHaveBeenCalled();
    expect(options.updateGraph).toHaveBeenCalledWith(true, "fileChange");
  });

  it("throws when the changed file cannot be analysed, and ignores unsupported files", async () => {
    const options = createOptions();
    vi.mocked(options.spider!.reanalyzeFile).mockResolvedValueOnce(null);
    const hub = new ExtensionEventHub(options);

    await expect(hub.handleFileChange("/workspace/src/broken.ts", "change" as EventType)).rejects.toThrow(/broken\.ts/);
    await hub.handleFileChange("/workspace/README.md", "change" as EventType);
    await hub.handleFileSaved("/workspace/README.md");

    expect(options.spider?.reanalyzeFile).toHaveBeenCalledTimes(1);
    expect(options.updateGraph).not.toHaveBeenCalled();
  });

  it("does nothing without a spider", async () => {
    const options = createOptions({ spider: undefined });
    const hub = new ExtensionEventHub(options);

    await hub.handleFileChange("/workspace/src/index.ts", "create" as EventType);
    await hub.handleFileSaved("/workspace/src/index.ts");

    expect(options.updateGraph).not.toHaveBeenCalled();
  });

  it("drills down again into the current symbol on save and change", async () => {
    const options = createOptions();
    Object.assign(options.stateManager, { currentSymbol: "/workspace/src/index.ts:main" });
    const hub = new ExtensionEventHub(options);

    await hub.handleFileSaved("/workspace/src/index.ts");
    await hub.handleFileChange("/workspace/src/index.ts", "change" as EventType);

    expect(options.handleDrillDown).toHaveBeenCalledTimes(2);
    expect(options.handleDrillDown).toHaveBeenCalledWith("/workspace/src/index.ts:main", true);
    expect(options.updateGraph).not.toHaveBeenCalled();
  });

  it("leaves the symbol view of a deleted file, and refreshes for any other deletion", async () => {
    const options = createOptions();
    Object.assign(options.stateManager, { selectedSymbolId: "/workspace/src/gone.ts" });
    const hub = new ExtensionEventHub(options);

    await hub.handleFileChange("/workspace/src/gone.ts", "delete" as EventType);
    expect(options.spider?.handleFileDeleted).toHaveBeenCalledWith("/workspace/src/gone.ts");
    expect(options.stateManager.setViewMode).toHaveBeenCalledWith("file");
    expect(options.stateManager.selectedSymbolId).toBeUndefined();
    expect(options.updateGraph).toHaveBeenCalledWith();

    await hub.handleFileChange("/workspace/src/other.ts", "delete" as EventType);
    expect(options.updateGraph).toHaveBeenLastCalledWith(true, "fileChange");
  });

  it("refreshes for the active file, in symbol mode or not, and ignores other editors", async () => {
    const options = createOptions();
    const hub = new ExtensionEventHub(options);

    vscodeWindow.activeTextEditor = undefined;
    await hub.handleActiveFileChanged();
    vscodeWindow.activeTextEditor = { document: { uri: { scheme: "file" }, fileName: "/workspace/notes.txt" } };
    await hub.handleActiveFileChanged();
    expect(options.updateGraph).not.toHaveBeenCalled();

    vscodeWindow.activeTextEditor = { document: { uri: { scheme: "file" }, fileName: "/workspace/src/a.ts" } };
    await hub.handleActiveFileChanged();
    expect(options.updateGraph).toHaveBeenCalledWith(true, "navigation");

    Object.assign(options.stateManager, { currentSymbol: "/workspace/src/index.ts:main" });
    await hub.handleActiveFileChanged();
    expect(options.handleDrillDown).toHaveBeenCalledWith("/workspace/src/a.ts", true);
    vscodeWindow.activeTextEditor = undefined;
  });

  describe("handleFileSaveDocument", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("debounces saves of the viewed file into one refresh", async () => {
      const options = createOptions();
      const postMessage = vi.fn();
      options.viewProvider = () => ({ webview: { postMessage } }) as unknown as import("vscode").WebviewView;
      const onFileSaved = vi.fn().mockResolvedValue(undefined);
      const hub = new ExtensionEventHub(options);

      hub.handleFileSaveDocument(fileDocument("/workspace/src/index.ts"), onFileSaved);
      hub.handleFileSaveDocument(fileDocument("/workspace/src/index.ts"), onFileSaved);
      await vi.advanceTimersByTimeAsync(500);

      expect(postMessage).toHaveBeenCalledWith({ command: "refreshing" });
      expect(onFileSaved).toHaveBeenCalledTimes(1);
      expect(onFileSaved).toHaveBeenCalledWith("/workspace/src/index.ts");
    });

    it("skips other files and non-file schemes, and logs a failed refresh", async () => {
      const options = createOptions();
      const onFileSaved = vi.fn().mockRejectedValue("boom");
      const hub = new ExtensionEventHub(options);

      hub.handleFileSaveDocument(fileDocument("/workspace/src/other.ts"), onFileSaved);
      hub.handleFileSaveDocument(fileDocument("/workspace/src/index.ts", "untitled"), onFileSaved);
      await vi.advanceTimersByTimeAsync(500);
      expect(onFileSaved).not.toHaveBeenCalled();

      hub.handleFileSaveDocument(fileDocument("/workspace/src/index.ts"), onFileSaved);
      await vi.advanceTimersByTimeAsync(500);
      expect(options.logger.error).toHaveBeenCalledWith("Error refreshing view after file save", new Error("boom"));
    });

    it("compares the saved file with the drilled-down symbol's file", async () => {
      const options = createOptions({
        navigationService: {
          parseFilePathAndSymbol: () => ({ actualFilePath: "/workspace/src/sym.ts" }),
        } as unknown as EventHubOptions["navigationService"],
      });
      Object.assign(options.stateManager, { currentSymbol: "/workspace/src/sym.ts:fn" });
      const onFileSaved = vi.fn().mockResolvedValue(undefined);
      const hub = new ExtensionEventHub(options);

      hub.handleFileSaveDocument(fileDocument("/workspace/src/sym.ts"), onFileSaved);
      await vi.advanceTimersByTimeAsync(500);
      expect(onFileSaved).toHaveBeenCalledWith("/workspace/src/sym.ts");
    });

    it("cancels a pending refresh and ignores events once disposed", async () => {
      const options = createOptions();
      const onFileSaved = vi.fn().mockResolvedValue(undefined);
      const hub = new ExtensionEventHub(options);

      hub.handleFileSaveDocument(fileDocument("/workspace/src/index.ts"), onFileSaved);
      await hub.dispose();
      await vi.advanceTimersByTimeAsync(500);
      hub.handleFileSaveDocument(fileDocument("/workspace/src/index.ts"), onFileSaved);
      await hub.handleFileSaved("/workspace/src/index.ts");
      await hub.handleFileChange("/workspace/src/index.ts", "change" as EventType);
      await hub.handleActiveFileChanged();

      expect(onFileSaved).not.toHaveBeenCalled();
      expect(options.spider?.reanalyzeFile).not.toHaveBeenCalled();
    });
  });
});
