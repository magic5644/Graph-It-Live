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
    cut: "The cells of a cycle that go against one order of its units (the matrix order or its reverse, the cheaper); without them the units are layered again.",
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
 * One cut per cycle block: the cells against the matrix order or against its reverse, the one
 * with fewer pairs. Any order gives a valid cut; two orders make it exact for a two-unit cycle.
 * shortcut: not the minimum cut of a larger block (NP-hard), switch to a heuristic search if blocks of 3+ units need it.
 */
export function cycleCuts(matrix: ArchitectureMatrix<string>): CycleCut[] {
  return matrix.cycles.map(({ firstRow, lastRow, members }) => {
    const inside = matrix.cells.filter((cell) => cell.row !== cell.column
      && cell.row >= firstRow && cell.row <= lastRow && cell.column >= firstRow && cell.column <= lastRow);
    const upward = inside.filter((cell) => cell.upward);
    const cuts = [upward, inside.filter((cell) => !cell.upward)]
      .map((cells) => ({ members, cells, pairs: cells.reduce((total, cell) => total + cell.fileEdgeCount, 0) }));
    // An empty side is no cut (a malformed matrix): keep the other one.
    const [first, second] = cuts.filter((cut) => cut.cells.length > 0);
    if (second === undefined) return first ?? cuts[0];
    return first.pairs <= second.pairs ? first : second;
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

function weakDependencies(input: AssessmentInput, pairs: Map<string, Edge[]>): QuickWin[] {
  return input.units.unitEdges
    .filter((edge) => edge.kind !== "cycle" && edge.fileEdgeCount <= ASSESSMENT_THRESHOLDS.cheapPairs)
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

function deadCode(input: AssessmentInput): QuickWin[] {
  const imported = new Set(input.graph.edges.map((edge) => edge.targetRelative));
  return input.deadCode.filter((file) => file.unusedSymbols.length > 0).map((file) => {
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
function deadFileGroups(input: AssessmentInput): DeadFileGroup[] {
  const groups = new Map<string, DeadFile[]>();
  for (const file of input.deadFiles ?? []) {
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

/** The dead files, the quick wins (ranked by gain / effort, then gain, then kind) and the matrix findings of an architecture. */
export function assessArchitecture(input: AssessmentInput): ArchitectureAssessment {
  const pairs = pairsByUnitEdge(input);
  const mutual = mutualPairs(input);
  const { wins: mutualWins, hotSpot } = mutualImports(input, mutual);
  const quickWins = [...cycleBreaks(input, cycleCuts(input.matrix), pairs), ...mutualWins, ...weakDependencies(input, pairs), ...deadCode(input)]
    // Cross products compare gain / effort without rounding.
    .sort((left, right) => right.gain * left.effort - left.gain * right.effort || right.gain - left.gain
      || KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind) || byCodeUnit(left.subject, right.subject));
  const deadFiles = deadFileGroups(input);
  return {
    deadFiles,
    quickWins,
    matrixFindings: rowFindings(input),
    glossary: glossary(input.matrix),
    totals: {
      files: input.unitOf.size,
      units: input.units.units.length,
      unitEdges: input.units.unitEdges.length,
      unitCycles: input.units.cycles,
      mutualImports: mutual.length,
      ...(hotSpot === undefined ? {} : { mutualHotSpot: hotSpot }),
      acceptedViolations: input.acceptedViolations,
      deadFiles: input.deadFiles?.length ?? 0,
      deadFileLines: deadFiles.reduce((total, group) => total + group.lines, 0),
      deadCodeFiles: input.deadCode.filter((file) => file.unusedSymbols.length > 0).length,
      unusedExports: input.deadCode.reduce((total, file) => total + file.unusedSymbols.length, 0),
      unusedExportsMedium: input.deadCodeBelowHigh?.medium ?? 0,
      unusedExportsLow: input.deadCodeBelowHigh?.low ?? 0,
    },
    thresholds: ASSESSMENT_THRESHOLDS,
  };
}
