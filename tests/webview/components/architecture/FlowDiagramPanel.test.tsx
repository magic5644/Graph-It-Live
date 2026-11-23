// @vitest-environment happy-dom

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FlowDiagramMessage, FlowDiagramNode, FlowDiagramStateMessage } from "@/shared/architecture-types";
import {
  flowDataUrl,
  FlowDiagramPanel,
  flowEntryKey,
  type FlowState,
  type FlowZoomMemory,
  nextFlowNode,
  NO_FLOW,
  pressFlowKeys,
  receiveFlow,
  drawsAtCursor,
} from "@/webview/components/architecture/FlowDiagramPanel";

const node = (id: string, lane: FlowDiagramNode["lane"], x: number, y: number): FlowDiagramNode => ({
  id, title: id, file: "src/a.ts", line: 1, lane, name: `Step ${id}, ${lane} lane`, x, y, width: 100, height: 40,
});
const edge = (from: string, to: string) => ({
  from, to, file: "src/a.ts", line: 2, relation: "CALLS" as const, lane: "main" as const,
  name: `Call ${from} → ${to}`, label: { x: 150, y: 20, text: `${to}()` },
});
// main row: a b c; error row below: e (under b), alternative row in between: x (under c).
const flow: FlowDiagramMessage = {
  type: "flowDiagram", requestId: 4, svg: '<svg><text>a → b é</text></svg>', width: 400, height: 300,
  title: "a", caption: "Call flow", counts: "5 steps", crumbs: [], entry: "a", stale: false,
  nodes: [node("a", "main", 0, 0), node("b", "main", 150, 0), node("c", "main", 300, 0), node("x", "alternative", 290, 100), node("e", "error", 140, 200)],
  edges: [edge("a", "a"), edge("a", "b"), edge("a", "c"), edge("b", "e"), edge("c", "x")],
};
const state = (status?: Partial<FlowDiagramStateMessage>, drawn: FlowDiagramMessage | null = flow): FlowState => ({
  flow: drawn,
  status: status ? { type: "flowDiagramState", requestId: drawn?.requestId ?? 1, status: "loading", ...status } : null,
});

describe("drawsAtCursor", () => {
  it("only without a known entry: nothing asked for, or a refusal before a symbol", () => {
    expect(drawsAtCursor(NO_FLOW)).toBe(true);
    expect(drawsAtCursor(state({ status: "error", message: "No active editor." }, null))).toBe(true);
    // A draw that failed knows its entry (crumbs): a tab click draws it again.
    expect(drawsAtCursor(state({ status: "error", message: "x", crumbs: [] }, null))).toBe(false);
    for (const status of ["loading", "empty", "stale"] as const) expect(drawsAtCursor(state({ status }, null))).toBe(false);
    expect(drawsAtCursor(state())).toBe(false);
    expect(drawsAtCursor(state({ status: "error", message: "x" }))).toBe(false);
  });
});

describe("receiveFlow", () => {
  it("only the answer to a loading request selects the Flow tab; a flow replayed on mount or a new entry without loading waits", () => {
    expect(receiveFlow(state({ requestId: 5 }), { ...flow, requestId: 5 }).selects).toBe(true);
    expect(receiveFlow(state({ requestId: 5 }), { ...flow, requestId: 5, entry: "b" }).selects).toBe(true);
    expect(receiveFlow(NO_FLOW, flow)).toEqual({ next: { flow, status: null }, selects: false });
    expect(receiveFlow(state(), { ...flow, requestId: 5, entry: "b" }).selects).toBe(false);
  });

  it("a re-render of the drawn entry (theme) keeps the tab; an older message is dropped", () => {
    expect(receiveFlow(state(), { ...flow, requestId: 5 }).selects).toBe(false);
    const current = state();
    expect(receiveFlow(current, { ...flow, requestId: 3 })).toEqual({ next: current, selects: false });
    expect(receiveFlow(current, { type: "flowDiagramState", requestId: 3, status: "error", message: "late" }).next).toBe(current);
  });

  it("loading selects the tab; empty or error select it when they answer a loading, not when replayed; stale never", () => {
    const loading: FlowDiagramStateMessage = { type: "flowDiagramState", requestId: 5, status: "loading" };
    expect(receiveFlow(state(), loading)).toEqual({ next: { flow, status: loading }, selects: true });
    for (const status of ["empty", "error"] as const) {
      const message: FlowDiagramStateMessage = { type: "flowDiagramState", requestId: 5, status };
      expect(receiveFlow(state({ requestId: 5 }), message)).toEqual({ next: { flow, status: message }, selects: true });
      expect(receiveFlow(state(), message).selects).toBe(false);
    }
    expect(receiveFlow(state({ requestId: 4 }), { type: "flowDiagramState", requestId: 4, status: "stale" }).selects).toBe(false);
  });

  // #823: a Flow refusal after a sequence showed on the Seq tab, over that sequence.
  it("an empty or error state of the other view drops the drawn diagram; of the same view, keeps it", () => {
    const sequence: FlowDiagramMessage = { ...flow, view: "sequence" };
    const current: FlowState = { flow: sequence, status: null };
    for (const status of ["empty", "error"] as const) {
      const other: FlowDiagramStateMessage = { type: "flowDiagramState", view: "flow", requestId: 5, status };
      expect(receiveFlow(current, other).next).toEqual({ flow: null, status: other });
      const same: FlowDiagramStateMessage = { ...other, view: "sequence" };
      expect(receiveFlow(current, same).next).toEqual({ flow: sequence, status: same });
    }
    const stale: FlowDiagramStateMessage = { type: "flowDiagramState", view: "flow", requestId: 5, status: "stale" };
    expect(receiveFlow(current, stale).next.flow).toBe(sequence);
  });

  it("cancelled drops the loading status, keeps the drawn flow (or none) and never selects", () => {
    const cancelled: FlowDiagramStateMessage = { type: "flowDiagramState", requestId: 6, status: "cancelled" };
    expect(receiveFlow(state({ requestId: 5 }), cancelled)).toEqual({ next: { flow, status: null }, selects: false });
    expect(receiveFlow(state({ requestId: 5 }, null), cancelled)).toEqual({ next: NO_FLOW, selects: false });
  });
});

describe("nextFlowNode", () => {
  it("ArrowRight follows the first outgoing call (a self-call skipped), ArrowLeft the first incoming one", () => {
    expect(nextFlowNode(flow, 0, "ArrowRight")).toBe(1);
    expect(nextFlowNode(flow, 1, "ArrowLeft")).toBe(0);
    expect(nextFlowNode(flow, 4, "ArrowLeft")).toBe(1);
  });

  it("ArrowDown and ArrowUp go to the nearest node of the next lane row", () => {
    expect(nextFlowNode(flow, 2, "ArrowDown")).toBe(3);
    expect(nextFlowNode(flow, 3, "ArrowDown")).toBe(4);
    expect(nextFlowNode(flow, 4, "ArrowUp")).toBe(3);
    expect(nextFlowNode(flow, 3, "ArrowUp")).toBe(2);
  });

  it("stays put with no call, no row, an unknown index or another key", () => {
    expect(nextFlowNode(flow, 4, "ArrowRight")).toBeUndefined();
    expect(nextFlowNode(flow, 0, "ArrowLeft")).toBeUndefined();
    expect(nextFlowNode(flow, 0, "ArrowUp")).toBeUndefined();
    expect(nextFlowNode(flow, 4, "ArrowDown")).toBeUndefined();
    expect(nextFlowNode(flow, 9, "ArrowRight")).toBeUndefined();
    expect(nextFlowNode(flow, 0, "Home")).toBeUndefined();
    // One lane: up and down have nowhere to go.
    const single = { nodes: [node("a", "main", 0, 0), node("b", "main", 150, 0)], edges: [edge("a", "missing")] };
    expect(nextFlowNode(single, 0, "ArrowDown")).toBeUndefined();
    expect(nextFlowNode(single, 0, "ArrowRight")).toBeUndefined();
  });
});

describe("flowDataUrl", () => {
  it("keeps non-Latin text (no base64 of UTF-16) and escapes the markup", () => {
    const url = flowDataUrl(flow.svg);
    expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.slice(url.indexOf(",") + 1))).toBe(flow.svg);
    expect(url).not.toContain("<");
  });
});

describe("FlowDiagramPanel", () => {
  afterEach(cleanup);
  const renderPanel = (current: FlowState) => {
    const props = { onOpen: vi.fn(), onRefresh: vi.fn(), onShowCallGraph: vi.fn(), onDrawCandidate: vi.fn(), onDrawAtCursor: vi.fn(), onEscape: vi.fn() };
    const view = render(<FlowDiagramPanel state={current} {...props} />);
    return { ...props, view };
  };

  it("draws the SVG as an image with its summary, never as markup, and one named button per step and call", () => {
    const { onOpen, view } = renderPanel(state());
    const image = screen.getByRole("img", { name: "a. Call flow. 5 steps." }) as HTMLImageElement;
    expect(image.src).toBe(flowDataUrl(flow.svg));
    expect(view.container.querySelector("svg")).toBeNull();
    const steps = screen.getByRole("group", { name: "Flow steps" }).querySelectorAll("button");
    expect(Array.from(steps, (button) => button.getAttribute("aria-label"))).toEqual(flow.nodes.map((entry) => entry.name));
    const calls = screen.getByRole("group", { name: "Flow calls" }).querySelectorAll("button");
    expect(Array.from(calls, (button) => button.getAttribute("aria-label"))).toEqual(flow.edges.map((entry) => entry.name));
    fireEvent.click(steps[2]);
    fireEvent.click(calls[1]);
    expect(onOpen.mock.calls).toEqual([["node", 2], ["edge", 1]]);
  });

  it("places the buttons on the boxes at the fitted scale, fitted again on a resize", () => {
    const observers: (() => void)[] = [];
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { observers.push(callback); } observe() {} disconnect() {} });
    // The panel keeps 8 px around a fitted diagram: 216 px wide fits the 400 px diagram at 50%.
    let width = 216;
    const spy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
    const heightSpy = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => 1000);
    renderPanel(state());
    const step = screen.getByRole("button", { name: flow.nodes[1].name });
    expect([step.style.left, step.style.width]).toEqual(["75px", "50px"]);
    width = 416;
    act(() => observers.forEach((callback) => callback()));
    expect([step.style.left, step.style.width]).toEqual(["150px", "100px"]);
    const call = screen.getByRole("button", { name: flow.edges[1].name });
    // "b()" is 3 characters: 3 × 6 / 2 + 4 = 13 units each side of the anchor.
    expect([call.style.left, call.style.width, call.style.top]).toEqual(["137px", "26px", "12px"]);
    spy.mockRestore();
    heightSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("moves with the arrow keys, Escape goes back to the tabs", () => {
    const { onEscape } = renderPanel(state());
    const first = screen.getByRole("button", { name: flow.nodes[0].name });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe(flow.nodes[1].name);
    // The next lane row holds x only: the nearest by x.
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe(flow.nodes[3].name);
    // No call leaves x: the focus stays.
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe(flow.nodes[3].name);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.keyDown(screen.getByRole("button", { name: flow.edges[0].name }), { key: "Escape" });
    fireEvent.keyDown(screen.getByRole("button", { name: flow.edges[0].name }), { key: "ArrowRight" });
    expect(onEscape).toHaveBeenCalledTimes(2);
  });

  it("states: nothing drawn yet, loading over the previous image, empty with Show call graph, error, stale with Refresh", () => {
    // #825: every entry point is named, and the button draws the symbol at the cursor.
    const empty = renderPanel(NO_FLOW);
    expect(empty.view.container.querySelector("[data-flow-line]")?.textContent).toBe(
      "Put the cursor in a function of the editor, then click this tab or Draw symbol at cursor; or right-click the function and run Show Flow Diagram (Symbol at Cursor), or Show Diagram… for its sequence. Draw symbol at cursor",
    );
    fireEvent.click(screen.getByRole("button", { name: "Draw symbol at cursor" }));
    expect(empty.onDrawAtCursor).toHaveBeenCalledTimes(1);
    empty.view.unmount();

    // A refusal before any symbol (no crumbs): its message, then the button to try again.
    const refused = renderPanel(state({ status: "error", message: "No active editor." }, null));
    expect(screen.getByRole("alert").textContent).toBe("No active editor. Draw symbol at cursor");
    fireEvent.click(screen.getByRole("button", { name: "Draw symbol at cursor" }));
    expect(refused.onDrawAtCursor).toHaveBeenCalledTimes(1);
    refused.view.unmount();

    const loading = renderPanel(state({ status: "loading" }));
    expect(screen.getByText("Drawing the flow diagram…")).toBeTruthy();
    expect(screen.getByRole("img", { name: /^a\. / })).toBeTruthy();
    loading.view.unmount();

    const none = renderPanel(state({ status: "empty", message: "a" }));
    expect(screen.getByText(/No calls found from `a`\./)).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show call graph" }));
    expect(none.onShowCallGraph).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByText(/No symbol of this file makes a call\./)).toBeTruthy();
    none.view.unmount();

    // A class calls nothing: the file's symbols that make calls are offered, each drawn by its index.
    const offered = renderPanel(state({ status: "empty", message: "Cart", candidates: [{ name: "save", line: 4, calls: 2 }, { name: "load", line: 9, calls: 1 }] }));
    expect(screen.getByText(/Symbols of this file that make calls:/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "load" }).title).toBe("Line 9, 1 call");
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    expect(offered.onDrawCandidate).toHaveBeenCalledWith(0);
    offered.view.unmount();

    const failed = renderPanel(state({ status: "error", message: "Graph-It-Live: x" }));
    expect(screen.getByRole("alert").textContent).toBe("Graph-It-Live: x");
    expect(screen.queryByRole("button", { name: "Draw symbol at cursor" })).toBeNull();
    expect(screen.getByRole("img")).toBeTruthy();
    failed.view.unmount();

    const stale = renderPanel(state(undefined, { ...flow, stale: true }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(stale.onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Stale: files changed since this flow was drawn/)).toBeTruthy();
  });
});

describe("pressFlowKeys", () => {
  afterEach(cleanup);

  it("Tab enters the first step then the next button, Enter clicks, arrows go to the focused button", () => {
    const onOpen = vi.fn();
    const { container } = render(<FlowDiagramPanel state={state()} onOpen={onOpen} onRefresh={vi.fn()} onShowCallGraph={vi.fn()} onDrawCandidate={vi.fn()} onEscape={vi.fn()} />);
    pressFlowKeys(container, ["Tab"]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe(flow.nodes[0].name);
    pressFlowKeys(container, ["Tab", "ArrowLeft", "Enter"]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe(flow.nodes[0].name);
    expect(onOpen).toHaveBeenCalledWith("node", 0);
    pressFlowKeys(container, [" "]);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("does nothing without a panel or with the focus outside it", () => {
    expect(() => pressFlowKeys(null, ["Tab"])).not.toThrow();
    const onOpen = vi.fn();
    const { container } = render(<FlowDiagramPanel state={state()} onOpen={onOpen} onRefresh={vi.fn()} onShowCallGraph={vi.fn()} onDrawCandidate={vi.fn()} onEscape={vi.fn()} />);
    (document.activeElement as HTMLElement | null)?.blur();
    pressFlowKeys(container, ["Enter", "ArrowRight"]);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("FlowDiagramPanel zoom and pan (#826)", () => {
  // A 216 × 1000 px panel fits the 400 × 300 diagram at 50%, 8 px from the left and the top.
  let restore: (() => void)[] = [];
  const mockPanel = () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(216);
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(1000);
    const capture = vi.fn();
    const original = HTMLElement.prototype.setPointerCapture;
    HTMLElement.prototype.setPointerCapture = capture;
    restore = [() => width.mockRestore(), () => height.mockRestore(), () => { HTMLElement.prototype.setPointerCapture = original; }];
    return capture;
  };
  afterEach(() => {
    cleanup();
    restore.forEach((undo) => undo());
  });
  const props = () => ({ onOpen: vi.fn(), onRefresh: vi.fn(), onShowCallGraph: vi.fn(), onDrawCandidate: vi.fn(), onDrawAtCursor: vi.fn(), onEscape: vi.fn(), onZoomed: vi.fn() });
  const figure = () => document.querySelector<HTMLElement>("figure[data-flow-zoom]")!;
  const zoomOf = () => Number(figure().dataset.flowZoom);
  const viewport = () => document.querySelector<HTMLElement>("[data-flow-viewport]")!;
  const stepB = () => screen.getByRole("button", { name: flow.nodes[1].name });
  const click = (action: string) => fireEvent.click(document.querySelector(`[aria-label="Zoom controls"] button[data-zoom="${action}"]`)!);

  it("opens fitted; + and − zoom around the centre, 100% shows the drawn size, Fit fits again; the buttons follow", () => {
    mockPanel();
    render(<FlowDiagramPanel state={state()} {...props()} />);
    expect([zoomOf(), figure().style.left, figure().style.top, stepB().style.left]).toEqual([0.5, "8px", "8px", "75px"]);
    expect(screen.getByRole("img").style.width).toBe("200px");
    click("in");
    expect([zoomOf(), stepB().style.left, stepB().style.width]).toEqual([0.625, "93.75px", "62.5px"]);
    click("out");
    expect(zoomOf()).toBe(0.5);
    click("reset");
    expect([zoomOf(), stepB().style.left, screen.getByRole("img").style.width]).toEqual([1, "150px", "400px"]);
    click("fit");
    expect([zoomOf(), figure().style.left]).toEqual([0.5, "8px"]);
    expect(screen.getByRole("button", { name: "Actual size (100%)" })).toBeTruthy();
  });

  it("0, + and - zoom from a focused step; with Ctrl, Alt or Meta, or another key, nothing changes", () => {
    mockPanel();
    render(<FlowDiagramPanel state={state()} {...props()} />);
    stepB().focus();
    fireEvent.keyDown(stepB(), { key: "+" });
    expect(zoomOf()).toBe(0.625);
    fireEvent.keyDown(stepB(), { key: "=" });
    fireEvent.keyDown(stepB(), { key: "-" });
    expect(zoomOf()).toBe(0.625);
    for (const modifier of ["ctrlKey", "altKey", "metaKey"]) fireEvent.keyDown(stepB(), { key: "+", [modifier]: true });
    fireEvent.keyDown(stepB(), { key: "a" });
    expect(zoomOf()).toBe(0.625);
    expect(fireEvent.keyDown(stepB(), { key: "0" })).toBe(false);
    expect(zoomOf()).toBe(0.5);
  });

  it("the wheel zooms around the pointer and never scrolls the page", () => {
    mockPanel();
    render(<FlowDiagramPanel state={state()} {...props()} />);
    // The pointer on the diagram's top-left corner (8, 8): the corner stays under it.
    expect(fireEvent.wheel(viewport(), { deltaY: -500, clientX: 8, clientY: 8 })).toBe(false);
    expect([zoomOf(), figure().style.left, figure().style.top]).toEqual([1.359, "8px", "8px"]);
    fireEvent.wheel(viewport(), { deltaY: 100_000, clientX: 8, clientY: 8 });
    expect(zoomOf()).toBe(0.1);
  });

  it("a drag pans, from a step too, without opening it; a press without a move still opens it", () => {
    const capture = mockPanel();
    const handlers = props();
    render(<FlowDiagramPanel state={state()} {...handlers} />);
    fireEvent.pointerDown(stepB(), { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(stepB(), { pointerId: 1, clientX: 101, clientY: 101 });
    fireEvent.pointerUp(stepB(), { pointerId: 1 });
    fireEvent.click(stepB());
    expect(handlers.onOpen).toHaveBeenCalledWith("node", 1);
    expect([figure().style.left, capture.mock.calls.length]).toEqual(["8px", 0]);
    fireEvent.pointerDown(stepB(), { pointerId: 2, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(viewport(), { pointerId: 3, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(viewport(), { pointerId: 2, clientX: 130, clientY: 120 });
    fireEvent.pointerMove(viewport(), { pointerId: 2, clientX: 140, clientY: 120 });
    expect([figure().style.left, figure().style.top, zoomOf()]).toEqual(["48px", "28px", 0.5]);
    expect(capture).toHaveBeenCalledOnce();
    fireEvent.pointerCancel(viewport(), { pointerId: 2 });
    fireEvent.pointerMove(viewport(), { pointerId: 2, clientX: 300, clientY: 300 });
    // A right-button press does not pan.
    fireEvent.pointerDown(viewport(), { pointerId: 4, button: 2, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(viewport(), { pointerId: 4, clientX: 50, clientY: 50 });
    expect(figure().style.left).toBe("48px");
  });

  it("a redraw of the same entry keeps the zoom and position; another entry or tab opens fitted", () => {
    mockPanel();
    const handlers = props();
    const view = render(<FlowDiagramPanel state={state()} {...handlers} />);
    click("in");
    fireEvent.pointerDown(viewport(), { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(viewport(), { pointerId: 1, clientX: 10, clientY: 0 });
    const kept = [zoomOf(), figure().style.left];
    view.rerender(<FlowDiagramPanel state={state(undefined, { ...flow, requestId: 5 })} {...handlers} />);
    expect([zoomOf(), figure().style.left]).toEqual(kept);
    view.rerender(<FlowDiagramPanel state={state(undefined, { ...flow, requestId: 6, view: "sequence" })} {...handlers} />);
    expect([zoomOf(), figure().style.left]).toEqual([0.5, "8px"]);
    // Not zoomed since: a redraw of the same entry at another size fits it again.
    view.rerender(<FlowDiagramPanel state={state(undefined, { ...flow, requestId: 7, view: "sequence", width: 800 })} {...handlers} />);
    expect(zoomOf()).toBe(0.25);
    view.rerender(<FlowDiagramPanel state={state(undefined, { ...flow, requestId: 8, entry: "b" })} {...handlers} />);
    expect(zoomOf()).toBe(0.5);
    expect(handlers.onZoomed).toHaveBeenCalled();
  });

  it("the zoom memory reopens the same entry where the user left it after a tab switch, never another entry", () => {
    mockPanel();
    const memory: { current: FlowZoomMemory | null } = { current: null };
    const first = render(<FlowDiagramPanel state={state()} {...props()} zoomMemory={memory} />);
    click("reset");
    expect(memory.current).toEqual({ key: flowEntryKey(flow), view: { zoom: 1, x: expect.any(Number), y: expect.any(Number) } });
    first.unmount();
    const again = render(<FlowDiagramPanel state={state()} {...props()} zoomMemory={memory} />);
    expect(zoomOf()).toBe(1);
    again.unmount();
    render(<FlowDiagramPanel state={state(undefined, { ...flow, entry: "b" })} {...props()} zoomMemory={memory} />);
    expect(zoomOf()).toBe(0.5);
  });

  it("an empty answer draws no viewport; the diagram that follows opens fitted", () => {
    mockPanel();
    const handlers = props();
    const view = render(<FlowDiagramPanel state={state({ status: "empty", message: "a" })} {...handlers} />);
    expect(document.querySelector("[data-flow-viewport]")).toBeNull();
    view.rerender(<FlowDiagramPanel state={state(undefined, { ...flow, requestId: 9 })} {...handlers} />);
    expect(zoomOf()).toBe(0.5);
  });
});
