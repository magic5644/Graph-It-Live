/**
 * The dependency structure matrix of one architecture level as a static diagram: one row and one
 * column per unit or group in the order of `graph-it architecture --matrix` (layer 0 first, the
 * rows of a cycle together), the file pairs in each cell, cycles outlined. diagramSvg.ts draws it.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { buildMatrix } from "../architecture/architectureMatrix";
import {
  capNodes,
  diagramHeader,
  type DrawOptions,
  fitLabel,
  hasAccepted,
  legendHeight,
  textBound,
  textWidth,
  type Box,
  type DiagramCounts,
  type DiagramEdge,
  type DiagramInput,
  type DiagramText,
} from "./architectureDiagram";
import { SIZES, snap } from "./diagramStyle";

/** Height of the column numbers above the grid. */
const COLUMN_HEADER = 20;
const MIN_CELL = 28;

export type CellKind = "diagonal" | "down" | "accent" | "error" | "accepted";

export interface PlacedCell extends Box {
  count: number;
  kind: CellKind;
  /** Tooltip: the two keys, the pairs and the broken rules. */
  title: string;
}

export interface MatrixLayout {
  input: DiagramInput;
  text: DiagramText;
  width: number;
  height: number;
  top: number;
  /** Row labels, numbered as the columns. */
  rows: { key: string; text: string; x: number; y: number }[];
  columns: { text: string; x: number; y: number }[];
  /** The grid's frame. */
  grid: Box;
  cells: PlacedCell[];
  cycles: (Box & { members: string[] })[];
  hidden: number;
  counts: DiagramCounts;
}

/** A rule violation outranks the accent of an upward cell. */
function cellKind(row: number, column: number, edge: DiagramEdge | undefined): CellKind {
  if (row === column) return "diagonal";
  if (edge && edge.rules.length > 0) return edge.accepted ? "accepted" : "error";
  return column > row ? "accent" : "down";
}

/** What a cell means, drawn above the legend of every matrix. */
const READING = "row imports column: N file pairs · grey diagonal: pairs inside";

/** Lays the matrix of one level out; `options` choose the rows drawn (capNodes). */
export function layoutMatrix(input: DiagramInput, options: DrawOptions = {}): MatrixLayout {
  const { nodes, edges, hidden, notes } = capNodes(input, options);
  const matrix = buildMatrix(
    nodes.map(({ key, label, internalEdgeCount }) => ({ id: key, key, label, internalEdgeCount: internalEdgeCount ?? 0 })),
    edges,
  );
  const edgeOf = new Map(edges.map((edge) => [`${edge.from}>${edge.to}`, edge]));
  const labels = matrix.rows.map((row, index) => `${index + 1} ${fitLabel(row.label)}`);
  // The widest number of a cell or a column header.
  const widest = Math.max(matrix.rows.length, ...matrix.cells.map((matrixCell) => matrixCell.fileEdgeCount));
  const cell = snap(Math.max(MIN_CELL, textWidth(String(widest), SIZES.meta) + 8));
  const labelWidth = snap(Math.max(0, ...labels.map((label) => textWidth(label, SIZES.label))) + SIZES.nodePaddingX);
  const top = SIZES.margin + SIZES.headerHeight;
  const gridX = SIZES.margin + labelWidth;
  const gridY = top + COLUMN_HEADER;
  const size = matrix.rows.length * cell;
  const header = diagramHeader(input, notes);
  const { counts } = header;
  const text = { ...header.text, reading: READING };
  const placed = matrix.cells.map((matrixCell): PlacedCell => {
    const [from, to] = [matrix.rows[matrixCell.row].key, matrix.rows[matrixCell.column].key];
    const edge = edgeOf.get(`${from}>${to}`);
    const accepted = edge?.accepted ? " (accepted)" : "";
    const rules = edge && edge.rules.length > 0 ? `, breaks ${edge.rules.join(", ")}${accepted}` : "";
    return {
      x: gridX + matrixCell.column * cell,
      y: gridY + matrixCell.row * cell,
      width: cell,
      height: cell,
      count: matrixCell.fileEdgeCount,
      kind: cellKind(matrixCell.row, matrixCell.column, edge),
      title: from === to ? `${from}: ${matrixCell.fileEdgeCount} file pairs inside` : `${from} → ${to}: ${matrixCell.fileEdgeCount} file pairs${rules}`,
    };
  });
  return {
    input,
    text,
    width: snap(SIZES.margin * 2 + Math.max(labelWidth + size, textBound(text, { accepted: hasAccepted(edges), weight: false }))),
    height: snap(gridY + size + SIZES.margin + legendHeight(text)),
    top,
    rows: labels.map((label, index) => ({ key: matrix.rows[index].key, text: label, x: SIZES.margin, y: gridY + index * cell })),
    columns: matrix.rows.map((_row, index) => ({ text: String(index + 1), x: gridX + index * cell, y: top })),
    grid: { x: gridX, y: gridY, width: size, height: size },
    cells: placed,
    cycles: matrix.cycles.map(({ firstRow, lastRow, members }) => ({
      x: gridX + firstRow * cell,
      y: gridY + firstRow * cell,
      width: (lastRow - firstRow + 1) * cell,
      height: (lastRow - firstRow + 1) * cell,
      members,
    })),
    hidden,
    counts,
  };
}
