// @vitest-environment happy-dom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LoadingState } from "../../../src/webview/components/LoadingState";

afterEach(cleanup);

describe("LoadingState", () => {
  it("shows the logo, the message and a progress bar when the percentage is known", () => {
    render(<LoadingState message="Indexing workspace…" percent={42} />);

    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText("Indexing workspace… (42%)")).toBeTruthy();
    const progress = screen.getByRole("progressbar");
    expect(progress.getAttribute("value")).toBe("42");
    expect(progress.getAttribute("max")).toBe("100");
    const logo = screen.getByTestId("graph-it-live-logo");
    expect(logo.getAttribute("aria-hidden")).toBe("true");
    expect(logo.querySelector("svg")).not.toBeNull();
  });

  it("shows no progress bar and no percentage when the percentage is unknown", () => {
    render(<LoadingState message="Extracting current file…" />);

    expect(screen.getByText("Extracting current file…")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("shows 0% as a known percentage", () => {
    render(<LoadingState message="Building" percent={0} />);

    expect(screen.getByText("Building (0%)")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("0");
  });

  it.each([undefined, ""])("falls back to a default message for %j", (message) => {
    render(<LoadingState message={message} />);

    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("renders extra content under the message", () => {
    render(<LoadingState message="Waiting"><button type="button">Retry</button></LoadingState>);

    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("gives every instance its own SVG ids, and its references point to its own ids", () => {
    render(<><LoadingState message="first" /><LoadingState message="second" /></>);

    const logos = screen.getAllByTestId("graph-it-live-logo");
    const ids = logos.map((logo) => Array.from(logo.querySelectorAll("[id]"), (element) => element.id));
    expect(ids[0]).toHaveLength(3);
    expect(ids[1]).toHaveLength(3);
    expect(ids[0].filter((id) => ids[1].includes(id))).toEqual([]);
    for (const [index, logo] of logos.entries()) {
      // url(#…) fills and <use href="#…"> resolve inside the same logo; no id keeps the shared source prefix.
      const references = [...logo.innerHTML.matchAll(/(?:url\(#|href="#)([^)"]+)/g)].map((match) => match[1]);
      expect(references.length).toBeGreaterThan(0);
      expect(references.every((id) => ids[index].includes(id))).toBe(true);
      expect(ids[index].every((id) => /^[\w-]+$/.test(id) && !id.startsWith("gil-"))).toBe(true);
    }
  });

  it("sizes the logo to its box", () => {
    render(<LoadingState />);

    const svg = screen.getByTestId("graph-it-live-logo").querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("100%");
    expect(svg?.getAttribute("height")).toBe("100%");
  });
});
