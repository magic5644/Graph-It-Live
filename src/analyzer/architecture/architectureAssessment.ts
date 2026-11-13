/**
 * The assessment `graph-it init` prints (#664, #716): dead files, quick wins ranked by gain over
 * effort, and the dependency matrix translated into findings. It reads the analyses that already
 * exist (architecture graph, units, unit matrix, dead-code scans) and adds none. A finding is a
 * lead, never a verdict.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import type { ArchitectureMatrix, ArchitectureUnits, MatrixCell } from "../../shared/architecture-model";
import type { ArchitectureGraph } from "./ArchitectureGraphBuilder";
import { byCodeUnit, ROOT_UNIT } from "./architectureUnits";

/** Fixed thresholds of the findings, documented in docs/CLI.md (graph-it init). */
export const ASSESSMENT_THRESHOLDS = {
  /** A unit dependency backed by at most this many file pairs is cheap. */
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

/** A file no production file imports (scan_dead_code `unreferencedFiles`, #711), with its line count. */
export interface DeadFile {
  relativePath: string;
  /** Undefined when the file could not be read (too large, binary, gone). */
  lines?: number;
  exports: number;
  /** `low` (`no-importer`) or `medium` (`test-only-use`), as the scan reports it. */
  confidence: string;
  reasons: readonly string[];
}

/** The dead files of one unit, largest first. */
export interface DeadFileGroup {
  unit: string;
  /** Lines of the files that could be read. */
  lines: number;
  files: DeadFile[];
}

export type QuickWinKind = "cycle-break" | "mutual-import" | "weak-dependency" | "dead-code";

export interface QuickWin {
  kind: QuickWinKind;
  /** What it removes: units layered again (cycle-break), file cycles (mutual-import), unit edges (weak-dependency), exports (dead-code). */
  gain: number;
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

export type MatrixFindingKind = "hub-at-risk" | "wide-row" | "entry-row" | "cohesion";

export interface MatrixFinding {
  kind: MatrixFindingKind;
  /** Row keys (units). */
  rows: string[];
  /** `from>to=pairs` cells. */
  cells: string[];
  evidence: string[];
  totalEvidence: number;
  action: string;
}

export interface ArchitectureAssessment {
  deadFiles: DeadFileGroup[];
  quickWins: QuickWin[];
  matrixFindings: MatrixFinding[];
  /** The terms and formulas the findings use, stated once. */
  glossary: Record<string, string>;
  totals: {
    files: number;
    units: number;
    unitEdges: number;
    unitCycles: number;
    mutualImports: number;
    /** The file in the most mutual imports, when it is in more than one. */
    mutualHotSpot?: { file: string; pairs: number };
    acceptedViolations: number;
    deadFiles: number;
    deadFileLines: number;
    deadCodeFiles: number;
    unusedExports: number;
    /** Unused exports below the high confidence the quick wins list (`graph-it check --minConfidence`) */
    unusedExportsMedium: number;
    unusedExportsLow: number;
  };
  thresholds: typeof ASSESSMENT_THRESHOLDS;
}

export interface AssessmentInput {
  graph: Pick<ArchitectureGraph, "edges">;
  units: Pick<ArchitectureUnits, "units" | "unitEdges" | "cycles">;
  unitOf: ReadonlyMap<string, string>;
  matrix: ArchitectureMatrix<string>;
  /** High-confidence unused exports only: safe deletion proposals */
  deadCode: readonly DeadCodeFile[];
  /** Files no production file imports */
  deadFiles?: readonly DeadFile[];
  /** Unused exports below high confidence, counted and never listed */
  deadCodeBelowHigh?: { medium: number; low: number };
  acceptedViolations: number;
}

/** Unit outside every package and folder of the assignment: its dead files are still listed. */
const NO_UNIT = ROOT_UNIT;

function glossary(matrix: ArchitectureMatrix<string>): Record<string, string> {
  return {
    "file pair": "A file importing another file; a unit edge counts the distinct file pairs behind it.",
    Ca: "Afferent coupling: file pairs where a file of another unit imports this unit.",
    Ce: "Efferent coupling: file pairs where this unit imports a file of another unit.",
    I: `Instability. ${matrix.formulas.instability} 0: only imported (stable), 1: only imports (free to change).`,
    C: "Cohesion. C = diagonal / (diagonal + Ce): the share of the unit's file pairs that stay inside it.",
    matrix: `${matrix.formulas.cell} ${matrix.formulas.order} ${matrix.formulas.upward}`,
    cut: "The cells of a cycle that go against one order of its units (the matrix order, its reverse or a greedy Eades–Lin–Smyth order, the cheapest); without them the units are layered again.",
    "gain / effort": "Quick wins are ranked by what they remove over the imports or symbols to change, then by gain.",
  };
}

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
}

/**
 * Eades–Lin–Smyth order of one cycle block: sinks to the back, sources to the front, otherwise the
 * row whose outgoing pairs exceed its incoming ones most; the cells going back in it are a cut.
 */
function greedyOrder(rows: readonly number[], inside: readonly MatrixCell[], keyOf: (row: number) => string): Map<number, number> {
  // Pairs out of and into each row, kept up to date as rows leave the block.
  const out = new Map(rows.map((row) => [row, 0]));
  const into = new Map(rows.map((row) => [row, 0]));
  for (const cell of inside) {
    out.set(cell.row, out.get(cell.row)! + cell.fileEdgeCount);
    into.set(cell.column, into.get(cell.column)! + cell.fileEdgeCount);
  }
  const remaining = rows.toSorted((left, right) => byCodeUnit(keyOf(left), keyOf(right)));
  const alive = new Set(rows);
  const front: number[] = [];
  const back: number[] = [];
  const take = (row: number) => {
    remaining.splice(remaining.indexOf(row), 1);
    alive.delete(row);
    for (const cell of inside) {
      if (cell.row === row && alive.has(cell.column)) into.set(cell.column, into.get(cell.column)! - cell.fileEdgeCount);
      if (cell.column === row && alive.has(cell.row)) out.set(cell.row, out.get(cell.row)! - cell.fileEdgeCount);
    }
  };
  while (remaining.length > 0) {
    const sink = remaining.find((row) => out.get(row) === 0);
    const source = remaining.find((row) => into.get(row) === 0);
    const delta = (row: number) => out.get(row)! - into.get(row)!;
    const next = sink ?? source ?? remaining.reduce((best, row) => (delta(row) > delta(best) ? row : best), remaining[0]);
    if (sink === undefined) front.push(next);
    else back.unshift(next);
    take(next);
  }
  return new Map([...front, ...back].map((row, index) => [row, index]));
}

/**
 * One cut per cycle block, the cheapest of three: the cells against the matrix order, against its
 * reverse, or against the Eades–Lin–Smyth order. Each is a valid cut; the two orders make it exact for
 * a two-unit cycle, the greedy one keeps it small on a large block.
 * shortcut: not the minimum cut of a larger block (NP-hard), a heuristic; add a local search if its cuts prove too large.
 */
export function cycleCuts(matrix: ArchitectureMatrix<string>): CycleCut[] {
  return matrix.cycles.map(({ firstRow, lastRow, members }) => {
    const inside = matrix.cells.filter((cell) => cell.row !== cell.column
      && cell.row >= firstRow && cell.row <= lastRow && cell.column >= firstRow && cell.column <= lastRow);
    const rows = Array.from({ length: lastRow - firstRow + 1 }, (_unused, index) => firstRow + index);
    const order = greedyOrder(rows, inside, (row) => matrix.rows[row].key);
    const greedy = inside.filter((cell) => order.get(cell.row)! > order.get(cell.column)!);
    const cuts = [inside.filter((cell) => cell.upward), inside.filter((cell) => !cell.upward), greedy]
      .map((cells) => ({ members, cells, pairs: cells.reduce((total, cell) => total + cell.fileEdgeCount, 0) }));
    // An empty side is no cut (a malformed matrix): keep the others.
    const valid = cuts.filter((cut) => cut.cells.length > 0);
    return valid.reduce((best, cut) => (cut.pairs < best.pairs ? cut : best), valid[0] ?? cuts[0]);
  });
}

const cellKey = (matrix: ArchitectureMatrix<string>, cell: MatrixCell) => `${matrix.rows[cell.row].key}>${matrix.rows[cell.column].key}`;
const unitEdgeCommand = (from: string, to: string) => `graph-it architecture --level units --from ${JSON.stringify(from)} --to ${JSON.stringify(to)}`;

function cycleBreaks(input: AssessmentInput, cuts: readonly CycleCut[], pairs: Map<string, Edge[]>): QuickWin[] {
  return cuts.filter((cut) => cut.cells.length > 0).map((cut) => {
    const keys = cut.cells.map((cell) => cellKey(input.matrix, cell));
    const [from, to] = keys[0].split(">");
    return {
      kind: "cycle-break",
      gain: cut.members.length,
      effort: cut.pairs,
      subject: `${cut.members.join(", ")} import each other: remove or move ${cut.pairs} import(s) (${keys.join(", ")}) to layer these ${cut.members.length} units again`,
      ...capped(keys.flatMap((key) => (pairs.get(key) ?? []).map(importLine))),
      units: cut.members,
      next: unitEdgeCommand(from, to),
    };
  });
}

/** Two files importing each other: removing one import breaks the file cycle. */
function mutualPairs(input: AssessmentInput): Edge[] {
  const byPair = new Map(input.graph.edges.map((edge) => [`${edge.sourceRelative}\0${edge.targetRelative}`, edge]));
  // One edge per file pair, from the first file in code-unit order.
  return [...byPair.values()].filter((edge) => edge.sourceRelative < edge.targetRelative && byPair.has(`${edge.targetRelative}\0${edge.sourceRelative}`));
}

/**
 * The mutual imports grouped by hot spot: the file in the most remaining pairs takes them all, so
 * a file in six mutual imports is one item, not six.
 */
function mutualImports(input: AssessmentInput, mutual: readonly Edge[]): { wins: QuickWin[]; hotSpot?: { file: string; pairs: number } } {
  const backOf = new Map(input.graph.edges.map((edge) => [`${edge.sourceRelative}\0${edge.targetRelative}`, edge]));
  const wins: QuickWin[] = [];
  // The first hub takes the most pairs: the hot spot when it is in more than one.
  let hotSpot: { file: string; pairs: number } | undefined;
  let left = [...mutual];
  while (left.length > 0) {
    const count = new Map<string, number>();
    for (const edge of left) for (const file of [edge.sourceRelative, edge.targetRelative]) count.set(file, (count.get(file) ?? 0) + 1);
    const [hub] = [...count].sort((a, b) => b[1] - a[1] || byCodeUnit(a[0], b[0]))[0];
    const mine = new Set(left.filter((edge) => edge.sourceRelative === hub || edge.targetRelative === hub));
    if (wins.length === 0 && mine.size > 1) hotSpot = { file: hub, pairs: mine.size };
    left = left.filter((edge) => !mine.has(edge));
    const partners = [...mine].map((edge) => (edge.sourceRelative === hub ? edge.targetRelative : edge.sourceRelative)).sort(byCodeUnit);
    const files = [hub, ...partners];
    const units = [...new Set(files.map((file) => input.unitOf.get(file)))].filter((unit) => unit !== undefined);
    wins.push({
      kind: "mutual-import",
      gain: mine.size,
      effort: mine.size,
      subject: mine.size === 1
        ? `${hub} and ${partners[0]} import each other: remove or move one import`
        : `${hub} and ${mine.size} files import each other (${partners.join(", ")}): remove or move one import of each pair`,
      ...capped([...mine].flatMap((edge) => [edge, backOf.get(`${edge.targetRelative}\0${edge.sourceRelative}`)!]).map(importLine)),
      units,
      next: `graph-it cycles ${JSON.stringify(hub)}`,
    });
  }
  return { wins, ...(hotSpot === undefined ? {} : { hotSpot }) };
}

function weakDependencies(input: AssessmentInput, pairs: Map<string, Edge[]>, scope: FocusScope): QuickWin[] {
  return input.units.unitEdges
    .filter((edge) => edge.kind !== "cycle" && edge.fileEdgeCount <= ASSESSMENT_THRESHOLDS.cheapPairs && scope.unitEdge(pairs, edge))
    .map((edge) => ({
      kind: "weak-dependency" as const,
      gain: 1,
      effort: edge.fileEdgeCount,
      subject: `${edge.from} depends on ${edge.to} through ${edge.fileEdgeCount} file pair(s): remove it before freezing it in allowOnly`,
      ...capped((pairs.get(`${edge.from}>${edge.to}`) ?? []).map(importLine)),
      units: [edge.from, edge.to],
      next: unitEdgeCommand(edge.from, edge.to),
    }));
}

function deadCode(input: AssessmentInput, files: readonly DeadCodeFile[]): QuickWin[] {
  const imported = new Set(input.graph.edges.map((edge) => edge.targetRelative));
  return files.filter((file) => file.unusedSymbols.length > 0).map((file) => {
    const unit = input.unitOf.get(file.relativePath);
    const unreferenced = imported.has(file.relativePath) ? "" : "; no file imports it";
    return {
      kind: "dead-code" as const,
      gain: file.unusedSymbols.length,
      effort: file.unusedSymbols.length,
      subject: `${file.relativePath}: ${file.unusedSymbols.length} unused export(s)${unreferenced}`,
      ...capped(file.unusedSymbols.map((symbol) => `${file.relativePath}:${symbol.line} ${symbol.name}`)),
      units: unit === undefined ? [] : [unit],
      next: `graph-it check ${JSON.stringify(file.relativePath)}`,
    };
  });
}

const KIND_ORDER: readonly QuickWinKind[] = ["cycle-break", "mutual-import", "weak-dependency", "dead-code"];

/** The dead files by unit, the unit with the most lines first, its largest files first. */
function deadFileGroups(input: AssessmentInput, files: readonly DeadFile[]): DeadFileGroup[] {
  const groups = new Map<string, DeadFile[]>();
  for (const file of files) {
    const unit = input.unitOf.get(file.relativePath) ?? NO_UNIT;
    groups.set(unit, [...(groups.get(unit) ?? []), file]);
  }
  return [...groups].map(([unit, files]) => ({
    unit,
    lines: files.reduce((total, file) => total + (file.lines ?? 0), 0),
    // An unread file (no line count) goes last.
    files: files.toSorted((left, right) => (right.lines ?? -1) - (left.lines ?? -1) || byCodeUnit(left.relativePath, right.relativePath)),
  })).sort((left, right) => right.lines - left.lines || right.files.length - left.files.length || byCodeUnit(left.unit, right.unit));
}

function rowFindings(input: AssessmentInput): MatrixFinding[] {
  const { matrix } = input;
  const fileCount = new Map(input.units.units.map((unit) => [unit.key, unit.fileCount]));
  const deadFiles = new Map<string, number>();
  for (const file of input.deadFiles ?? []) {
    const unit = input.unitOf.get(file.relativePath) ?? NO_UNIT;
    deadFiles.set(unit, (deadFiles.get(unit) ?? 0) + 1);
  }
  const t = ASSESSMENT_THRESHOLDS;
  const row = (kind: MatrixFindingKind, key: string, action: string): MatrixFinding =>
    ({ kind, rows: [key], cells: [], evidence: [], totalEvidence: 0, action });
  return [
    ...matrix.rows
      .filter((r) => r.incomingPairs >= t.hubIncomingPairs && (r.instability ?? 0) >= t.hubInstability)
      .map((r) => row("hub-at-risk", r.key,
        `${r.incomingPairs} file pairs from ${r.incomingGroups} unit(s) import it (Ca), and it depends on others too (I = ${r.instability}): a change here ripples. Make it depend on less, or split it.`)),
    ...matrix.rows
      .filter((r) => r.outgoingGroups >= t.wideOutgoingUnits)
      .toSorted((left, right) => right.outgoingPairs - left.outgoingPairs || byCodeUnit(left.key, right.key))
      .map((r) => row("wide-row", r.key,
        `It imports ${r.outgoingGroups} other units through ${r.outgoingPairs} file pairs (Ce): split it, or put it behind an interface.`)),
    ...matrix.rows
      .filter((r) => r.incomingPairs === 0)
      .map((r) => row("entry-row", r.key,
        `No other unit imports it: an entry point, or a unit nothing uses (${deadFiles.get(r.key) ?? 0} dead file(s)).`)),
    ...matrix.rows
      .filter((r) => (fileCount.get(r.key) ?? 0) >= t.cohesionMinFiles && r.outgoingPairs > 0
        && r.internalEdgeCount / (r.internalEdgeCount + r.outgoingPairs) < t.cohesionRatio)
      .map((r) => row("cohesion", r.key,
        `Only ${r.internalEdgeCount} of its ${r.internalEdgeCount + r.outgoingPairs} file pairs stay inside it (C = ${r.internalEdgeCount}/${r.internalEdgeCount + r.outgoingPairs}): its files depend more on other units than on each other. Merge it or re-cut it.`)),
  ];
}

/** What a `--focus` keeps; every test passes without one. */
interface FocusScope {
  /** The units of the focus files, and those with the files they import or that import them. */
  rows: ReadonlySet<string> | undefined;
  file(relativePath: string): boolean;
  edge(edge: Edge): boolean;
  unit(unit: string): boolean;
  unitEdge(pairs: Map<string, Edge[]>, edge: { from: string; to: string }): boolean;
}

/**
 * The units of a focus (the units of its files) and the units of its direct neighbours (files
 * importing a focus file or imported by one), for the report and the diagrams of `init --focus`.
 */
export function focusUnits(input: Pick<AssessmentInput, "graph" | "unitOf">, focus: ReadonlySet<string>): { focus: Set<string>; withNeighbours: Set<string> } {
  const unitsOf = (files: Iterable<string>) => new Set([...files].flatMap((file) => input.unitOf.get(file) ?? []));
  const neighbours = input.graph.edges.flatMap((edge) => {
    if (focus.has(edge.sourceRelative)) return [edge.targetRelative];
    return focus.has(edge.targetRelative) ? [edge.sourceRelative] : [];
  });
  const own = unitsOf(focus);
  return { focus: own, withNeighbours: new Set([...own, ...unitsOf(neighbours)]) };
}

function focusScope(input: AssessmentInput, focus: ReadonlySet<string> | undefined): FocusScope {
  if (focus === undefined) {
    return { rows: undefined, file: () => true, edge: () => true, unit: () => true, unitEdge: () => true };
  }
  const units = focusUnits(input, focus);
  const edge = (candidate: Edge) => focus.has(candidate.sourceRelative) || focus.has(candidate.targetRelative);
  const importsFocus = new Set(input.graph.edges.filter((candidate) => focus.has(candidate.targetRelative)).map((candidate) => candidate.sourceRelative));
  return {
    rows: units.withNeighbours,
    // A dead file is in the focus, or a neighbour importing it (nothing imports a dead file).
    file: (relativePath) => focus.has(relativePath) || importsFocus.has(relativePath),
    edge,
    unit: (unit) => units.focus.has(unit),
    unitEdge: (pairs, { from, to }) => (pairs.get(`${from}>${to}`) ?? []).some(edge),
  };
}

/**
 * The dead files, the quick wins (ranked by gain / effort, then gain, then kind) and the matrix
 * findings of an architecture. With `focus` (workspace-relative files, `init --focus`), only what
 * touches those files and their direct neighbours, totals included; cycles and matrix rows are
 * still computed on the whole workspace, so a unit cycle the focus is in is kept whole.
 */
export function assessArchitecture(input: AssessmentInput, focus?: ReadonlySet<string>): ArchitectureAssessment {
  const scope = focusScope(input, focus);
  const pairs = pairsByUnitEdge(input);
  const mutual = mutualPairs(input).filter(scope.edge);
  const { wins: mutualWins, hotSpot } = mutualImports(input, mutual);
  const cuts = cycleCuts(input.matrix).filter((cut) => cut.members.some(scope.unit));
  const deadCodeFiles = input.deadCode.filter((file) => focus?.has(file.relativePath) ?? true);
  const quickWins = [...cycleBreaks(input, cuts, pairs), ...mutualWins, ...weakDependencies(input, pairs, scope), ...deadCode(input, deadCodeFiles)]
    // Cross products compare gain / effort without rounding.
    .sort((left, right) => right.gain * left.effort - left.gain * right.effort || right.gain - left.gain
      || KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind) || byCodeUnit(left.subject, right.subject));
  const deadFileList = (input.deadFiles ?? []).filter((file) => scope.file(file.relativePath));
  const deadFiles = deadFileGroups(input, deadFileList);
  const { rows } = scope;
  return {
    deadFiles,
    quickWins,
    matrixFindings: rowFindings(input).filter((finding) => rows === undefined || finding.rows.some((row) => rows.has(row))),
    glossary: glossary(input.matrix),
    totals: {
      files: focus?.size ?? input.unitOf.size,
      units: rows?.size ?? input.units.units.length,
      unitEdges: input.units.unitEdges.filter((edge) => scope.unitEdge(pairs, edge)).length,
      unitCycles: focus === undefined ? input.units.cycles : cuts.length,
      mutualImports: mutual.length,
      ...(hotSpot === undefined ? {} : { mutualHotSpot: hotSpot }),
      acceptedViolations: input.acceptedViolations,
      deadFiles: deadFileList.length,
      deadFileLines: deadFiles.reduce((total, group) => total + group.lines, 0),
      deadCodeFiles: deadCodeFiles.filter((file) => file.unusedSymbols.length > 0).length,
      unusedExports: deadCodeFiles.reduce((total, file) => total + file.unusedSymbols.length, 0),
      unusedExportsMedium: input.deadCodeBelowHigh?.medium ?? 0,
      unusedExportsLow: input.deadCodeBelowHigh?.low ?? 0,
    },
    thresholds: ASSESSMENT_THRESHOLDS,
  };
}
