/**
 * The assessment `graph-it init` prints (#664): quick wins ranked by effort, and the dependency
 * matrix translated into findings. It reads the analyses that already exist (architecture graph,
 * units, unit matrix, dead-code scan) and adds none. A finding is a lead, never a verdict.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import type { ArchitectureMatrix, ArchitectureUnits, MatrixCell } from "../../shared/architecture-model";
import type { ArchitectureGraph } from "./ArchitectureGraphBuilder";
import { byCodeUnit } from "./architectureUnits";

/** Fixed thresholds of the findings, documented in docs/CLI.md (graph-it init). */
export const ASSESSMENT_THRESHOLDS = {
  /** A cycle cut or a unit dependency backed by at most this many file pairs is cheap. */
  cheapPairs: 2,
  /** Hub at risk: at least this many incoming pairs (Ca) and at least this instability (I). */
  hubIncomingPairs: 10,
  hubInstability: 0.5,
  /** Wide row: imports at least this many other units. */
  wideOutgoingUnits: 5,
  /** Weak cohesion: C = diagonal / (diagonal + Ce) below this, for units of at least `cohesionMinFiles` files. */
  cohesionRatio: 0.25,
  cohesionMinFiles: 3,
  /** Evidence lines kept per item; the total is always given. */
  evidence: 5,
} as const;

/** One file of the dead-code scan (scan_dead_code, `graph-it check`) with its unused exports. */
export interface DeadCodeFile {
  relativePath: string;
  unusedSymbols: readonly { name: string; line: number }[];
}

export type QuickWinKind = "cycle-break" | "mutual-import" | "weak-dependency" | "dead-code";

export interface QuickWin {
  kind: QuickWinKind;
  /** Imports or symbols to change. */
  effort: number;
  subject: string;
  /** `file:line -> file` import lines, or `file:line symbol` unused exports; at most `evidence`. */
  evidence: string[];
  totalEvidence: number;
  /** Unit keys the item is about, to link its diagram. */
  units: string[];
  next: string;
}

export type MatrixFindingKind = "upward-cell" | "cycle-block" | "hub-at-risk" | "wide-row" | "entry-row" | "cohesion";

export interface MatrixFinding {
  kind: MatrixFindingKind;
  /** Row keys (units). */
  rows: string[];
  /** `from>to=pairs` cells. */
  cells: string[];
  evidence: string[];
  totalEvidence: number;
  formula: string;
  action: string;
}

export interface ArchitectureAssessment {
  quickWins: QuickWin[];
  matrixFindings: MatrixFinding[];
  totals: {
    units: number;
    unitEdges: number;
    unitCycles: number;
    mutualImports: number;
    acceptedViolations: number;
    deadCodeFiles: number;
    unusedExports: number;
  };
  thresholds: typeof ASSESSMENT_THRESHOLDS;
}

export interface AssessmentInput {
  graph: Pick<ArchitectureGraph, "edges">;
  units: Pick<ArchitectureUnits, "units" | "unitEdges" | "cycles">;
  unitOf: ReadonlyMap<string, string>;
  matrix: ArchitectureMatrix<string>;
  deadCode: readonly DeadCodeFile[];
  acceptedViolations: number;
}

const FORMULAS = {
  cut: "Cut = the cells of a cycle block that go against one order of its rows (the matrix order or its reverse, the cheaper); without them every cell sits below the diagonal.",
  wide: "Ce = outgoingPairs (file pairs to other rows); outgoingGroups = the rows they reach.",
  entry: "Ca = incomingPairs = 0: no file of another row imports this row.",
  cohesion: "C = diagonal / (diagonal + Ce): the share of the row's file pairs that stay inside it.",
} as const;

type Edge = AssessmentInput["graph"]["edges"][number];

const importLine = (edge: Edge) => `${edge.sourceRelative}${edge.line === undefined ? "" : ":" + edge.line} -> ${edge.targetRelative}`;

function capped(lines: readonly string[]): Pick<QuickWin, "evidence" | "totalEvidence"> {
  const sorted = lines.toSorted(byCodeUnit);
  return { evidence: sorted.slice(0, ASSESSMENT_THRESHOLDS.evidence), totalEvidence: sorted.length };
}

/** The import lines of every unit edge, keyed `from>to`. */
function pairsByUnitEdge(input: AssessmentInput): Map<string, Edge[]> {
  const pairs = new Map<string, Edge[]>();
  for (const edge of input.graph.edges) {
    const from = input.unitOf.get(edge.sourceRelative);
    const to = input.unitOf.get(edge.targetRelative);
    if (from === undefined || to === undefined || from === to) continue;
    pairs.set(`${from}>${to}`, [...(pairs.get(`${from}>${to}`) ?? []), edge]);
  }
  return pairs;
}

interface CycleCut {
  members: string[];
  cells: MatrixCell[];
  pairs: number;
  /** The block's cells above the diagonal, as the matrix shows them. */
  upward: MatrixCell[];
}

/**
 * One cut per cycle block: the cells against the matrix order or against its reverse, the one
 * with fewer pairs. Any order gives a valid cut; two orders make it exact for a two-unit cycle.
 * shortcut: not the minimum cut of a larger block (NP-hard), switch to a heuristic search if blocks of 3+ units need it.
 */
function cycleCuts(matrix: ArchitectureMatrix<string>): CycleCut[] {
  return matrix.cycles.map(({ firstRow, lastRow, members }) => {
    const inside = matrix.cells.filter((cell) => cell.row !== cell.column
      && cell.row >= firstRow && cell.row <= lastRow && cell.column >= firstRow && cell.column <= lastRow);
    const upward = inside.filter((cell) => cell.upward);
    const cuts = [upward, inside.filter((cell) => !cell.upward)]
      .map((cells) => ({ members, cells, pairs: cells.reduce((total, cell) => total + cell.fileEdgeCount, 0), upward }));
    // An empty side is no cut (a malformed matrix): keep the other one.
    const [first, second] = cuts.filter((cut) => cut.cells.length > 0);
    if (second === undefined) return first ?? cuts[0];
    return first.pairs <= second.pairs ? first : second;
  });
}

const cellKey = (matrix: ArchitectureMatrix<string>, cell: MatrixCell) => `${matrix.rows[cell.row].key}>${matrix.rows[cell.column].key}`;
const unitEdgeCommand = (from: string, to: string) => `graph-it architecture --level units --from ${JSON.stringify(from)} --to ${JSON.stringify(to)}`;

function cycleBreaks(input: AssessmentInput, cuts: readonly CycleCut[], pairs: Map<string, Edge[]>): QuickWin[] {
  return cuts.filter((cut) => cut.cells.length > 0 && cut.pairs <= ASSESSMENT_THRESHOLDS.cheapPairs).map((cut) => {
    const keys = cut.cells.map((cell) => cellKey(input.matrix, cell));
    const [from, to] = keys[0].split(">");
    return {
      kind: "cycle-break",
      effort: cut.pairs,
      subject: `Break the cycle of ${cut.members.join(", ")}: remove or move ${cut.pairs} import(s) (${keys.join(", ")})`,
      ...capped(keys.flatMap((key) => (pairs.get(key) ?? []).map(importLine))),
      units: cut.members,
      next: unitEdgeCommand(from, to),
    };
  });
}

/** Two files importing each other: removing one import breaks the file cycle. */
function mutualImports(input: AssessmentInput): QuickWin[] {
  const byPair = new Map(input.graph.edges.map((edge) => [`${edge.sourceRelative}\0${edge.targetRelative}`, edge]));
  // One item per file pair, from the first file in code-unit order.
  return [...byPair.values()].flatMap((edge) => {
    const back = byPair.get(`${edge.targetRelative}\0${edge.sourceRelative}`);
    if (back === undefined || edge.sourceRelative >= edge.targetRelative) return [];
    const units = [...new Set([input.unitOf.get(edge.sourceRelative), input.unitOf.get(edge.targetRelative)])].filter((unit) => unit !== undefined);
    return [{
      kind: "mutual-import" as const,
      effort: 1,
      subject: `${edge.sourceRelative} and ${edge.targetRelative} import each other: remove or move one import`,
      ...capped([importLine(edge), importLine(back)]),
      units,
      next: `graph-it cycles ${JSON.stringify(edge.sourceRelative)}`,
    }];
  });
}

function weakDependencies(input: AssessmentInput, pairs: Map<string, Edge[]>): QuickWin[] {
  return input.units.unitEdges
    .filter((edge) => edge.kind !== "cycle" && edge.fileEdgeCount <= ASSESSMENT_THRESHOLDS.cheapPairs)
    .map((edge) => ({
      kind: "weak-dependency" as const,
      effort: edge.fileEdgeCount,
      subject: `${edge.from} depends on ${edge.to} through ${edge.fileEdgeCount} file pair(s): remove it before freezing it in allowOnly`,
      ...capped((pairs.get(`${edge.from}>${edge.to}`) ?? []).map(importLine)),
      units: [edge.from, edge.to],
      next: unitEdgeCommand(edge.from, edge.to),
    }));
}

function deadCode(input: AssessmentInput): QuickWin[] {
  const imported = new Set(input.graph.edges.map((edge) => edge.targetRelative));
  return input.deadCode.filter((file) => file.unusedSymbols.length > 0).map((file) => {
    const unit = input.unitOf.get(file.relativePath);
    const unreferenced = imported.has(file.relativePath) ? "" : "; no file imports it";
    return {
      kind: "dead-code" as const,
      effort: file.unusedSymbols.length,
      subject: `${file.relativePath}: ${file.unusedSymbols.length} unused export(s)${unreferenced}`,
      ...capped(file.unusedSymbols.map((symbol) => `${file.relativePath}:${symbol.line} ${symbol.name}`)),
      units: unit === undefined ? [] : [unit],
      next: `graph-it check ${JSON.stringify(file.relativePath)}`,
    };
  });
}

const KIND_ORDER: readonly QuickWinKind[] = ["cycle-break", "mutual-import", "weak-dependency", "dead-code"];

/** The cheapest upward cell of a cycle block; none when the block has no upward cell (a malformed matrix). */
function upwardFinding(matrix: ArchitectureMatrix<string>, cut: CycleCut, pairs: Map<string, Edge[]>): MatrixFinding[] {
  const cheapest = cut.upward.toSorted((left, right) => left.fileEdgeCount - right.fileEdgeCount || left.row - right.row).at(0);
  if (cheapest === undefined) return [];
  const key = cellKey(matrix, cheapest);
  return [{
    kind: "upward-cell",
    rows: key.split(">"),
    cells: [`${key}=${cheapest.fileEdgeCount}`],
    ...capped((pairs.get(key) ?? []).map(importLine)),
    formula: matrix.formulas.upward,
    action: `The cheapest upward cell of this cycle (${cheapest.fileEdgeCount} file pair(s)): the edge to cut first.`,
  }];
}

function cycleFindings(input: AssessmentInput, cuts: readonly CycleCut[], pairs: Map<string, Edge[]>): MatrixFinding[] {
  const { matrix } = input;
  return cuts.flatMap((cut) => {
    const cells = cut.cells.map((cell) => `${cellKey(matrix, cell)}=${cell.fileEdgeCount}`);
    return [
      ...upwardFinding(matrix, cut, pairs),
      {
        kind: "cycle-block" as const,
        rows: cut.members,
        cells,
        ...capped(cut.cells.flatMap((cell) => (pairs.get(cellKey(matrix, cell)) ?? []).map(importLine))),
        formula: FORMULAS.cut,
        action: `${cut.members.length} units cannot be layered: removing ${cut.pairs} file pair(s) on ${cut.cells.length} cell(s) layers them again.`,
      },
    ];
  });
}

function rowFindings(input: AssessmentInput): MatrixFinding[] {
  const { matrix } = input;
  const fileCount = new Map(input.units.units.map((unit) => [unit.key, unit.fileCount]));
  const deadFiles = new Map<string, number>();
  for (const file of input.deadCode) {
    const unit = input.unitOf.get(file.relativePath);
    if (unit !== undefined) deadFiles.set(unit, (deadFiles.get(unit) ?? 0) + 1);
  }
  const t = ASSESSMENT_THRESHOLDS;
  const row = (kind: MatrixFindingKind, key: string, formula: string, action: string): MatrixFinding =>
    ({ kind, rows: [key], cells: [], evidence: [], totalEvidence: 0, formula, action });
  return [
    ...matrix.rows
      .filter((r) => r.incomingPairs >= t.hubIncomingPairs && (r.instability ?? 0) >= t.hubInstability)
      .map((r) => row("hub-at-risk", r.key, matrix.formulas.instability,
        `Ca = ${r.incomingPairs} from ${r.incomingGroups} unit(s), I = ${r.instability}: a change here ripples. Stabilize it (fewer outgoing dependencies) or split it.`)),
    ...matrix.rows
      .filter((r) => r.outgoingGroups >= t.wideOutgoingUnits)
      .toSorted((left, right) => right.outgoingPairs - left.outgoingPairs || byCodeUnit(left.key, right.key))
      .map((r) => row("wide-row", r.key, FORMULAS.wide,
        `Ce = ${r.outgoingPairs} to ${r.outgoingGroups} units: a candidate to split or to put behind an interface.`)),
    ...matrix.rows
      .filter((r) => r.incomingPairs === 0)
      .map((r) => row("entry-row", r.key, FORMULAS.entry,
        `An entry point, or a unit nothing uses: ${deadFiles.get(r.key) ?? 0} of its files have unused exports.`)),
    ...matrix.rows
      .filter((r) => (fileCount.get(r.key) ?? 0) >= t.cohesionMinFiles && r.outgoingPairs > 0
        && r.internalEdgeCount / (r.internalEdgeCount + r.outgoingPairs) < t.cohesionRatio)
      .map((r) => row("cohesion", r.key, FORMULAS.cohesion,
        `C = ${r.internalEdgeCount}/${r.internalEdgeCount + r.outgoingPairs}: its files depend more on other units than on each other. Merge it or re-cut it.`)),
  ];
}

/** The quick wins (ranked by effort, then kind) and the matrix findings of an architecture. */
export function assessArchitecture(input: AssessmentInput): ArchitectureAssessment {
  const pairs = pairsByUnitEdge(input);
  const cuts = cycleCuts(input.matrix);
  const mutual = mutualImports(input);
  const quickWins = [...cycleBreaks(input, cuts, pairs), ...mutual, ...weakDependencies(input, pairs), ...deadCode(input)]
    .sort((left, right) => left.effort - right.effort
      || KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind) || byCodeUnit(left.subject, right.subject));
  return {
    quickWins,
    matrixFindings: [...cycleFindings(input, cuts, pairs), ...rowFindings(input)],
    totals: {
      units: input.units.units.length,
      unitEdges: input.units.unitEdges.length,
      unitCycles: input.units.cycles,
      mutualImports: mutual.length,
      acceptedViolations: input.acceptedViolations,
      deadCodeFiles: input.deadCode.filter((file) => file.unusedSymbols.length > 0).length,
      unusedExports: input.deadCode.reduce((total, file) => total + file.unusedSymbols.length, 0),
    },
    thresholds: ASSESSMENT_THRESHOLDS,
  };
}
