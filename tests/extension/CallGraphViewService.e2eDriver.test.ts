import { describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
  openTextDocument: vi.fn(async (uri: { fsPath: string }) => ({ uri })),
  showTextDocument: vi.fn(),
}));

vi.mock("vscode", () => ({
  Uri: { file: (p: string) => ({ fsPath: p }) },
  Position: class { constructor(public readonly line: number, public readonly character: number) {} },
  Range: class { constructor(public readonly start: unknown, public readonly end: unknown) {} },
  window: { createOutputChannel: () => ({ appendLine: vi.fn(), dispose: vi.fn() }), showTextDocument: vscodeMock.showTextDocument },
  workspace: { workspaceFolders: undefined, openTextDocument: vscodeMock.openTextDocument },
  commands: { executeCommand: vi.fn() },
}));

import { CallGraphViewService } from "@/extension/services/CallGraphViewService";

const CARD = { id: "/w/src/Card.tsx:Card:2", name: "Card", path: "/w/src/Card.tsx", startLine: 2, startCol: 7 };
const GRAPH = { rootSymbolId: CARD.id, nodes: [CARD], edges: [], compounds: [], depth: 1, hiddenNodeCount: 0, timestamp: 1 };

function service(): CallGraphViewService {
  return new CallGraphViewService({ subscriptions: [], extensionPath: "/ext" } as never, async () => []);
}

describe("CallGraphViewService E2E observability and click driver (#591)", () => {
  it("has no graph before one is posted, then exposes the posted nodes and edges", () => {
    const callGraph = service();
    expect(callGraph.getCallGraphE2EGraph()).toBeNull();

    (callGraph as unknown as { postGraphData(graph: typeof GRAPH): void }).postGraphData(GRAPH);

    expect(callGraph.getCallGraphE2EGraph()).toEqual({ rootSymbolId: CARD.id, nodes: [CARD], edges: [] });
  });

  it("opens a displayed node at the position the graph holds for it", async () => {
    const callGraph = service();
    (callGraph as unknown as { lastGraph: typeof GRAPH }).lastGraph = GRAPH;

    expect(await callGraph.clickCallGraphNodeForE2E(CARD.id)).toBe(true);

    expect(vscodeMock.openTextDocument).toHaveBeenCalledWith({ fsPath: CARD.path });
    expect(vscodeMock.showTextDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      selection: { start: { line: 2, character: 7 }, end: { line: 2, character: 7 } },
    }));
  });

  it("refuses a node id the graph does not display, without opening anything", async () => {
    vscodeMock.openTextDocument.mockClear();
    const callGraph = service();
    expect(await callGraph.clickCallGraphNodeForE2E(CARD.id)).toBe(false);

    (callGraph as unknown as { lastGraph: typeof GRAPH }).lastGraph = GRAPH;
    expect(await callGraph.clickCallGraphNodeForE2E("/etc/passwd:x:0")).toBe(false);
    expect(vscodeMock.openTextDocument).not.toHaveBeenCalled();
  });
});
