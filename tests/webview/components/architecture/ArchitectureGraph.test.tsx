// @vitest-environment happy-dom

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groupMatrix, matrixDigest, unitMatrix } from "@/analyzer/architecture/architectureMatrix";
import type {
  ArchitectureExtensionMessage,
  ArchitectureFolderLevelMessage,
  ArchitectureMatrixMessage,
  ArchitectureSummaryMessage,
} from "@/shared/architecture-types";

// Cytoscape needs a canvas: stand in a fake that records elements and runs layouts at once.
// fcose drops every node at the origin; labels are as wide as `labelWidth` (default: textWidth).
const cy = vi.hoisted(() => {
  type Data = Record<string, string | number | boolean>;
  type Point = { x: number; y: number };
  const state = {
    nodes: [] as ReturnType<typeof fakeNode>[],
    edges: [] as ReturnType<typeof fakeEdge>[],
    labelWidth: undefined as number | undefined,
    container: undefined as HTMLElement | undefined,
    container: undefined as HTMLElement | undefined,
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
      parent: () => state.nodes.find(other => other.id() === data.parent) ?? { data: () => undefined, nonempty: () => false, empty: () => true },
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
      renderedPosition: () => position,
      visible: () => true,
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
    return asCollection({
      data: (key: string) => data[key], id: () => String(data.id), isNode: () => false, isEdge: () => true, style: () => "element",
    });
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
    zoom: vi.fn(() => 1),
    pan: vi.fn(() => ({ x: 0, y: 0 })),
    viewport: vi.fn(),
    width: () => 800,
    height: () => 600,
    style: vi.fn(),
    minZoom: () => 0.05,
    maxZoom: () => 5,
    resize: vi.fn(),
    nodes: () => state.nodes,
    edges: () => state.edges,
    getElementById: (id: string) =>
      state.nodes.find(node => node.id() === id) ?? { empty: () => true, nonempty: () => false, isParent: () => false },
    destroy: () => {},
    destroyed: () => false,
    container: () => (state.container ??= document.createElement("div")),
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
  applyRoleFilter: vi.fn(() => 2),
  findGroups: vi.fn(),
  highlightFocus: vi.fn(),
  measureInteraction: () => ({ highlightedGroups: 2, fadedGroups: 1, labelledEdges: 1, shownGroupEdges: 1 }),
  // Lays out new files and hides what the focus leaves out on real Cytoscape; tested in architectureElements.test.ts.
  placeNewFiles: vi.fn(),
  focusGroup: vi.fn(() => ({ nodes: () => ({ filter: () => ({ length: 3 }) }) })),
  // The units measurement runs on real Cytoscape in architectureUnitsLevel.test.ts.
  measureUnitLevel: vi.fn(() => ({ units: 2, colors: 2, redEdges: 1, edgesNotDown: 0, routedEdges: 2, hiddenEdges: 0, minLabelPx: 11 })),
  // Isolated groups are measured, set aside and packed on real Cytoscape in architectureElements.test.ts.
  measureIsolated: vi.fn(() => ({ isolatedBelow: 0, minLabelPx: 11 })),
  linkedElements: vi.fn(() => ({ nodes: () => ({ empty: () => false }), layout: (options: unknown) => cy.instance.layout(options) })),
  packIsolatedGroups: vi.fn(),
  // Bands, marks and arrow-key moves run on real Cytoscape in architectureUnitsLevel.test.ts.
  layerBands: vi.fn(() => [{ layer: 1, y1: -50, y2: 0 }, { layer: 0, y1: 0, y2: 50 }]),
  markNodes: vi.fn(),
  nearestNode: vi.fn(),
  describeNode: vi.fn(() => "described"),
}));
helpers.findGroups.mockImplementation(() => helpers.empty);
vi.mock("@/webview/components/architecture/architectureElements", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...helpers,
}));

// ELK runs on real Cytoscape in elkLayout.test.ts and architectureUnitsLevel.test.ts; here its worker answers when told.
const elk = vi.hoisted(() => ({
  runner: { layout: vi.fn(), terminate: vi.fn() },
  toElkGraph: vi.fn(() => ({ id: "root" })),
  applyElkLayout: vi.fn(() => new Map([["a>b", { points: [], source: { x: 0, y: 0 }, target: { x: 0, y: 0 } }]])),
  applyRoutes: vi.fn(),
}));
vi.mock("@/webview/components/architecture/elkWorker", () => ({ createElk: () => elk.runner }));
vi.mock("@/webview/components/architecture/elkLayout", () => ({
  toElkGraph: elk.toElkGraph, applyElkLayout: elk.applyElkLayout, applyRoutes: elk.applyRoutes,
}));

import { ArchitectureGraph, shortPath } from "@/webview/components/architecture/ArchitectureGraph";

/** The Evidence region's lines as shown: a target heading, then `← <source>` below it. */
const evidenceRows = () => Array.from(
  screen.getByRole("region", { name: "Evidence" }).querySelectorAll("li"),
  (row) => (row.querySelector("ul") ? row.querySelector("button")?.textContent : row.textContent),
);

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
    send({ type: "architectureState", status: "building", message: "Building architecture: 3 of 10 files", percent: 30 });
    expect(screen.getByText("Building architecture: 3 of 10 files (30%)")).toBeTruthy();
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });

  it("renders the header from the summary and reports what was drawn", () => {
    const postMessage = vi.fn();
    render(<ArchitectureGraph postMessage={postMessage} />);
    send(summary);

    expect(screen.getByText("Groups based on imports (Louvain)")).toBeTruthy();
    expect(screen.getByText(/2 of 3 groups shown/)).toBeTruthy();
    // Parse failures stay in the Details line, the rest behind its disclosure.
    expect(screen.getByText(/Details: 10 files, 4 file pairs/).textContent).toContain("2 failed");
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

    expect(screen.getByText(/Files or architecture rules changed since this view was built/)).toBeTruthy();
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

    send({ type: "architectureState", status: "empty", message: "No supported source file in \"ws\"." });
    expect(screen.getByText("No supported source file in \"ws\".")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(postMessage).toHaveBeenLastCalledWith({ command: "architectureOpenSettings" });
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
    const interacted = {
      command: "architectureInteracted", highlightedGroups: 2, fadedGroups: 1, labelledEdges: 1, shownGroupEdges: 1,
      announcement: "", canvasFocused: false, zoom: 1,
    };
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
      const matches = { empty: () => false, nonempty: () => true, length: 1, map: <R,>(fn: (node: { id: () => string }) => R) => [fn({ id: () => "group-1" })] };
      helpers.findGroups.mockImplementation((_cy, query: string) => (query ? matches : empty));
      const { postMessage } = renderWithSummary();
      const find = screen.getByRole("searchbox", { name: "Find group" }) as HTMLInputElement;

      fireEvent.change(find, { target: { value: "ui" } });
      expect(helpers.findGroups).toHaveBeenLastCalledWith(cy.instance, "ui");
      // summary hides 1 of its 3 groups: the extension searches it.
      expect(postMessage).toHaveBeenCalledWith({ command: "architectureFind", revision: "r1", query: "ui" });
      expect(screen.queryByRole("status", { name: "Find result" })).toBeNull();
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

    it("reports the hidden groups a find matches, never as no group, and Show more groups asks for them", () => {
      const { postMessage } = renderWithSummary();
      const find = screen.getByRole("searchbox", { name: "Find group" }) as HTMLInputElement;
      const status = () => screen.queryByRole("status", { name: "Find result" })?.textContent;

      fireEvent.change(find, { target: { value: "legacy" } });
      expect(status()).toBe("Searching the hidden groups…");
      // An answer for another query or revision is dropped.
      send({ type: "architectureFound", revision: "r1", query: "leg", matches: ["legacy"], total: 1 });
      send({ type: "architectureFound", revision: "r0", query: "legacy", matches: ["legacy"], total: 1 });
      expect(status()).toBe("Searching the hidden groups…");
      send({ type: "architectureFound", revision: "r1", query: "legacy", matches: ["legacy"], total: 1 });
      expect(status()).toBe('"legacy" is also in 1 hidden group (legacy). Only the 150 largest groups are drawn.');
      expect(lastOf(postMessage, "architectureDetailRendered").findStatus).toBe(status());

      fireEvent.change(find, { target: { value: "nothing" } });
      send({ type: "architectureFound", revision: "r1", query: "nothing", matches: [], total: 0 });
      expect(status()).toBe('No group matches "nothing".');

      // Below the cap's maximum, both the header and the find offer Show more groups.
      send({ ...summary, maxGroups: 50 });
      fireEvent.change(find, { target: { value: "legacy" } });
      send({ type: "architectureFound", revision: "r1", query: "legacy", matches: ["a", "b"], total: 12 });
      expect(status()).toBe('"legacy" is also in 12 hidden groups (a, b, +10 more). Show more groups');
      const buttons = screen.getAllByRole("button", { name: "Show more groups" });
      expect(buttons).toHaveLength(2);
      fireEvent.click(buttons[1]);
      expect(postMessage).toHaveBeenLastCalledWith({ command: "architectureShowMoreGroups", revision: "r1" });
      postMessage.mockClear();
      send({ type: "architectureControls", showMoreGroups: true });
      expect(postMessage).toHaveBeenCalledWith({ command: "architectureShowMoreGroups", revision: "r1" });
    });

    it("states the groups without cross-group imports, and keeps the viewport and find when Show more groups draws more", () => {
      const matches = { empty: () => false, nonempty: () => true, length: 1, map: () => ["group-1"] };
      helpers.findGroups.mockImplementation((_cy, query: string) => (query ? matches : empty));
      const { postMessage } = renderWithSummary();
      send({ ...summary, isolatedGroups: [0, 2], groupEdges: [] });
      expect(screen.getByText("2 groups without cross-group imports, drawn apart below the others.")).toBeTruthy();
      expect(cy.state.nodes.filter(node => node.data("isolated") === true).map(node => node.id())).toEqual(["group-2", "group-0"]);
      expect(lastOf(postMessage, "architectureRendered").groupLevel).toEqual({
        shownGroups: 2, totalGroups: 3, hiddenGroups: 1, hiddenGroupEdges: 2, isolatedGroups: 2, isolatedBelow: 0, minLabelPx: 11,
      });

      fireEvent.change(screen.getByRole("searchbox", { name: "Find group" }), { target: { value: "ui" } });
      vi.mocked(cy.instance.center).mockClear();
      vi.mocked(cy.instance.fit).mockClear();
      // Show more groups: the same revision with one more group is laid out again, centred on what was found.
      send({ ...summary, maxGroups: 150, hiddenGroups: 0, groups: [...summary.groups, { id: 3, key: "legacy", label: "legacy", fileCount: 1, internalEdgeCount: 0 }] });
      expect(helpers.packIsolatedGroups).toHaveBeenCalled();
      expect(cy.instance.fit).toHaveBeenCalled();
      // The find runs again on the groups now drawn, and stays in view.
      expect(helpers.findGroups).toHaveBeenLastCalledWith(cy.instance, "ui");
      expect(cy.instance.center).toHaveBeenLastCalledWith(matches);
      // A stale mark finds nothing again: what is pinned stays.
      vi.mocked(helpers.findGroups).mockClear();
      send({ ...summary, maxGroups: 150, hiddenGroups: 0, stale: true, groups: [...summary.groups, { id: 3, key: "legacy", label: "legacy", fileCount: 1, internalEdgeCount: 0 }] });
      expect(helpers.findGroups).not.toHaveBeenCalled();
      // Same revision: nothing is reset or asked again.
      expect(postMessage.mock.calls.filter(([message]) => message.command === "architectureMounted")).toHaveLength(1);
    });

    it("hides weak edges from the min-imports control and states how many are shown", () => {
      renderWithSummary();
      const min = screen.getByRole("spinbutton", { name: /Min. imports/ }) as HTMLInputElement;
      expect(min.max).toBe("3");

      helpers.applyMinImports.mockReturnValue(0);
      fireEvent.change(min, { target: { value: "4" } });
      expect(helpers.applyMinImports).toHaveBeenLastCalledWith(cy.instance, 4);
      expect(screen.getByText("0 of 1 group edges shown (min. 4 imports). Totals include them.")).toBeTruthy();
      // The totals line is unchanged by the filter.
      expect(screen.getByText(/Details: 10 files, 4 file pairs/)).toBeTruthy();

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
      const matches = { empty: () => false, nonempty: () => true, length: 1, map: <R,>(fn: (node: { id: () => string }) => R) => [fn({ id: () => "group-1" })] };
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

      // A zoom or pan of its own (focus, find, the user; a stale banner then shrinks the canvas) is kept.
      act(() => cy.state.handlers.get("viewport")?.({}));
      onResize();
      vi.advanceTimersByTime(120);
      expect(cy.instance.resize).toHaveBeenCalledTimes(2);
      expect(cy.instance.fit).toHaveBeenCalledTimes(1);
      expect(postMessage).toHaveBeenLastCalledWith({ command: "architectureResized", width: 0, height: 0 });

      onResize();
      unmount();
      expect(disconnect).toHaveBeenCalled();
      window.dispatchEvent(new Event("resize"));
      vi.runAllTimers();
      expect(cy.instance.resize).toHaveBeenCalledTimes(2);
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
        visibleGroups: 3, focusedGroup: "ui", capReached: false, findStatus: "", viewport: "1@0,0", evidence: undefined,
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

    it("focuses a clicked group without expanding it; its × or the level's step and a background click show everything again", () => {
      const postMessage = setup();
      tap(nodeById("group-2"));
      expect(lastOf(postMessage, "architectureExpandGroup")).toBeUndefined();
      expect(helpers.focusGroup).toHaveBeenLastCalledWith(cy.instance, nodeById("group-2"));
      expect(lastOf(postMessage, "architectureDetailRendered")).toMatchObject({ focusedGroup: "store", expandedGroups: 0 });
      expect(screen.getByRole("navigation", { name: "Architecture path" }).textContent).toContain("store");

      // The focused group ends the path: where the view is, not a link.
      expect(screen.getByText("store", { selector: "nav span[aria-current]" }).getAttribute("aria-current")).toBe("location");
      fireEvent.click(screen.getByRole("button", { name: "Clear focus on store" }));
      expect(lastOf(postMessage, "architectureDetailRendered")).toMatchObject({ focusedGroup: undefined });
      expect(screen.getByRole("button", { name: "All groups" }).getAttribute("aria-current")).toBe("location");

      tap(nodeById("group-2"));
      fireEvent.click(screen.getByRole("button", { name: "All groups" }));
      expect(lastOf(postMessage, "architectureDetailRendered")).toMatchObject({ focusedGroup: undefined });

      tap(nodeById("group-0"));
      expect(lastOf(postMessage, "architectureDetailRendered")).toMatchObject({ focusedGroup: "" });
      act(() => cy.state.handlers.get("tap")?.({ target: cy.instance }));
      expect(lastOf(postMessage, "architectureDetailRendered")).toMatchObject({ focusedGroup: undefined });
    });

    it("Escape leaves the last entered group, then drops the focus; the level's step leaves every group", () => {
      const postMessage = setup();
      enter("group-1");
      send(page(0));
      enter("group-2");
      send({ ...page(0), detail: { ...page(0).detail, group: summary.groups[1], files: [{ relativePath: "store/s.ts", dependencyCount: 0, dependentCount: 1 }] } });
      expect(fileIds()).toHaveLength(3);
      fireEvent.keyDown(window, { key: "Escape" });
      expect(fileIds()).toEqual(["file:ui/f0.ts", "file:ui/f1.ts"]);
      fireEvent.click(screen.getByRole("button", { name: "All groups" }));
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

    it("keeps the page asked for when a stale page of an earlier visit arrives first", () => {
      setup();
      enter("group-1");
      send(page(0));
      tap(nodeById("more-1"));
      leave("ui");
      enter("group-1");
      send(page(2));
      send(page(0));
      expect(fileIds()).toEqual(["file:ui/f0.ts", "file:ui/f1.ts"]);
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
      expect(lastOf(postMessage, "architectureDetailRendered")?.evidence).toMatchObject({
        edgeCount: 3, total: 3, shown: 2, firstSource: "ui/a.ts", pairs: ["ui/a.ts → store/b.ts", "ui/a.ts → store/c.ts"],
      });

      fireEvent.click(screen.getByRole("button", { name: "Load more" }));
      expect(postMessage).toHaveBeenLastCalledWith({ command: "architectureEvidence", revision: "r1", from: 1, to: 2, offset: 2 });
      send(evidencePage(2, [{ source: "ui/d.ts", target: "store/b.ts" }]));
      expect(screen.getByText("showing 3 of 3")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
      // Sorted by source: a target comes back under a new heading; no unit drawn, paths stay whole.
      expect(evidenceRows()).toEqual(["store/b.ts", "← ui/a.ts", "store/c.ts", "← ui/a.ts", "store/b.ts", "← ui/d.ts"]);
      expect(lastOf(postMessage, "architectureDetailRendered")?.evidence?.pairs).toEqual([
        "ui/a.ts → store/b.ts", "ui/a.ts → store/c.ts", "ui/d.ts → store/b.ts",
      ]);

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
  describe("units level", () => {
    const withUnits: ArchitectureSummaryMessage = {
      ...summary,
      context: { ...summary.context, communityMode: "path", truncated: false },
      hiddenGroups: 0,
      unassigned: { fileCount: 0, internalEdgeCount: 0 },
      units: {
        units: [
          {
            key: "apps/web", name: "@ws/web", fileCount: 5, internalEdgeCount: 1, layer: 1,
            role: "frontend", confidence: "inferred", evidence: [{ role: "frontend", detail: "`react` in dependencies" }],
          },
          {
            key: "packages/core", name: "@ws/core", fileCount: 4, internalEdgeCount: 0, layer: 1,
            role: "library", confidence: "declared", evidence: [{ role: "library", detail: 'declared by roles["@ws/core"] in graphit.architecture.json' }],
          },
        ],
        unitEdges: [
          { from: "apps/web", to: "packages/core", fileEdgeCount: 3, kind: "cycle" },
          { from: "packages/core", to: "apps/web", fileEdgeCount: 1, kind: "cycle" },
        ],
        upwardEdges: 0,
        cycles: 1,
        roleCounts: { frontend: 1, library: 1 },
        totals: { files: 9, fileEdges: 5, intraUnitEdges: 1, interUnitEdges: 4 },
        groupUnits: { 1: "apps/web", 2: "packages/core" },
        groupLayers: { 1: 0, 2: 0 },
        groupEdgeKinds: {},
        nestedGroups: [],
      },
    };
    const nodeById = (id: string) => cy.state.nodes.find(node => node.id() === id);
    const edgeById = (id: string) => cy.state.edges.find(edge => edge.id() === id);
    /** Units never drawn before: no saved position to restore, so ELK lays them out. */
    let fileCount = 20;
    const unseen = (): ArchitectureSummaryMessage => {
      fileCount += 10;
      return { ...withUnits, units: { ...withUnits.units!, units: withUnits.units!.units.map(entry => ({ ...entry, fileCount })) } };
    };
    /** Lets the ELK worker's answer reach the component. */
    const settle = () => act(async () => {});
    const setup = async (level = withUnits) => {
      const postMessage = vi.fn();
      render(<ArchitectureGraph postMessage={postMessage} />);
      send(level);
      await settle();
      return postMessage;
    };
    const dbltap = async (target: unknown) => {
      act(() => cy.state.handlers.get("dbltap")?.({ target }));
      await settle();
    };
    /** The next ELK layout, settled when the test says so. */
    const deferLayout = () => {
      const answer = Promise.withResolvers<{ id: string }>();
      elk.runner.layout.mockReturnValueOnce(answer.promise);
      return answer;
    };

    // A braced body: a function returned from beforeEach is run as its teardown.
    beforeEach(() => {
      elk.runner.layout.mockResolvedValue({ id: "root" });
    });
    afterEach(() => vi.clearAllMocks());

    it("fits, zooms in and out from the overlay and from the focused canvas's keys, and reports the zoom", async () => {
      const postMessage = await setup();
      const fits = cy.instance.fit.mock.calls.length;
      fireEvent.click(screen.getByRole("button", { name: "Fit the graph (0)" }));
      expect(cy.instance.fit.mock.calls).toHaveLength(fits + 1);
      fireEvent.click(screen.getByRole("button", { name: "Zoom in (+)" }));
      expect(cy.instance.zoom).toHaveBeenCalledWith({ level: 1.25, renderedPosition: { x: 400, y: 300 } });
      fireEvent.click(screen.getByRole("button", { name: "Zoom out (-)" }));
      expect(cy.instance.zoom).toHaveBeenCalledWith({ level: 0.8, renderedPosition: { x: 400, y: 300 } });
      expect(lastOf(postMessage, "architectureInteracted")).toMatchObject({ zoom: 1 });

      const canvas = screen.getByRole("application");
      expect(canvas.tabIndex).toBe(0);
      expect(canvas.getAttribute("aria-label")).toMatch(/^Architecture graph of the units: arrow keys select/);
      fireEvent.keyDown(canvas, { key: "0" });
      expect(cy.instance.fit.mock.calls).toHaveLength(fits + 2);
      fireEvent.keyDown(canvas, { key: "+" });
      fireEvent.keyDown(canvas, { key: "-" });
      expect(cy.instance.zoom).toHaveBeenCalledWith({ level: 0.8, renderedPosition: { x: 400, y: 300 } });
      // Other keys are left to the page (Tab leaves the canvas).
      fireEvent.keyDown(canvas, { key: "Tab" });
      expect(cy.instance.fit.mock.calls).toHaveLength(fits + 2);
    });

    it("selects the nearest unit with the arrow keys, rings and announces it, and Enter enters it", async () => {
      const postMessage = await setup();
      helpers.nearestNode.mockImplementationOnce(() => nodeById("group-1"));
      fireEvent.keyDown(screen.getByRole("application"), { key: "ArrowDown" });
      expect(helpers.nearestNode).toHaveBeenLastCalledWith(expect.anything(), undefined, "ArrowDown");
      expect(helpers.markNodes).toHaveBeenLastCalledWith(cy.instance, "selected", nodeById("group-1"));
      expect(document.getElementById("architecture-announcement")?.textContent).toBe("described");
      expect(document.getElementById("architecture-announcement")?.getAttribute("aria-live")).toBe("polite");
      expect(lastOf(postMessage, "architectureInteracted")).toMatchObject({ announcement: "described" });
      // The next arrow moves from the selected unit; nothing in that direction keeps it.
      helpers.nearestNode.mockImplementationOnce(() => undefined);
      fireEvent.keyDown(screen.getByRole("application"), { key: "ArrowRight" });
      expect(helpers.nearestNode).toHaveBeenLastCalledWith(expect.anything(), nodeById("group-1"), "ArrowRight");
      fireEvent.keyDown(screen.getByRole("application"), { key: "Enter" });
      await settle();
      expect(lastOf(postMessage, "architectureRendered")).toEqual(expect.objectContaining({ unit: "apps/web" }));
    });

    it("selects a unit clicked in the legend overlay, and the cycle count shows the cycle block", async () => {
      const postMessage = await setup({ ...withUnits, units: { ...withUnits.units!, cycleUnits: [["apps/web", "packages/core"]] } });
      expect(nodeById("cycle-0")?.data("label")).toBe("Cycle · 2 units");
      // The block is not a group: the report counts the two units.
      expect(lastOf(postMessage, "architectureRendered")).toEqual(expect.objectContaining({ renderedGroups: 2 }));
      const legend = screen.getByRole("group", { name: "Zoom controls" });
      expect(legend).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /@ws\/core \[library\]/ }));
      expect(helpers.markNodes).toHaveBeenLastCalledWith(cy.instance, "selected", nodeById("group-2"));

      fireEvent.click(screen.getByRole("button", { name: "1 cycle" }));
      expect(cy.instance.fit).toHaveBeenLastCalledWith(nodeById("cycle-0"), 30);
      expect(helpers.highlightFocus.mock.lastCall?.[1].map((node: { id: () => string }) => node.id())).toEqual(["group-1", "group-2"]);
      // The same buttons, clicked by the E2E driver.
      send({ type: "architectureControls", legendUnit: "apps/web", zoom: "fit", cycleCount: true, keys: ["ArrowDown"] });
      expect(document.activeElement).toBe(screen.getByRole("application"));
    });

    it("restyles the canvas when VS Code switches the theme kind", async () => {
      await setup();
      cy.instance.style.mockClear();
      document.body.dataset.vscodeThemeKind = "vscode-high-contrast";
      await settle();
      try {
        expect(cy.instance.style).toHaveBeenCalledOnce();
        const sheet = cy.instance.style.mock.lastCall?.[0] as { selector: string; style: Record<string, unknown> }[];
        expect(sheet.find(entry => entry.selector === "node[hue]")?.style["background-opacity"]).toBe(0);
      } finally {
        delete document.body.dataset.vscodeThemeKind;
      }
    });

    it("says so when a level has several nodes and no import between them", async () => {
      await setup({ ...withUnits, units: { ...withUnits.units!, unitEdges: [], cycles: 0 } });
      expect(screen.getByText("No imports between these units.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /cycle/ })).toBeNull();
    });

    it("draws the units in layers with their counts and legend, and reports them", async () => {
      const postMessage = await setup(unseen());
      expect(elk.runner.layout).toHaveBeenCalledOnce();
      expect(elk.applyElkLayout).toHaveBeenCalledOnce();
      // The routes ELK returned are drawn once the positions settle.
      expect(elk.applyRoutes).toHaveBeenLastCalledWith(cy.instance, expect.anything(), expect.objectContaining({ size: 1 }));
      expect(screen.getByText(/Units in layers/)).toBeTruthy();
      expect(screen.getByText(/^2 units$/)).toBeTruthy();
      expect(screen.getByText(/0 upward/).parentElement?.textContent).toBe("2 units · 1 layer · 0 upward · 1 cycle");
      expect(screen.getByRole("list", { name: "Units" }).textContent).toBe("@ws/web [frontend?]@ws/core [library]");
      expect(cy.state.nodes.map(node => node.data("key"))).toEqual(["units:apps/web", "units:packages/core"]);
      expect(lastOf(postMessage, "architectureRendered")).toEqual(expect.objectContaining({
        renderedGroups: 2, renderedGroupEdges: 2, unit: undefined, unitLevel: expect.objectContaining({ redEdges: 1 }),
      }));
    });

    it("lists the units per role, filters them on a legend click, and reports the legend", async () => {
      const postMessage = await setup(unseen());
      const legend = screen.getByRole("list", { name: "Unit roles" });
      expect(legend.textContent).toBe("1 frontend1 library");
      expect(legend.parentElement?.title).toMatch(/^\[role\?\] inferred from manifests and files/);
      expect(lastOf(postMessage, "architectureRendered")).toEqual(expect.objectContaining({ roles: ["frontend=1", "library=1"] }));
      expect(helpers.applyRoleFilter).toHaveBeenLastCalledWith(cy.instance, null);

      fireEvent.click(screen.getByRole("button", { name: "1 library" }));
      expect(helpers.applyRoleFilter).toHaveBeenLastCalledWith(cy.instance, "library");
      expect(screen.getByRole("button", { name: "1 library" }).getAttribute("aria-pressed")).toBe("true");
      expect(lastOf(postMessage, "architectureRendered")).toEqual(expect.objectContaining({ roles: ["frontend=1", "library=1*"] }));

      // The E2E driver clicks the same button: a second click shows every unit again.
      send({ type: "architectureControls", role: "library" });
      expect(helpers.applyRoleFilter).toHaveBeenLastCalledWith(cy.instance, null);
      expect(lastOf(postMessage, "architectureRendered")).toEqual(expect.objectContaining({ roles: ["frontend=1", "library=1"] }));

      // A new revision draws every unit.
      send({ type: "architectureControls", role: "frontend" });
      send({ ...withUnits, revision: "r2" });
      await settle();
      expect(screen.getByRole("button", { name: "1 frontend" }).getAttribute("aria-pressed")).toBe("false");
    });

    it("states the hidden weaker edges", () => {
      const many = { ...withUnits.units!, unitEdges: Array.from({ length: 8 }, (_, index) =>
        ({ from: "apps/web", to: index % 2 ? "packages/core" : `lib${index}`, fileEdgeCount: 10 - index, kind: "down" as const })) };
      render(<ArchitectureGraph postMessage={vi.fn()} />);
      send({ ...withUnits, units: many });
      expect(screen.getByText(/2 weaker edges hidden/)).toBeTruthy();
      // Said once: the controls repeat the count only once min-imports takes over.
      expect(screen.queryByText(/group edges shown/)).toBeNull();
      send({ type: "architectureControls", minImports: 2 });
      expect(screen.getByText(/of 8 group edges shown \(min\. 2 imports\)/)).toBeTruthy();
    });

    it("lays out off the UI thread: the canvas stays hidden until ELK answers, then is reported", async () => {
      const answer = deferLayout();
      const postMessage = vi.fn();
      render(<ArchitectureGraph postMessage={postMessage} />);
      send(unseen());
      expect(cy.instance.container().style.visibility).toBe("hidden");
      // The webview keeps handling input meanwhile: a control message is answered at once.
      send({ type: "architectureControls", minImports: 2 });
      expect(lastOf(postMessage, "architectureRendered")).toBeUndefined();

      answer.resolve({ id: "root" });
      await settle();
      expect(cy.instance.container().style.visibility).toBe("");
      expect(lastOf(postMessage, "architectureRendered")).toEqual(expect.objectContaining({ renderedGroups: 2 }));
    });

    it("drops an ELK answer a later render superseded", async () => {
      const stale = deferLayout();
      const postMessage = await setup(unseen());
      // The units are still waiting for ELK: entering a unit starts another layout.
      await dbltap(nodeById("group-1"));
      expect(lastOf(postMessage, "architectureRendered")).toEqual(expect.objectContaining({ unit: "apps/web" }));
      const applied = elk.applyElkLayout.mock.calls.length;
      stale.resolve({ id: "root" });
      await settle();
      expect(elk.applyElkLayout).toHaveBeenCalledTimes(applied);
      expect(postMessage.mock.calls.filter(([message]) => message.command === "architectureRendered")).toHaveLength(1);
    });

    it("still draws and reports the level when the ELK layout fails", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        elk.runner.layout.mockRejectedValueOnce(new Error("ELK worker failed: blocked"));
        const postMessage = await setup(unseen());
        expect(error).toHaveBeenCalledWith("[Graph-It-Live] ELK layout failed", expect.any(Error));
        expect(elk.applyElkLayout).not.toHaveBeenCalled();
        expect(cy.instance.container().style.visibility).toBe("");
        expect(lastOf(postMessage, "architectureRendered")).toEqual(expect.objectContaining({ renderedGroups: 2, overlappingGroups: 0 }));
      } finally {
        error.mockRestore();
      }
    });

    it("drops the routes of the edges around a dragged node, and stops the worker on unmount", async () => {
      const { unmount } = render(<ArchitectureGraph postMessage={vi.fn()} />);
      const edges = { kind: "connected edges" };
      const around = { connectedEdges: () => edges };
      const moved = { union: () => around, descendants: () => moved };
      const target = { union: () => moved, ancestors: () => moved };
      act(() => cy.state.handlers.get("drag")?.({ target }));
      expect(elk.applyRoutes).toHaveBeenLastCalledWith(cy.instance, edges, expect.any(Map));
      const terminated = elk.runner.terminate.mock.calls.length;
      unmount();
      expect(elk.runner.terminate).toHaveBeenCalledTimes(terminated + 1);
    });

    it("lists the file pairs of a clicked unit edge by unit key, pages them, opens a file and closes on entering a unit", async () => {
      const postMessage = await setup();
      const unitEdge = edgeById("edge-1-2");
      expect(unitEdge?.data("tooltip")).toBe("@ws/web → @ws/core\n3 file pairs (static imports) · click files");
      act(() => cy.state.handlers.get("tap")?.({ target: unitEdge }));
      expect(lastOf(postMessage, "architectureUnitEvidence")).toEqual({
        command: "architectureUnitEvidence", revision: "r1", from: "apps/web", to: "packages/core", offset: 0,
      });
      expect(lastOf(postMessage, "architectureEvidence")).toBeUndefined();
      const panel = () => screen.queryByRole("region", { name: "Evidence" });
      expect(panel()?.textContent).toContain("@ws/web → @ws/core: 3 file pairs (static imports) (cycle)");

      const unitPage = (offset: number, pairs: { source: string; target: string }[], nextOffset?: number) => ({
        type: "architectureEvidencePage" as const, revision: "r1", from: "apps/web", to: "packages/core", pairs,
        page: { total: 3, offset, returned: pairs.length, truncated: nextOffset !== undefined, nextOffset },
      });
      // The group ids 1 → 2 name another edge than the unit keys.
      send({ ...unitPage(0, [{ source: "x.ts", target: "y.ts" }]), from: 1, to: 2 });
      send(unitPage(0, [{ source: "apps/web/src/a.ts", target: "packages/core/src/index.ts" }], 1));
      expect(screen.getByText("showing 1 of 3")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Load more" }));
      expect(postMessage).toHaveBeenLastCalledWith({
        command: "architectureUnitEvidence", revision: "r1", from: "apps/web", to: "packages/core", offset: 1,
      });
      send(unitPage(1, [
        { source: "apps/web/src/b.ts", target: "packages/core/src/index.ts" },
        { source: "apps/web/src/c.ts", target: "packages/core/src/util.ts" },
      ]));
      expect(screen.getByText("showing 3 of 3")).toBeTruthy();
      // The next page continues index.ts under its heading; each path is shown from its unit, whole in title and name.
      expect(evidenceRows()).toEqual(["src/index.ts", "← src/a.ts", "← src/b.ts", "src/util.ts", "← src/c.ts"]);
      expect(screen.getByRole("button", { name: "packages/core/src/index.ts" }).getAttribute("title")).toBe("packages/core/src/index.ts");
      expect(screen.getByRole("button", { name: "apps/web/src/a.ts" }).textContent).toBe("src/a.ts");
      expect(screen.getByRole("list", { name: "Imported by (packages/core/src/index.ts)" }).children).toHaveLength(2);
      expect(lastOf(postMessage, "architectureDetailRendered")?.evidence?.pairs).toEqual([
        "apps/web/src/a.ts → packages/core/src/index.ts",
        "apps/web/src/b.ts → packages/core/src/index.ts",
        "apps/web/src/c.ts → packages/core/src/util.ts",
      ]);
      fireEvent.click(screen.getByRole("button", { name: "apps/web/src/c.ts" }));
      expect(postMessage).toHaveBeenLastCalledWith({ command: "architectureOpenFile", revision: "r1", relativePath: "apps/web/src/c.ts" });

      // A click on a unit focuses it and opens no panel; entering a unit closes the panel.
      postMessage.mockClear();
      act(() => cy.state.handlers.get("tap")?.({ target: nodeById("group-2") }));
      expect(lastOf(postMessage, "architectureUnitEvidence")).toBeUndefined();
      expect(panel()).not.toBeNull();
      await dbltap(nodeById("group-1"));
      expect(panel()).toBeNull();
    });

    it("replaces a unit edge's panel with another edge's, closes it with × and Escape, and leaves a double-clicked edge unassigned", async () => {
      const postMessage = await setup();
      const panel = () => screen.queryByRole("region", { name: "Evidence" });
      const tapEdge = (id: string) => act(() => cy.state.handlers.get("tap")?.({ target: edgeById(id) }));
      tapEdge("edge-1-2");
      tapEdge("edge-2-1");
      expect(lastOf(postMessage, "architectureUnitEvidence")).toMatchObject({ from: "packages/core", to: "apps/web" });
      expect(panel()?.textContent).toContain("@ws/core → @ws/web: 1 file pair (static imports) (cycle)");
      // A late page of the first edge is another edge's: dropped.
      send({ type: "architectureEvidencePage", revision: "r1", from: "apps/web", to: "packages/core", pairs: [{ source: "a.ts", target: "b.ts" }],
        page: { total: 3, offset: 0, returned: 1, truncated: true, nextOffset: 1 } });
      expect(panel()?.textContent).not.toContain("a.ts");

      fireEvent.click(screen.getByRole("button", { name: "Close evidence" }));
      expect(panel()).toBeNull();
      tapEdge("edge-1-2");
      act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
      expect(panel()).toBeNull();
      expect(cy.state.nodes.map(node => node.data("key"))).toEqual(["units:apps/web", "units:packages/core"]);

      postMessage.mockClear();
      await dbltap(edgeById("edge-1-2"));
      expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ command: "architectureEnterFolder" }));
      expect(cy.state.nodes.map(node => node.data("key"))).toEqual(["units:apps/web", "units:packages/core"]);
    });

    it("names no kind on a down unit edge, and opens a unit edge's evidence from the E2E driver", async () => {
      const down = { ...withUnits.units!, unitEdges: [{ from: "apps/web", to: "packages/core", fileEdgeCount: 1, kind: "down" as const }] };
      const postMessage = await setup({ ...withUnits, units: down });
      send({ type: "architectureControls", evidenceOf: "apps/web" });
      expect(lastOf(postMessage, "architectureUnitEvidence")).toMatchObject({ from: "apps/web", to: "packages/core" });
      expect(screen.getByRole("region", { name: "Evidence" }).textContent).toContain("@ws/web → @ws/core: 1 file pair (static imports)×");
    });

    it("enters a double-clicked unit, shows its groups, and goes back with All units or Escape", async () => {
      const postMessage = await setup();
      await dbltap(nodeById("group-1"));
      expect(cy.state.nodes.map(node => node.data("key"))).toEqual(["path:ui"]);
      expect(nodeById("group-1")?.data("color")).toBeDefined();
      expect(lastOf(postMessage, "architectureRendered")).toEqual(expect.objectContaining({ unit: "apps/web", unitLevel: undefined }));
      expect(screen.getByRole("button", { name: "@ws/web" })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "All units" }));
      expect(cy.state.nodes.map(node => node.data("key"))).toEqual(["units:apps/web", "units:packages/core"]);

      await dbltap(nodeById("group-2"));
      expect(cy.state.nodes.map(node => node.data("key"))).toEqual(["path:store"]);
      act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
      expect(cy.state.nodes.map(node => node.data("key"))).toEqual(["units:apps/web", "units:packages/core"]);
    });

    it("enters and leaves units from the E2E controls", async () => {
      const postMessage = await setup();
      send({ type: "architectureControls", unit: "packages/core" });
      await settle();
      expect(lastOf(postMessage, "architectureRendered")).toEqual(expect.objectContaining({ unit: "packages/core" }));
      send({ type: "architectureControls", unit: "" });
      await settle();
      expect(lastOf(postMessage, "architectureRendered")).toEqual(expect.objectContaining({ unit: undefined }));
    });

    const nested: ArchitectureSummaryMessage = { ...withUnits, units: { ...withUnits.units!, nestedGroups: [1] } };
    const { type: _type, stale: _stale, ...base } = nested;
    const uiLevel: ArchitectureFolderLevelMessage = {
      type: "architectureFolderLevel",
      revision: "r1",
      folder: "ui",
      level: {
        ...base,
        revision: "r2",
        groups: [
          { id: 1, key: "ui", label: "ui", fileCount: 2, internalEdgeCount: 0 },
          { id: 2, key: "ui/forms", label: "forms", fileCount: 3, internalEdgeCount: 1 },
        ],
        groupEdges: [{ from: 2, to: 1, fileEdgeCount: 2, fromLabel: "forms", toLabel: "ui" }],
        units: { ...nested.units!, groupUnits: { 1: "apps/web", 2: "apps/web" }, groupLayers: { 1: 0, 2: 1 }, groupEdgeKinds: { "2>1": "down" }, nestedGroups: [] },
      },
    };
    describe("folder levels", () => {
      const keys = () => cy.state.nodes.map(node => node.data("key"));
      const escape = async () => {
        act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
        await settle();
      };

      it("enters a folder holding sub-folders, asks the extension for its level, and draws its sub-folders", async () => {
        const postMessage = await setup(nested);
        await dbltap(nodeById("group-1"));
        expect(nodeById("group-1")?.data("folder")).toBe("ui");
        expect(nodeById("group-1")?.data("tooltip")).toContain("double-click to enter");

        await dbltap(nodeById("group-1"));
        expect(lastOf(postMessage, "architectureEnterFolder")).toEqual({ command: "architectureEnterFolder", revision: "r1", folder: "ui" });
        expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ command: "architectureExpandGroup" }));
        // A level for a folder not asked for, or another revision, is dropped.
        send({ ...uiLevel, folder: "store" });
        send({ ...uiLevel, revision: "old" });
        expect(keys()).toEqual(["path:ui"]);

        send(uiLevel);
        await settle();
        expect(keys()).toEqual(["path:ui@ui", "path:ui/forms@ui"]);
        expect(nodeById("group-2")?.data("color")).toBe(nodeById("group-1")?.data("color"));
        expect(nodeById("group-2")?.data("layer")).toBe(1);
        expect(edgeById("edge-2-1")?.data("kind")).toBe("down");
        expect(lastOf(postMessage, "architectureRendered")).toEqual(expect.objectContaining({ unit: "apps/web", folder: "ui" }));
        expect(screen.getByRole("navigation", { name: "Architecture path" }).textContent).toMatch(/^All units › @ws\/web › ui(?! ›)/);

        // Requests made in the folder name its level: its revision and the folder.
        await dbltap(nodeById("group-2"));
        expect(lastOf(postMessage, "architectureExpandGroup")).toEqual({ command: "architectureExpandGroup", revision: "r2", folder: "ui", groupId: 2, offset: 0 });
        act(() => cy.state.handlers.get("tap")?.({ target: edgeById("edge-2-1") }));
        expect(lastOf(postMessage, "architectureEvidence")).toEqual(expect.objectContaining({ revision: "r2", folder: "ui", from: 2, to: 1 }));
        send({ type: "architectureEvidencePage", revision: "r2", from: 2, to: 1, pairs: [{ source: "a.ts", target: "b.ts" }], page: { total: 1, offset: 0, returned: 1, truncated: false } });
        fireEvent.click(screen.getByRole("button", { name: "a.ts" }));
        expect(lastOf(postMessage, "architectureOpenFile")).toEqual({ command: "architectureOpenFile", revision: "r2", folder: "ui", relativePath: "a.ts" });
      });

      it("goes back up with Escape and the breadcrumb, to the viewport each level was left with", async () => {
        const postMessage = await setup(nested);
        await dbltap(nodeById("group-1"));
        cy.instance.zoom.mockReturnValue(2);
        cy.instance.pan.mockReturnValue({ x: 5, y: 6 });
        await dbltap(nodeById("group-1"));
        send(uiLevel);
        await settle();
        cy.instance.zoom.mockReturnValue(1);
        cy.instance.pan.mockReturnValue({ x: 0, y: 0 });

        await escape();
        expect(keys()).toEqual(["path:ui"]);
        expect(cy.instance.viewport).toHaveBeenLastCalledWith({ zoom: 2, pan: { x: 5, y: 6 } });

        // Entered again from the level already received: no new request.
        const asked = postMessage.mock.calls.filter(([message]) => message.command === "architectureEnterFolder").length;
        await dbltap(nodeById("group-1"));
        expect(keys()).toEqual(["path:ui@ui", "path:ui/forms@ui"]);
        expect(postMessage.mock.calls.filter(([message]) => message.command === "architectureEnterFolder")).toHaveLength(asked);

        fireEvent.click(screen.getByRole("button", { name: "@ws/web" }));
        await settle();
        expect(keys()).toEqual(["path:ui"]);
        await escape();
        expect(keys()).toEqual(["units:apps/web", "units:packages/core"]);
      });

      it("returns from two folders down to the middle one with its breadcrumb step and viewport", async () => {
        const deepUi: ArchitectureFolderLevelMessage = { ...uiLevel, level: { ...uiLevel.level, units: { ...uiLevel.level.units!, nestedGroups: [2] } } };
        const formsLevel: ArchitectureFolderLevelMessage = {
          ...uiLevel,
          folder: "ui/forms",
          level: {
            ...uiLevel.level,
            revision: "r3",
            groups: [{ id: 1, key: "ui/forms", label: "forms", fileCount: 3, internalEdgeCount: 1 }],
            groupEdges: [],
            units: { ...uiLevel.level.units!, groupUnits: { 1: "apps/web" }, groupLayers: { 1: 0 }, groupEdgeKinds: {}, nestedGroups: [] },
          },
        };
        const postMessage = await setup(nested);
        await dbltap(nodeById("group-1"));
        await dbltap(nodeById("group-1"));
        send(deepUi);
        await settle();
        cy.instance.zoom.mockReturnValue(3);
        cy.instance.pan.mockReturnValue({ x: 7, y: 8 });
        await dbltap(nodeById("group-2"));
        expect(lastOf(postMessage, "architectureEnterFolder")).toEqual({ command: "architectureEnterFolder", revision: "r1", folder: "ui/forms" });
        send(formsLevel);
        await settle();
        cy.instance.zoom.mockReturnValue(1);
        cy.instance.pan.mockReturnValue({ x: 0, y: 0 });
        expect(keys()).toEqual(["path:ui/forms@ui/forms"]);
        expect(screen.getByRole("navigation", { name: "Architecture path" }).textContent).toMatch(/^All units › @ws\/web › ui › forms/);

        const asked = postMessage.mock.calls.filter(([message]) => message.command === "architectureEnterFolder").length;
        fireEvent.click(screen.getByRole("button", { name: "ui" }));
        await settle();
        expect(keys()).toEqual(["path:ui@ui", "path:ui/forms@ui"]);
        expect(cy.instance.viewport).toHaveBeenLastCalledWith({ zoom: 3, pan: { x: 7, y: 8 } });
        expect(lastOf(postMessage, "architectureRendered")).toEqual(expect.objectContaining({ folder: "ui" }));
        expect(postMessage.mock.calls.filter(([message]) => message.command === "architectureEnterFolder")).toHaveLength(asked);
      });

      it("enters and leaves folders from the E2E controls, and forgets them on a new revision", async () => {
        const postMessage = await setup(nested);
        send({ type: "architectureControls", unit: "apps/web" });
        await settle();
        send({ type: "architectureControls", folder: "ui" });
        send(uiLevel);
        await settle();
        expect(lastOf(postMessage, "architectureRendered")).toEqual(expect.objectContaining({ folder: "ui" }));
        send({ type: "architectureControls", expand: "ui/forms" });
        expect(lastOf(postMessage, "architectureExpandGroup")).toEqual(expect.objectContaining({ folder: "ui", groupId: 2 }));
        send({ type: "architectureControls", folder: "" });
        await settle();
        expect(lastOf(postMessage, "architectureRendered")).toEqual(expect.objectContaining({ unit: "apps/web", folder: undefined }));

        send({ ...nested, revision: "r3", context: { ...nested.context, revision: "r3" } });
        await settle();
        expect(keys()).toEqual(["units:apps/web", "units:packages/core"]);
        send({ type: "architectureControls", unit: "apps/web" });
        await settle();
        send({ type: "architectureControls", folder: "ui" });
        expect(lastOf(postMessage, "architectureEnterFolder")).toEqual(expect.objectContaining({ revision: "r3", folder: "ui" }));
      });
    });

    describe("matrix", () => {
      const units = unitMatrix(withUnits.units!);
      const unitsMatrix: ArchitectureMatrixMessage = { type: "architectureMatrix", revision: "r1", matrix: units, digest: matrixDigest(units), nestedGroups: [] };
      const webMatrix: ArchitectureMatrixMessage = {
        type: "architectureMatrix", revision: "r1", unit: "apps/web", nestedGroups: [1], digest: "",
        matrix: groupMatrix({ ...withUnits, groups: [...withUnits.groups, { id: 3, key: "apps/web/lib", label: "lib", fileCount: 1, internalEdgeCount: 0 }], groupEdges: [{ from: 1, to: 3, fileEdgeCount: 2 }] }, (id) => id !== 2),
      };
      const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      const toMatrix = async (postMessage: ReturnType<typeof vi.fn>, message = unitsMatrix) => {
        fireEvent.click(screen.getByRole("button", { name: "Matrix" }));
        send(message);
        await nextFrame();
        return postMessage;
      };
      const escape = async () => {
        act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
        await settle();
      };
      const asked = (postMessage: ReturnType<typeof vi.fn>) => postMessage.mock.calls.filter(([message]) => message.command === "architectureMatrix").length;

      it("asks for the drawn level's matrix once, shows it, reports it, and keeps it across toggles", async () => {
        const postMessage = await setup();
        fireEvent.click(screen.getByRole("button", { name: "Matrix" }));
        expect(lastOf(postMessage, "architectureMatrix")).toEqual({ command: "architectureMatrix", revision: "r1", folder: undefined, unit: undefined });
        expect(screen.getByText("Building the matrix…")).toBeTruthy();
        expect(screen.queryByRole("textbox", { name: "Find group" })).toBeNull();
        send(unitsMatrix);
        await nextFrame();

        expect(screen.getByRole("region", { name: /Dependency structure matrix: 2 rows, 3 non-empty cells/ })).toBeTruthy();
        expect(screen.getByRole("button", { name: "@ws/web: Ca 1, Ce 3, I 0.75, enter" })).toBeTruthy();
        expect(lastOf(postMessage, "architectureMatrixRendered")).toEqual(expect.objectContaining({
          revision: "r1", rows: 2, cells: 3, fileEdges: 5, upwardCells: 1, cycles: 1, cause: "matrix",
          digest: "apps/web>apps/web=1;apps/web>packages/core=3;packages/core>apps/web=1",
        }));
        expect(screen.getByTestId("architecture-graph").parentElement!.style.visibility).toBe("hidden");

        fireEvent.click(screen.getByRole("button", { name: "Graph" }));
        expect(screen.getByTestId("architecture-graph").parentElement!.style.visibility).toBe("");
        fireEvent.click(screen.getByRole("button", { name: "Matrix" }));
        expect(asked(postMessage)).toBe(1);
        expect(screen.getByRole("region", { name: /Dependency structure matrix/ })).toBeTruthy();
      });

      it("reports the cells breaking a declared rule from the whole matrix, not only those in view", async () => {
        const postMessage = await setup();
        fireEvent.click(screen.getByRole("button", { name: "Matrix" }));
        send({ ...unitsMatrix, violations: { "apps/web>packages/core": ["r"], "packages/core>apps/web": ["r"], "x>y": ["r"] } });
        await nextFrame();

        expect(lastOf(postMessage, "architectureMatrixRendered")).toEqual(expect.objectContaining({ violationCells: 2 }));
        expect(screen.getByText(/red frame: breaks a rule/)).toBeTruthy();
      });

      it("opens the evidence of a clicked cell with its total, but not for a unit's own pairs", async () => {
        const postMessage = await toMatrix(await setup());
        fireEvent.click(screen.getByRole("button", { name: "@ws/web imports @ws/core: 3 file pairs" }));
        expect(lastOf(postMessage, "architectureUnitEvidence")).toEqual({ command: "architectureUnitEvidence", revision: "r1", from: "apps/web", to: "packages/core", offset: 0 });
        expect(screen.getByRole("region", { name: "Evidence" }).textContent).toContain("@ws/web → @ws/core: 3 file pairs (static imports) (cycle)");
        // The matrix is its own stacking context, so its sticky headers stay below the evidence drawn after it.
        const matrixRoot = screen.getByRole("region", { name: /Dependency structure matrix/ }).parentElement!;
        expect(matrixRoot.style.zIndex).toBe("0");
        expect(matrixRoot.compareDocumentPosition(screen.getByRole("region", { name: "Evidence" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(screen.getByRole("navigation", { name: "Architecture path" }).title).toMatch(/^Cell: evidence · Header: enter/);

        fireEvent.click(screen.getByRole("button", { name: "Close evidence" }));
        const evidence = postMessage.mock.calls.length;
        fireEvent.click(screen.getByRole("button", { name: "@ws/web: 1 file pair inside" }));
        expect(postMessage.mock.calls.slice(evidence).some(([message]) => message.command === "architectureUnitEvidence")).toBe(false);
        expect(screen.queryByRole("region", { name: "Evidence" })).toBeNull();
      });

      it("enters a unit from its header, asks for its groups by group id, and Escape goes back to the units", async () => {
        const postMessage = await toMatrix(await setup());
        fireEvent.click(screen.getByRole("button", { name: "@ws/web: Ca 1, Ce 3, I 0.75, enter" }));
        await settle();
        expect(lastOf(postMessage, "architectureMatrix")).toEqual({ command: "architectureMatrix", revision: "r1", folder: undefined, unit: "apps/web" });
        send(webMatrix);
        await nextFrame();
        fireEvent.click(screen.getByRole("button", { name: "ui imports lib: 2 file pairs" }));
        expect(lastOf(postMessage, "architectureEvidence")).toEqual(expect.objectContaining({ revision: "r1", from: 1, to: 3 }));

        await escape();
        expect(screen.queryByRole("region", { name: "Evidence" })).toBeNull();
        await escape();
        expect(screen.getByRole("button", { name: "@ws/web: Ca 1, Ce 3, I 0.75, enter" })).toBeTruthy();
        expect(asked(postMessage)).toBe(2);
      });

      it("enters a folder holding sub-folders from its header, and selects a row the graph focuses", async () => {
        const postMessage = await setup(nested);
        send({ type: "architectureControls", unit: "apps/web" });
        await settle();
        await toMatrix(postMessage, webMatrix);
        fireEvent.click(screen.getByRole("button", { name: "lib: Ca 2, Ce 0, I 0" }));
        expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ command: "architectureEnterFolder" }));
        fireEvent.click(screen.getByRole("button", { name: "ui: Ca 0, Ce 2, I 1, enter" }));
        expect(lastOf(postMessage, "architectureEnterFolder")).toEqual({ command: "architectureEnterFolder", revision: "r1", folder: "ui" });
        send(uiLevel);
        await settle();
        expect(lastOf(postMessage, "architectureMatrix")).toEqual({ command: "architectureMatrix", revision: "r2", folder: "ui", unit: "apps/web" });
      });

      it("follows the E2E controls: toggle, cell and header by row key", async () => {
        const postMessage = await setup();
        send({ type: "architectureControls", view: "matrix" });
        send(unitsMatrix);
        await nextFrame();
        send({ type: "architectureControls", matrixCell: { row: "packages/core", column: "apps/web" } });
        expect(lastOf(postMessage, "architectureUnitEvidence")).toEqual(expect.objectContaining({ from: "packages/core", to: "apps/web" }));
        send({ type: "architectureControls", matrixCell: { row: "nowhere", column: "apps/web" }, matrixHeader: "packages/core" });
        await settle();
        expect(lastOf(postMessage, "architectureMatrix")).toEqual(expect.objectContaining({ unit: "packages/core" }));
        send({ type: "architectureControls", view: "graph" });
        expect(screen.getByTestId("architecture-graph").parentElement!.style.visibility).toBe("");
        // The driver's cell was clicked once: showing the matrix again does not click it again.
        const clicks = postMessage.mock.calls.filter(([message]) => message.command === "architectureUnitEvidence").length;
        send({ type: "architectureControls", view: "matrix", unit: "" });
        await nextFrame();
        expect(postMessage.mock.calls.filter(([message]) => message.command === "architectureUnitEvidence")).toHaveLength(clicks);
        expect(screen.queryByRole("region", { name: "Evidence" })).toBeNull();
      });

      it("forgets the matrices of an old revision, and drops a matrix for another level", async () => {
        const postMessage = await toMatrix(await setup());
        send({ ...unitsMatrix, unit: "apps/web" });
        expect(screen.getByRole("region", { name: /2 rows/ })).toBeTruthy();
        send({ ...unitsMatrix, revision: "old" });
        send({ ...withUnits, revision: "r3", context: { ...withUnits.context, revision: "r3" } });
        await settle();
        expect(lastOf(postMessage, "architectureMatrix")).toEqual(expect.objectContaining({ revision: "r3" }));
        expect(screen.getByText("Building the matrix…")).toBeTruthy();
      });
    });
  });
});

describe("shortPath", () => {
  it("cuts a path at its unit, or at a folder key whose umbrella dirs are skipped", () => {
    expect(shortPath("packages/ui/src/index.ts", "packages/ui")).toBe("src/index.ts");
    expect(shortPath("packages/ui/src/forms/a.ts", "packages/ui", "packages/ui/forms")).toBe("a.ts");
    expect(shortPath("graphql-project/queries/q.ts", "(root)", "(root)/graphql-project")).toBe("queries/q.ts");
    expect(shortPath("a/src/a/x.ts", "(root)", "(root)/a")).toBe("x.ts");
    expect(shortPath("packages/ui/src/x.ts", "packages/ui", "packages/ui")).toBe("src/x.ts");
  });

  it("keeps the whole path outside the unit or folder", () => {
    expect(shortPath("graphql-project/q.ts", "(root)")).toBe("graphql-project/q.ts");
    expect(shortPath("packages/core/x.ts", "packages/ui")).toBe("packages/core/x.ts");
    expect(shortPath("packages/ui/src/x.ts", "packages/ui", "packages/ui/forms")).toBe("packages/ui/src/x.ts");
  });
});

describe("ArchitectureGraph: declared architecture rules", () => {
  afterEach(cleanup);

  const rule = {
    name: "ui-not-store", kind: "forbid" as const, severity: "error" as const, reason: "UI reads through the API.",
    violations: 3, newViolations: 1, elementPairs: [{ from: "ui", to: "store", count: 3 }],
  };
  const withRules: ArchitectureSummaryMessage = {
    ...summary,
    rules: {
      configFile: "graphit.architecture.json",
      revision: "c1",
      totals: { files: 10, unmatchedFiles: 2, rules: 2, brokenRules: 1, violations: 3, newViolations: 1, errors: 3, newErrors: 1, warnings: 0, resolved: 0 },
      rules: [rule, { ...rule, name: "quiet", violations: 0, newViolations: 0, elementPairs: [] }],
      configWarnings: ['$.elements.ghost.path: "nowhere/" matches no file'],
      unitEdges: {},
      groupEdges: { "1>2": ["ui-not-store"] },
    },
  };

  it("states the violations, draws violating edges red with their rules, and lists a rule's pairs on click", () => {
    const postMessage = vi.fn();
    render(<ArchitectureGraph postMessage={postMessage} />);
    send(withRules);

    expect(screen.getByText(/3 violations of 1 rule \(1 new\)/)).toBeTruthy();
    expect(screen.getByText(/2 files in no element/)).toBeTruthy();
    expect(screen.getByText(/matches no file/)).toBeTruthy();
    const edge = cy.state.edges.find((candidate) => candidate.id() === "edge-1-2")!;
    expect(edge.data("violation")).toBe(true);
    expect(edge.data("tooltip")).toContain("Breaks: ui-not-store");
    expect(lastOf(postMessage, "architectureRendered")).toEqual(expect.objectContaining({
      violationEdges: 1, rules: ["ui-not-store=3", "quiet=0"],
    }));
    expect((screen.getByRole("button", { name: "quiet" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "ui-not-store" }));
    expect(postMessage).toHaveBeenCalledWith({ command: "architectureRuleEvidence", revision: "r1", rule: "ui-not-store", offset: 0 });
    // An edge's page does not fill a rule's panel.
    send({ type: "architectureEvidencePage", revision: "r1", from: 1, to: 2, pairs: [{ source: "x.ts", target: "y.ts" }], page: { total: 1, offset: 0, returned: 1, truncated: false } });
    send({
      type: "architectureEvidencePage", revision: "r1", rule: "ui-not-store", from: "", to: "",
      pairs: [{ source: "ui/a.ts", target: "store/b.ts" }], page: { total: 3, offset: 0, returned: 1, truncated: true, nextOffset: 1 },
    });
    expect(screen.getByText(/Rule "ui-not-store" \(error\): 3 violating file pairs: UI reads through the API\./)).toBeTruthy();
    expect(evidenceRows()).toEqual(["store/b.ts", "← ui/a.ts"]);
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(postMessage).toHaveBeenLastCalledWith({ command: "architectureRuleEvidence", revision: "r1", rule: "ui-not-store", offset: 1 });
  });

  it("clicks a rule from the E2E controls, and starts over when a rebuild changes the rules", () => {
    const postMessage = vi.fn();
    render(<ArchitectureGraph postMessage={postMessage} />);
    send(withRules);
    send({ type: "architectureControls", rule: "ui-not-store" });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: "architectureRuleEvidence", rule: "ui-not-store" }));

    // A stale mark of the same check keeps the panel; a check with another revision starts over.
    send({ ...withRules, stale: true });
    expect(screen.getByRole("region", { name: "Evidence" })).toBeTruthy();
    send({ ...withRules, rules: { ...withRules.rules!, revision: "c2", groupEdges: {} } });
    expect(screen.queryByRole("region", { name: "Evidence" })).toBeNull();
    expect(cy.state.edges.find((candidate) => candidate.id() === "edge-1-2")!.data("violation")).toBeUndefined();
  });

  it("says why a refused config was not checked", () => {
    render(<ArchitectureGraph postMessage={vi.fn()} />);
    send({ ...summary, rules: { configFile: "graphit.architecture.json", error: "graphit.architecture.json: $.rules[0].from: unknown element \"x\"", rules: [], configWarnings: [], unitEdges: {}, groupEdges: {} } });
    expect(screen.getByText(/Architecture rules not checked: .*unknown element "x"/)).toBeTruthy();
  });
});
