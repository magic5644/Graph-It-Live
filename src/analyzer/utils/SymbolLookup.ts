import * as fs from "node:fs";
import * as path from "node:path";
import { normalizePath } from "../../shared/path";
import { shouldSkipDirectory } from "../SourceFileFilters";
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
  return rankByDistance(names, (name) => name.toLowerCase(), target.toLowerCase(), Math.max(2, Math.floor(target.length / 3)), limit);
}

/**
 * Up to 3 file names or paths close to `target`: same extension (case-insensitive), distance measured without it.
 * A shared extension makes no names closer, so the threshold follows the base name: a short name tolerates one edit.
 */
export function closestFileNames(names: string[], target: string): string[] {
  const extension = path.extname(target).toLowerCase();
  const withoutExtension = (name: string) => name.slice(0, name.length - path.extname(name).length).toLowerCase();
  const maxDistance = Math.max(1, Math.floor(path.basename(target, path.extname(target)).length / 3));
  const sameExtension = names.filter((name) => path.extname(name).toLowerCase() === extension);
  return rankByDistance(sameExtension, withoutExtension, withoutExtension(target), maxDistance, 3);
}

function rankByDistance(names: string[], key: (name: string) => string, wanted: string, maxDistance: number, limit: number): string[] {
  return names
    .map((name) => ({ name, distance: editDistance(key(name), wanted) }))
    .filter((c) => c.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((c) => c.name);
}

/** Optimal string alignment distance: Levenshtein where swapping two adjacent characters is one edit (flow → flwo). */
function editDistance(a: string, b: string): number {
  let previous: number[] = [];
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) next[j] = Math.min(next[j], previous[j - 2] + 1);
    }
    previous = row;
    row = next;
  }
  return row[b.length];
}

/** ` Did you mean: a, b?` with the workspace-relative names closest to a missing path, in its folder; else "". */
export function closestPathsHint(absolutePath: string, workspaceRoot: string): string {
  const folder = path.dirname(absolutePath);
  const names = fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory() ? fs.readdirSync(folder) : [];
  // The file itself is never a suggestion: it exists, so the caller's problem lies elsewhere.
  const near = closestFileNames(names.filter((name) => name !== path.basename(absolutePath)), path.basename(absolutePath)).map((name) => path.join(folder, name));
  // A mistyped folder holds no close name: look for the file name anywhere in the workspace.
  const close = near.length > 0 ? near : sameNameFiles(workspaceRoot, absolutePath);
  const relative = (file: string) => normalizePath(path.relative(workspaceRoot, file));
  return close.length > 0 ? ` Did you mean: ${close.map(relative).join(", ")}?` : "";
}

/** Directories read at most by sameNameFiles: a hint stays instant on a large monorepo. */
const MAX_HINT_DIRECTORIES = 5000;

/** A directory's entries, none when it cannot be read (permissions, removed meanwhile). */
function readEntries(directory: string): fs.Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Other workspace files whose name is close to `absolutePath`'s, breadth first, skipping node_modules, dot and build folders. */
function sameNameFiles(workspaceRoot: string, absolutePath: string): string[] {
  const queue = [workspaceRoot];
  const files: string[] = [];
  const self = path.resolve(absolutePath);
  for (let head = 0; head < queue.length && head < MAX_HINT_DIRECTORIES; head++) {
    const entries = readEntries(queue[head]);
    for (const entry of entries) {
      const full = path.join(queue[head], entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entry.name, true)) queue.push(full);
      } else if (entry.isFile() && full !== self) {
        files.push(full);
      }
    }
  }
  const byName = new Map<string, string[]>();
  for (const file of files) byName.set(path.basename(file), [...(byName.get(path.basename(file)) ?? []), file]);
  return closestFileNames([...byName.keys()], path.basename(absolutePath)).flatMap((name) => byName.get(name) ?? []).slice(0, 3);
}
