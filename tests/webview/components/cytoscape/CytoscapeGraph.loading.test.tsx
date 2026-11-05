// @vitest-environment happy-dom

import React from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Cytoscape needs a canvas: every method of the fake core is a no-op returning the core (layouts, collections).
vi.mock("cytoscape", () => {
  const core: Record<string | symbol, unknown> = new Proxy({} as Record<string | symbol, unknown>, {
    get: (target, key) => (key === "then" ? undefined : (target[key] ??= vi.fn(() => core))),
  });
  return { default: Object.assign(vi.fn(() => core), { use: vi.fn() }) };
});

const { CytoscapeGraph } = await import("../../../../src/webview/components/cytoscape/CytoscapeGraph");

function send(data: unknown): void {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data }));
  });
}

afterEach(cleanup);

describe("CytoscapeGraph — loading overlay", () => {
  it("shows the shared loading state with the extension's message and percentage", () => {
    render(<CytoscapeGraph postMessage={vi.fn()} />);

    send({ type: "callGraphIndexing", status: "progress", message: "Indexing workspace…", percent: 40 });

    const overlay = screen.getByTestId("loading-overlay");
    expect(within(overlay).getByText("Indexing workspace… (40%)")).toBeTruthy();
    expect(within(overlay).getByRole("progressbar").getAttribute("value")).toBe("40");
    expect(within(overlay).getByTestId("graph-it-live-logo")).toBeTruthy();
  });

  it("drops the progress bar when a later message has no percentage, and hides on complete", () => {
    render(<CytoscapeGraph postMessage={vi.fn()} />);

    send({ type: "callGraphIndexing", status: "progress", message: "Indexing workspace…", percent: 40 });
    send({ type: "callGraphIndexing", status: "started" });

    const overlay = screen.getByTestId("loading-overlay");
    expect(within(overlay).getByText("Analyzing…")).toBeTruthy();
    expect(within(overlay).queryByRole("progressbar")).toBeNull();

    send({ type: "callGraphIndexing", status: "complete" });
    expect(screen.queryByTestId("loading-overlay")).toBeNull();
  });

  it("drops the indexing percentage when the layout starts", () => {
    render(<CytoscapeGraph postMessage={vi.fn()} />);

    send({ type: "callGraphIndexing", status: "progress", message: "Indexing workspace…", percent: 40 });
    send({
      type: "showCallGraph", rootSymbolId: "a", depth: 1, timestamp: Date.now(), compounds: [], edges: [],
      nodes: [{
        id: "a", name: "a", type: "function", lang: "typescript", path: "/project/a.ts", folder: "",
        startLine: 1, endLine: 2, startCol: 0, isExported: true, isRoot: true,
      }],
    });

    const overlay = screen.getByTestId("loading-overlay");
    expect(within(overlay).getByText("Calculating layout…")).toBeTruthy();
    expect(within(overlay).queryByRole("progressbar")).toBeNull();
  });
});
