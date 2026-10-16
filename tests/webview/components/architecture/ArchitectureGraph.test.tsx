// @vitest-environment happy-dom

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArchitectureExtensionMessage, ArchitectureSummaryMessage } from "@/shared/architecture-types";

// Cytoscape needs a canvas: stand in a fake that records elements and runs layouts at once.
// fcose drops every node at the origin; labels are as wide as `labelWidth` (default: textWidth).
const cy = vi.hoisted(() => {
  type Data = Record<string, string | number | boolean>;
  type Point = { x: number; y: number };
  const state = {
    nodes: [] as ReturnType<typeof fakeNode>[],
    edges: 0,
    labelWidth: undefined as number | undefined,
    handlers: new Map<string, (event: unknown) => void>(),
  };
  function fakeNode(data: Data) {
    let position: Point = { x: 0, y: 0 };
    const node = {
      data: (key: string) => data[key],
      position: (arg?: string | Point) => {
        if (typeof arg === "object") position = { ...arg };
        return typeof arg === "string" ? position[arg as keyof Point] : position;
      },
      outerWidth: () => Number(data.width) + 2,
      outerHeight: () => Number(data.height) + 2,
      boundingBox: (options: { includeNodes?: boolean }) => {
        const width = options.includeNodes === false ? (state.labelWidth ?? Number(data.textWidth)) : node.outerWidth();
        const height = options.includeNodes === false ? 22 : node.outerHeight();
        return { x1: position.x - width / 2, x2: position.x + width / 2, y1: position.y - height / 2, y2: position.y + height / 2 };
      },
    };
    return node;
  }
  const instance = {
    on: (name: string, _selector: string, handler: (event: unknown) => void) => state.handlers.set(name, handler),
    elements: () => ({ remove: () => { state.nodes = []; state.edges = 0; } }),
    add: (elements: { group: string; data: Data }[]) => {
      state.nodes.push(...elements.filter(element => element.group === "nodes").map(element => fakeNode(element.data)));
      state.edges += elements.filter(element => element.group === "edges").length;
    },
    layout: (options: { name: string; positions?: (node: unknown) => Point }) => {
      let stop = () => {};
      const run = () => {
        for (const node of state.nodes) node.position(options.positions?.(node) ?? { x: 0, y: 0 });
        stop();
      };
      return { on: (_name: string, handler: () => void) => { stop = handler; }, run };
    },
    fit: vi.fn(),
    resize: vi.fn(),
    nodes: () => state.nodes,
    edges: () => ({ length: state.edges }),
    destroy: () => {},
  };
  const factory = Object.assign(() => instance, { use: () => {} });
  return { state, factory, instance };
});
vi.mock("cytoscape", () => ({ default: cy.factory }));
vi.mock("cytoscape-fcose", () => ({ default: () => {} }));

import { ArchitectureGraph } from "@/webview/components/architecture/ArchitectureGraph";

const summary: ArchitectureSummaryMessage = {
  type: "architectureSummary",
  revision: "r1",
  stale: false,
  context: {
    communityMode: "louvain",
    revision: "r1",
    graphKind: "imports",
    scope: "workspace",
    exclusions: "",
    indexedAt: undefined,
    maxFiles: 10,
    truncated: true,
    failedFiles: 2,
  },
  provenance: { facts: "File pairs are static import relations.", grouping: "", interpretation: "" },
  scannedFiles: 12,
  analyzedFiles: 10,
  totals: { files: 10, fileEdges: 4, intraGroupEdges: 1, interGroupEdges: 3 },
  unassigned: { fileCount: 1, internalEdgeCount: 0 },
  groups: [
    { id: 1, key: "ui", label: "ui", fileCount: 5, internalEdgeCount: 1 },
    { id: 2, key: "store", label: "store", fileCount: 4, internalEdgeCount: 0 },
  ],
  groupEdges: [{ from: 1, to: 2, fileEdgeCount: 3, fromLabel: "ui", toLabel: "store" }],
  totalGroups: 3,
  hiddenGroups: 1,
  hiddenGroupEdges: 2,
};

const send = (message: ArchitectureExtensionMessage) =>
  act(() => { window.dispatchEvent(new MessageEvent("message", { data: message })); });

describe("ArchitectureGraph", () => {
  afterEach(cleanup);

  it("asks for the summary on mount and shows the build progress", () => {
    const postMessage = vi.fn();
    render(<ArchitectureGraph postMessage={postMessage} />);

    expect(postMessage).toHaveBeenCalledWith({ command: "architectureMounted" });
    send({ type: "architectureState", status: "building", message: "Analysing files (3/10)…", percent: 30 });
    expect(screen.getByText("Analysing files (3/10)…")).toBeTruthy();
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });

  it("renders the header from the summary and reports what was drawn", () => {
    const postMessage = vi.fn();
    render(<ArchitectureGraph postMessage={postMessage} />);
    send(summary);

    expect(screen.getByText("Groups based on imports (Louvain)")).toBeTruthy();
    expect(screen.getByText(/2 of 3 groups shown/)).toBeTruthy();
    expect(screen.getByText(/2 failed/)).toBeTruthy();
    expect(screen.getByText(/Only the first 10 files/)).toBeTruthy();
    expect(screen.queryByText(/Files changed/)).toBeNull();
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      command: "architectureRendered",
      revision: "r1",
      renderedGroups: 3,
      renderedGroupEdges: 1,
      communityMode: "louvain",
      stale: false,
      overflowingLabels: 0,
    }));
  });

  it("pushes overlapping groups apart, then redraws the same picture for the same groups", () => {
    const postMessage = vi.fn();
    const layout = vi.spyOn(cy.instance, "layout");
    try {
      render(<ArchitectureGraph postMessage={postMessage} />);
      const fresh = { ...summary, groups: summary.groups.map(group => ({ ...group, key: `stable-${group.key}` })) };
      send(fresh);
      const first = postMessage.mock.lastCall?.[0];
      expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ name: "fcose", randomize: true }));
      // fcose left every node at the origin: separateOverlaps spread them.
      expect(first.overlappingGroups).toBe(0);
      expect(first.positions.split(";")).toHaveLength(3);
      expect(new Set(cy.state.nodes.map(node => `${node.position("x")},${node.position("y")}`)).size).toBe(3);

      send({ ...fresh, revision: "r2", stale: true });
      expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ name: "preset" }));
      expect(postMessage.mock.lastCall?.[0].positions).toBe(first.positions);

      // A group whose size changed cannot reuse its box: the whole graph is laid out again.
      send({ ...fresh, groups: [{ ...fresh.groups[0], fileCount: 50 }, fresh.groups[1]] });
      expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ name: "fcose" }));
    } finally {
      layout.mockRestore();
    }
  });

  it("reports an empty render when there is no group", () => {
    const postMessage = vi.fn();
    render(<ArchitectureGraph postMessage={postMessage} />);
    send({ ...summary, groups: [], groupEdges: [], unassigned: { fileCount: 0, internalEdgeCount: 0 } });
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      renderedGroups: 0, renderedGroupEdges: 0, overlappingGroups: 0, overflowingLabels: 0, positions: "",
    }));
  });

  it("reports a label drawn outside its node", () => {
    const postMessage = vi.fn();
    cy.state.labelWidth = 500;
    try {
      render(<ArchitectureGraph postMessage={postMessage} />);
      send(summary);
      expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ overflowingLabels: 3 }));
    } finally {
      cy.state.labelWidth = undefined;
    }
  });

  it("shows the stale banner, whose Refresh asks for a rebuild", () => {
    const postMessage = vi.fn();
    render(<ArchitectureGraph postMessage={postMessage} />);
    send({ ...summary, stale: true, hiddenGroups: 0, context: { ...summary.context, truncated: false, failedFiles: 0 } });

    expect(screen.getByText(/Files changed since this view was built/)).toBeTruthy();
    expect(screen.queryByText(/groups shown/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(postMessage).toHaveBeenLastCalledWith({ command: "architectureRefresh" });
  });

  it("offers Retry on error and states when there is nothing to show", () => {
    const postMessage = vi.fn();
    render(<ArchitectureGraph postMessage={postMessage} />);

    send({ type: "architectureState", status: "error", message: "boom" });
    expect(screen.getByText(/Architecture build failed: boom/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(postMessage).toHaveBeenLastCalledWith({ command: "architectureRefresh" });

    send({ type: "architectureState", status: "empty", message: "No source file found in the workspace folder." });
    expect(screen.getByText("No source file found in the workspace folder.")).toBeTruthy();
  });

  it("ignores messages from another origin", () => {
    render(<ArchitectureGraph postMessage={vi.fn()} />);
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: summary, origin: "https://evil.example" }));
    });
    expect(screen.queryByText("Groups based on imports (Louvain)")).toBeNull();
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: summary, origin: "vscode-webview://abc" }));
    });
    expect(screen.getByText("Groups based on imports (Louvain)")).toBeTruthy();
  });

  it("sets the hovered element's tooltip on the container", () => {
    render(<ArchitectureGraph postMessage={vi.fn()} />);
    const container = screen.getByTestId("architecture-graph");

    act(() => cy.state.handlers.get("mouseover")?.({ target: { data: () => "ui\n5 files" } }));
    expect(container.title).toBe("ui\n5 files");
    act(() => cy.state.handlers.get("mouseout")?.({}));
    expect(container.title).toBe("");
  });

  it("re-fits once after a debounced resize, without re-running the layout, and cleans up", () => {
    vi.useFakeTimers();
    let onResize = () => {};
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", function (callback: () => void) {
      onResize = callback;
      return { observe, disconnect };
    });
    const layout = vi.spyOn(cy.instance, "layout");
    try {
      const postMessage = vi.fn();
      const { unmount } = render(<ArchitectureGraph postMessage={postMessage} />);
      expect(observe).toHaveBeenCalledWith(screen.getByTestId("architecture-graph"));
      cy.instance.resize.mockClear();
      cy.instance.fit.mockClear();

      onResize();
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(119);
      expect(cy.instance.resize).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(cy.instance.resize).toHaveBeenCalledTimes(1);
      expect(cy.instance.fit).toHaveBeenCalledExactlyOnceWith(undefined, 30);
      expect(layout).not.toHaveBeenCalled();
      expect(postMessage).toHaveBeenLastCalledWith({ command: "architectureResized", width: 0, height: 0 });

      onResize();
      unmount();
      expect(disconnect).toHaveBeenCalled();
      window.dispatchEvent(new Event("resize"));
      vi.runAllTimers();
      expect(cy.instance.resize).toHaveBeenCalledTimes(1);
    } finally {
      layout.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("falls back to the window resize event without ResizeObserver", () => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", undefined);
    try {
      const { unmount } = render(<ArchitectureGraph postMessage={vi.fn()} />);
      cy.instance.resize.mockClear();
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(120);
      expect(cy.instance.resize).toHaveBeenCalledTimes(1);
      unmount();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
