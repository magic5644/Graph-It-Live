import { normalizePath } from '../../shared/path.js';

/**
 * Top-level directories that are structural containers, not functional domains.
 * When encountered as the first relative path segment, we skip to the next one.
 * e.g. src/analyzer/types.ts → skip 'src' → domain = 'analyzer'
 *      tests/analyzer/foo.test.ts → skip 'tests' → domain = 'analyzer'
 */
const UMBRELLA_DIRS = new Set(['src', 'tests', 'test', 'lib', 'app', 'packages', 'dist', 'out']);

/**
 * Returns the longest common path prefix (as an array of parts),
 * capped so at least 2 parts remain after stripping (1 dir + 1 filename).
 */
function workspacePrefix(paths: string[]): string[] {
  if (paths.length === 0) return [];
  const split = paths.map(p => p.split('/'));
  const minLen = Math.min(...split.map(p => p.length));
  const shared: string[] = [];
  for (let i = 0; i < minLen; i++) {
    if (split.every(p => p[i] === split[0][i])) shared.push(split[0][i]);
    else break;
  }
  const maxStrip = Math.max(0, minLen - 2);
  return shared.slice(0, Math.min(shared.length, maxStrip));
}

/**
 * Groups files by their first functional domain (first non-umbrella subdirectory).
 *
 * - Umbrella dirs (src, tests, lib…) are skipped: src/analyzer → domain 'analyzer'.
 * - Files with no domain after stripping → communityId 0 (isolated).
 * - All others → 1-indexed communityId, contiguous, assigned in encounter order.
 *
 * Examples (workspace = /project):
 *   /project/src/analyzer/Spider.ts       → 'analyzer' → id 1
 *   /project/src/webview/App.tsx          → 'webview'  → id 2
 *   /project/tests/analyzer/foo.test.ts   → 'analyzer' → id 1 (same domain)
 *   /project/src/index.ts                 → id 0 (no domain after skipping 'src')
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

    // Skip leading umbrella directory (src, tests, lib…)
    const startIdx = dirParts.length > 0 && UMBRELLA_DIRS.has(dirParts[0]) ? 1 : 0;
    const domain = dirParts[startIdx]; // first functional subdirectory

    if (!domain) {
      result.set(fp, 0); // no functional domain → isolated
      continue;
    }

    if (!groupToId.has(domain)) groupToId.set(domain, nextId++);
    result.set(fp, groupToId.get(domain)!);
  }

  return result;
}
