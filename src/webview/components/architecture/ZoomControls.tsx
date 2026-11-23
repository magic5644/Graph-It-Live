/**
 * Zoom of the Architecture view's diagrams: the toolbar over a canvas, its keys, and the zoom and pan
 * of the Flow and Sequence tabs (the Units and Folder canvases zoom through Cytoscape).
 */
import React from "react";

export type ZoomAction = "fit" | "in" | "out" | "reset";
/** Keys of a focused diagram: 0 fits, + (or =) zooms in, - zooms out. */
export const ZOOM_KEYS: Readonly<Record<string, ZoomAction>> = { "0": "fit", "+": "in", "=": "in", "-": "out" };
export const ZOOM_STEP = 1.25;
/** Flow and Sequence zoom bounds: 10% to 400%. */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;
/** Margin kept around a fitted diagram, in pixels. */
const FIT_PADDING = 8;

/** Zoom of a diagram and the panel position of its top-left corner, in pixels; `fitted` until the user zooms or pans. */
export interface ZoomView {
  zoom: number;
  x: number;
  y: number;
  fitted?: boolean;
}

export interface Size {
  width: number;
  height: number;
}

export const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/**
 * The whole diagram in the panel, centred across and at the top: diagrams read top down. Never above 100%,
 * a small diagram keeps its drawn size. A panel without a size yet (hidden) shows it at 100%.
 */
export function fitView(content: Size, panel: Size): ZoomView {
  if (panel.width <= 0 || panel.height <= 0 || content.width <= 0 || content.height <= 0) return { zoom: 1, x: 0, y: 0, fitted: true };
  const zoom = clampZoom(Math.min(1, (panel.width - 2 * FIT_PADDING) / content.width, (panel.height - 2 * FIT_PADDING) / content.height));
  return { zoom, x: (panel.width - content.width * zoom) / 2, y: FIT_PADDING, fitted: true };
}

/** Zooms to `zoom` (within bounds) keeping the diagram point under `point` (panel pixels) in place. */
export function zoomAt(view: ZoomView, zoom: number, point: { x: number; y: number }): ZoomView {
  const next = clampZoom(zoom);
  const ratio = next / view.zoom;
  return { zoom: next, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio };
}

/** Middle of the diagram's part shown on one axis, or of the panel when none is shown. */
function shownMiddle(start: number, length: number, size: number): number {
  const from = Math.max(0, start);
  const to = Math.min(size, start + length);
  return from < to ? (from + to) / 2 : size / 2;
}

/**
 * A toolbar action: Fit the whole diagram, 100%, or one step in or out around the centre of the diagram's shown part.
 * Not the panel's centre: a fitted diagram sits at the top, so in a taller panel that centre is empty space and
 * each step would push the diagram out of sight.
 */
export function applyZoom(view: ZoomView, action: ZoomAction, content: Size, panel: Size): ZoomView {
  if (action === "fit") return fitView(content, panel);
  const centre = {
    x: shownMiddle(view.x, content.width * view.zoom, panel.width),
    y: shownMiddle(view.y, content.height * view.zoom, panel.height),
  };
  if (action === "reset") return zoomAt(view, 1, centre);
  return zoomAt(view, view.zoom * (action === "in" ? ZOOM_STEP : 1 / ZOOM_STEP), centre);
}

/** A wheel or pinch step (pixels of `deltaY`, negative zooms in) around the pointer. */
export const wheelZoom = (view: ZoomView, deltaY: number, point: { x: number; y: number }) => zoomAt(view, view.zoom * Math.exp(-deltaY / 500), point);

/** Fit (0), 100% (Flow and Sequence only), zoom in (+) and out (-), over the canvas's bottom-right corner. */
export function ZoomControls({ onZoom, noun, reset = false }: Readonly<{ onZoom: (action: ZoomAction) => void; noun: string; reset?: boolean }>) {
  const control = (action: ZoomAction, text: string, label: string) => (
    <button type="button" data-zoom={action} aria-label={label} title={label} onClick={() => onZoom(action)} style={{ minWidth: 26 }}>{text}</button>
  );
  return (
    <fieldset aria-label="Zoom controls" style={{ position: "absolute", right: 8, bottom: 8, zIndex: 1, display: "flex", gap: 2, margin: 0, padding: 0, border: "none" }}>
      {control("fit", "Fit", `Fit the ${noun} (0)`)}
      {reset && control("reset", "100%", "Actual size (100%)")}
      {control("in", "+", "Zoom in (+)")}
      {control("out", "−", "Zoom out (-)")}
    </fieldset>
  );
}
