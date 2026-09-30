/**
 * Compact tool output for agents.
 *
 * Most tools emit the same file under several keys (`id`, `path`,
 * `relativePath`, `sourceRelative`…). Once paths are workspace-relative the
 * values are identical, so roughly a third of every payload is duplicated data.
 * This drops each redundant key and keeps its canonical sibling.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

type Matcher = (redundant: string, canonical: string) => boolean;

/** Same file, whether each side is absolute or workspace-relative. */
const sameFile: Matcher = (a, b) => {
  const left = a.replaceAll("\\", "/");
  const right = b.replaceAll("\\", "/");
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
};

/** Symbol ids are `<file>:<symbol>:<line>`, so the id already names the file. */
const fileOfId: Matcher = (file, id) => id.startsWith(`${file}:`);

/** [redundant key, canonical key, match] — the redundant key is dropped on a match. */
const REDUNDANT_KEYS: ReadonlyArray<readonly [string, string, Matcher]> = [
  ["relativePath", "path", sameFile],
  ["relativePath", "filePath", sameFile],
  ["id", "path", sameFile],
  ["sourceRelative", "source", sameFile],
  ["targetRelative", "target", sameFile],
  ["sourceFile", "sourceId", fileOfId],
  ["targetFile", "targetId", fileOfId],
];

/** Drop `undefined` fields and keys that repeat a sibling's value, recursively. */
export function compactOutput<T>(value: T): T {
  if (Array.isArray(value)) return value.map(compactOutput) as T;
  if (!isPlainObject(value)) return value;

  const drop = new Set(
    REDUNDANT_KEYS
      .filter(([redundant, canonical, match]) => {
        const a = value[redundant];
        const b = value[canonical];
        return typeof a === "string" && typeof b === "string" && match(a, b);
      })
      .map(([redundant]) => redundant),
  );

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, child]) => child !== undefined && !drop.has(key))
      .map(([key, child]) => [key, compactOutput(child)]),
  ) as T;
}

/** Dates, Maps and class instances serialize on their own terms; leave them intact. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
