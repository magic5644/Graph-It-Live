/**
 * The Flow tab: the analyzer's SVG (the CLI's bytes) as an `<img>`, never injected as markup
 * (its `<style>` would leak into the webview), with a transparent button over each step box and
 * each call label. The buttons are the click targets and the keyboard list; their names come
 * from the extension verbatim. The image and its buttons zoom and pan together (wheel, drag, toolbar, keys).
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FlowDiagramMessage, FlowDiagramNode, FlowDiagramStateMessage } from "../../../shared/architecture-types";
import { LoadingState } from "../LoadingState";
import { DIAGRAM_FOCUS_CLASS } from "./DiagramTabs";
import { applyZoom, fitView, type Size, wheelZoom, ZOOM_KEYS, type ZoomAction, ZoomControls, type ZoomView } from "./ZoomControls";

export interface FlowState {
  flow: FlowDiagramMessage | null;
  status: FlowDiagramStateMessage | null;
}

export const NO_FLOW: FlowState = { flow: null, status: null };

/**
 * The next flow state for a message, and whether it shows the Flow tab: a request (loading, empty,
 * error) or a flow of another entry does; a re-render of the drawn one (theme, stale) or a cancel keeps the tab.
 * A message older than the drawn flow is dropped.
 */
export function receiveFlow(current: FlowState, message: FlowDiagramMessage | FlowDiagramStateMessage): { next: FlowState; selects: boolean } {
  if (current.flow && message.requestId < current.flow.requestId) return { next: current, selects: false };
  // Cancelled: back to the flow drawn before the loading state, without its status (a replayed one follows).
  if (message.type === "flowDiagramState" && message.status === "cancelled") return { next: { flow: current.flow, status: null }, selects: false };
  // Only a draw the user asked for (announced by loading) takes the Flow tab; the flow replayed when the view mounts waits on its tab.
  const answersLoading = current.status?.status === "loading";
  if (message.type === "flowDiagramState") {
    // An empty or failed draw of the other view is that view's answer: keeping the drawn one would show it on that tab (#823).
    const otherView = (message.status === "empty" || message.status === "error") && current.flow !== null && message.view !== current.flow.view;
    return { next: { flow: otherView ? null : current.flow, status: message }, selects: message.status === "loading" || (answersLoading && message.status !== "stale") };
  }
  return { next: { flow: message, status: null }, selects: answersLoading };
}

/**
 * A Flow or Sequence tab click draws the symbol at the cursor when no entry is known: nothing asked for yet,
 * or the last ask refused before a symbol (an error without crumbs). A known entry is drawn again instead.
 */
export const drawsAtCursor = ({ flow, status }: FlowState) => !flow && (!status || (status.status === "error" && !status.crumbs));

/** `data:` URL of the SVG, UTF-8 safe (titles hold arrows and non-Latin names); the CSP allows `img-src data:`. */
export const flowDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

const centreX = (node: FlowDiagramNode) => node.x + node.width / 2;

/** The lane rows top to bottom, each the indices of its nodes. */
function laneRows(nodes: readonly FlowDiagramNode[]): number[][] {
  const rows = new Map<string, number[]>();
  nodes.forEach((node, index) => rows.set(node.lane, [...(rows.get(node.lane) ?? []), index]));
  const top = (row: number[]) => Math.min(...row.map((index) => nodes[index].y));
  return [...rows.values()].sort((left, right) => top(left) - top(right));
}

/**
 * Keyboard moves from node `index`: ArrowRight the target of its first outgoing call (call order),
 * ArrowLeft the source of its first incoming one, ArrowDown/ArrowUp the nearest node (by x) of the
 * next/previous lane row. Undefined: no such node, the focus stays.
 */
export function nextFlowNode(flow: Pick<FlowDiagramMessage, "nodes" | "edges">, index: number, key: string): number | undefined {
  const node = flow.nodes[index];
  if (!node) return undefined;
  const indexOf = (id: string | undefined) => {
    const found = flow.nodes.findIndex((candidate) => candidate.id === id);
    return found < 0 ? undefined : found;
  };
  if (key === "ArrowRight") return indexOf(flow.edges.find((edge) => edge.from === node.id && edge.to !== node.id)?.to);
  if (key === "ArrowLeft") return indexOf(flow.edges.find((edge) => edge.to === node.id && edge.from !== node.id)?.from);
  if (key !== "ArrowDown" && key !== "ArrowUp") return undefined;
  const rows = laneRows(flow.nodes);
  const row = rows[rows.findIndex((entry) => entry.includes(index)) + (key === "ArrowDown" ? 1 : -1)];
  if (!row) return undefined;
  const x = centreX(node);
  return row.reduce((best, candidate) =>
    (Math.abs(centreX(flow.nodes[candidate]) - x) < Math.abs(centreX(flow.nodes[best]) - x) ? candidate : best), row[0]);
}

/**
 * E2E driver: presses keys as a keyboard user would. Tab enters the first step when the focus is
 * outside the steps (then the next button), Enter and Space click the focused button, any other key
 * goes to the focused element.
 */
export function pressFlowKeys(root: HTMLElement | null, keys: readonly string[]): void {
  if (!root) return;
  for (const key of keys) {
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("button[data-flow-node], button[data-flow-edge]"));
    const active = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
    if (key === "Tab") (buttons[active ? buttons.indexOf(active as HTMLButtonElement) + 1 : 0] ?? buttons[0])?.focus();
    else if (key === "Enter" || key === " ") active?.click();
    else active?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  }
}

const hitStyle: React.CSSProperties = { position: "absolute", background: "transparent", border: "none", padding: 0, margin: 0, cursor: "pointer" };
/** Label box half-size in SVG units around the anchor. shortcut: estimated from the text length, measure the SVG text if a long label is hard to hit. */
const LABEL_CHAR_WIDTH = 6;
const LABEL_HALF_HEIGHT = 8;

export interface FlowDiagramPanelProps {
  state: FlowState;
  onOpen: (kind: "node" | "edge", index: number) => void;
  onRefresh: () => void;
  onShowCallGraph: () => void;
  /** Empty state: draws the candidate of this index (a symbol of the file that makes calls). */
  onDrawCandidate: (index: number) => void;
  /** Nothing drawn: the symbol at the cursor, in the tab shown. */
  onDrawAtCursor: () => void;
  /** Escape: back to the tab strip. */
  onEscape: () => void;
  panelRef?: React.RefObject<HTMLDivElement | null>;
  /** The zoom of the last entry drawn, kept by the view across tab switches: a redraw of that entry opens with it. */
  zoomMemory?: React.RefObject<FlowZoomMemory | null>;
  /** After each zoom or pan (E2E report). */
  onZoomed?: () => void;
}

export interface FlowZoomMemory {
  key: string;
  view: ZoomView;
}

/** One entry on one tab: Flow and Sequence of the same symbol are two diagrams. */
export const flowEntryKey = (flow: Pick<FlowDiagramMessage, "view" | "entry">) => `${flow.view}\n${flow.entry}`;

/** Pointer moves shorter than this, in pixels, stay a click on a step or call. */
const DRAG_THRESHOLD = 3;

/**
 * Wheel and pinch zoom around the pointer, a drag pans, 0 + - zoom from a focused step or call, and a fitted
 * diagram fits again when the panel resizes. `content` is the drawn diagram's size. Returns the detach.
 */
export function attachPanZoom(viewport: HTMLElement, setView: React.Dispatch<React.SetStateAction<ZoomView>>, content: () => Size | null): () => void {
  const panel = () => ({ width: viewport.clientWidth, height: viewport.clientHeight });
  let drag: { pointer: number; x: number; y: number; moved: boolean } | null = null;
  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    const box = viewport.getBoundingClientRect();
    setView((view) => wheelZoom(view, event.deltaY, { x: event.clientX - box.left, y: event.clientY - box.top }));
  };
  const key = (event: KeyboardEvent) => {
    const action = ZOOM_KEYS[event.key];
    const size = content();
    if (!action || !size || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    setView((view) => applyZoom(view, action, size, panel()));
  };
  const down = (event: PointerEvent) => {
    drag = event.button === 0 ? { pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false } : null;
  };
  const move = (event: PointerEvent) => {
    if (drag?.pointer !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    // Captured, the click that ends the drag goes to the viewport: a pan never opens the step it started on.
    if (!drag.moved) viewport.setPointerCapture(event.pointerId);
    drag = { ...drag, x: event.clientX, y: event.clientY, moved: true };
    setView((view) => ({ zoom: view.zoom, x: view.x + dx, y: view.y + dy }));
  };
  const up = () => { drag = null; };
  const refit = () => setView((view) => {
    const size = content();
    return view.fitted && size ? fitView(size, panel()) : view;
  });
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refit);
  observer?.observe(viewport);
  const listeners: [string, EventListener, AddEventListenerOptions?][] = [
    ["wheel", wheel as EventListener, { passive: false }], ["keydown", key as EventListener], ["pointerdown", down as EventListener],
    ["pointermove", move as EventListener], ["pointerup", up], ["pointercancel", up],
  ];
  for (const [type, listener, options] of listeners) viewport.addEventListener(type, listener, options);
  return () => {
    observer?.disconnect();
    for (const [type, listener] of listeners) viewport.removeEventListener(type, listener);
  };
}

function FlowStatus({ state, onRefresh, onShowCallGraph, onDrawCandidate, onDrawAtCursor }: Readonly<Pick<FlowDiagramPanelProps, "state" | "onRefresh" | "onShowCallGraph" | "onDrawCandidate" | "onDrawAtCursor">>) {
  const { flow, status } = state;
  const drawAtCursor = drawsAtCursor(state) && (
    <>{" "}<button type="button" data-flow-draw-at-cursor className={DIAGRAM_FOCUS_CLASS} onClick={onDrawAtCursor}>Draw symbol at cursor</button></>
  );
  if (status?.status === "error") {
    return <output role="alert" data-flow-line style={{ display: "block", color: "var(--vscode-errorForeground)" }}>{status.message}{drawAtCursor}</output>;
  }
  if (status?.status === "empty") {
    return (
      <output data-flow-line style={{ display: "block" }}>
        No calls found from `{status.message}`.{" "}
        {status.candidates?.length ? (
          <>
            Symbols of this file that make calls:{" "}
            {status.candidates.map((candidate, index) => (
              <React.Fragment key={`${candidate.name}:${candidate.line}`}>
                <button
                  type="button" data-flow-candidate={index} className={DIAGRAM_FOCUS_CLASS} onClick={() => onDrawCandidate(index)}
                  title={`Line ${candidate.line}, ${candidate.calls} call${candidate.calls === 1 ? "" : "s"}`}
                >
                  {candidate.name}
                </button>{" "}
              </React.Fragment>
            ))}
          </>
        ) : "No symbol of this file makes a call. "}
        <button type="button" className={DIAGRAM_FOCUS_CLASS} onClick={onShowCallGraph}>Show call graph</button>
      </output>
    );
  }
  if (status?.status === "stale" || flow?.stale) {
    return (
      <output data-flow-stale data-flow-line style={{ display: "block" }}>
        Stale: files changed since this {flow?.view ?? status?.view ?? "flow"} was drawn.{" "}
        <button type="button" className={DIAGRAM_FOCUS_CLASS} onClick={onRefresh}>Refresh</button>
      </output>
    );
  }
  if (!flow && status?.status !== "loading") {
    return (
      <output data-flow-line style={{ display: "block" }}>
        Put the cursor in a function of the editor, then click this tab or Draw symbol at cursor; or right-click the function and run Show Flow Diagram (Symbol at Cursor), or Show Diagram… for its sequence.{drawAtCursor}
      </output>
    );
  }
  return null;
}

export function FlowDiagramPanel({ state, onOpen, onRefresh, onShowCallGraph, onDrawCandidate, onDrawAtCursor, onEscape, panelRef, zoomMemory, onZoomed }: Readonly<FlowDiagramPanelProps>) {
  const { flow, status } = state;
  const drawn = flow !== null && status?.status !== "empty";
  const viewportRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const remembered = flow && zoomMemory?.current?.key === flowEntryKey(flow) ? zoomMemory.current.view : null;
  const [view, setView] = useState<ZoomView>(remembered ?? { zoom: 1, x: 0, y: 0, fitted: true });
  const keyRef = useRef(remembered && flow ? flowEntryKey(flow) : "");
  const flowRef = useRef(flow);
  const onZoomedRef = useRef(onZoomed);
  onZoomedRef.current = onZoomed;
  const panelSize = () => ({ width: viewportRef.current?.clientWidth ?? 0, height: viewportRef.current?.clientHeight ?? 0 });
  // Another entry opens fitted, and so does a redraw the user has not zoomed; a redraw of the same entry keeps the zoom.
  useLayoutEffect(() => {
    flowRef.current = flow;
    if (!flow) return;
    const key = flowEntryKey(flow);
    const sameEntry = key === keyRef.current;
    const fitted = fitView(flow, panelSize());
    setView((current) => (sameEntry && !current.fitted ? current : fitted));
    keyRef.current = key;
  }, [flow]);
  useEffect(() => (viewportRef.current ? attachPanZoom(viewportRef.current, setView, () => flowRef.current) : undefined), [drawn]);
  useEffect(() => {
    if (!flow) return;
    if (zoomMemory) zoomMemory.current = { key: flowEntryKey(flow), view };
    onZoomedRef.current?.();
  }, [flow, view, zoomMemory]);
  const zoom = (action: ZoomAction) => {
    if (flow) setView((current) => applyZoom(current, action, flow, panelSize()));
  };
  const scale = view.zoom;
  const nodeKey = (index: number) => (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onEscape();
      return;
    }
    if (!flow || !event.key.startsWith("Arrow")) return;
    event.preventDefault();
    const next = nextFlowNode(flow, index, event.key);
    if (next !== undefined) nodeRefs.current[next]?.focus();
  };
  const escapeOnly = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    onEscape();
  };
  return (
    <div
      ref={panelRef} data-testid="flow-diagram" aria-busy={status?.status === "loading"}
      style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", padding: "4px 10px", fontSize: 12 }}
    >
      <FlowStatus state={state} onRefresh={onRefresh} onShowCallGraph={onShowCallGraph} onDrawCandidate={onDrawCandidate} onDrawAtCursor={onDrawAtCursor} />
      {flow && drawn && (
        <div ref={viewportRef} data-flow-viewport style={{ position: "relative", flex: 1, minHeight: 0, overflow: "hidden", touchAction: "none", cursor: "grab" }}>
          <figure data-flow-zoom={Math.round(scale * 1000) / 1000} style={{ position: "absolute", left: view.x, top: view.y, margin: 0 }}>
            {/* Sized, not CSS-scaled: the SVG is drawn again at each zoom and stays sharp. */}
            <img
              data-request-id={flow.requestId} src={flowDataUrl(flow.svg)} alt={`${flow.title}. ${flow.caption}. ${flow.counts}.`} draggable={false}
              style={{ display: "block", width: flow.width * scale, height: flow.height * scale, maxWidth: "none" }}
            />
            <fieldset aria-label={flow.view === "sequence" ? "Sequence lifelines" : "Flow steps"} style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }}>
              {flow.nodes.map((node, index) => (
                <button
                  key={node.id} type="button" data-flow-node={index} className={DIAGRAM_FOCUS_CLASS}
                  ref={(element) => { nodeRefs.current[index] = element; }}
                  aria-label={node.name} title={node.name} onClick={() => onOpen("node", index)} onKeyDown={nodeKey(index)}
                  style={{ ...hitStyle, left: node.x * scale, top: node.y * scale, width: node.width * scale, height: node.height * scale }}
                />
              ))}
            </fieldset>
            <fieldset aria-label={flow.view === "sequence" ? "Sequence calls" : "Flow calls"} style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }}>
              {flow.edges.map((edge, index) => {
                const halfWidth = (edge.label.text.length * LABEL_CHAR_WIDTH) / 2 + 4;
                return (
                  <button
                    key={`${edge.from}>${edge.to}@${edge.line}#${index}`} type="button" data-flow-edge={index} className={DIAGRAM_FOCUS_CLASS}
                    aria-label={edge.name} title={edge.name} onClick={() => onOpen("edge", index)} onKeyDown={escapeOnly}
                    style={{
                      ...hitStyle, left: (edge.label.x - halfWidth) * scale, top: (edge.label.y - LABEL_HALF_HEIGHT) * scale,
                      width: halfWidth * 2 * scale, height: LABEL_HALF_HEIGHT * 2 * scale,
                    }}
                  />
                );
              })}
            </fieldset>
          </figure>
        <ZoomControls onZoom={zoom} noun="diagram" reset />
        </div>
      )}
      {status?.status === "loading" && (
        <div style={{ position: "absolute", inset: 0 }}><LoadingState message={status.message ?? "Drawing the flow diagram…"} /></div>
      )}
    </div>
  );
}
