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
 * Domain = first meaningful directory segment of a file, given the dir segments
 * (filename already stripped) and the common-prefix length shared by all files.
 *
 * Rule: skip the common prefix, then skip everything up to and INCLUDING the last
 * UMBRELLA dir found — the segment right after it is the functional domain. This
 * handles nested source roots at any depth:
 *   vue/src/views/x.vue      → last umbrella 'src' → 'views'
 *   packages/app/src/store/y → last umbrella 'src' → 'store'
 *   src/analyzer/z.ts        → last umbrella 'src' → 'analyzer'
 *   backend/services/w.ts    → no umbrella → 'backend' (fallback: first seg after prefix)
 * Exported for reuse (webview legend keeps its own copy — no cross-layer import).
 */
export function domainFromDirParts(dirParts: string[], commonPrefixLen: number): string | undefined {
  let startIdx = commonPrefixLen;
  // Advance past the LAST umbrella dir in the leading run so nested roots collapse.
  for (let i = commonPrefixLen; i < dirParts.length; i++) {
    if (UMBRELLA_DIRS.has(dirParts[i])) startIdx = i + 1;
  }
  return dirParts[startIdx];
}

/**
 * Groups files by their first functional domain.
 *
 * Algorithm:
 *  1. Compute relative path from workspaceRoot (or infer from common absolute prefix)
 *  2. Strip any directory prefix shared by ALL files (monorepo container dirs)
 *  3. Skip up to and including the LAST umbrella dir (src, tests, lib…) — handles
 *     nested source roots like vue/src/, packages/app/src/
 *  4. First remaining dir = functional domain
 *
 * Examples (workspaceRoot = /project):
 *   /project/src/analyzer/Spider.ts       → 'analyzer' → id 1
 *   /project/src/webview/App.tsx          → 'webview'  → id 2
 *   /project/tests/analyzer/foo.test.ts   → 'analyzer' → id 1 (same)
 *   /project/vue/src/services/a.ts        → 'services'
 *   /project/vue/src/store/b.ts           → 'store' (distinct — nested src handled)
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

  // Skip dir segments shared by ALL files (e.g. a single 'vue/src' root)
  const commonPrefixLen = inferCommonDirPrefixLen(rels);

  const groupToId = new Map<string, number>();
  const result = new Map<string, number>();
  let nextId = 1;

  for (let i = 0; i < normalized.length; i++) {
    const fp = normalized[i];
    const dirParts = rels[i].split('/').slice(0, -1); // strip filename

    const domain = domainFromDirParts(dirParts, commonPrefixLen);
    if (!domain) { result.set(fp, 0); continue; }

    if (!groupToId.has(domain)) groupToId.set(domain, nextId++);
    result.set(fp, groupToId.get(domain)!);
  }

  return result;
}
