// @vitest-environment happy-dom

import React, { type ComponentType } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const postMessage = vi.fn();

vi.mock("../../src/webview/components/ReactFlowGraph", () => ({
  default: ({ onFindReferences }: { onFindReferences: (path: string) => void }) => (
    <button type="button" onClick={() => onFindReferences("C:\\workspace\\root.ts")}>
      Find references
    </button>
  ),
}));

vi.mock("../../src/webview/components/AtomicSymbolGraph", () => ({
  AtomicSymbolGraph: () => null,
}));

vi.mock("../../src/webview/components/cytoscape/CytoscapeGraph", () => ({
  CytoscapeGraph: () => null,
}));

vi.mock("../../src/webview/components/SymbolCardView", () => ({
  default: () => null,
}));

let App: ComponentType;

beforeAll(async () => {
  Object.defineProperty(globalThis, "acquireVsCodeApi", {
    configurable: true,
    value: () => ({ postMessage }),
  });
  ({ default: App } = await import("../../src/webview/App"));
});

afterEach(() => {
  cleanup();
  postMessage.mockClear();
});

describe("App — find referencing files", () => {
  it("sends every normalized Windows, macOS, and Linux graph path as knownNodes", () => {
    render(React.createElement(App));

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            command: "updateGraph",
            filePath: "C:\\workspace\\root.ts",
            data: {
              nodes: [
                "C:\\workspace\\root.ts",
                "/Users/example/project/dependency.ts",
                "/home/example/project/linux.ts",
              ],
              edges: [
                {
                  source: "C:\\workspace\\root.ts",
                  target: "C:/workspace/discovered.ts",
                },
              ],
            },
          },
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Find references" }));

    expect(postMessage).toHaveBeenLastCalledWith({
      command: "findReferencingFiles",
      nodeId: "c:/workspace/root.ts",
      knownNodes: expect.arrayContaining([
        "c:/workspace/root.ts",
        "/Users/example/project/dependency.ts",
        "/home/example/project/linux.ts",
        "c:/workspace/discovered.ts",
      ]),
    });
  });
});
