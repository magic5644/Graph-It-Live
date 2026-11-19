/**
 * Text and markdown views of `graph-it architecture --level units | --folder | --from/--to | --matrix`:
 * the tables a human reads, where json/toon carry the full data.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import type { ArchitectureMatrix, CommunityGroupAggregation } from "../../shared/architecture-model.js";

type Cell = string | number | null;

export interface ViewTable {
  title: string;
  headers: string[];
  rows: Cell[][];
}

export interface ArchitectureView {
  title: string;
  notes: string[];
  tables: ViewTable[];
}

const text = (value: Cell): string => (value === null ? "" : String(value));

function renderTextTable({ title, headers, rows }: ViewTable): string[] {
  if (rows.length === 0) return [`${title}: none`];
  // reduce, not Math.max(...rows): a matrix may have more cells than a call takes arguments.
  const widths = headers.map((header, column) => rows.reduce((width, row) => Math.max(width, text(row[column]).length), header.length));
  const line = (cells: Cell[]) => cells.map((cell, column) => text(cell).padEnd(widths[column])).join("  ").trimEnd();
  return [`${title}:`, `  ${line(headers)}`, ...rows.map((row) => `  ${line(row)}`)];
}

function renderMarkdownTable({ title, headers, rows }: ViewTable): string[] {
  if (rows.length === 0) return [`### ${title}`, "", "_None._"];
  const escapedPipe = String.raw`\|`;
  const line = (cells: Cell[]) => `| ${cells.map((cell) => text(cell).replaceAll("|", escapedPipe)).join(" | ")} |`;
  return [`### ${title}`, "", line(headers), line(headers.map(() => "---")), ...rows.map(line)];
}

export function renderArchitectureView(view: ArchitectureView, format: "text" | "markdown"): string {
  if (format === "markdown") {
    const sections = view.tables.map((table) => renderMarkdownTable(table).join("\n"));
    return [`## ${view.title}`, "", ...view.notes.flatMap((note) => [note, ""]), sections.join("\n\n")].join("\n");
  }
  return [view.title, ...view.notes.map((note) => `  ${note}`), "", ...view.tables.flatMap((table) => [...renderTextTable(table), ""])]
    .join("\n")
    .trimEnd();
}

interface UnitsLike {
  units: Array<{ key: string; layer: number; role: string; fileCount: number }>;
  unitEdges: Array<{ from: string; to: string; fileEdgeCount: number; kind: string }>;
  layerCount: number;
  cycles: number;
  upwardEdges: number;
}

export function unitsView(units: UnitsLike): ArchitectureView {
  return {
    title: "Units",
    notes: [
      `${units.units.length} unit(s) in ${units.layerCount} layer(s), 0 = depends on no other unit; ${units.cycles} cycle(s), ${units.upwardEdges} upward edge(s).`,
      "Next: graph-it architecture --level units --from <unit> --to <unit> lists the file pairs of an edge; add --matrix for the matrix.",
    ],
    tables: [
      { title: "Units", headers: ["Unit", "Layer", "Role", "Files"], rows: units.units.map((unit) => [unit.key, unit.layer, unit.role, unit.fileCount]) },
      {
        title: "Unit edges",
        headers: ["From", "To", "File pairs", "Kind"],
        rows: units.unitEdges.map((edge) => [edge.from, edge.to, edge.fileEdgeCount, edge.kind]),
      },
    ],
  };
}

export function folderView(folder: string, nestedGroups: number[], groups: CommunityGroupAggregation): ArchitectureView {
  const keyOf = new Map(groups.groups.map((group) => [group.id, group.key]));
  const key = (id: number) => keyOf.get(id) ?? "(unassigned)";
  const nested = nestedGroups.map(key);
  return {
    title: `Folder ${folder}`,
    notes: [
      `${groups.groups.length} group(s), ${groups.totals.files} file(s), ${groups.totals.interGroupEdges} file pair(s) between groups.`,
      ...(nested.length > 0 ? [`Groups with sub-folders: ${nested.join(", ")} (graph-it architecture --folder <key> opens one).`] : []),
    ],
    tables: [
      { title: "Groups", headers: ["Group", "Files", "Internal pairs"], rows: groups.groups.map((group) => [group.key, group.fileCount, group.internalEdgeCount]) },
      {
        title: "Group edges",
        headers: ["From", "To", "File pairs"],
        rows: groups.groupEdges.map((edge) => [key(edge.from), key(edge.to), edge.fileEdgeCount]),
      },
    ],
  };
}

interface EvidenceLike {
  from: { key: string };
  to: { key: string };
  kind?: string;
  pairs: Array<{ source: string; target: string }>;
}

export function evidenceView(evidence: EvidenceLike): ArchitectureView {
  return {
    title: `Unit edge ${evidence.from.key} → ${evidence.to.key}`,
    notes: [evidence.kind === undefined ? "No file of the first unit imports the second." : `${evidence.pairs.length} file pair(s), kind ${evidence.kind}.`],
    tables: [{ title: "File pairs", headers: ["Source", "Target"], rows: evidence.pairs.map((pair) => [pair.source, pair.target]) }],
  };
}

export function matrixView(level: string, matrix: ArchitectureMatrix): ArchitectureView {
  const label = (row: number) => matrix.rows[row].label;
  const cells = matrix.cells.filter((cell) => cell.row !== cell.column);
  return {
    title: `Dependency matrix (${level})`,
    notes: [
      `${matrix.rows.length} row(s), ${cells.length} non-zero cell(s). A cell counts the file pairs where the row imports the column; an upward cell belongs to a cycle.`,
      // Members are row keys; the unassigned group's key is "", its label is not.
      ...matrix.cycles.map((cycle, index) => `Cycle ${index + 1}: ${matrix.rows.slice(cycle.firstRow, cycle.lastRow + 1).map((row) => row.label).join(", ")}.`),
      "Ce = outgoing pairs, Ca = incoming pairs, I = Ce / (Ca + Ce). The whole grid: --format csv.",
    ],
    tables: [
      {
        title: "Rows",
        headers: ["Row", "Ce", "Ca", "I"],
        rows: matrix.rows.map((row) => [row.label, row.outgoingPairs, row.incomingPairs, row.instability]),
      },
      {
        title: "Cells",
        headers: ["Row", "Column", "File pairs", "Upward"],
        rows: cells.map((cell) => [label(cell.row), label(cell.column), cell.fileEdgeCount, cell.upward ? "yes" : ""]),
      },
    ],
  };
}
