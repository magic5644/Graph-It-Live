/**
 * Dependency structure matrix (DSM) of one architecture level: one row and one column per unit
 * or group, the distinct file pairs between them in each cell. Shared by `graph-it architecture
 * --matrix`, explore_architecture `view: "matrix"` and the extension's Matrix view.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import type { CommunityGroupAggregation } from "../community/groupAggregation";
import { byCodeUnit, type ArchitectureUnits } from "./architectureUnits";
import { layerGraph } from "./stronglyConnectedComponents";

/** Formulas stated with the numbers, never a verdict (#300). */
export const MATRIX_FORMULAS = {
  order: "Rows and columns share one order: layer 0 first (depends on no other row), the rows of a cycle together, then by label.",
  cell: "Cell (row, column) = distinct file pairs where a file of the row imports a file of the column; the diagonal counts the pairs inside the row.",
  upward: "In this order every dependency sits below the diagonal; a cell above it (upward) belongs to a cycle.",
  instability: "I = Ce / (Ca + Ce), Ce = outgoingPairs (efferent), Ca = incomingPairs (afferent), diagonal excluded; null when both are 0.",
};

export interface MatrixNode<Id> {
  id: Id;
  key: string;
  label: string;
  /** Distinct file pairs with both ends in this node: its diagonal cell. */
  internalEdgeCount: number;
}

export interface MatrixEdge<Id> {
  from: Id;
  to: Id;
  fileEdgeCount: number;
}

export interface MatrixRow<Id> extends MatrixNode<Id> {
  layer: number;
  /** Index in `cycles` of the cycle this row belongs to. */
  cycle?: number;
  /** Ce: file pairs from this row to the other rows, and the rows they reach. */
  outgoingPairs: number;
  outgoingGroups: number;
  /** Ca: file pairs from the other rows to this row, and the rows they come from. */
  incomingPairs: number;
  incomingGroups: number;
  /** Ce / (Ca + Ce), rounded to 2 decimals; null without any pair across the row's boundary. */
  instability: number | null;
}

export interface MatrixCell {
  /** Row and column indexes in `rows`. */
  row: number;
  column: number;
  fileEdgeCount: number;
  /** Above the diagonal: the row imports a row placed after it. */
  upward: boolean;
}

export interface ArchitectureMatrix<Id extends number | string = number | string> {
  rows: MatrixRow<Id>[];
  /** Non-zero cells only, the diagonal included, by row then column. */
  cells: MatrixCell[];
  /** Groups of two or more rows that depend on each other; their rows are contiguous. */
  cycles: { firstRow: number; lastRow: number; members: string[] }[];
  totals: { rows: number; cells: number; fileEdges: number; intraEdges: number; interEdges: number; upwardCells: number };
  formulas: typeof MATRIX_FORMULAS;
}

/** Rows ordered by layer, each cycle kept together (at its first member's label), then by label. */
export function buildMatrix<Id extends number | string>(nodes: readonly MatrixNode<Id>[], edges: readonly MatrixEdge<Id>[]): ArchitectureMatrix<Id> {
  const byName = (left: MatrixNode<Id>, right: MatrixNode<Id>) => byCodeUnit(left.label, right.label) || byCodeUnit(left.key, right.key);
  const sorted = nodes.toSorted(byName);
  const ids = sorted.map((node) => String(node.id));
  const between = edges.filter((edge) => edge.from !== edge.to && edge.fileEdgeCount > 0);
  const successors = new Map<string, string[]>();
  for (const { from, to } of between) successors.set(String(from), [...(successors.get(String(from)) ?? []), String(to)]);
  const { components, componentOf, layerOf } = layerGraph(ids, successors);
  // Nodes come sorted by name: a component's rank is its first member's.
  const componentRank = new Map<number, number>();
  ids.forEach((id, index) => {
    const component = componentOf.get(id)!;
    if (!componentRank.has(component)) componentRank.set(component, index);
  });
  const rank = (node: MatrixNode<Id>) => componentRank.get(componentOf.get(String(node.id))!)!;
  const ordered = sorted.toSorted((left, right) =>
    layerOf.get(String(left.id))! - layerOf.get(String(right.id))! || rank(left) - rank(right));
  const indexOf = new Map(ordered.map((node, index) => [String(node.id), index]));

  const cycleComponents = [...new Set(ordered.map((node) => componentOf.get(String(node.id))!))]
    .filter((component) => components[component].length > 1);
  const cycleOf = new Map(cycleComponents.map((component, index) => [component, index]));
  const cycles = cycleComponents.map((component) => {
    const rows = components[component].map((id) => indexOf.get(id)!).sort((left, right) => left - right);
    return { firstRow: rows[0], lastRow: rows.at(-1)!, members: rows.map((row) => ordered[row].key) };
  });

  const outgoing = ordered.map(() => ({ pairs: 0, groups: 0 }));
  const incoming = ordered.map(() => ({ pairs: 0, groups: 0 }));
  const cells: MatrixCell[] = ordered
    .map((node, index) => ({ row: index, column: index, fileEdgeCount: node.internalEdgeCount, upward: false }))
    .filter((cell) => cell.fileEdgeCount > 0);
  for (const edge of between) {
    const row = indexOf.get(String(edge.from));
    const column = indexOf.get(String(edge.to));
    if (row === undefined || column === undefined) continue;
    cells.push({ row, column, fileEdgeCount: edge.fileEdgeCount, upward: column > row });
    outgoing[row].pairs += edge.fileEdgeCount;
    outgoing[row].groups += 1;
    incoming[column].pairs += edge.fileEdgeCount;
    incoming[column].groups += 1;
  }
  cells.sort((left, right) => left.row - right.row || left.column - right.column);

  const rows = ordered.map((node, index): MatrixRow<Id> => {
    const ce = outgoing[index].pairs;
    const ca = incoming[index].pairs;
    const cycle = cycleOf.get(componentOf.get(String(node.id))!);
    return {
      id: node.id,
      key: node.key,
      label: node.label,
      internalEdgeCount: node.internalEdgeCount,
      layer: layerOf.get(String(node.id))!,
      ...(cycle === undefined ? {} : { cycle }),
      outgoingPairs: ce,
      outgoingGroups: outgoing[index].groups,
      incomingPairs: ca,
      incomingGroups: incoming[index].groups,
      instability: ca + ce === 0 ? null : Math.round((ce / (ca + ce)) * 100) / 100,
    };
  });
  const intraEdges = ordered.reduce((total, node) => total + node.internalEdgeCount, 0);
  const fileEdges = cells.reduce((total, cell) => total + cell.fileEdgeCount, 0);
  return {
    rows,
    cells,
    cycles,
    totals: {
      rows: rows.length,
      cells: cells.length,
      fileEdges,
      intraEdges,
      interEdges: fileEdges - intraEdges,
      upwardCells: cells.filter((cell) => cell.upward).length,
    },
    formulas: MATRIX_FORMULAS,
  };
}

/**
 * The matrix of a group level, the unassigned files (id 0) as one more row when there are any.
 * `include` keeps some groups (an entered unit's) and the edges between them.
 */
export function groupMatrix(aggregation: CommunityGroupAggregation, include: (id: number) => boolean = () => true): ArchitectureMatrix<number> {
  const groups = aggregation.unassigned.fileCount > 0
    ? [...aggregation.groups, { id: 0, key: "", label: "unassigned", internalEdgeCount: aggregation.unassigned.internalEdgeCount }]
    : aggregation.groups;
  const nodes = groups
    .filter((group) => include(group.id))
    .map(({ id, key, label, internalEdgeCount }) => ({ id, key, label, internalEdgeCount }));
  const kept = new Set(nodes.map((node) => node.id));
  return buildMatrix(nodes, aggregation.groupEdges.filter((edge) => kept.has(edge.from) && kept.has(edge.to)));
}

/** The matrix of the units: rows are unit keys, labels their names. */
export function unitMatrix(units: Pick<ArchitectureUnits, "units" | "unitEdges">): ArchitectureMatrix<string> {
  return buildMatrix(
    units.units.map((unit) => ({ id: unit.key, key: unit.key, label: unit.name, internalEdgeCount: unit.internalEdgeCount })),
    units.unitEdges,
  );
}

/** Sorted `rowKey>columnKey=count` of every non-zero cell: one string to compare two matrices (E2E). */
export function matrixDigest({ rows, cells }: Pick<ArchitectureMatrix, "rows" | "cells">): string {
  return cells.map((cell) => `${rows[cell.row].key}>${rows[cell.column].key}=${cell.fileEdgeCount}`).sort(byCodeUnit).join(";");
}

/** A CSV field: quoted when needed, and a leading formula character neutralised (CSV injection). */
function csvField(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** The whole matrix for a spreadsheet: a label column, one column per row (empty = 0), then Ce, Ca and I. */
export function matrixToCsv(matrix: ArchitectureMatrix): string {
  const width = matrix.rows.length;
  const grid = matrix.rows.map((): (number | null)[] => Array.from({ length: width }, () => null));
  for (const cell of matrix.cells) grid[cell.row][cell.column] = cell.fileEdgeCount;
  const lines = [
    ["row imports column", ...matrix.rows.map((row) => row.label), "Ce", "Ca", "I"],
    ...matrix.rows.map((row, index) => [row.label, ...grid[index], row.outgoingPairs, row.incomingPairs, row.instability]),
  ];
  return `${lines.map((line) => line.map(csvField).join(",")).join("\n")}\n`;
}
