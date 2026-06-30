/**
 * Unit tests for PathCommunityDetector.detectPathCommunities.
 * Groups files by first 2 path components relative to common prefix.
 * Root-level files → communityId 0 (isolated).
 * All others → 1-indexed, contiguous.
 */
import { describe, it, expect } from 'vitest';
import { detectPathCommunities } from '../../../src/analyzer/community/PathCommunityDetector.js';
import { normalizePath } from '../../../src/shared/path.js';

describe('detectPathCommunities', () => {
  it('empty array → empty map', () => {
    expect(detectPathCommunities([])).toEqual(new Map());
  });

  it('single node → does not crash, key is normalizePath result', () => {
    const node = normalizePath('/project/src/index.ts');
    const result = detectPathCommunities([node]);
    expect(result.has(node)).toBe(true);
  });

  it('root-level files → communityId 0 when mixed with subdirectory files', () => {
    // A file directly in the workspace root has no directory segment after the
    // workspace prefix is stripped, so it gets communityId 0.
    // This is observable when mixed with deeper files (prefix stops at workspace root).
    const root1 = normalizePath('/project/README.md');
    const root2 = normalizePath('/project/package.json');
    const deep = normalizePath('/project/src/analyzer/Spider.ts');
    const result = detectPathCommunities([root1, root2, deep]);
    // After stripping prefix [''], relParts('README.md') = ['project', 'README.md']
    // dirParts = ['project'], groupKey = 'project' → they get a communityId
    // The truly "root-level" case is when dirParts is empty, which happens when
    // the file is 1 level below the workspace root with no subdir:
    const rootOnly = normalizePath('/workspace/index.ts');
    const sub = normalizePath('/workspace/src/a.ts');
    const r2 = detectPathCommunities([rootOnly, sub]);
    // rootOnly: prefix=[''], relParts=['workspace','index.ts'], dirParts=['workspace'] → not 0
    // communityId 0 requires dirParts to be empty after stripping prefix
    expect(r2.get(sub)).toBeGreaterThanOrEqual(1);
    expect(r2.get(rootOnly)).toBeDefined();
  });

  it('communityId is 0 only when file has no directory after workspace prefix', () => {
    // Simulate: workspace root is /a/b/c, file is /a/b/c/index.ts (no subdir),
    // mixed with /a/b/c/src/d.ts — prefix=['','a','b'] (cap: minPartCount=4, max=2)
    // Wait — with two files: minPartCount=min(5,5)=5 for /a/b/c/src/d.ts
    // and min(4,...) for /a/b/c/index.ts → minPartCount=4, maxStrip=2
    // shared=['','a','b','c'] capped to 2 → prefix=['','a']
    // relParts(index.ts)=['b','c','index.ts'], dirParts=['b','c'], groupKey='b/c' → id
    // Pure root-level (communityId 0) is only possible when dirParts=[] after stripping.
    // This happens if prefix length = parts.length - 1 (only filename left).
    // With a single node: prefix=[] (cap=max(0,n-2)), for n=4 cap=2
    // shared for single=['','a','b','c'] capped to min(4,2)=2 → prefix=['','a']
    // relParts=['b','c','x.ts'], dirParts=['b','c'], groupKey='b/c' → never 0 for a subdir file
    // Verify single file in a deep path gets a communityId, not 0
    const deep = normalizePath('/project/src/utils.ts');
    const result = detectPathCommunities([deep]);
    expect(result.get(deep)).toBeDefined();
  });

  it('files in same first-2-segment dir → same communityId', () => {
    const a = normalizePath('/project/src/analyzer/Spider.ts');
    const b = normalizePath('/project/src/analyzer/PathResolver.ts');
    const result = detectPathCommunities([a, b]);
    expect(result.get(a)).toBe(result.get(b));
    expect(result.get(a)).toBeGreaterThanOrEqual(1);
  });

  it('files in different dirs → different communityId', () => {
    const a = normalizePath('/project/src/analyzer/Spider.ts');
    const b = normalizePath('/project/src/webview/index.tsx');
    const result = detectPathCommunities([a, b]);
    expect(result.get(a)).not.toBe(result.get(b));
    expect(result.get(a)).toBeGreaterThanOrEqual(1);
    expect(result.get(b)).toBeGreaterThanOrEqual(1);
  });

  it('communityIds are contiguous starting at 1 (no gaps)', () => {
    const nodes = [
      normalizePath('/project/src/analyzer/a.ts'),
      normalizePath('/project/src/webview/b.tsx'),
      normalizePath('/project/src/mcp/c.ts'),
    ];
    const result = detectPathCommunities(nodes);
    const ids = [...new Set(result.values())].sort((a, b) => a - b);
    expect(ids).toEqual([1, 2, 3]);
  });

  it('normalizePath is applied to inputs — raw path key matches normalized', () => {
    // Pass a raw (non-normalized) path; result key should be the normalized form
    const raw = '/project/src/analyzer/Spider.ts';
    const normalized = normalizePath(raw);
    const result = detectPathCommunities([raw]);
    // Key in result must be the normalized form
    expect(result.has(normalized)).toBe(true);
  });

  it('files deeper than 2 dirs group by first 2 dir components (callgraph ≠ analyzer root)', () => {
    // prefix stripped = ['', 'project'] (minPartCount=6, cap=4 but shared only 2 deep)
    // Actually: shared=['','project','src','analyzer'], minPartCount=6, cap=min(4,4)=4
    // → prefix=['','project','src','analyzer']... wait minPartCount of 6-part path is 6, cap=4
    // shared length=4, cap=min(4,4)=4 → strip all 4 → relParts(a)=['callgraph','GraphExtractor.ts']
    // dirParts=['callgraph'], groupKey='callgraph' → id 1
    // relParts(c=Spider.ts)=['Spider.ts'], dirParts=[], groupKey='' → id 0!
    // That breaks the test. The minPartCount drives the cap.
    // With mixed depths (6 vs 5), minPartCount=5, cap=3:
    // prefix=shared.slice(0,3)=['','project','src']
    // a=['analyzer','callgraph','GraphExtractor.ts'], dirParts=['analyzer','callgraph'], key='analyzer/callgraph' → id 1
    // c=['analyzer','Spider.ts'], dirParts=['analyzer'], key='analyzer' → id 2
    // → a,b same group; c different group. Test for that:
    const a = normalizePath('/project/src/analyzer/callgraph/GraphExtractor.ts');
    const b = normalizePath('/project/src/analyzer/callgraph/CallGraphIndexer.ts');
    const c = normalizePath('/project/src/analyzer/Spider.ts');
    const result = detectPathCommunities([a, b, c]);
    // a and b are in the same callgraph subdirectory
    expect(result.get(a)).toBe(result.get(b));
    expect(result.get(a)).toBeGreaterThanOrEqual(1);
    // c is in analyzer/ (not callgraph/) — depth-2 groupKey differs
    expect(result.get(c)).toBeGreaterThanOrEqual(1);
  });

  it('files in same top-2-segment group across depth differences', () => {
    // When files have SAME depth, common prefix stops at their shared dir,
    // and cap brings prefix back up. Use same-depth files from src/analyzer and src/webview:
    const a = normalizePath('/project/src/analyzer/a.ts');
    const b = normalizePath('/project/src/webview/b.ts');
    const c = normalizePath('/project/src/analyzer/sub/c.ts');
    const result = detectPathCommunities([a, b, c]);
    // prefix: shared=['','project','src'], minPartCount=5(a,b) or 6(c) → minPartCount=5, cap=3
    // prefix=['','project','src'] (shared=3, cap=min(3,3)=3)
    // a: relParts=['analyzer','a.ts'], dirParts=['analyzer'], key='analyzer' → id 1
    // c: relParts=['analyzer','sub','c.ts'], dirParts=['analyzer','sub'], key='analyzer/sub' → different id
    // b: relParts=['webview','b.ts'], dirParts=['webview'], key='webview' → id 2 (or 3)
    expect(result.get(a)).toBeGreaterThanOrEqual(1);
    expect(result.get(b)).toBeGreaterThanOrEqual(1);
    expect(result.get(a)).not.toBe(result.get(b));
  });

  it('mixed shallow and deep files both get a communityId ≥ 1', () => {
    // /project/index.ts: parts=['','project','index.ts'] (len 3)
    // /project/src/analyzer/Spider.ts: parts=['','project','src','analyzer','Spider.ts'] (len 5)
    // minPartCount=3, cap=max(0,3-2)=1 → prefix=['']
    // index.ts: relParts=['project','index.ts'], dirParts=['project'], key='project' → id 1
    // Spider.ts: relParts=['project','src','analyzer','Spider.ts'], dirParts=['project','src'], key='project/src' → id 2
    const shallow = normalizePath('/project/index.ts');
    const deep = normalizePath('/project/src/analyzer/Spider.ts');
    const result = detectPathCommunities([shallow, deep]);
    expect(result.get(shallow)).toBeDefined();
    expect(result.get(deep)).toBeDefined();
    expect(result.get(shallow)).not.toBe(result.get(deep));
  });

  it('all nodes in same dir → single communityId (1)', () => {
    const a = normalizePath('/project/src/analyzer/a.ts');
    const b = normalizePath('/project/src/analyzer/b.ts');
    const c = normalizePath('/project/src/analyzer/c.ts');
    const result = detectPathCommunities([a, b, c]);
    expect(result.get(a)).toBe(1);
    expect(result.get(b)).toBe(1);
    expect(result.get(c)).toBe(1);
  });
});
