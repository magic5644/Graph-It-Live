// @vitest-environment happy-dom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyZoom, clampZoom, fitView, MAX_ZOOM, MIN_ZOOM, wheelZoom, ZOOM_KEYS, ZOOM_STEP, ZoomControls, zoomAt,
} from "@/webview/components/architecture/ZoomControls";

const content = { width: 400, height: 300 };

describe("fitView", () => {
  it("fits the whole diagram, 8 px from the edges, centred across and at the top", () => {
    expect(fitView(content, { width: 216, height: 1000 })).toEqual({ zoom: 0.5, x: 8, y: 8, fitted: true });
    // The height decides: 100 × 2 + 16 px high.
    expect(fitView(content, { width: 1000, height: 166 })).toEqual({ zoom: 0.5, x: 400, y: 8, fitted: true });
  });

  it("never enlarges a small diagram past 100%, and never shrinks one below 10%", () => {
    expect(fitView(content, { width: 2000, height: 2000 }).zoom).toBe(1);
    const huge = fitView({ width: 100_000, height: 300 }, { width: 216, height: 1000 });
    expect(huge.zoom).toBe(MIN_ZOOM);
    expect(huge.x).toBe((216 - 100_000 * MIN_ZOOM) / 2);
  });

  it("a panel or a diagram without a size shows the diagram at 100%, still fitted", () => {
    for (const panel of [{ width: 0, height: 500 }, { width: 500, height: 0 }]) expect(fitView(content, panel)).toEqual({ zoom: 1, x: 0, y: 0, fitted: true });
    expect(fitView({ width: 0, height: 0 }, { width: 500, height: 500 })).toEqual({ zoom: 1, x: 0, y: 0, fitted: true });
  });
});

describe("zoomAt and clampZoom", () => {
  it("keeps the diagram point under the pointer in place and drops fitted", () => {
    const view = { zoom: 0.5, x: 8, y: 8, fitted: true };
    const next = zoomAt(view, 1, { x: 108, y: 58 });
    expect(next).toEqual({ zoom: 1, x: -92, y: -42 });
    // The diagram point (200, 100) was under (108, 58) and still is.
    expect([(108 - view.x) / view.zoom, (58 - view.y) / view.zoom]).toEqual([(108 - next.x) / next.zoom, (58 - next.y) / next.zoom]);
  });

  it("stays within 10% and 400%", () => {
    expect([clampZoom(0.01), clampZoom(10), clampZoom(2)]).toEqual([MIN_ZOOM, MAX_ZOOM, 2]);
    expect(zoomAt({ zoom: 1, x: 0, y: 0 }, 50, { x: 0, y: 0 }).zoom).toBe(MAX_ZOOM);
  });
});

describe("applyZoom and wheelZoom", () => {
  const panel = { width: 216, height: 1000 };
  const view = { zoom: 0.5, x: 8, y: 8, fitted: true };

  it("in and out step by 1.25 around the panel centre, reset shows 100%, fit fits", () => {
    expect(applyZoom(view, "in", content, panel).zoom).toBe(0.5 * ZOOM_STEP);
    expect(applyZoom(view, "out", content, panel).zoom).toBe(0.5 / ZOOM_STEP);
    expect(applyZoom(view, "reset", content, panel)).toEqual(zoomAt(view, 1, { x: 108, y: 500 }));
    expect(applyZoom({ zoom: 3, x: -500, y: -40 }, "fit", content, panel)).toEqual(view);
  });

  it("the wheel zooms in on a negative delta, out on a positive one, and nothing on 0", () => {
    const point = { x: 50, y: 50 };
    expect(wheelZoom(view, -100, point).zoom).toBeGreaterThan(0.5);
    expect(wheelZoom(view, 100, point).zoom).toBeLessThan(0.5);
    expect(wheelZoom(view, 0, point).zoom).toBe(0.5);
  });

  it("0 fits, + or = zooms in, - zooms out; no key for 100%", () => {
    expect(ZOOM_KEYS).toEqual({ "0": "fit", "+": "in", "=": "in", "-": "out" });
  });
});

describe("ZoomControls", () => {
  afterEach(cleanup);

  it("shows 100% only when asked, and names the diagram it fits", () => {
    const onZoom = vi.fn();
    const view = render(<ZoomControls onZoom={onZoom} noun="graph" />);
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Fit the graph (0)", "Zoom in (+)", "Zoom out (-)"]);
    view.rerender(<ZoomControls onZoom={onZoom} noun="diagram" reset />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Fit", "100%", "+", "−"]);
    buttons.forEach((button) => fireEvent.click(button));
    expect(onZoom.mock.calls).toEqual([["fit"], ["reset"], ["in"], ["out"]]);
    expect(screen.getByRole("group", { name: "Zoom controls" })).toBeTruthy();
  });
});
