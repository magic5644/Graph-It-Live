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

  it("routes architecture messages to the architecture handler", async () => {
    const handleArchitectureMessage = vi.fn().mockResolvedValue(undefined);
    const dispatcher = new MessageDispatcher({
      graphState: createGraphStateMock(),
      handleArchitectureMessage,
      logger: { debug: vi.fn() },
    } as unknown as ConstructorParameters<typeof MessageDispatcher>[0]);
    const rendered = {
      command: "architectureRendered" as const,
      revision: "r1",
      renderedGroups: 2,
      renderedGroupEdges: 1,
      communityMode: "path" as const,
      stale: false,
      overlappingGroups: 0,
      overflowingLabels: 0,
      positions: "",
    };

    const resized = { command: "architectureResized" as const, width: 300, height: 200 };
    const interacted = {
      command: "architectureInteracted" as const,
      highlightedGroups: 2,
      fadedGroups: 1,
      labelledEdges: 1,
      shownGroupEdges: 1,
    };

    await dispatcher.handle({ command: "architectureMounted" });
    await dispatcher.handle({ command: "architectureRefresh" });
    await dispatcher.handle(rendered);
    await dispatcher.handle(resized);
    await dispatcher.handle(interacted);
    const unitEvidence = { command: "architectureUnitEvidence" as const, revision: "r1", from: "apps/web", to: "packages/core" };
    await dispatcher.handle(unitEvidence);

    expect(handleArchitectureMessage.mock.calls).toEqual([
      [{ command: "architectureMounted" }],
      [{ command: "architectureRefresh" }],
      [rendered],
      [resized],
      [interacted],
      [unitEvidence],
    ]);
  });

  describe("routing", () => {
    const createDeps = () => ({
      graphState: createGraphStateMock(),
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
      handleCallGraphMessage: vi.fn(),
      logger: { debug: vi.fn() },
    });

    it("forwards each message to its handler", async () => {
      const deps = createDeps();
      const dispatcher = new MessageDispatcher(deps);

      await dispatcher.handle({ command: "openFile", path: "/a.ts", line: 3 });
      await dispatcher.handle({ command: "expandNode", nodeId: "/a.ts", knownNodes: ["/b.ts"] });
      await dispatcher.handle({ command: "cancelExpandNode", nodeId: "/a.ts" });
      await dispatcher.handle({ command: "refreshGraph" });
      await dispatcher.handle({ command: "findReferencingFiles", nodeId: "/a.ts" });
      await dispatcher.handle({ command: "drillDown", filePath: "/a.ts" });
      await dispatcher.handle({ command: "ready" });
      await dispatcher.handle({ command: "enableUnusedFilter" });
      await dispatcher.handle({ command: "selectSymbol", symbolId: "/a.ts:x" });
      await dispatcher.handle({ command: "navigateToSymbol", filePath: "/a.ts", line: 2 } as never);
      await dispatcher.handle({ command: "callGraphMounted" });
      await dispatcher.handle({ command: "callGraphOpenFile", uri: "/a.ts", line: 0, character: 0 });
      await dispatcher.handle({ command: "callGraphSymbolFocus", nodeId: "n", path: "/a.ts", startLine: 0, startCol: 0 });
      await dispatcher.handle({ command: "callGraphReady", nodeCount: 1, edgeCount: 0 });
      await dispatcher.handle({ command: "callGraphDepthChanged", depth: 2 });
      await dispatcher.handle({ command: "callGraphFilterChanged", filterType: "folder", value: "src", visible: false });
      deps.getUnusedFilterActive.mockReturnValue(true);
      await dispatcher.handle({ command: "disableUnusedFilter" });
      await dispatcher.handle({ command: "enableUnusedFilter" });
      for (const level of ["debug", "info", "warn", "error"] as const) {
        await dispatcher.handle({ command: "webviewLog", level, message: "from webview" });
      }

      expect(deps.handleOpenFile.mock.calls).toEqual([["/a.ts", 3], ["/a.ts", 2]]);
      expect(deps.handleExpandNode).toHaveBeenCalledWith("/a.ts", ["/b.ts"]);
      expect(deps.handleCancelExpandNode).toHaveBeenCalledWith("/a.ts");
      expect(deps.refreshGraph).toHaveBeenCalledOnce();
      expect(deps.handleFindReferencingFiles).toHaveBeenCalledWith("/a.ts", undefined);
      expect(deps.handleDrillDown).toHaveBeenCalledWith("/a.ts");
      expect(deps.updateGraph).toHaveBeenCalledOnce();
      expect(deps.toggleUnusedFilter).toHaveBeenCalledTimes(2);
      expect(deps.handleCallGraphMessage).toHaveBeenCalledTimes(6);
      expect(deps.handleSelectSymbol).toHaveBeenCalledWith("/a.ts:x");
      expect(deps.handleCallGraphMessage).toHaveBeenCalledWith({ command: "callGraphMounted" });
      expect(deps.logger.debug).toHaveBeenCalled();
    });

    it("switches back to file mode on the previous symbol's file, else refreshes", async () => {
      const deps = createDeps();
      deps.getSelectedSymbolId.mockReturnValue("/src/a.ts:run");
      deps.parseFilePathAndSymbol.mockReturnValue({ actualFilePath: "/src/a.ts" });
      const dispatcher = new MessageDispatcher(deps);

      await dispatcher.handle({ command: "switchMode", mode: "file" });
      expect(deps.setViewMode).toHaveBeenCalledWith("file");
      expect(deps.sendGraphUpdate).toHaveBeenCalledWith("/src/a.ts", false);

      deps.getSelectedSymbolId.mockReturnValue(undefined);
      await dispatcher.handle({ command: "switchMode", mode: "file" });
      expect(deps.updateGraph).toHaveBeenCalledOnce();

      deps.getActiveEditorFilePath.mockReturnValue("/src/b.ts");
      await dispatcher.handle({ command: "switchMode", mode: "symbol" });
      expect(deps.handleDrillDown).toHaveBeenCalledWith("/src/b.ts");
    });
  });
});
