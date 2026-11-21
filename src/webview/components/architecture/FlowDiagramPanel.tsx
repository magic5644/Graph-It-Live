/**
 * The Flow tab: the analyzer's SVG (the CLI's bytes) as an `<img>`, never injected as markup
 * (its `<style>` would leak into the webview), with a transparent button over each step box and
 * each call label. The buttons are the click targets and the keyboard list; their names come
 * from the extension verbatim.
 */
import React, { useEffect, useRef, useState } from "react";
import type { FlowDiagramMessage, FlowDiagramNode, FlowDiagramStateMessage } from "../../../shared/architecture-types";
import { LoadingState } from "../LoadingState";
import { DIAGRAM_FOCUS_CLASS } from "./DiagramTabs";

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
    return { next: { flow: current.flow, status: message }, selects: message.status === "loading" || (answersLoading && message.status !== "stale") };
  }
  return { next: { flow: message, status: null }, selects: answersLoading };
}

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
    (Math.abs(centreX(flow.nodes[candidate]) - x) < Math.abs(centreX(flow.nodes[best]) - x) ? candidate : best));
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
  /** Escape: back to the tab strip. */
  onEscape: () => void;
  panelRef?: React.RefObject<HTMLDivElement | null>;
}

function FlowStatus({ state, onRefresh, onShowCallGraph }: Readonly<Pick<FlowDiagramPanelProps, "state" | "onRefresh" | "onShowCallGraph">>) {
  const { flow, status } = state;
  if (status?.status === "error") {
    return <output role="alert" data-flow-line style={{ display: "block", color: "var(--vscode-errorForeground)" }}>{status.message}</output>;
  }
  if (status?.status === "empty") {
    return (
      <output data-flow-line style={{ display: "block" }}>
        No calls found from `{status.message}`.{" "}
        <button type="button" className={DIAGRAM_FOCUS_CLASS} onClick={onShowCallGraph}>Show call graph</button>
      </output>
    );
  }
  if (status?.status === "stale" || flow?.stale) {
    return (
      <output data-flow-stale data-flow-line style={{ display: "block" }}>
        Stale: files changed since this flow was drawn.{" "}
        <button type="button" className={DIAGRAM_FOCUS_CLASS} onClick={onRefresh}>Refresh</button>
      </output>
    );
  }
  if (!flow && status?.status !== "loading") return <output data-flow-line style={{ display: "block" }}>Right-click a function in the editor and run Show Flow Diagram.</output>;
  return null;
}

export function FlowDiagramPanel({ state, onOpen, onRefresh, onShowCallGraph, onEscape, panelRef }: Readonly<FlowDiagramPanelProps>) {
  const { flow, status } = state;
  const imageRef = useRef<HTMLImageElement>(null);
  const nodeRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const image = imageRef.current;
    if (!image || !flow) return;
    const measure = () => setScale(image.clientWidth > 0 ? image.clientWidth / flow.width : 1);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(image);
    return () => observer?.disconnect();
  }, [flow]);
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
    <div ref={panelRef} data-testid="flow-diagram" aria-busy={status?.status === "loading"} style={{ position: "absolute", inset: 0, overflow: "auto", padding: "4px 10px", fontSize: 12 }}>
      <FlowStatus state={state} onRefresh={onRefresh} onShowCallGraph={onShowCallGraph} />
      {flow && status?.status !== "empty" && (
        <figure style={{ position: "relative", margin: 0 }}>
          <img
            ref={imageRef} role="img" data-request-id={flow.requestId} src={flowDataUrl(flow.svg)} alt={`${flow.title}. ${flow.caption}. ${flow.counts}.`}
            style={{ display: "block", width: "100%", maxWidth: flow.width }}
          />
          <div role="group" aria-label="Flow steps">
            {flow.nodes.map((node, index) => (
              <button
                key={node.id} type="button" data-flow-node={index} className={DIAGRAM_FOCUS_CLASS}
                ref={(element) => { nodeRefs.current[index] = element; }}
                aria-label={node.name} title={node.name} onClick={() => onOpen("node", index)} onKeyDown={nodeKey(index)}
                style={{ ...hitStyle, left: node.x * scale, top: node.y * scale, width: node.width * scale, height: node.height * scale }}
              />
            ))}
          </div>
          <div role="group" aria-label="Flow calls">
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
          </div>
        </figure>
      )}
      {status?.status === "loading" && (
        <div style={{ position: "absolute", inset: 0 }}><LoadingState message={status.message ?? "Drawing the flow diagram…"} /></div>
      )}
    </div>
  );
}
