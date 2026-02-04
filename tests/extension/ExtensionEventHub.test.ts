import { describe, expect, it, vi } from "vitest";
import type { EventHubOptions } from "../../src/extension/services/ExtensionEventHub";
import { ExtensionEventHub } from "../../src/extension/services/ExtensionEventHub";
import type { EventType } from "../../src/extension/services/FileChangeScheduler";

vi.mock("vscode", () => ({
  window: {
    activeTextEditor: undefined,
  },
}));

function createOptions(overrides: Partial<EventHubOptions> = {}): EventHubOptions {
  const spider = {
    reanalyzeFile: vi.fn(),
    handleFileDeleted: vi.fn(),
  };
  const indexingManager = {
    persistIndexIfEnabled: vi.fn(),
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
    indexingManager: indexingManager as unknown as EventHubOptions["indexingManager"],
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
    expect(options.indexingManager?.persistIndexIfEnabled).toHaveBeenCalled();
    expect(options.updateGraph).toHaveBeenCalledWith(true, "fileSaved");
  });

  it("handles file change events", async () => {
    const options = createOptions();
    const hub = new ExtensionEventHub(options);

    await hub.handleFileChange("/workspace/src/index.ts", "change" as EventType);

    expect(options.spider?.reanalyzeFile).toHaveBeenCalled();
    expect(options.indexingManager?.persistIndexIfEnabled).toHaveBeenCalled();
  });
});
