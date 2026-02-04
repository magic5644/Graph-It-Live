import { describe, expect, it, vi } from "vitest";
import { GraphState } from "../../src/extension/services/GraphState";
import type { ProviderStateManager } from "../../src/extension/services/ProviderStateManager";

function createStateManagerMock(): ProviderStateManager {
  return {
    viewMode: "file",
    getUnusedFilterActive: vi.fn().mockReturnValue(false),
    getExpandAll: vi.fn().mockReturnValue(false),
    setExpandAll: vi.fn(),
  } as unknown as ProviderStateManager;
}

describe("GraphState", () => {
  it("tracks reverse dependency visibility", () => {
    const state = new GraphState(createStateManagerMock());

    expect(state.getReverseDependenciesVisible()).toBe(false);
    state.setReverseDependenciesVisible(true);
    expect(state.getReverseDependenciesVisible()).toBe(true);
  });

  it("stores expansion controllers and clears them", () => {
    const state = new GraphState(createStateManagerMock());
    const controller = new AbortController();

    state.setExpansionController("node", controller);
    expect(state.getExpansionController("node")).toBe(controller);

    state.abortAndClearExpansionControllers();
    expect(state.getExpansionController("node")).toBeUndefined();
  });

  it("delegates expandAll and unused filter state", async () => {
    const stateManager = createStateManagerMock();
    const state = new GraphState(stateManager);

    await state.setExpandAll(true);

    expect(state.getExpandAll()).toBe(false);
    expect(stateManager.setExpandAll as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(true);
    expect(state.getUnusedFilterActive()).toBe(false);
  });
});
