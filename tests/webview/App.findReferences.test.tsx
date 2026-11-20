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

describe("App — waiting screen", () => {
  it("shows the shared loading state with the logo before any graph data", () => {
    render(React.createElement(App));

    expect(screen.getByRole("status").textContent).toContain("Waiting for graph data...");
    expect(screen.getByTestId("graph-it-live-logo")).toBeTruthy();
    expect(screen.queryByText(/Tip:/)).toBeNull();
  });

  it("shows the extension's empty-state message with the tip", () => {
    render(React.createElement(App));

    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { command: "emptyState", reason: "no-file-open", message: "No file open" } }));
    });

    expect(screen.getByText("No file open")).toBeTruthy();
    // The tip lists the extensions from SUPPORTED_SOURCE_EXTENSIONS (#770).
    const tip = screen.getByText(/Tip: open a \.ts, \.tsx, /).textContent ?? "";
    expect(tip).toContain(".py, .pyi, .rs, .cs, .csproj, .go, .java file");
  });

  it("shows no file-type tip when no folder is open (#770)", () => {
    render(React.createElement(App));

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: { command: "emptyState", reason: "no-workspace", message: "Open a folder to see its dependency graph" },
      }));
    });

    expect(screen.getByText("Open a folder to see its dependency graph")).toBeTruthy();
    expect(screen.queryByText(/Tip:/)).toBeNull();
  });

  it("ignores extension messages from another origin (S2819)", () => {
    render(React.createElement(App));

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: { command: "emptyState", reason: "no-file-open", message: "No file open" },
        origin: "https://evil.example",
      }));
    });

    expect(screen.queryByText("No file open")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Waiting for graph data...");
  });
});
