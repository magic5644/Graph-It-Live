import type { SymbolInfo } from "../types";

export type SymbolCheck =
  | { status: "found" }
  | { status: "missing"; suggestions: string[] }
  /** The file's symbols could not be listed (unsupported language or parse error). */
  | { status: "unverified" };

/**
 * Checks that `symbolName` is declared in `filePath`, so that "no dependents"
 * is never reported for a symbol that does not exist. A method matches by its
 * full name (`Class.method`) or by its member name (`method`).
 */
export async function checkSymbolInFile(
  spider: { getSymbolGraph(filePath: string): Promise<{ symbols: SymbolInfo[] }> },
  filePath: string,
  symbolName: string,
): Promise<SymbolCheck> {
  let symbols: SymbolInfo[];
  try {
    ({ symbols } = await spider.getSymbolGraph(filePath));
  } catch {
    return { status: "unverified" };
  }
  if (symbols.length === 0) return { status: "unverified" };

  const names = [...new Set(symbols.map((s) => s.name))];
  if (names.some((name) => name === symbolName || name.endsWith(`.${symbolName}`))) {
    return { status: "found" };
  }
  return { status: "missing", suggestions: closestNames(names, symbolName) };
}

/** Error message for a missing symbol, listing close matches when there are any. */
export function symbolNotFoundMessage(symbolName: string, fileLabel: string, suggestions: string[]): string {
  const hint = suggestions.length > 0
    ? ` Did you mean: ${suggestions.join(", ")}?`
    : " No symbol with a similar name is declared in this file.";
  return `Symbol '${symbolName}' not found in ${fileLabel}.${hint}`;
}

/** Up to `limit` names within a small edit distance of `target`, closest first (case-insensitive). */
export function closestNames(names: string[], target: string, limit = 3): string[] {
  const wanted = target.toLowerCase();
  const maxDistance = Math.max(2, Math.floor(wanted.length / 3));
  return names
    .map((name) => ({ name, distance: editDistance(name.toLowerCase(), wanted) }))
    .filter((c) => c.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((c) => c.name);
}

/** Levenshtein distance with a single rolling row. */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}
