/**
 * REPL File Search
 *
 * Filters a list of absolute file paths by a case-insensitive substring query.
 * Returns relative paths sorted alphabetically.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import * as path from 'node:path';

/**
 * Filter `files` (absolute paths) by `query` substring against relative paths.
 *
 * @param files - Absolute file paths from SourceFileCollector
 * @param query - User-typed string (case-insensitive)
 * @param workspaceRoot - Workspace root for computing relative paths
 * @returns Sorted array of relative paths that match `query`
 */
export function filterFiles(
  files: string[],
  query: string,
  workspaceRoot: string,
): string[] {
  const q = query.toLowerCase();
  const matches = files
    .map((f) => path.relative(workspaceRoot, f))
    .filter((rel) => rel.toLowerCase().includes(q));
  matches.sort((a, b) => a.localeCompare(b));
  return matches;
}
