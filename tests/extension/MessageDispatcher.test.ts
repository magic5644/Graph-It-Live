import { describe, expect, it, vi } from "vitest";
import type { GraphState } from "../../src/extension/services/GraphState";
import { MessageDispatcher } from "../../src/extension/services/MessageDispatcher";

vi.mock("vscode", () => ({
  window: {
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    })),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn(() => "info"),
    })),
  },
}));

function createGraphStateMock(): GraphState {
  return {
    setExpandAll: vi.fn(),
  } as unknown as GraphState;
}

describe("MessageDispatcher", () => {
  it("handles setExpandAll messages", async () => {
    const graphState = createGraphStateMock();
    const dispatcher = new MessageDispatcher({
      graphState,
      getUnusedFilterActive: vi.fn().mockReturnValue(false),
      toggleUnusedFilter: vi.fn(),
      handleOpenFile: vi.fn(),
      handleExpandNode: vi.fn(),
      handleCancelExpandNode: vi.fn(),
      handleFindReferencingFiles: vi.fn(),
      handleDrillDown: vi.fn(),
      updateGraph: vi.fn(),
      refreshGraph: vi.fn(),
      handleSelectSymbol: vi.fn(),
      sendGraphUpdate: vi.fn(),
      setViewMode: vi.fn(),
      getViewMode: vi.fn().mockReturnValue("file"),
      getSelectedSymbolId: vi.fn().mockReturnValue(undefined),
      setSelectedSymbolId: vi.fn(),
      getLastActiveFilePath: vi.fn().mockReturnValue(undefined),
      parseFilePathAndSymbol: vi.fn().mockReturnValue(undefined),
      getActiveEditorFilePath: vi.fn().mockReturnValue(undefined),
      logger: { debug: vi.fn() },
    });

    await dispatcher.handle({ command: "setExpandAll", expandAll: true });

    expect(graphState.setExpandAll as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(true);
  });
});
