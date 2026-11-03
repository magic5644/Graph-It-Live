import type { Node } from "web-tree-sitter";
import type { SymbolDependency } from "../types";

/** A symbol a passed name (`register(save)`) reaches, and the file it is declared in or imported from. */
export interface ReferenceTarget {
  symbolId: string;
  filePath: string;
}

/** Records that `sourceSymbolId` passes `target` without calling it, at a 1-based `line`; once per source and target. */
export function addReferenceDependency(
  dependencies: SymbolDependency[],
  sourceSymbolId: string,
  target: ReferenceTarget | null,
  line: number,
): void {
  if (!target) return;
  const known = dependencies.some((d) => d.sourceSymbolId === sourceSymbolId && d.targetSymbolId === target.symbolId && d.relation === "REFERENCES");
  if (known) return;
  dependencies.push({
    sourceSymbolId,
    targetSymbolId: target.symbolId,
    targetFilePath: target.filePath,
    line,
    isTypeOnly: false,
    relation: "REFERENCES",
  });
}

/**
 * Records a REFERENCES dependency for each passed value of an argument list whose node type is `accepted` and
 * that `resolve` links to a symbol: `register(save)` passes `save` without calling it.
 */
export function addPassedReferences(
  dependencies: SymbolDependency[],
  sourceSymbolId: string,
  values: Array<Node | null>,
  accepted: ReadonlySet<string>,
  resolve: (value: Node) => ReferenceTarget | null,
): void {
  for (const value of values) {
    if (value && accepted.has(value.type)) addReferenceDependency(dependencies, sourceSymbolId, resolve(value), value.startPosition.row + 1);
  }
}
