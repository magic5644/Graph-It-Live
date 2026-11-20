/**
 * The assessment `graph-it init` prints (#664, #716): dead files, quick wins ranked by gain over
 * effort, and the dependency matrix translated into findings. It reads the analyses that already
 * exist (architecture graph, units, unit matrix, dead-code scans) and adds none. A finding is a
 * lead, never a verdict.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import type { ArchitectureMatrix, ArchitectureUnits, MatrixCell, UnitCycleKind } from "../../shared/architecture-model";
import type { ArchitectureGraph } from "./ArchitectureGraphBuilder";
import { unitDisplayName } from "../../shared/unitDisplayName";
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
  /** `endLine`: last line of the declaration, when the analyzer can tell. */
  unusedSymbols: readonly { name: string; line: number; endLine?: number }[];
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
  /** Dead by cascade (#726): the dead production files that import it. */
  via?: readonly string[];
  /** Tests that import nothing but dead files, deleted with it; lines undefined when unread. */
  tests?: readonly { relativePath: string; lines?: number }[];
}

/** The dead files of one unit, those nothing imports first, then those dead by cascade; largest first. */
export interface DeadFileGroup {
  unit: string;
  /** Lines of the files and of their tests to delete (each test once) that could be read. */
  lines: number;
  files: DeadFile[];
}

export type QuickWinKind = "cycle-break" | "mutual-import" | "weak-dependency" | "dead-code";

export interface QuickWin {
  kind: QuickWinKind;
  /** What it removes: units layered again (cycle-break), runtime file cycles (mutual-import), unit edges (weak-dependency), lines (dead-code). */
  gain: number;
  /** What it costs: file pairs to remove or move (cycle-break, weak-dependency), files to edit (mutual-import, dead-code); 0 ranks first. */
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
  /** The command that shows what to change (#745). */
  next: string;
}

/** One pattern of the matrix: what it means and what to do about it (#745). */
export interface MatrixPattern {
  pattern: string;
  meaning: string;
  action: string;
}

/**
 * How to read the dependency matrix, in plain words, and the action each pattern calls for: the
 * report's "How to read the matrix" section and the page's matrix panel (#745).
 */
export const MATRIX_GUIDE: { reading: string[]; patterns: MatrixPattern[] } = {
  reading: [
    "Each row imports the columns where it has a number: the file pairs from the row's unit to the column's.",
    "Rows and columns share the layering graph-it inferred: layer 0 (depends on no other unit) first, the rows of a cycle together.",
    "The diagonal counts the file pairs inside a unit: its internal coupling.",
    "Below the diagonal a dependency goes down the layers, as layering wants. A cell above it goes up: it is part of a cycle.",
    "An outlined block holds the units of one cycle, drawn by how it runs (runtime, type-only, lazy); the cells to cut to break it are marked.",
  ],
  patterns: [
    { pattern: "upward cell (cycle)", meaning: "units that import each other, directly or through others: none can change or ship alone.", action: "Cut the marked cells: move or invert those imports (see Cycles to cut)." },
    { pattern: "hub-at-risk", meaning: "many units depend on a unit that itself depends on others (high Ca and I): every change there ripples.", action: "Split out its stable part (what the others import), or invert its dependencies so it depends on less." },
    { pattern: "wide-row", meaning: "a unit that imports many others (high Ce): it knows too much.", action: "Put a facade in front of what it imports, or split it by the units it talks to." },
    { pattern: "cohesion", meaning: "a unit whose files import other units more than each other (low C): it may be several units.", action: "Split it along its folders, or move its files to the units they use." },
    { pattern: "entry-row", meaning: "no other unit imports it (empty column).", action: "Expected for apps, handlers and scripts; otherwise its files are dead: check them, then delete." },
  ],
};

/**
 * Cycles kept out of the quick wins as one item, no init-order risk: those whose every import is
 * type-only (#740), and those that close only through dynamic `import()` (#741).
 */
export interface GroupedCycles {
  unitCycles: number;
  mutualImports: number;
  /** `a <-> b` file pairs, then `units a, b` unit cycles; at most `evidence`. */
  evidence: string[];
  totalEvidence: number;
  units: string[];
}

export interface ArchitectureAssessment {
  /** Every unit with its display name (unitDisplayName): what the report and the page show for a unit key (#774). A list, so toon carries it. */
  unitNames: { key: string; name: string }[];
  deadFiles: DeadFileGroup[];
  /** Runtime cycles only: a cycle with at least one runtime import. */
  quickWins: QuickWin[];
  typeOnlyCycles: GroupedCycles;
  lazyCycles: GroupedCycles;
  matrixFindings: MatrixFinding[];
  /** How to read the matrix and the action per pattern (MATRIX_GUIDE). */
  matrixGuide: typeof MATRIX_GUIDE;
  /** The terms and formulas the findings use, stated once. */
  glossary: Record<string, string>;
  totals: {
    files: number;
    units: number;
    unitEdges: number;
    /** Runtime unit cycles and mutual imports: neither type-only nor closing only through import(). */
    unitCycles: number;
    mutualImports: number;
    typeOnlyUnitCycles: number;
    typeOnlyMutualImports: number;
    lazyUnitCycles: number;
    lazyMutualImports: number;
    /** The file in the most runtime mutual imports, when it is in more than one. */
    mutualHotSpot?: { file: string; pairs: number };
    acceptedViolations: number;
    deadFiles: number;
    deadFileLines: number;
    deadCodeFiles: number;
    unusedExports: number;
    /** Unused exports below the high confidence the quick wins list (`graph-it check --minConfidence`) */
    unusedExportsMedium: number;
    /** Medium ones per reason code (`test-only-use`, `convention:generated`…); one export may have several reasons */
    unusedExportsMediumByReason: Record<string, number>;
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
  deadCodeBelowHigh?: { medium: number; low: number; mediumByReason?: Record<string, number> };
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
    "gain / effort": "Quick wins are ranked by gain over effort (effort 0 first), then by gain. cycle-break: units layered again over file pairs to remove or move. mutual-import: runtime file cycles broken over files to edit (1: the hub, which drops its import of each partner). weak-dependency: 1 unit edge over its file pairs. dead-code: lines of the unused declarations over files to edit (0 when nothing imports the file, else 1); a dead file is listed under Dead files instead.",
    "type-only": "An import erased at runtime (import type, every specifier type, export type). A cycle is type-only when all its imports are: design coupling, no init-order risk. One runtime import makes it a runtime cycle.",
    lazy: "A dynamic import() loads its target on demand. A cycle is lazy when it is no longer a cycle without its import() calls: no init-order risk, still a dependency (rules, impact).",
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

/** The display name of a unit key; a key outside the units (NO_UNIT) names itself. */
function unitNamer(input: AssessmentInput): (key: string) => string {
  const names = new Map(input.units.units.map((unit) => [unit.key, unitDisplayName(unit)]));
  return (key) => names.get(key) ?? key;
}

function cycleBreaks(input: AssessmentInput, cuts: readonly CycleCut[], pairs: Map<string, Edge[]>): QuickWin[] {
  const name = unitNamer(input);
  return cuts.filter((cut) => cut.cells.length > 0).map((cut) => {
    const keys = cut.cells.map((cell) => cellKey(input.matrix, cell));
    const [from, to] = keys[0].split(">");
    const cells = cut.cells.map((cell) => `${name(input.matrix.rows[cell.row].key)}>${name(input.matrix.rows[cell.column].key)}`);
    return {
      kind: "cycle-break",
      gain: cut.members.length,
      effort: cut.pairs,
      subject: `${cut.members.map(name).join(", ")} import each other: remove or move ${cut.pairs} import(s) (${cells.join(", ")}) to layer these ${cut.members.length} units again`,
      ...capped(keys.flatMap((key) => (pairs.get(key) ?? []).map(importLine))),
      units: cut.members,
      next: unitEdgeCommand(from, to),
    };
  });
}

/**
 * Two files importing each other: removing one import breaks the file cycle. Type-only when both
 * imports are, lazy when one is a dynamic import(), runtime otherwise.
 */
function mutualPairs(input: AssessmentInput): { runtime: Edge[]; typeOnly: Edge[]; lazy: Edge[] } {
  const byPair = new Map(input.graph.edges.map((edge) => [`${edge.sourceRelative}\0${edge.targetRelative}`, edge]));
  const backOf = (edge: Edge) => byPair.get(`${edge.targetRelative}\0${edge.sourceRelative}`);
  // One edge per file pair, from the first file in code-unit order.
  const mutual = [...byPair.values()].filter((edge) => edge.sourceRelative < edge.targetRelative && backOf(edge) !== undefined);
  const typeOnly = (edge: Edge) => edge.typeOnly === true && backOf(edge)?.typeOnly === true;
  const lazy = (edge: Edge) => edge.dynamic === true || backOf(edge)?.dynamic === true;
  return {
    runtime: mutual.filter((edge) => !typeOnly(edge) && !lazy(edge)),
    typeOnly: mutual.filter(typeOnly),
    lazy: mutual.filter(lazy),
  };
}

/** How the unit cycle of a cut runs, as buildArchitectureUnits classified it (#745: one source for every view). */
function cutKind(input: AssessmentInput, cut: CycleCut): UnitCycleKind {
  return input.units.unitEdges.find((edge) => edge.kind === "cycle" && edge.from === cut.members[0])?.cycleKind ?? "runtime";
}

function groupedCycles(input: AssessmentInput, cuts: readonly CycleCut[], mutual: readonly Edge[]): GroupedCycles {
  const files = mutual.flatMap((edge) => [edge.sourceRelative, edge.targetRelative]);
  const units = new Set([...cuts.flatMap((cut) => cut.members), ...files.flatMap((file) => input.unitOf.get(file) ?? [])]);
  return {
    unitCycles: cuts.length,
    mutualImports: mutual.length,
    ...capped([...mutual.map((edge) => `${edge.sourceRelative} <-> ${edge.targetRelative}`), ...cuts.map((cut) => `units ${cut.members.map(unitNamer(input)).join(", ")}`)]),
    units: [...units].sort(byCodeUnit),
  };
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
      // One file to edit: the hub drops its import of each partner.
      effort: 1,
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
  const name = unitNamer(input);
  return input.units.unitEdges
    .filter((edge) => edge.kind !== "cycle" && edge.fileEdgeCount <= ASSESSMENT_THRESHOLDS.cheapPairs && scope.unitEdge(pairs, edge))
    .map((edge) => ({
      kind: "weak-dependency" as const,
      gain: 1,
      effort: edge.fileEdgeCount,
      subject: `${name(edge.from)} depends on ${name(edge.to)} through ${edge.fileEdgeCount} file pair(s): remove it before freezing it in allowOnly`,
      ...capped((pairs.get(`${edge.from}>${edge.to}`) ?? []).map(importLine)),
      units: [edge.from, edge.to],
      next: unitEdgeCommand(edge.from, edge.to),
    }));
}

function deadCode(input: AssessmentInput, files: readonly DeadCodeFile[]): QuickWin[] {
  const imported = new Set(input.graph.edges.map((edge) => edge.targetRelative));
  return files.filter((file) => file.unusedSymbols.length > 0).map((file) => {
    const unit = input.unitOf.get(file.relativePath);
    const unreferenced = !imported.has(file.relativePath);
    return {
      kind: "dead-code" as const,
      // A declaration whose end the analyzer cannot tell counts one line.
      gain: file.unusedSymbols.reduce((total, symbol) => total + Math.max(1, (symbol.endLine ?? symbol.line) - symbol.line + 1), 0),
      // Files to edit: none to delete a file nothing imports, else the file itself.
      effort: unreferenced ? 0 : 1,
      subject: `${file.relativePath}: ${file.unusedSymbols.length} unused export(s)${unreferenced ? "; no file imports it" : ""}`,
      ...capped(file.unusedSymbols.map((symbol) => `${file.relativePath}:${symbol.line} ${symbol.name}`)),
      units: unit === undefined ? [] : [unit],
      next: `graph-it check ${JSON.stringify(file.relativePath)}`,
    };
  });
}

const KIND_ORDER: readonly QuickWinKind[] = ["cycle-break", "mutual-import", "weak-dependency", "dead-code"];

/** Lines of the files that could be read, and of their tests to delete, each test once. */
function deadLines(files: readonly DeadFile[]): number {
  const tests = new Map(files.flatMap((file) => file.tests ?? []).map((test) => [test.relativePath, test.lines ?? 0]));
  return [...files.map((file) => file.lines ?? 0), ...tests.values()].reduce((total, lines) => total + lines, 0);
}

/** The dead files by unit, the unit with the most lines first, its largest files first. */
function deadFileGroups(input: AssessmentInput, files: readonly DeadFile[]): DeadFileGroup[] {
  const groups = new Map<string, DeadFile[]>();
  for (const file of files) {
    const unit = input.unitOf.get(file.relativePath) ?? NO_UNIT;
    groups.set(unit, [...(groups.get(unit) ?? []), file]);
  }
  return [...groups].map(([unit, files]) => ({
    unit,
    lines: deadLines(files),
    // Cascade files after the others; an unread file (no line count) goes last.
    files: files.toSorted((left, right) => Number(left.via !== undefined) - Number(right.via !== undefined) ||
      (right.lines ?? -1) - (left.lines ?? -1) || byCodeUnit(left.relativePath, right.relativePath)),
  })).sort((left, right) => right.lines - left.lines || right.files.length - left.files.length || byCodeUnit(left.unit, right.unit));
}

/** What to do about a matrix finding, as MATRIX_GUIDE words it. */
export const matrixAction = (kind: MatrixFindingKind) => MATRIX_GUIDE.patterns.find((pattern) => pattern.pattern === kind)!.action;

function rowFindings(input: AssessmentInput): MatrixFinding[] {
  const { matrix } = input;
  const fileCount = new Map(input.units.units.map((unit) => [unit.key, unit.fileCount]));
  // Commands take the unit folder, never its key: an element unit is named, not a path (#776).
  const folderOf = new Map(input.units.units.map((unit) => [unit.key, unit.folder]));
  const checkCommand = (folder: string) => `graph-it check${folder === "" ? "" : " " + JSON.stringify(folder)} --unreferencedFiles`;
  const deadFiles = new Map<string, number>();
  for (const file of input.deadFiles ?? []) {
    const unit = input.unitOf.get(file.relativePath) ?? NO_UNIT;
    deadFiles.set(unit, (deadFiles.get(unit) ?? 0) + 1);
  }
  const t = ASSESSMENT_THRESHOLDS;
  const row = (kind: MatrixFindingKind, key: string, facts: string, next: string): MatrixFinding =>
    ({ kind, rows: [key], cells: [], evidence: [], totalEvidence: 0, action: `${facts} ${matrixAction(kind)}`, next });
  // The heaviest cell into (or out of) a row: the unit edge to look at first.
  const heaviest = (index: number, side: "row" | "column") => matrix.cells
    .filter((cell) => cell.row !== cell.column && cell[side] === index)
    .reduce<MatrixCell | undefined>((best, cell) => (best === undefined || cell.fileEdgeCount > best.fileEdgeCount ? cell : best), undefined);
  const edgeNext = (cell: MatrixCell | undefined, fallback: string) =>
    (cell === undefined ? fallback : unitEdgeCommand(matrix.rows[cell.row].key, matrix.rows[cell.column].key));
  const folderMatrix = (key: string) => `graph-it architecture --folder ${JSON.stringify(key)} --matrix`;
  return [
    ...matrix.rows
      .flatMap((r, index) => (r.incomingPairs >= t.hubIncomingPairs && (r.instability ?? 0) >= t.hubInstability ? [{ r, index }] : []))
      .map(({ r, index }) => row("hub-at-risk", r.key,
        `${r.incomingPairs} file pairs from ${r.incomingGroups} unit(s) import it (Ca), and it depends on others too (I = ${r.instability}): a change here ripples.`,
        edgeNext(heaviest(index, "column"), folderMatrix(r.key)))),
    ...matrix.rows
      .flatMap((r, index) => (r.outgoingGroups >= t.wideOutgoingUnits ? [{ r, index }] : []))
      .toSorted((left, right) => right.r.outgoingPairs - left.r.outgoingPairs || byCodeUnit(left.r.key, right.r.key))
      .map(({ r, index }) => row("wide-row", r.key,
        `It imports ${r.outgoingGroups} other units through ${r.outgoingPairs} file pairs (Ce).`,
        edgeNext(heaviest(index, "row"), folderMatrix(r.key)))),
    ...matrix.rows
      .filter((r) => r.incomingPairs === 0)
      .map((r) => row("entry-row", r.key,
        `No other unit imports it (${deadFiles.get(r.key) ?? 0} dead file(s)).`,
        checkCommand(folderOf.get(r.key) ?? (r.key === ROOT_UNIT ? "" : r.key)))),
    ...matrix.rows
      .filter((r) => (fileCount.get(r.key) ?? 0) >= t.cohesionMinFiles && r.outgoingPairs > 0
        && r.internalEdgeCount / (r.internalEdgeCount + r.outgoingPairs) < t.cohesionRatio)
      .map((r) => row("cohesion", r.key,
        `Only ${r.internalEdgeCount} of its ${r.internalEdgeCount + r.outgoingPairs} file pairs stay inside it (C = ${r.internalEdgeCount}/${r.internalEdgeCount + r.outgoingPairs}).`,
        folderMatrix(r.key))),
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
  const mutualByKind = mutualPairs(input);
  const mutual = mutualByKind.runtime.filter(scope.edge);
  const typeOnlyMutual = mutualByKind.typeOnly.filter(scope.edge);
  const lazyMutual = mutualByKind.lazy.filter(scope.edge);
  // The hot spot and the ranking count runtime cycles only (#740, #741).
  const { wins: mutualWins, hotSpot } = mutualImports(input, mutual);
  const scopedCuts = cycleCuts(input.matrix).filter((cut) => cut.members.some(scope.unit));
  const typeOnlyCuts = scopedCuts.filter((cut) => cutKind(input, cut) === "type-only");
  const lazyCuts = scopedCuts.filter((cut) => cutKind(input, cut) === "lazy");
  const cuts = scopedCuts.filter((cut) => cutKind(input, cut) === "runtime");
  // A dead file's unused exports go with it: its Dead files entry deletes the whole file (#758).
  const dead = new Set((input.deadFiles ?? []).map((file) => file.relativePath));
  const deadCodeFiles = input.deadCode.filter((file) => !dead.has(file.relativePath) && (focus?.has(file.relativePath) ?? true));
  const quickWins = [...cycleBreaks(input, cuts, pairs), ...mutualWins, ...weakDependencies(input, pairs, scope), ...deadCode(input, deadCodeFiles)]
    // Cross products compare gain / effort without rounding; effort 0 ranks first.
    .sort((left, right) => right.gain * left.effort - left.gain * right.effort || right.gain - left.gain
      || KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind) || byCodeUnit(left.subject, right.subject));
  const deadFileList = (input.deadFiles ?? []).filter((file) => scope.file(file.relativePath));
  const deadFiles = deadFileGroups(input, deadFileList);
  const { rows } = scope;
  return {
    unitNames: input.units.units.map((unit) => ({ key: unit.key, name: unitDisplayName(unit) })),
    deadFiles,
    quickWins,
    typeOnlyCycles: groupedCycles(input, typeOnlyCuts, typeOnlyMutual),
    lazyCycles: groupedCycles(input, lazyCuts, lazyMutual),
    matrixFindings: rowFindings(input).filter((finding) => rows === undefined || finding.rows.some((row) => rows.has(row))),
    glossary: glossary(input.matrix),
    matrixGuide: MATRIX_GUIDE,
    totals: {
      files: focus?.size ?? input.unitOf.size,
      units: rows?.size ?? input.units.units.length,
      unitEdges: input.units.unitEdges.filter((edge) => scope.unitEdge(pairs, edge)).length,
      unitCycles: (focus === undefined ? input.units.cycles : scopedCuts.length) - typeOnlyCuts.length - lazyCuts.length,
      mutualImports: mutual.length,
      typeOnlyUnitCycles: typeOnlyCuts.length,
      typeOnlyMutualImports: typeOnlyMutual.length,
      lazyUnitCycles: lazyCuts.length,
      lazyMutualImports: lazyMutual.length,
      ...(hotSpot === undefined ? {} : { mutualHotSpot: hotSpot }),
      acceptedViolations: input.acceptedViolations,
      deadFiles: deadFileList.length,
      deadFileLines: deadLines(deadFileList),
      deadCodeFiles: deadCodeFiles.filter((file) => file.unusedSymbols.length > 0).length,
      unusedExports: deadCodeFiles.reduce((total, file) => total + file.unusedSymbols.length, 0),
      unusedExportsMedium: input.deadCodeBelowHigh?.medium ?? 0,
      unusedExportsMediumByReason: input.deadCodeBelowHigh?.mediumByReason ?? {},
      unusedExportsLow: input.deadCodeBelowHigh?.low ?? 0,
    },
    thresholds: ASSESSMENT_THRESHOLDS,
  };
}
