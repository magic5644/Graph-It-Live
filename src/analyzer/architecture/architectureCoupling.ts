/**
 * Most coupled pairs and bridging files of one architecture level (#342), on the rows of its
 * matrix: groups, a folder's groups or units. Each item keeps its first file pairs as evidence.
 * Shared by `graph-it architecture --coupling` and explore_architecture `view: "coupling"`.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import {
  COUPLING_FORMULAS,
  type ArchitectureCoupling,
  type BridgingFile,
  type CoupledPair,
  type FilePair,
  type MatrixNode,
} from "../../shared/architecture-model";
import { byCodeUnit } from "./architectureUnits";

const EVIDENCE_LIMIT = 3;

const byPair = (left: FilePair, right: FilePair) => byCodeUnit(left.source, right.source) || byCodeUnit(left.target, right.target);
const evidence = (pairs: FilePair[]) => pairs.toSorted(byPair).slice(0, EVIDENCE_LIMIT);

interface Link {
  imports: number;
  importedBy: number;
  pairs: FilePair[];
}

interface Crossings {
  /** Keyed by `a * rowCount + b`, a < b: the pairs of each direction. */
  coupled: Map<number, { a: number; b: number; aToB: FilePair[]; bToA: FilePair[] }>;
  /** Each file's own row and, per other row it touches, its pairs. */
  files: Map<string, { row: number; links: Map<number, Link> }>;
}

/** Every file pair whose ends sit in two different rows, filed by row pair and by file. */
function collectCrossings(
  edges: readonly { sourceRelative: string; targetRelative: string }[],
  rowIndex: (file: string) => number | undefined,
  rowCount: number,
): Crossings {
  const coupled: Crossings["coupled"] = new Map();
  const files: Crossings["files"] = new Map();
  const touch = (file: string, row: number, other: number, pair: FilePair, side: "imports" | "importedBy") => {
    const entry = files.get(file) ?? files.set(file, { row, links: new Map() }).get(file)!;
    const link = entry.links.get(other) ?? entry.links.set(other, { imports: 0, importedBy: 0, pairs: [] }).get(other)!;
    link[side] += 1;
    link.pairs.push(pair);
  };
  for (const { sourceRelative: source, targetRelative: target } of edges) {
    const from = rowIndex(source);
    const to = rowIndex(target);
    if (from === undefined || to === undefined || from === to) continue;
    const pair = { source, target };
    const a = Math.min(from, to);
    const key = a * rowCount + Math.max(from, to);
    const entry = coupled.get(key) ?? coupled.set(key, { a, b: Math.max(from, to), aToB: [], bToA: [] }).get(key)!;
    (from === a ? entry.aToB : entry.bToA).push(pair);
    touch(source, from, to, pair, "imports");
    touch(target, to, from, pair, "importedBy");
  }
  return { coupled, files };
}

function coupledPairsOf<Id>(coupled: Crossings["coupled"], rows: readonly Pick<MatrixNode<Id>, "id" | "label">[]): CoupledPair<Id>[] {
  return [...coupled.values()]
    .sort((left, right) => right.aToB.length + right.bToA.length - left.aToB.length - left.bToA.length || left.a - right.a || left.b - right.b)
    .map(({ a, b, aToB, bToA }) => ({
      a: rows[a].id,
      b: rows[b].id,
      aLabel: rows[a].label,
      bLabel: rows[b].label,
      aToB: aToB.length,
      bToA: bToA.length,
      fileEdgeCount: aToB.length + bToA.length,
      mutual: aToB.length > 0 && bToA.length > 0,
      evidence: evidence([...aToB, ...bToA]),
    }));
}

function bridgingFilesOf<Id>(files: Crossings["files"], rows: readonly Pick<MatrixNode<Id>, "id" | "label">[]): BridgingFile<Id>[] {
  return [...files]
    .filter(([, { links }]) => links.size >= 2)
    .map(([file, { row, links }]) => {
      const ordered = [...links].sort(([left], [right]) => left - right);
      return {
        file,
        group: rows[row].id,
        groupLabel: rows[row].label,
        groupCount: links.size,
        fileEdgeCount: ordered.reduce((total, [, link]) => total + link.pairs.length, 0),
        links: ordered.map(([other, link]) => ({
          group: rows[other].id,
          label: rows[other].label,
          imports: link.imports,
          importedBy: link.importedBy,
          evidence: evidence(link.pairs),
        })),
      };
    })
    .sort((left, right) => right.groupCount - left.groupCount || right.fileEdgeCount - left.fileEdgeCount || byCodeUnit(left.file, right.file));
}

/**
 * `rows` in matrix order (it orders pairs and links), `rowOf` the row id of a workspace-relative
 * file, undefined for a file outside the level. Pairs inside one row count for neither analysis.
 */
export function architectureCoupling<Id extends number | string>(
  rows: readonly Pick<MatrixNode<Id>, "id" | "label">[],
  edges: readonly { sourceRelative: string; targetRelative: string }[],
  rowOf: (relativePath: string) => Id | undefined,
): ArchitectureCoupling<Id> {
  const indexOf = new Map(rows.map((row, index) => [row.id, index]));
  const rowIndex = (file: string) => {
    const id = rowOf(file);
    return id === undefined ? undefined : indexOf.get(id);
  };
  const { coupled, files } = collectCrossings(edges, rowIndex, rows.length);
  return { coupledPairs: coupledPairsOf(coupled, rows), bridgingFiles: bridgingFilesOf(files, rows), formulas: COUPLING_FORMULAS };
}
