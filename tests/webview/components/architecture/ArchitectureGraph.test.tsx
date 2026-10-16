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
    edges: [] as ReturnType<typeof fakeEdge>[],
    labelWidth: undefined as number | undefined,
    handlers: new Map<string, (event: unknown) => void>(),
  };
  function fakeNode(data: Data) {
    let position: Point = { x: 0, y: 0 };
    const node = {
      data: (key: string) => data[key],
      id: () => String(data.id),
      isNode: () => true,
      isEdge: () => false,
      isChild: () => data.parent !== undefined,
      isParent: () => state.nodes.some(other => other.data("parent") === data.id),
      empty: () => false,
      nonempty: () => true,
      children: () => {
        const children = state.nodes.filter(other => other.data("parent") === data.id);
        return Object.assign(children, {
          shift: (delta: Point) => children.forEach(child =>
            child.position({ x: Number(child.position("x")) + delta.x, y: Number(child.position("y")) + delta.y })),
        });
      },
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
    return asCollection(node);
  }
  function fakeEdge(data: Data) {
    return asCollection({ data: (key: string) => data[key], id: () => String(data.id), isNode: () => false, isEdge: () => true });
  }
  /** A Cytoscape element is also a collection of itself. */
  function asCollection<T extends object>(element: T) {
    return Object.assign(element, { length: 1, 0: element, map: <R,>(fn: (item: T) => R) => [fn(element)] });
  }
  const instance = {
    on: (name: string, selector: string | ((event: unknown) => void), handler?: (event: unknown) => void) =>
      state.handlers.set(name, handler ?? (selector as (event: unknown) => void)),
    collection: () => ({ empty: () => true, nonempty: () => false, length: 0, map: () => [] }),
    center: vi.fn(),
    elements: () => Object.assign([...state.nodes, ...state.edges], { remove: () => { state.nodes = []; state.edges = []; } }),
    add: (elements: { group: string; data: Data }[]) => {
      state.nodes.push(...elements.filter(element => element.group === "nodes").map(element => fakeNode(element.data)));
      state.edges.push(...elements.filter(element => element.group === "edges").map(element => fakeEdge(element.data)));
    },
    layout: () => {
      let stop = () => {};
      const run = () => {
        for (const node of state.nodes) node.position({ x: 0, y: 0 });
        stop();
      };
      return { on: (_name: string, handler: () => void) => { stop = handler; }, run };
    },
    fit: vi.fn(),
    resize: vi.fn(),
    nodes: () => state.nodes,
    edges: () => state.edges,
    getElementById: (id: string) =>
      state.nodes.find(node => node.id() === id) ?? { empty: () => true, nonempty: () => false, isParent: () => false },
    destroy: () => {},
  };
  const factory = Object.assign(() => instance, { use: () => {} });
  return { state, factory, instance };
});
vi.mock("cytoscape", () => ({ default: cy.factory }));
vi.mock("cytoscape-fcose", () => ({ default: () => {} }));
// The highlight and filter helpers run on real Cytoscape in architectureElements.test.ts.
const helpers = vi.hoisted(() => ({
  empty: { empty: () => true, nonempty: () => false, length: 0, map: () => [] },
  applyMinImports: vi.fn(() => 1),
  findGroups: vi.fn(),
  highlightFocus: vi.fn(),
  measureInteraction: () => ({ highlightedGroups: 2, fadedGroups: 1, labelledEdges: 1, shownGroupEdges: 1 }),
  // Lays out new files and hides what the focus leaves out on real Cytoscape; tested in architectureElements.test.ts.
  placeNewFiles: vi.fn(),
  focusGroup: vi.fn(() => ({ nodes: () => ({ filter: () => ({ length: 3 }) }) })),
}));
helpers.findGroups.mockImplementation(() => helpers.empty);
vi.mock("@/webview/components/architecture/architectureElements", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...helpers,
}));

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

/** A hovered or tapped file node: tapping it only pins it. */
const fileTarget = (tooltip: string) => {
  const target = {
    data: (key: string) => ({ tooltip, file: true } as Record<string, unknown>)[key],
    id: () => `file:${tooltip}`,
    isNode: () => true,
    isEdge: () => false,
  };
  return Object.assign(target, { length: 1, 0: target, map: <R,>(fn: (item: typeof target) => R) => [fn(target)] });
};

/** Last message of a kind: interactions are reported after every render. */
const lastOf = (postMessage: ReturnType<typeof vi.fn>, command: string) =>
  postMessage.mock.calls.map(([message]) => message).findLast((message) => message.command === command);

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
    expect(lastOf(postMessage, "architectureRendered")).toEqual(expect.objectContaining({
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
      const first = lastOf(postMessage, "architectureRendered");
      expect(layout).toHaveBeenLastCalledWith(expect.objectContaining({ name: "fcose", randomize: true }));
      // fcose left every node at the origin: separateOverlaps spread them.
      expect(first.overlappingGroups).toBe(0);
      expect(first.positions.split(";")).toHaveLength(3);
      expect(new Set(cy.state.nodes.map(node => `${node.position("x")},${node.position("y")}`)).size).toBe(3);

      const layouts = layout.mock.calls.length;
      send({ ...fresh, revision: "r2", stale: true });
      expect(layout).toHaveBeenCalledTimes(layouts);
      expect(lastOf(postMessage, "architectureRendered").positions).toBe(first.positions);

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
    expect(lastOf(postMessage, "architectureRendered")).toEqual(expect.objectContaining({
      renderedGroups: 0, renderedGroupEdges: 0, overlappingGroups: 0, overflowingLabels: 0, positions: "",
    }));
  });

  it("reports a label drawn outside its node", () => {
    const postMessage = vi.fn();
    cy.state.labelWidth = 500;
    try {
      render(<ArchitectureGraph postMessage={postMessage} />);
      send(summary);
      expect(lastOf(postMessage, "architectureRendered")).toEqual(expect.objectContaining({ overflowingLabels: 3 }));
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

  describe("highlight, find and min-imports filter", () => {
    const { empty } = helpers;
    const interacted = { command: "architectureInteracted", highlightedGroups: 2, fadedGroups: 1, labelledEdges: 1, shownGroupEdges: 1 };
    const renderWithSummary = () => {
      const postMessage = vi.fn();
      const view = render(<ArchitectureGraph postMessage={postMessage} />);
      send(summary);
      return { postMessage, ...view };
    };

    afterEach(() => {
      vi.clearAllMocks();
      helpers.findGroups.mockImplementation(() => empty);
    });

    it("draws the summary with the default filter and no highlight, and reports it", () => {
      const { postMessage } = renderWithSummary();
      expect(helpers.applyMinImports).toHaveBeenLastCalledWith(cy.instance, 1);
      expect(helpers.findGroups).toHaveBeenLastCalledWith(cy.instance, "");
      expect(helpers.highlightFocus).toHaveBeenLastCalledWith(cy.instance, empty);
      expect(cy.instance.center).not.toHaveBeenCalled();
      expect(postMessage).toHaveBeenLastCalledWith(interacted);
      expect(screen.queryByText(/group edges shown/)).toBeNull();
    });

    it("highlights the hovered element, then returns to the pinned one", () => {
      const { postMessage } = renderWithSummary();
      const node = fileTarget("ui");
      act(() => cy.state.handlers.get("mouseover")?.({ target: node }));
      expect(helpers.highlightFocus).toHaveBeenLastCalledWith(cy.instance, node);
      expect(postMessage).toHaveBeenLastCalledWith(interacted);
      act(() => cy.state.handlers.get("mouseout")?.({}));
      expect(helpers.highlightFocus).toHaveBeenLastCalledWith(cy.instance, empty);

      act(() => cy.state.handlers.get("tap")?.({ target: node }));
      expect(helpers.highlightFocus).toHaveBeenLastCalledWith(cy.instance, node);
      act(() => cy.state.handlers.get("mouseover")?.({ target: { data: () => "store" } }));
      act(() => cy.state.handlers.get("mouseout")?.({}));
      expect(helpers.highlightFocus).toHaveBeenLastCalledWith(cy.instance, node);
    });

    it("finds and centres matching groups; Escape and a background tap clear the find and the highlight", () => {
      const matches = { empty: () => false, nonempty: () => true };
      helpers.findGroups.mockImplementation((_cy, query: string) => (query ? matches : empty));
      renderWithSummary();
      const find = screen.getByRole("searchbox", { name: "Find group" }) as HTMLInputElement;

      expect(screen.queryByText(/hidden groups are not searched/)).toBeNull();
      fireEvent.change(find, { target: { value: "ui" } });
      expect(helpers.findGroups).toHaveBeenLastCalledWith(cy.instance, "ui");
      // summary hides 1 of its 3 groups: find cannot see it, and says so.
      expect(screen.getByText("Find searches the 2 groups shown; the 1 hidden groups are not searched.")).toBeTruthy();
      expect(helpers.highlightFocus).toHaveBeenLastCalledWith(cy.instance, matches);
      expect(cy.instance.center).toHaveBeenCalledWith(matches);

      fireEvent.keyDown(find, { key: "Enter" });
      expect(find.value).toBe("ui");
      fireEvent.keyDown(find, { key: "Escape" });
      expect(find.value).toBe("");
      expect(helpers.highlightFocus).toHaveBeenLastCalledWith(cy.instance, empty);

      fireEvent.change(find, { target: { value: "store" } });
      act(() => cy.state.handlers.get("tap")?.({ target: cy.instance }));
      expect(find.value).toBe("");
      expect(helpers.highlightFocus).toHaveBeenLastCalledWith(cy.instance, empty);
    });

    it("hides weak edges from the min-imports control and states how many are shown", () => {
      renderWithSummary();
      const min = screen.getByRole("spinbutton", { name: /Min. imports per edge/ }) as HTMLInputElement;
      expect(min.max).toBe("3");

      helpers.applyMinImports.mockReturnValue(0);
      fireEvent.change(min, { target: { value: "4" } });
      expect(helpers.applyMinImports).toHaveBeenLastCalledWith(cy.instance, 4);
      expect(screen.getByText("0 of 1 group edges shown (min. 4 imports). Totals include them.")).toBeTruthy();
      // The totals line is unchanged by the filter.
      expect(screen.getByText(/4 file edges/)).toBeTruthy();

      helpers.applyMinImports.mockReturnValue(1);
      for (const value of ["", "0", "-3"]) {
        fireEvent.change(min, { target: { value: "4" } });
        fireEvent.change(min, { target: { value } });
        expect(min.value).toBe("1");
      }
      fireEvent.change(min, { target: { value: "2.7" } });
      expect(min.value).toBe("2");
      expect(screen.queryByText(/group edges shown/)).toBeNull();
    });

    it("applies the controls sent by the extension", () => {
      renderWithSummary();
      send({ type: "architectureControls", find: "store", minImports: 2 });
      expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("store");
      expect(helpers.applyMinImports).toHaveBeenLastCalledWith(cy.instance, 2);
      send({ type: "architectureControls" });
      expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("store");
    });

    it("drops a tapped group when a new summary arrives, keeping the find", () => {
      const matches = { empty: () => false, nonempty: () => true };
      helpers.findGroups.mockImplementation((_cy, query: string) => (query ? matches : empty));
      renderWithSummary();
      const node = fileTarget("ui");
      act(() => cy.state.handlers.get("tap")?.({ target: node }));
      send({ ...summary, revision: "r2" });
      expect(helpers.highlightFocus).toHaveBeenLastCalledWith(cy.instance, empty);
      act(() => cy.state.handlers.get("mouseout")?.({}));
      expect(helpers.highlightFocus).toHaveBeenLastCalledWith(cy.instance, empty);

      fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ui" } });
      send({ ...summary, revision: "r3" });
      expect(helpers.findGroups).toHaveBeenLastCalledWith(cy.instance, "ui");
      expect(helpers.highlightFocus).toHaveBeenLastCalledWith(cy.instance, matches);
    });

    it("Escape with nothing highlighted reports an empty highlight", () => {
      const { postMessage } = renderWithSummary();
      helpers.highlightFocus.mockClear();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(helpers.highlightFocus.mock.lastCall?.[1].empty()).toBe(true);
      expect(postMessage).toHaveBeenLastCalledWith(interacted);
    });

    it("stops listening to Escape once unmounted", () => {
      const { unmount } = renderWithSummary();
      unmount();
      helpers.highlightFocus.mockClear();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(helpers.highlightFocus).not.toHaveBeenCalled();
    });
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

  describe("expanded groups and evidence", () => {
    /** One page of group 1 (ui, 5 files in pages of 2), files named f<offset>. */
    const page = (offset: number, revision = "r1", group = 1) => ({
      type: "architectureGroupDetail" as const,
      revision,
      detail: {
        context: summary.context,
        group: { ...summary.groups[0], id: group },
        files: [offset, offset + 1].filter(index => index < 5)
          .map(index => ({ relativePath: `ui/f${index}.ts`, dependencyCount: 1, dependentCount: 0 })),
        internalPairs: [],
        outgoingPairs: [],
        outgoing: offset === 0 ? [{ relativePath: "ui/f0.ts", toGroup: 2, fileEdgeCount: 3 }] : [],
        incoming: [],
        page: { total: 5, offset, returned: 2, truncated: offset + 2 < 5, nextOffset: offset + 2 < 5 ? offset + 2 : undefined, limit: 2 },
      },
    });
    const nodeById = (id: string) => cy.state.nodes.find(node => node.id() === id);
    const tap = (target: unknown) => act(() => cy.state.handlers.get("tap")?.({ target }));
    const enter = (id: string) => act(() => cy.state.handlers.get("dbltap")?.({ target: nodeById(id) }));
    const leave = (label: string) => fireEvent.click(screen.getByRole("button", { name: `Leave ${label}` }));
    const fileIds = () => cy.state.nodes.filter(node => node.data("file")).map(node => node.id());
    const setup = () => {
      const postMessage = vi.fn();
      render(<ArchitectureGraph postMessage={postMessage} />);
      send(summary);
      return postMessage;
    };

    afterEach(() => vi.clearAllMocks());

    it("enters a double-clicked group page by page from its +N more files node, and leaves it", () => {
      const postMessage = setup();
      enter("group-1");
      expect(postMessage).toHaveBeenCalledWith({ command: "architectureExpandGroup", revision: "r1", groupId: 1, offset: 0 });

      send(page(0));
      expect(fileIds()).toEqual(["file:ui/f0.ts", "file:ui/f1.ts"]);
      expect(nodeById("more-1")?.data("label")).toBe("+3 more files");
      expect(helpers.placeNewFiles).toHaveBeenCalled();
      // The ui → store group edge stays; f0's 3 imports to store are drawn for f0 only.
      expect(cy.state.edges.map(edge => edge.id())).toEqual(expect.arrayContaining(["edge-1-2", "file:ui/f0.ts->group-2"]));
      expect(cy.instance.fit).toHaveBeenLastCalledWith(nodeById("group-1"), 30);
      expect(lastOf(postMessage, "architectureDetailRendered")).toEqual({
        command: "architectureDetailRendered", expandedGroups: 1, expandedFileCount: 5, renderedFiles: 2, groupLevelEdges: 1,
        visibleGroups: 3, focusedGroup: "ui", capReached: false, evidence: undefined,
      });

      tap(nodeById("more-1"));
      expect(postMessage).toHaveBeenLastCalledWith({ command: "architectureExpandGroup", revision: "r1", groupId: 1, offset: 2 });
      send(page(2));
      // A page received twice is merged once.
      send(page(2));
      expect(fileIds()).toHaveLength(4);
      leave("ui");
      expect(fileIds()).toEqual([]);
      expect(lastOf(postMessage, "architectureDetailRendered")).toMatchObject({ expandedGroups: 0, groupLevelEdges: 1, focusedGroup: "ui" });
    });

    it("focuses a clicked group without expanding it; Overview and a background click show everything again", () => {
      const postMessage = setup();
      tap(nodeById("group-2"));
      expect(lastOf(postMessage, "architectureExpandGroup")).toBeUndefined();
      expect(helpers.focusGroup).toHaveBeenLastCalledWith(cy.instance, nodeById("group-2"));
      expect(lastOf(postMessage, "architectureDetailRendered")).toMatchObject({ focusedGroup: "store", expandedGroups: 0 });
      expect(screen.getByRole("navigation", { name: "Architecture path" }).textContent).toContain("store");

      fireEvent.click(screen.getByRole("button", { name: "Overview" }));
      expect(lastOf(postMessage, "architectureDetailRendered")).toMatchObject({ focusedGroup: undefined });
      expect((screen.getByRole("button", { name: "Overview" }) as HTMLButtonElement).disabled).toBe(true);

      tap(nodeById("group-0"));
      expect(lastOf(postMessage, "architectureDetailRendered")).toMatchObject({ focusedGroup: "" });
      act(() => cy.state.handlers.get("tap")?.({ target: cy.instance }));
      expect(lastOf(postMessage, "architectureDetailRendered")).toMatchObject({ focusedGroup: undefined });
    });

    it("Escape leaves the last entered group, then drops the focus; Overview leaves every group", () => {
      const postMessage = setup();
      enter("group-1");
      send(page(0));
      enter("group-2");
      send({ ...page(0), detail: { ...page(0).detail, group: summary.groups[1], files: [{ relativePath: "store/s.ts", dependencyCount: 0, dependentCount: 1 }] } });
      expect(fileIds()).toHaveLength(3);
      fireEvent.keyDown(window, { key: "Escape" });
      expect(fileIds()).toEqual(["file:ui/f0.ts", "file:ui/f1.ts"]);
      fireEvent.click(screen.getByRole("button", { name: "Overview" }));
      expect(fileIds()).toEqual([]);
      tap(nodeById("group-1"));
      fireEvent.keyDown(window, { key: "Escape" });
      expect(lastOf(postMessage, "architectureDetailRendered")).toMatchObject({ focusedGroup: undefined });
    });

    it("enters the selected group on Enter, and leaves it on Escape", () => {
      const postMessage = setup();
      tap(nodeById("group-1"));
      fireEvent.keyDown(window, { key: "Enter" });
      expect(postMessage).toHaveBeenCalledWith({ command: "architectureExpandGroup", revision: "r1", groupId: 1, offset: 0 });
      send(page(0));
      fireEvent.keyDown(window, { key: "Escape" });
      expect(fileIds()).toEqual([]);

      postMessage.mockClear();
      fireEvent.keyDown(window, { key: "Enter" });
      expect(postMessage).toHaveBeenCalledWith({ command: "architectureExpandGroup", revision: "r1", groupId: 1, offset: 0 });
      postMessage.mockClear();
      fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });
      expect(lastOf(postMessage, "architectureExpandGroup")).toBeUndefined();
    });

    it("keeps the expanded groups and the tapped element on a stale mark, and drops them on a new revision", () => {
      setup();
      tap(nodeById("group-1"));
      enter("group-1");
      send(page(0));
      send({ ...summary, stale: true });
      expect(fileIds()).toHaveLength(2);
      expect(helpers.highlightFocus.mock.lastCall?.[1].map((element: { id(): string }) => element.id())).toEqual(["group-1"]);

      send({ ...summary, revision: "r2" });
      expect(fileIds()).toEqual([]);
      // A late page of the old revision is dropped.
      send(page(0, "r1"));
      expect(fileIds()).toEqual([]);
    });

    it("drops what it holds and asks for the summary again when the revision changed", () => {
      const postMessage = setup();
      enter("group-1");
      send(page(0));
      expect(fileIds()).toHaveLength(2);
      postMessage.mockClear();
      send({ type: "architectureRevisionChanged", currentRevision: "r2" });
      expect(postMessage).toHaveBeenCalledWith({ command: "architectureMounted" });
      expect(fileIds()).toEqual([]);
    });

    it("drops a page it did not ask for, such as a late answer after a collapse", () => {
      setup();
      send(page(0));
      expect(fileIds()).toEqual([]);
      enter("group-1");
      send(page(0));
      tap(nodeById("more-1"));
      leave("ui");
      send(page(2));
      expect(fileIds()).toEqual([]);
    });

    it("refuses a page past the file cap and says so", () => {
      setup();
      enter("group-1");
      const big = page(0);
      big.detail.files = Array.from({ length: 501 }, (_, index) => ({ relativePath: `ui/g${index}.ts`, dependencyCount: 0, dependentCount: 0 }));
      send(big);
      expect(fileIds()).toEqual([]);
      expect(screen.getByText("Collapse a group first (500 files shown)")).toBeTruthy();
    });

    it("lists the evidence of a tapped edge page by page, opens its files and closes on Escape", () => {
      const postMessage = setup();
      tap(cy.state.edges.find(edge => edge.id() === "edge-1-2"));
      expect(lastOf(postMessage, "architectureEvidence")).toEqual({ command: "architectureEvidence", revision: "r1", from: 1, to: 2, offset: 0 });
      expect(screen.getByText("ui → store: 3 file pairs (static imports)")).toBeTruthy();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close evidence" }));

      const evidencePage = (offset: number, pairs: { source: string; target: string }[], nextOffset?: number) => ({
        type: "architectureEvidencePage" as const, revision: "r1", from: 1, to: 2, pairs,
        page: { total: 3, offset, returned: pairs.length, truncated: nextOffset !== undefined, nextOffset },
      });
      send(evidencePage(0, [{ source: "ui/a.ts", target: "store/b.ts" }, { source: "ui/a.ts", target: "store/c.ts" }], 2));
      // Another edge's page, or one at the wrong offset, is dropped.
      send({ ...evidencePage(2, [{ source: "x.ts", target: "y.ts" }]), from: 2 });
      send(evidencePage(1, [{ source: "x.ts", target: "y.ts" }]));
      expect(screen.getByText("showing 2 of 3")).toBeTruthy();
      expect(lastOf(postMessage, "architectureDetailRendered")?.evidence).toEqual({ edgeCount: 3, total: 3, shown: 2, firstSource: "ui/a.ts" });

      fireEvent.click(screen.getByRole("button", { name: "Load more" }));
      expect(postMessage).toHaveBeenLastCalledWith({ command: "architectureEvidence", revision: "r1", from: 1, to: 2, offset: 2 });
      send(evidencePage(2, [{ source: "ui/d.ts", target: "store/b.ts" }]));
      expect(screen.getByText("showing 3 of 3")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "ui/d.ts" }));
      expect(postMessage).toHaveBeenLastCalledWith({ command: "architectureOpenFile", revision: "r1", relativePath: "ui/d.ts" });
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("region", { name: "Evidence" })).toBeNull();
    });

    it("filters the evidence of a file edge by its file, and closes from its button", () => {
      const postMessage = setup();
      enter("group-1");
      send(page(0));
      tap(cy.state.edges.find(edge => edge.id() === "file:ui/f0.ts->group-2"));
      expect(lastOf(postMessage, "architectureEvidence")).toEqual({
        command: "architectureEvidence", revision: "r1", from: 1, to: 2, sourceFile: "ui/f0.ts", offset: 0,
      });
      expect(screen.getByText("ui/f0.ts → store: 3 file pairs (static imports)")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Close evidence" }));
      expect(screen.queryByRole("region", { name: "Evidence" })).toBeNull();
    });

    it("drives the same actions from the E2E controls, groups named by key", () => {
      const postMessage = setup();
      send({ type: "architectureControls", focus: "store" });
      expect(lastOf(postMessage, "architectureDetailRendered")).toMatchObject({ focusedGroup: "store" });
      send({ type: "architectureControls", focus: "" });
      expect(lastOf(postMessage, "architectureDetailRendered")).toMatchObject({ focusedGroup: undefined });
      send({ type: "architectureControls", expand: "ui" });
      expect(lastOf(postMessage, "architectureExpandGroup")).toEqual({ command: "architectureExpandGroup", revision: "r1", groupId: 1, offset: 0 });
      send(page(0));
      send({ type: "architectureControls", evidenceOf: "ui" });
      expect(lastOf(postMessage, "architectureEvidence")).toMatchObject({ from: 1, to: 2, sourceFile: "ui/f0.ts" });
      send({ type: "architectureEvidencePage", revision: "r1", from: 1, to: 2, sourceFile: "ui/f0.ts",
        pairs: [{ source: "ui/f0.ts", target: "store/b.ts" }], page: { total: 1, offset: 0, returned: 1, truncated: false } });
      send({ type: "architectureControls", openEvidenceRow: 0 });
      expect(postMessage).toHaveBeenLastCalledWith({ command: "architectureOpenFile", revision: "r1", relativePath: "ui/f0.ts" });
      send({ type: "architectureControls", collapse: "ui", expand: "missing", openEvidenceRow: 5 });
      expect(fileIds()).toEqual([]);
    });
  });
});
