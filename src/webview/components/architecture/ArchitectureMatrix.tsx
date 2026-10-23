/**
 * ArchitectureMatrix — the Matrix tab of the Architecture view: the dependency structure matrix
 * of the drawn level, as the extension computed it (order, cells, Ce/Ca/I and cycles all come
 * from src/analyzer/architecture/architectureMatrix.ts). Rows and columns are virtualised, so
 * only the cells in view are in the DOM, and the headers stay in place while scrolling.
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ArchitectureMatrix as Matrix, MatrixCell, MatrixRow } from "../../../analyzer/architecture/architectureMatrix";

type Row = MatrixRow<number | string>;

/** What a paint showed and how long it took (E2E and benchmark observability). */
export interface MatrixPaint {
  renderedCells: number;
  paintMs: number;
  cause: "matrix" | "scroll";
}

interface ArchitectureMatrixProps {
  matrix: Matrix;
  /** Rule names of every cell breaking a declared rule, keyed `rowId>columnId`. */
  violations?: Readonly<Record<string, string[]>>;
  /** Rows whose header enters the level below: units, folders holding sub-folders. */
  enterable: (row: Row) => boolean;
  /** Unit colour of a row's swatch, if any. */
  colorOf: (row: Row) => string | undefined;
  /** Key of the selected row (the graph's focus): the active cell starts on its diagonal. */
  selectedKey: string | undefined;
  /** A cell to click from outside (E2E driver): selected, revealed and reported like a click. */
  request?: { row: number; column: number } | null;
  /** Key of the row the find matches first: made active and scrolled into view, nothing opened. */
  revealKey?: string;
  /** Dependents by group, by row key: the seed's rows and the rows reached, directly or not. */
  dependents?: ReadonlyMap<string, DependentMark>;
  onCell: (row: Row, column: Row, cell: MatrixCell | undefined) => void;
  onHeader: (row: Row) => void;
  onPaint: (paint: MatrixPaint) => void;
}

export type DependentMark = "seed" | "direct" | "transitive";

/** A dependents mark in words (screen readers) and as a row tint: stronger for the seed and direct importers. */
const DEPENDENT_MARKS: Record<DependentMark, { text: string; share: number }> = {
  seed: { text: "the selection", share: 45 },
  direct: { text: "depends on the selection directly", share: 35 },
  transitive: { text: "depends on the selection transitively", share: 18 },
};

const HEADER_WIDTH = 260;
const HEADER_HEIGHT = 36;
const ZOOMS = [12, 16, 24, 32] as const;
/** Cell size from which the count is written in the cell. */
const NUMBERS_FROM = 24;
/** Rows and columns drawn beyond the visible ones, so a small scroll shows no gap. */
const OVERSCAN = 4;
const FALLBACK_VIEWPORT = { width: 800, height: 600 };

const plural = (count: number) => `${count} file pair${count === 1 ? "" : "s"}`;
export const cellLabel = (row: Row, column: Row, count: number) =>
  row === column ? `${row.label}: ${plural(count)} inside` : `${row.label} imports ${column.label}: ${plural(count)}`;

/** Log scale, so one heavy cell does not wash out the others. */
function cellBackground(cell: MatrixCell, max: number): string {
  const share = Math.round(20 + 80 * (Math.log1p(cell.fileEdgeCount) / Math.log1p(max)));
  const colour = cell.upward ? "var(--vscode-errorForeground, #f14c4c)" : "var(--vscode-charts-blue, #3794ff)";
  return `color-mix(in srgb, ${colour} ${share}%, transparent)`;
}

function headerTitle(row: Row, index: number): string {
  const instability = row.instability === null ? "none (no pair across its boundary)" : String(row.instability);
  const key = row.key && row.key !== row.label ? ` (${row.key})` : "";
  return `${index + 1}. ${row.label}${key} · layer ${row.layer}\n`
    + `Ca ${row.incomingPairs} incoming pairs from ${row.incomingGroups} · Ce ${row.outgoingPairs} outgoing pairs to ${row.outgoingGroups}\n`
    + `I = Ce / (Ca + Ce) = ${instability}`;
}

const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, offset) => from + offset);

export function ArchitectureMatrix(props: Readonly<ArchitectureMatrixProps>): React.ReactElement {
  const { matrix, violations, enterable, colorOf, selectedKey, request, dependents } = props;
  const callbacks = useRef(props);
  callbacks.current = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const size = ZOOMS[zoom];
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [viewport, setViewport] = useState(FALLBACK_VIEWPORT);
  const count = matrix.rows.length;
  const selectedRow = Math.max(0, matrix.rows.findIndex((row) => row.key === selectedKey));
  const [active, setActive] = useState({ row: selectedRow, column: selectedRow });
  /** Set by the keyboard: the next render moves the focus to the active cell. */
  const focusActiveRef = useRef(false);
  /** Start and cause of the paint being measured. */
  const paintRef = useRef<{ started: number; cause: MatrixPaint["cause"] } | null>(null);

  const byRow = useMemo(() => {
    const cells = new Map<number, Map<number, MatrixCell>>();
    for (const cell of matrix.cells) cells.set(cell.row, (cells.get(cell.row) ?? new Map()).set(cell.column, cell));
    return cells;
  }, [matrix]);
  const max = useMemo(() => Math.max(1, ...matrix.cells.map((cell) => cell.fileEdgeCount)), [matrix]);

  useLayoutEffect(() => {
    paintRef.current = { started: performance.now(), cause: "matrix" };
    setActive({ row: selectedRow, column: selectedRow });
    // A new matrix (another level) starts on the selection; the zoom stays.
  }, [matrix]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => setViewport({
      width: element.clientWidth || FALLBACK_VIEWPORT.width,
      height: element.clientHeight || FALLBACK_VIEWPORT.height,
    });
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);

  const rowsShown = {
    from: Math.max(0, Math.floor(scroll.top / size) - OVERSCAN),
    to: Math.min(count, Math.ceil((scroll.top + viewport.height - HEADER_HEIGHT) / size) + OVERSCAN),
  };
  const columnsShown = {
    from: Math.max(0, Math.floor(scroll.left / size) - OVERSCAN),
    to: Math.min(count, Math.ceil((scroll.left + viewport.width - HEADER_WIDTH) / size) + OVERSCAN),
  };
  const visibleCells: MatrixCell[] = range(rowsShown.from, rowsShown.to).flatMap((row) =>
    [...(byRow.get(row)?.values() ?? [])].filter((cell) => cell.column >= columnsShown.from && cell.column < columnsShown.to));
  const activeCell = byRow.get(active.row)?.get(active.column);
  const shownCells = activeCell || count === 0 ? visibleCells : [...visibleCells, { ...active, fileEdgeCount: 0, upward: false }];

  // After each commit: the focus follows the keyboard, and a measured paint reports its next frame.
  useEffect(() => {
    if (focusActiveRef.current) {
      focusActiveRef.current = false;
      scrollRef.current?.querySelector<HTMLButtonElement>('[data-active="true"]')?.focus();
    }
    const paint = paintRef.current;
    if (!paint) return;
    paintRef.current = null;
    const renderedCells = shownCells.length;
    requestAnimationFrame(() => callbacks.current.onPaint({ renderedCells, paintMs: performance.now() - paint.started, cause: paint.cause }));
  });

  /** Scrolls the least needed to show a cell next to the headers. */
  const reveal = (row: number, column: number) => {
    const element = scrollRef.current;
    if (!element) return;
    const top = row * size;
    const left = column * size;
    const height = viewport.height - HEADER_HEIGHT;
    const width = viewport.width - HEADER_WIDTH;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + size > element.scrollTop + height) element.scrollTop = top + size - height;
    if (left < element.scrollLeft) element.scrollLeft = left;
    else if (left + size > element.scrollLeft + width) element.scrollLeft = left + size - width;
  };
  const select = (row: number, column: number) => {
    setActive({ row, column });
    reveal(row, column);
    callbacks.current.onCell(matrix.rows[row], matrix.rows[column], byRow.get(row)?.get(column));
  };
  const MOVES: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
  const move = (event: React.KeyboardEvent) => {
    const step = MOVES[event.key];
    if (!step) return;
    event.preventDefault();
    const row = Math.min(count - 1, Math.max(0, active.row + step[0]));
    const column = Math.min(count - 1, Math.max(0, active.column + step[1]));
    focusActiveRef.current = true;
    setActive({ row, column });
    reveal(row, column);
  };
  useEffect(() => {
    if (request) select(request.row, request.column);
  }, [request]);
  useEffect(() => {
    const row = matrix.rows.findIndex((entry) => entry.key === props.revealKey);
    if (row < 0) return;
    setActive({ row, column: row });
    reveal(row, row);
  }, [props.revealKey, matrix]);
  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop: top, scrollLeft: left } = event.currentTarget;
    paintRef.current ??= { started: performance.now(), cause: "scroll" };
    setScroll({ top, left });
  };

  const headerButton: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 4, width: "100%", height: "100%", padding: "0 4px", border: "none",
    background: "none", color: "inherit", font: "inherit", textAlign: "left", cursor: "pointer",
  };
  const sticky: React.CSSProperties = { position: "sticky", background: "var(--vscode-editor-background, #1e1e1e)" };
  const rowHeaderCell = (index: number) => {
    const row = matrix.rows[index];
    const color = colorOf(row);
    const mark = dependents?.get(row.key);
    const tint = mark ? `color-mix(in srgb, var(--vscode-focusBorder, #007fd4) ${DEPENDENT_MARKS[mark].share}%, transparent)` : undefined;
    const markText = mark ? `, ${DEPENDENT_MARKS[mark].text}` : "";
    return (
      <div key={row.key || `#${index}`} style={{ position: "absolute", top: index * size, left: 0, width: HEADER_WIDTH, height: size, boxSizing: "border-box", borderBottom: "1px solid var(--vscode-widget-border, #444)" }}>
        <button
          type="button" data-dependent={mark} style={{ ...headerButton, fontWeight: index === active.row ? 600 : undefined, background: tint }}
          title={headerTitle(row, index)}
          aria-label={`${row.label}: Ca ${row.incomingPairs}, Ce ${row.outgoingPairs}, I ${row.instability ?? "none"}${enterable(row) ? ", enter" : ""}${markText}`}
          onClick={() => callbacks.current.onHeader(row)}
        >
          <span style={{ width: "3ch", textAlign: "right", color: "var(--vscode-descriptionForeground)" }}>{index + 1}</span>
          <span aria-hidden="true" style={{ flex: "none", width: 9, height: 9, background: color ?? "transparent" }} />
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.label}</span>
          {size >= 16 && (
            <span style={{ color: "var(--vscode-descriptionForeground)", whiteSpace: "nowrap" }}>
              {row.incomingPairs}/{row.outgoingPairs} · {row.instability ?? "–"}
            </span>
          )}
        </button>
      </div>
    );
  };
  const cellButton = (cell: MatrixCell) => {
    const row = matrix.rows[cell.row];
    const column = matrix.rows[cell.column];
    const isActive = cell.row === active.row && cell.column === active.column;
    const broken = cell.fileEdgeCount > 0 ? violations?.[`${row.id}>${column.id}`] : undefined;
    let background = "transparent";
    if (cell.fileEdgeCount > 0) {
      background = cell.row === cell.column ? "color-mix(in srgb, var(--vscode-descriptionForeground, #999) 35%, transparent)" : cellBackground(cell, max);
    }
    const label = cellLabel(row, column, cell.fileEdgeCount) + (broken ? `, breaks ${broken.join(", ")}` : "");
    return (
      <button
        key={`${cell.row}:${cell.column}`}
        type="button"
        data-active={isActive}
        data-violation={broken !== undefined}
        tabIndex={isActive ? 0 : -1}
        aria-label={label}
        title={`${label}${cell.upward ? " (above the diagonal: cycle)" : ""}`}
        onClick={() => select(cell.row, cell.column)}
        onKeyDown={move}
        style={{
          position: "absolute", top: cell.row * size, left: HEADER_WIDTH + cell.column * size, width: size, height: size,
          padding: 0, border: "none", background, color: "var(--vscode-foreground)", font: "inherit", fontSize: Math.min(11, size / 2),
          outline: isActive ? "2px solid var(--vscode-focusBorder, #007fd4)" : undefined, outlineOffset: -2, cursor: "pointer",
          // A broken rule: a red frame, so it reads apart from the red of a cycle's upward cells.
          boxShadow: broken ? "inset 0 0 0 2px var(--vscode-errorForeground, #f14c4c)" : undefined,
        }}
      >
        {size >= NUMBERS_FROM && cell.fileEdgeCount > 0 ? cell.fileEdgeCount : null}
      </button>
    );
  };

  return (
    // zIndex 0: the sticky headers stay below the evidence panel drawn over the matrix.
    <div style={{ position: "absolute", inset: 0, zIndex: 0, display: "flex", flexDirection: "column", fontSize: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: "2px 10px", borderBottom: "1px solid var(--vscode-widget-border)" }}>
        <span>
          Row imports column · <span style={{ color: "var(--vscode-errorForeground)" }}>red: above the diagonal (cycle)</span> · outlined: cycles
          {violations && Object.keys(violations).length > 0 && <span style={{ color: "var(--vscode-errorForeground)" }}> · red frame: breaks a rule</span>}
        </span>
        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span>Zoom</span>
          <input type="range" min={0} max={ZOOMS.length - 1} value={zoom} onChange={(event) => setZoom(Number(event.target.value))} />
        </label>
        <span style={{ color: "var(--vscode-descriptionForeground)" }} title={matrix.formulas.order}>
          Header: Ca/Ce · I, with {matrix.formulas.instability}
        </span>
      </div>
      <section
        aria-label={`Dependency structure matrix: ${count} rows, ${matrix.totals.cells} non-empty cells`}
        ref={scrollRef}
        onScroll={onScroll}
        style={{ flex: 1, minHeight: 0, overflow: "auto", position: "relative" }}
      >
        <div style={{ position: "relative", width: HEADER_WIDTH + count * size, height: HEADER_HEIGHT + count * size }}>
          <div style={{ ...sticky, top: 0, zIndex: 2, height: HEADER_HEIGHT, width: HEADER_WIDTH + count * size }}>
            <div style={{ ...sticky, left: 0, zIndex: 3, width: HEADER_WIDTH, height: HEADER_HEIGHT, padding: "2px 4px", boxSizing: "border-box", color: "var(--vscode-descriptionForeground)" }}>
              {matrix.totals.fileEdges} file pairs · {matrix.cycles.length} cycle{matrix.cycles.length === 1 ? "" : "s"}
            </div>
            {range(columnsShown.from, columnsShown.to).map((index) => (
              <div
                key={index} title={headerTitle(matrix.rows[index], index)}
                style={{
                  position: "absolute", top: 0, left: HEADER_WIDTH + index * size, width: size, height: HEADER_HEIGHT, overflow: "hidden",
                  writingMode: "vertical-rl", fontSize: Math.min(11, size - 2), fontWeight: index === active.column ? 600 : undefined,
                  color: "var(--vscode-descriptionForeground)", borderRight: "1px solid var(--vscode-widget-border, #444)", boxSizing: "border-box",
                }}
              >
                {index + 1}
              </div>
            ))}
          </div>
          <div style={{ position: "relative", height: count * size }}>
            <div
              aria-hidden="true"
              style={{
                position: "absolute", top: 0, left: HEADER_WIDTH, width: count * size, height: count * size,
                backgroundImage: "linear-gradient(to right, var(--vscode-widget-border, #444) 1px, transparent 1px), linear-gradient(to bottom, var(--vscode-widget-border, #444) 1px, transparent 1px)",
                backgroundSize: `${size}px ${size}px`, opacity: 0.5,
              }}
            />
            {matrix.cycles.map((cycle) => (
              <div
                key={cycle.firstRow} aria-hidden="true"
                style={{
                  position: "absolute", top: cycle.firstRow * size, left: HEADER_WIDTH + cycle.firstRow * size, zIndex: 1, pointerEvents: "none",
                  width: (cycle.lastRow - cycle.firstRow + 1) * size, height: (cycle.lastRow - cycle.firstRow + 1) * size,
                  boxSizing: "border-box", border: "2px solid var(--vscode-errorForeground, #f14c4c)",
                }}
              />
            ))}
            {shownCells.map(cellButton)}
            <div style={{ ...sticky, left: 0, zIndex: 2, width: HEADER_WIDTH, height: count * size }}>
              {range(rowsShown.from, rowsShown.to).map(rowHeaderCell)}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
