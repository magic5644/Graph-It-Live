import * as nodePath from 'node:path';
import { normalizePath } from '../../shared/path.js';

/**
 * Top-level directories that are structural containers, not functional domains.
 * When encountered as the first relative path segment, we skip to the next one.
 * e.g. src/analyzer/types.ts → skip 'src' → domain = 'analyzer'
 *      tests/analyzer/foo.test.ts → skip 'tests' → domain = 'analyzer'
 */
const UMBRELLA_DIRS = new Set(['src', 'tests', 'test', 'lib', 'app', 'packages', 'dist', 'out']);

/** Longest common path prefix from a set of absolute paths (no cap). */
function inferWorkspaceRoot(paths: string[]): string {
  if (paths.length === 0) return '';
  const split = paths.map(p => p.split('/'));
  const minLen = Math.min(...split.map(p => p.length));
  const common: string[] = [];
  for (let i = 0; i < minLen; i++) {
    if (split.every(p => p[i] === split[0][i])) common.push(split[0][i]);
    else break;
  }
  // Drop the last common segment if it looks like a filename (has an extension)
  // so we don't accidentally include a shared filename as part of the root.
  return common.join('/');
}

/**
 * Groups files by their first functional domain (first non-umbrella subdirectory).
 *
 * workspaceRoot is optional: when omitted it is inferred as the longest common
 * path prefix of all nodes (correct for single-project workspaces).
 * Pass it explicitly when available to handle mixed-depth edge cases.
 *
 * Examples (workspaceRoot = /project):
 *   /project/src/analyzer/Spider.ts       → 'analyzer' → id 1
 *   /project/src/webview/App.tsx          → 'webview'  → id 2
 *   /project/tests/analyzer/foo.test.ts   → 'analyzer' → id 1 (same domain)
 *   /project/src/index.ts                 → id 0 (no domain after skipping 'src')
 *   /project/package.json                 → id 0 (root-level file)
 *
 * CRITICAL ARCHITECTURE RULE: NO import from 'vscode' — pure Node.js only.
 */
export function detectPathCommunities(nodes: string[], workspaceRoot?: string): Map<string, number> {
  if (nodes.length === 0) return new Map();

  const normalized = nodes.map(normalizePath);
  const root = workspaceRoot
    ? normalizePath(workspaceRoot)
    : inferWorkspaceRoot(normalized);

  const groupToId = new Map<string, number>();
  const result = new Map<string, number>();
  let nextId = 1;

  for (const fp of normalized) {
    const rel = root
      ? normalizePath(nodePath.relative(root, fp))
      : fp;
    const parts = rel.split('/');
    const dirParts = parts.slice(0, -1); // strip filename

    // Skip leading umbrella directory (src, tests, lib…)
    const startIdx = dirParts.length > 0 && UMBRELLA_DIRS.has(dirParts[0]) ? 1 : 0;
    const domain = dirParts[startIdx];

    if (!domain) {
      result.set(fp, 0);
      continue;
    }

    if (!groupToId.has(domain)) groupToId.set(domain, nextId++);
    result.set(fp, groupToId.get(domain)!);
  }

  return result;
}
