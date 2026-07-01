import * as nodePath from 'node:path';
import { normalizePath } from '../../shared/path.js';

/**
 * Well-known structural container dirs — skip ONE level when encountered.
 * e.g. src/analyzer/types.ts → skip 'src' → domain = 'analyzer'
 *      tests/analyzer/foo.test.ts → skip 'tests' → domain = 'analyzer'
 */
const UMBRELLA_DIRS = new Set(['src', 'tests', 'test', 'lib', 'app', 'packages', 'dist', 'out']);

/**
 * Length of the common dir prefix across all relative paths.
 * e.g. ['vue/src/services/a.ts', 'vue/src/store/b.ts'] → 2 ('vue' + 'src')
 * Operates on paths ALREADY relative to workspace root.
 */
function inferCommonDirPrefixLen(relPaths: string[]): number {
  if (!relPaths.length) return 0;
  const dirParts = relPaths.map(p => p.split('/').slice(0, -1)); // without filename
  const minLen = Math.min(...dirParts.map(p => p.length));
  // Cap at minLen-1: never strip ALL dir segments — leave at least one for domain detection.
  const cap = Math.max(0, minLen - 1);
  let i = 0;
  while (i < cap && dirParts.every(p => p[i] === dirParts[0][i])) i++;
  return i;
}

/**
 * Groups files by their first functional domain (first non-umbrella subdirectory
 * after stripping any common path prefix).
 *
 * Algorithm:
 *  1. Compute relative path from workspaceRoot (or infer from common absolute prefix)
 *  2. Strip any directory prefix shared by ALL files (handles monorepos where all
 *     sources live under e.g. vue/src/ or packages/app/src/)
 *  3. Skip a single UMBRELLA dir if present (src, tests, lib…)
 *  4. First remaining dir = functional domain
 *
 * Examples (workspaceRoot = /project):
 *   /project/src/analyzer/Spider.ts       → domain 'analyzer' → id 1
 *   /project/src/webview/App.tsx          → domain 'webview'  → id 2
 *   /project/tests/analyzer/foo.test.ts   → domain 'analyzer' → id 1 (same)
 *   /project/vue/src/services/a.ts        → common 'vue/src' stripped → domain 'services'
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
    : (() => {
        // Fallback: infer from longest common absolute path prefix
        const split = normalized.map(p => p.split('/'));
        const minLen = Math.min(...split.map(p => p.length));
        const common: string[] = [];
        for (let i = 0; i < minLen; i++) {
          if (split.every(p => p[i] === split[0][i])) common.push(split[0][i]);
          else break;
        }
        return common.join('/');
      })();

  // Compute all relative paths once
  const rels = normalized.map(fp =>
    root ? nodePath.relative(root, fp).replaceAll('\\', '/') : fp,
  );

  // Skip dir segments shared by ALL files (e.g. 'vue/src' in a vue monorepo)
  const commonPrefixLen = inferCommonDirPrefixLen(rels);

  const groupToId = new Map<string, number>();
  const result = new Map<string, number>();
  let nextId = 1;

  for (let i = 0; i < normalized.length; i++) {
    const fp = normalized[i];
    const parts = rels[i].split('/');
    const dirParts = parts.slice(0, -1); // strip filename

    let startIdx = commonPrefixLen;
    // Skip one UMBRELLA dir at startIdx if present
    if (dirParts[startIdx] !== undefined && UMBRELLA_DIRS.has(dirParts[startIdx])) startIdx++;

    const domain = dirParts[startIdx];
    if (!domain) { result.set(fp, 0); continue; }

    if (!groupToId.has(domain)) groupToId.set(domain, nextId++);
    result.set(fp, groupToId.get(domain)!);
  }

  return result;
}
