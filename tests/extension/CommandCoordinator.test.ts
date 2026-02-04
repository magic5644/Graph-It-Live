import { describe, expect, it, vi } from "vitest";
import type { CommandCoordinatorDependencies, CommandUi } from "../../src/extension/services/CommandCoordinator";
import { CommandCoordinator } from "../../src/extension/services/CommandCoordinator";

function createProviderMock(overrides: Partial<CommandCoordinatorDependencies> = {}): CommandCoordinatorDependencies {
  return {
    forceReindex: vi.fn(),
    expandAllNodes: vi.fn().mockResolvedValue({ expanded: true, message: "ok" }),
    refreshGraph: vi.fn(),
    toggleViewMode: vi.fn().mockResolvedValue({ mode: "file", message: "ok" }),
    setViewModeFile: vi.fn(),
    setViewModeList: vi.fn(),
    setViewModeSymbol: vi.fn(),
    showReverseDependencies: vi.fn(),
    hideReverseDependencies: vi.fn(),
    getUnusedFilterActive: vi.fn().mockReturnValue(false),
    toggleUnusedFilter: vi.fn(),
    getIndexStatus: vi.fn().mockReturnValue(null),
    ...overrides,
  };
}

function createUiMock(): CommandUi {
  return {
    showInformationMessage: vi.fn(),
  };
}

describe("CommandCoordinator", () => {
  it("triggers force reindex and shows message", async () => {
    const provider = createProviderMock();
    const ui = createUiMock();
    const coordinator = new CommandCoordinator({ provider, ui });

    await coordinator.handleForceReindex();

    expect(provider.forceReindex).toHaveBeenCalled();
    expect(ui.showInformationMessage).toHaveBeenCalledWith("Graph-It-Live: Re-index triggered");
  });

  it("enables unused filter only when inactive", async () => {
    const provider = createProviderMock({ getUnusedFilterActive: vi.fn().mockReturnValue(false) });
    const coordinator = new CommandCoordinator({ provider, ui: createUiMock() });

    await coordinator.handleEnableUnusedFilter();

    expect(provider.toggleUnusedFilter).toHaveBeenCalled();
  });

  it("skips disabling unused filter when already inactive", async () => {
    const provider = createProviderMock({ getUnusedFilterActive: vi.fn().mockReturnValue(false) });
    const coordinator = new CommandCoordinator({ provider, ui: createUiMock() });

    await coordinator.handleDisableUnusedFilter();

    expect(provider.toggleUnusedFilter).not.toHaveBeenCalled();
  });

  it("shows index status when available", async () => {
    const provider = createProviderMock({
      getIndexStatus: vi.fn().mockReturnValue({
        state: "indexing",
        processed: 1,
        total: 2,
        percentage: 50,
      }),
    });
    const ui = createUiMock();
    const coordinator = new CommandCoordinator({ provider, ui });

    await coordinator.handleShowIndexStatus();

    expect(ui.showInformationMessage).toHaveBeenCalledWith("Indexer: indexing 1/2 (50%)");
  });
});
