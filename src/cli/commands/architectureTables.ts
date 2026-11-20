/**
 * Text and markdown views of `graph-it architecture --level units | --folder | --from/--to | --matrix | --coupling`:
 * the tables a human reads, where json/toon carry the full data.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { unitMatrix } from "../../analyzer/architecture/architectureMatrix.js";
import { evidenceCell, linksCell, pairsCell, rulesCell } from "../../mcp/markdownViews.js";
import type { ArchitectureCoupling, ArchitectureMatrix, ArchitectureUnit, ArchitectureUnits, CommunityGroupAggregation } from "../../shared/architecture-model.js";

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

type UnitsLike = Pick<ArchitectureUnits, "units" | "unitEdges" | "layerCount" | "cycles" | "upwardEdges" | "unitsFrom" | "configFile" | "configWarnings" | "rules">;

export function unitsView(units: UnitsLike): ArchitectureView {
  // The key is what --from/--to/--focus take; the Name column (package, artifact or module name) shows only when one differs (#774).
  const named = units.units.some((unit) => unit.name !== unit.key);
  const ruled = units.rules !== undefined;
  const unitRules = ruled && units.units.some((unit) => unit.rules !== undefined && unit.rules.length > 0);
  const unitRow = (unit: ArchitectureUnit): Cell[] => [
    unit.key, ...(named ? [unit.name] : []), unit.layer, unit.role, evidenceCell(unit), unit.fileCount, ...(unitRules ? [rulesCell(unit.rules)] : []),
  ];
  const fromElements = units.unitsFrom === "elements";
  const between = fromElements ? "declared elements" : "detected projects";
  const cycles = unitMatrix(units).cycles.map((cycle) => [cycle.members.join(", ")]);
  return {
    title: fromElements ? `Units: declared elements of ${units.configFile ?? "graphit.architecture.json"}` : "Units: detected projects",
    notes: [
      `${units.units.length} unit(s) in ${units.layerCount} layer(s), 0 = depends on no other unit; ${units.cycles} cycle(s), ${units.upwardEdges} upward edge(s).`,
      "Evidence: declared (roles in the config), else the first evidence of the inferred role (--format json lists every one).",
      "Next: graph-it architecture --level units --from <unit> --to <unit> lists the file pairs of an edge; add --matrix for the matrix.",
    ],
    tables: [
      ...(units.configWarnings === undefined ? [] : [{ title: "Config warnings", headers: ["Warning"], rows: units.configWarnings.map((warning) => [warning]) }]),
      {
        title: "Units",
        headers: ["Unit", ...(named ? ["Name"] : []), "Layer", "Role", "Evidence", "Files", ...(unitRules ? ["Rules"] : [])],
        rows: units.units.map(unitRow),
      },
      {
        title: "Unit edges",
        headers: ["From", "To", "File pairs", "Kind", ...(ruled ? ["Rules"] : [])],
        rows: units.unitEdges.map((edge) => [edge.from, edge.to, edge.fileEdgeCount, edge.kind, ...(ruled ? [rulesCell(edge.rules)] : [])]),
      },
      { title: `Cycles between ${between}`, headers: ["Units"], rows: cycles },
      ...(units.rules === undefined ? [] : [{
        title: "Rules",
        headers: ["Rule", "Kind", "Severity", "Violations", "New"],
        rows: units.rules.map((rule) => [rule.name, rule.kind, rule.severity, rule.violations, rule.newViolations]),
      }]),
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

/** Rows per coupling table in text and markdown: the heaviest first, json and toon list every one. */
export const COUPLING_ROWS = 50;

export function couplingView(level: string, coupling: ArchitectureCoupling): ArchitectureView {
  const { coupledPairs, bridgingFiles, formulas } = coupling;
  const cut = coupledPairs.length > COUPLING_ROWS || bridgingFiles.length > COUPLING_ROWS;
  const shown = (total: number) => Math.min(total, COUPLING_ROWS);
  const next = level === "units"
    ? "Next: graph-it architecture --level units --from <a> --to <b> lists every file pair of one direction."
    : "Next: --format json lists up to 3 evidence pairs per item; the MCP tool explore_architecture with from and to lists every file pair of an edge.";
  return {
    title: `Coupling (${level})`,
    notes: [
      `${coupledPairs.length} coupled pair(s), ${bridgingFiles.length} bridging file(s).`,
      ...(cut
        ? [`Showing the first ${shown(coupledPairs.length)} pair(s) and ${shown(bridgingFiles.length)} file(s); --format json or toon lists them all.`]
        : []),
      formulas.coupledPair,
      formulas.bridgingFile,
      next,
    ],
    tables: [
      {
        title: "Most coupled pairs",
        headers: ["A", "B", "A → B", "B → A", "File pairs", "Mutual", "Evidence"],
        rows: coupledPairs.slice(0, COUPLING_ROWS).map((pair) => [pair.aLabel, pair.bLabel, pair.aToB, pair.bToA, pair.fileEdgeCount, pair.mutual ? "yes" : "", pairsCell(pair.evidence)]),
      },
      {
        title: "Bridging files",
        headers: ["File", "Group", "Groups", "File pairs", "Links"],
        rows: bridgingFiles.slice(0, COUPLING_ROWS).map((file) => [file.file, file.groupLabel, file.groupCount, file.fileEdgeCount, linksCell(file.links)]),
      },
    ],
  };
}
