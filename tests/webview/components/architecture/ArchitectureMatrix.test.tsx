// @vitest-environment happy-dom

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMatrix } from "@/analyzer/architecture/architectureMatrix";
import type { MatrixNode } from "@/shared/architecture-model";
import { ArchitectureMatrix, cellLabel } from "@/webview/components/architecture/ArchitectureMatrix";

// A chain of 300 rows: row i imports row i - 1, plus one cycle between the last two.
const nodes: MatrixNode<number>[] = Array.from({ length: 300 }, (_, id) => ({ id, key: `g${String(id).padStart(3, "0")}`, label: `g${String(id).padStart(3, "0")}`, internalEdgeCount: id % 2 }));
const chain = buildMatrix(nodes, [
  ...nodes.slice(1).map((node) => ({ from: node.id, to: node.id - 1, fileEdgeCount: node.id })),
  { from: 298, to: 299, fileEdgeCount: 1 },
]);
const small = buildMatrix(nodes.slice(0, 3), [{ from: 1, to: 0, fileEdgeCount: 4 }, { from: 2, to: 1, fileEdgeCount: 1 }]);

const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

function setup(matrix = chain, overrides: Partial<React.ComponentProps<typeof ArchitectureMatrix>> = {}) {
  const props = {
    matrix,
    enterable: (row: { id: number | string }) => row.id === 0,
    colorOf: () => "#123456",
    selectedKey: undefined,
    onCell: vi.fn(),
    onHeader: vi.fn(),
    onPaint: vi.fn(),
    ...overrides,
  };
  const view = render(<ArchitectureMatrix {...props} />);
  return { ...props, ...view };
}

const cells = () => screen.getByRole("region", { name: /Dependency structure matrix/ }).querySelectorAll("button[tabindex]");

describe("ArchitectureMatrix", () => {
  afterEach(cleanup);

  it("puts only the cells and headers in view in the DOM, and reports the first paint", async () => {
    const { onPaint } = setup();
    await nextFrame();
    // 800 × 600 fallback viewport, 16 px cells: about 35 rows and 34 columns plus the overscan.
    const headers = screen.getAllByRole("button", { name: /: Ca \d+/ });
    expect(headers.length).toBeGreaterThan(20);
    expect(headers.length).toBeLessThan(60);
    expect(cells().length).toBeLessThan(120);
    expect(onPaint).toHaveBeenCalledWith(expect.objectContaining({ cause: "matrix", renderedCells: cells().length }));
    expect(screen.getByText(/1 cycle$/)).toBeTruthy();
  });

  it("labels each cell for screen readers, writes counts once zoomed in, and states the formula", () => {
    setup(small);
    expect(screen.getByRole("button", { name: "g001 imports g000: 4 file pairs" }).textContent).toBe("");
    expect(screen.getByRole("button", { name: "g001: 1 file pair inside" })).toBeTruthy();
    fireEvent.change(screen.getByRole("slider", { name: "Zoom" }), { target: { value: "3" } });
    expect(screen.getByRole("button", { name: "g001 imports g000: 4 file pairs" }).textContent).toBe("4");
    expect(screen.getByText(/I = Ce \/ \(Ca \+ Ce\)/)).toBeTruthy();
  });

  it("scrolls the row a find reveals into view and makes it active, without opening anything", () => {
    const { onCell, rerender, ...props } = setup();
    const region = screen.getByRole("region", { name: /Dependency structure matrix/ });
    rerender(<ArchitectureMatrix {...props} onCell={onCell} revealKey="g250" />);
    // 250 rows of 16 px, less the 600 px fallback viewport under its 36 px header.
    expect(region.scrollTop).toBe(250 * 16 + 16 - (600 - 36));
    expect(region.querySelector('[data-active="true"]')?.getAttribute("aria-label")).toBe("g250: 0 file pairs inside");
    expect(onCell).not.toHaveBeenCalled();
    rerender(<ArchitectureMatrix {...props} onCell={onCell} revealKey="none" />);
    expect(region.scrollTop).toBe(250 * 16 + 16 - (600 - 36));
  });

  it("reports a click on a cell or a header", () => {
    const { onCell, onHeader } = setup(small);
    fireEvent.click(screen.getByRole("button", { name: "g002 imports g001: 1 file pair" }));
    expect(onCell).toHaveBeenCalledWith(small.rows[2], small.rows[1], small.cells.find((cell) => cell.row === 2 && cell.column === 1));
    fireEvent.click(screen.getByRole("button", { name: "g000: Ca 4, Ce 0, I 0, enter" }));
    expect(onHeader).toHaveBeenCalledWith(small.rows[0]);
  });

  it("moves between cells with the arrow keys, empty ones included, and keeps the focus on the active cell", () => {
    const { onCell } = setup(small, { selectedKey: "g001" });
    const start = screen.getByRole("button", { name: "g001: 1 file pair inside" });
    expect(start.tabIndex).toBe(0);
    fireEvent.keyDown(start, { key: "ArrowLeft" });
    const left = screen.getByRole("button", { name: "g001 imports g000: 4 file pairs" });
    expect(document.activeElement).toBe(left);
    fireEvent.keyDown(left, { key: "ArrowUp" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("g000: 0 file pairs inside");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("g000: 0 file pairs inside");
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(onCell).not.toHaveBeenCalled();
  });

  it("selects and reveals a requested cell, and reports the paint after scrolling", async () => {
    const { onCell, onPaint, rerender } = setup();
    await nextFrame();
    const region = screen.getByRole("region", { name: /Dependency structure matrix/ });
    rerender(<ArchitectureMatrix matrix={chain} enterable={() => false} colorOf={() => undefined} selectedKey={undefined}
      request={{ row: 299, column: 298 }} onCell={onCell} onHeader={vi.fn()} onPaint={onPaint} />);
    expect(onCell).toHaveBeenCalledWith(chain.rows[299], chain.rows[298], expect.objectContaining({ fileEdgeCount: expect.any(Number) }));
    expect(region.scrollTop).toBeGreaterThan(0);
    fireEvent.scroll(region, { target: { scrollTop: 4000, scrollLeft: 4000 } });
    await nextFrame();
    expect(onPaint).toHaveBeenLastCalledWith(expect.objectContaining({ cause: "scroll" }));
    expect(screen.getAllByRole("button", { name: /^g25\d: Ca/ })[0]).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^g000: Ca/ })).toBeNull();
  });

  it("tints the dependents' rows, the seed and direct importers more, and says so to screen readers", () => {
    setup(small, { dependents: new Map([["g000", "seed"], ["g001", "direct"], ["g002", "transitive"]]) });
    const header = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}: Ca`) });
    expect(header("g000").getAttribute("aria-label")).toMatch(/, the selection$/);
    expect(header("g001").getAttribute("aria-label")).toMatch(/, depends on the selection directly$/);
    expect(header("g001").dataset.dependent).toBe("direct");
    expect(header("g002").dataset.dependent).toBe("transitive");
  });

  it("leaves the rows alone without dependents", () => {
    setup(small);
    const header = screen.getByRole("button", { name: /^g001: Ca/ });
    expect(header.dataset.dependent).toBeUndefined();
    // No tint must not fall back to the native (light grey) button background.
    expect(header.getAttribute("style")).toMatch(/background: none/);
  });

  it("shows an empty matrix", () => {
    setup(buildMatrix([], []));
    expect(screen.getByRole("region", { name: "Dependency structure matrix: 0 rows, 0 non-empty cells" })).toBeTruthy();
    expect(cells()).toHaveLength(0);
  });
});

describe("cellLabel", () => {
  it("reads a cell as row imports column, and the diagonal as pairs inside", () => {
    const [a, b] = small.rows;
    expect(cellLabel(a, b, 2)).toBe("g000 imports g001: 2 file pairs");
    expect(cellLabel(a, a, 1)).toBe("g000: 1 file pair inside");
  });

  it("frames the cells breaking a declared rule and names the rules", () => {
    setup(small, { violations: { "1>0": ["no-down"] } });
    const broken = screen.getByRole("button", { name: `${cellLabel(small.rows[1], small.rows[0], 4)}, breaks no-down` });
    expect(broken.dataset.violation).toBe("true");
    expect(broken.style.boxShadow).toContain("var(--vscode-errorForeground");
    expect(screen.getByText(/red frame: breaks a rule/)).toBeTruthy();
    expect(screen.getByRole("button", { name: cellLabel(small.rows[2], small.rows[1], 1) }).dataset.violation).toBe("false");
  });
});

