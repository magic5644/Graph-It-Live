/**
 * Unit tests for PathCommunityDetector.detectPathCommunities.
 * Groups files by first functional subdirectory (skipping umbrella dirs: src, tests…).
 * Root-level / umbrella-only files → communityId 0 (isolated).
 * All others → 1-indexed, contiguous.
 */
import { describe, it, expect } from 'vitest';
import { detectPathCommunities } from '../../../src/analyzer/community/PathCommunityDetector.js';
import { normalizePath } from '../../../src/shared/path.js';

const ROOT = '/project';

describe('detectPathCommunities', () => {
  it('empty array → empty map', () => {
    expect(detectPathCommunities([])).toEqual(new Map());
  });

  it('single node with workspaceRoot → does not crash', () => {
    const node = normalizePath('/project/src/analyzer/index.ts');
    const result = detectPathCommunities([node], ROOT);
    expect(result.has(node)).toBe(true);
  });

  it('src/analyzer → domain "analyzer" (umbrella src skipped)', () => {
    const a = normalizePath('/project/src/analyzer/Spider.ts');
    const b = normalizePath('/project/src/analyzer/PathResolver.ts');
    const result = detectPathCommunities([a, b], ROOT);
    expect(result.get(a)).toBe(result.get(b));
    expect(result.get(a)).toBeGreaterThanOrEqual(1);
  });

  it('src/webview → domain "webview", different from analyzer', () => {
    const a = normalizePath('/project/src/analyzer/Spider.ts');
    const b = normalizePath('/project/src/webview/index.tsx');
    const result = detectPathCommunities([a, b], ROOT);
    expect(result.get(a)).not.toBe(result.get(b));
    expect(result.get(a)).toBeGreaterThanOrEqual(1);
    expect(result.get(b)).toBeGreaterThanOrEqual(1);
  });

  it('tests/analyzer → same domain as src/analyzer (both "analyzer")', () => {
    const src = normalizePath('/project/src/analyzer/Spider.ts');
    const test = normalizePath('/project/tests/analyzer/Spider.test.ts');
    const result = detectPathCommunities([src, test], ROOT);
    expect(result.get(src)).toBe(result.get(test));
    expect(result.get(src)).toBeGreaterThanOrEqual(1);
  });

  it('communityIds are contiguous starting at 1 (no gaps)', () => {
    const nodes = [
      normalizePath('/project/src/analyzer/a.ts'),
      normalizePath('/project/src/webview/b.tsx'),
      normalizePath('/project/src/mcp/c.ts'),
    ];
    const result = detectPathCommunities(nodes, ROOT);
    const ids = [...new Set(result.values())].sort((a, b) => a - b);
    expect(ids).toEqual([1, 2, 3]);
  });

  it('normalizePath applied — key is normalized form', () => {
    const raw = '/project/src/analyzer/Spider.ts';
    const normalized = normalizePath(raw);
    const result = detectPathCommunities([raw], ROOT);
    expect(result.has(normalized)).toBe(true);
  });

  it('files deeper than 2 dirs still group by first domain (src/analyzer/callgraph → "analyzer")', () => {
    const a = normalizePath('/project/src/analyzer/callgraph/GraphExtractor.ts');
    const b = normalizePath('/project/src/analyzer/callgraph/CallGraphIndexer.ts');
    const c = normalizePath('/project/src/analyzer/Spider.ts');
    const result = detectPathCommunities([a, b, c], ROOT);
    // a, b, c all under src/analyzer → same domain "analyzer"
    expect(result.get(a)).toBe(result.get(b));
    expect(result.get(a)).toBe(result.get(c));
    expect(result.get(a)).toBeGreaterThanOrEqual(1);
  });

  it('src/index.ts (umbrella-only) → communityId 0 (isolated)', () => {
    const shallow = normalizePath('/project/src/index.ts');
    const deep = normalizePath('/project/src/analyzer/Spider.ts');
    const result = detectPathCommunities([shallow, deep], ROOT);
    expect(result.get(shallow)).toBe(0);
    expect(result.get(deep)).toBeGreaterThanOrEqual(1);
    expect(result.get(shallow)).not.toBe(result.get(deep));
  });

  it('root-level file (no dir) → communityId 0', () => {
    const root = normalizePath('/project/package.json');
    const deep = normalizePath('/project/src/analyzer/Spider.ts');
    const result = detectPathCommunities([root, deep], ROOT);
    expect(result.get(root)).toBe(0);
    expect(result.get(deep)).toBeGreaterThanOrEqual(1);
  });

  it('all nodes in same domain → all get same communityId 1', () => {
    const a = normalizePath('/project/src/analyzer/a.ts');
    const b = normalizePath('/project/src/analyzer/b.ts');
    const c = normalizePath('/project/src/analyzer/sub/c.ts');
    const result = detectPathCommunities([a, b, c], ROOT);
    expect(result.get(a)).toBe(1);
    expect(result.get(b)).toBe(1);
    expect(result.get(c)).toBe(1);
  });

  it('inference fallback (no workspaceRoot) — does not crash', () => {
    const a = normalizePath('/project/src/analyzer/Spider.ts');
    const b = normalizePath('/project/src/webview/App.tsx');
    // No workspaceRoot: uses common prefix inference, best-effort
    const result = detectPathCommunities([a, b]);
    expect(result.has(a)).toBe(true);
    expect(result.has(b)).toBe(true);
  });

  it('monorepo: non-umbrella container dir (vue/src/…) → distinct communities', () => {
    const a = normalizePath('/project/vue/src/services/userServices.ts');
    const b = normalizePath('/project/vue/src/store/store.ts');
    const c = normalizePath('/project/vue/src/types/generics.types.ts');
    const result = detectPathCommunities([a, b, c], ROOT);
    // All three should have distinct, non-zero communityIds
    expect(result.get(a)).toBeGreaterThanOrEqual(1);
    expect(result.get(b)).toBeGreaterThanOrEqual(1);
    expect(result.get(c)).toBeGreaterThanOrEqual(1);
    expect(result.get(a)).not.toBe(result.get(b)); // services ≠ store
    expect(result.get(a)).not.toBe(result.get(c)); // services ≠ types
    expect(result.get(b)).not.toBe(result.get(c)); // store ≠ types
  });

  it('monorepo: files in same subdir get same communityId', () => {
    const a = normalizePath('/project/vue/src/services/userServices.ts');
    const b = normalizePath('/project/vue/src/services/companyServices.ts');
    const c = normalizePath('/project/vue/src/store/store.ts');
    const result = detectPathCommunities([a, b, c], ROOT);
    expect(result.get(a)).toBe(result.get(b)); // both services
    expect(result.get(a)).not.toBe(result.get(c)); // services ≠ store
  });

  it('divergent roots (vue/src/ + backend/): nested src split by subdir', () => {
    // app-bobbee case: two top-level roots, no common prefix, vue not umbrella
    const views = normalizePath('/project/vue/src/views/GeneralLedger2.vue');
    const store = normalizePath('/project/vue/src/store/store.ts');
    const types = normalizePath('/project/vue/src/types/x.types.ts');
    const back = normalizePath('/project/backend/handlers/h.ts');
    const result = detectPathCommunities([views, store, types, back], ROOT);
    // vue subdirs must be distinct (not all collapsed to 'vue')
    expect(result.get(views)).not.toBe(result.get(store));
    expect(result.get(views)).not.toBe(result.get(types));
    expect(result.get(store)).not.toBe(result.get(types));
    // backend is its own cluster (no umbrella marker → first segment)
    expect(result.get(back)).toBeGreaterThanOrEqual(1);
    expect(result.get(back)).not.toBe(result.get(views));
  });

  it('deeply nested container: packages/app/src/store/ → store', () => {
    const a = normalizePath('/project/packages/app/src/store/s.ts');
    const b = normalizePath('/project/packages/app/src/views/v.ts');
    const result = detectPathCommunities([a, b], ROOT);
    expect(result.get(a)).not.toBe(result.get(b)); // store ≠ views
    expect(result.get(a)).toBeGreaterThanOrEqual(1);
  });
});
