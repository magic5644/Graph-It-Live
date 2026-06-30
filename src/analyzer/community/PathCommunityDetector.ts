import { normalizePath } from '../../shared/path.js';

/**
 * Finds the workspace prefix to strip before grouping.
 *
 * We strip the longest common path prefix, but cap it so that at least
 * ONE directory segment always remains after stripping (i.e. files are never
 * left with an empty dirParts and a non-zero groupKey).
 *
 * Rule: strip at most (minPartCount - 2) parts, where minPartCount is the
 * minimum number of slash-split parts across all paths. "- 2" reserves one
 * part for a directory and one for the filename.
 *
 * Example — all files in same deep dir:
 *   ['/project/src/analyzer/Spider.ts', '/project/src/analyzer/PathResolver.ts']
 *   shared = ['', 'project', 'src', 'analyzer']  (len 4)
 *   minPartCount = 5  (each path has 5 parts)
 *   cap = min(4, 5-2) = 3  → prefix = ['', 'project', 'src']
 *   relParts(Spider.ts) = ['analyzer', 'Spider.ts']
 *   dirParts = ['analyzer'], groupKey = 'analyzer'  ✓ (communityId ≥ 1)
 */
function workspacePrefix(paths: string[]): string[] {
  if (paths.length === 0) return [];

  const split = paths.map(p => p.split('/'));
  const minPartCount = Math.min(...split.map(p => p.length));

  const shared: string[] = [];
  for (let i = 0; i < minPartCount; i++) {
    if (split.every(p => p[i] === split[0][i])) shared.push(split[0][i]);
    else break;
  }

  // Reserve at least 1 directory segment + 1 filename after the prefix.
  const maxStrip = Math.max(0, minPartCount - 2);
  return shared.slice(0, Math.min(shared.length, maxStrip));
}

/**
 * Groups files by their first 2 path components relative to the workspace root.
 *
 * - Files with no directory after stripping the workspace prefix → communityId 0.
 * - All others → 1-indexed communityId, contiguous, assigned in encounter order.
 *
 * Examples (workspace = /project):
 *   /project/src/analyzer/Spider.ts       → group 'src/analyzer'  → id 1
 *   /project/src/webview/App.tsx          → group 'src/webview'   → id 2
 *   /project/src/analyzer/callgraph/X.ts  → group 'src/analyzer'  → id 1 (depth capped at 2)
 *   /project/index.ts (when mixed)        → dirParts=[], id 0
 *
 * CRITICAL ARCHITECTURE RULE: NO import from 'vscode' — pure Node.js only.
 */
export function detectPathCommunities(nodes: string[]): Map<string, number> {
  if (nodes.length === 0) return new Map();

  const normalized = nodes.map(normalizePath);
  const prefix = workspacePrefix(normalized);

  const groupToId = new Map<string, number>();
  const result = new Map<string, number>();
  let nextId = 1;

  for (const fp of normalized) {
    const parts = fp.split('/');
    const relParts = parts.slice(prefix.length); // strip workspace prefix
    const dirParts = relParts.slice(0, -1);       // strip filename
    const depth = Math.min(2, dirParts.length);
    const groupKey = dirParts.slice(0, depth).join('/');

    if (!groupKey) {
      result.set(fp, 0); // file sits directly at workspace root → isolated
      continue;
    }

    if (!groupToId.has(groupKey)) groupToId.set(groupKey, nextId++);
    result.set(fp, groupToId.get(groupKey)!);
  }

  return result;
}
