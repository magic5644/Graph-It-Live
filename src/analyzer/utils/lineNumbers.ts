/**
 * 1-based line numbers of ts-morph nodes from a line map built once per parsed file.
 * ts-morph's `getStartLineNumber()` / `getEndLineNumber()` recount the lines from the start of
 * the file on every call, which is quadratic on large files (#774).
 *
 * NO vscode import — pure Node.js analyzer layer.
 */

import type { Node, ts } from "ts-morph";

/** Offsets of every `\n`, per parsed tree: `replaceWithText()` makes a new tree, so a stale map is never read. */
const newlineOffsets = new WeakMap<ts.SourceFile, number[]>();
let lineMapsBuilt = 0;

/** Line maps built so far: each is one pass over a file's text. A work counter for tests and benchmarks. */
export const lineMapBuilds = (): number => lineMapsBuilt;

function offsetsOf(file: ts.SourceFile): number[] {
  let offsets = newlineOffsets.get(file);
  if (!offsets) {
    offsets = [];
    const { text } = file;
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) offsets.push(i);
    newlineOffsets.set(file, offsets);
    lineMapsBuilt++;
  }
  return offsets;
}

/** Line of `pos`: 1 + the `\n` before it. Only `\n` counts, as in ts-morph (a lone `\r` or U+2028 does not). */
function lineAt(node: Node, pos: number): number {
  const offsets = offsetsOf(node.getSourceFile().compilerNode);
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (offsets[mid] < pos) low = mid + 1;
    else high = mid;
  }
  return low + 1;
}

/** Same value as `node.getStartLineNumber()`. */
export function startLineOf(node: Node): number {
  return lineAt(node, node.getStart());
}

/** Same value as `node.getEndLineNumber()`. */
export function endLineOf(node: Node): number {
  return lineAt(node, node.getEnd());
}
