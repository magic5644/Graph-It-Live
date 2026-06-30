/**
 * Unit tests for LouvainDetector.detectCommunities (F4 feature).
 * Coverage targets: triangle graph, 2 disjoint clusters, isolated node, empty graph,
 * normalizePath on keys.
 */
import { describe, it, expect } from 'vitest';
import { detectCommunities } from '../../../src/analyzer/community/LouvainDetector.js';
import { normalizePath } from '../../../src/shared/path.js';

describe('detectCommunities', () => {
  it('triangle graph (3 nodes, 3 edges) → 1 community, all ids >= 1', () => {
    const a = normalizePath('/project/a.ts');
    const b = normalizePath('/project/b.ts');
    const c = normalizePath('/project/c.ts');

    const result = detectCommunities({
      nodes: [a, b, c],
      edges: [
        { source: a, target: b },
        { source: b, target: c },
        { source: c, target: a },
      ],
    });

    expect(result.count).toBe(1);
    expect(result.assignments.get(a)).toBeGreaterThanOrEqual(1);
    expect(result.assignments.get(b)).toBeGreaterThanOrEqual(1);
    expect(result.assignments.get(c)).toBeGreaterThanOrEqual(1);
    // All should be in the same community
    expect(result.assignments.get(a)).toBe(result.assignments.get(b));
    expect(result.assignments.get(b)).toBe(result.assignments.get(c));
  });

  it('2 disjoint clusters (A-B-C and D-E-F) → 2 distinct communities', () => {
    const a = normalizePath('/project/a.ts');
    const b = normalizePath('/project/b.ts');
    const c = normalizePath('/project/c.ts');
    const d = normalizePath('/project/d.ts');
    const e = normalizePath('/project/e.ts');
    const f = normalizePath('/project/f.ts');

    const result = detectCommunities({
      nodes: [a, b, c, d, e, f],
      edges: [
        { source: a, target: b },
        { source: b, target: c },
        { source: c, target: a },
        { source: d, target: e },
        { source: e, target: f },
        { source: f, target: d },
      ],
    });

    expect(result.count).toBe(2);

    // Cluster 1: a, b, c should all share the same communityId
    const commABC = result.assignments.get(a)!;
    expect(commABC).toBeGreaterThanOrEqual(1);
    expect(result.assignments.get(b)).toBe(commABC);
    expect(result.assignments.get(c)).toBe(commABC);

    // Cluster 2: d, e, f should all share the same communityId
    const commDEF = result.assignments.get(d)!;
    expect(commDEF).toBeGreaterThanOrEqual(1);
    expect(result.assignments.get(e)).toBe(commDEF);
    expect(result.assignments.get(f)).toBe(commDEF);

    // The two clusters must have different community ids
    expect(commABC).not.toBe(commDEF);
  });

  it('isolated node → communityId === 0', () => {
    const isolated = normalizePath('/project/isolated.ts');

    const result = detectCommunities({
      nodes: [isolated],
      edges: [],
    });

    expect(result.assignments.get(isolated)).toBe(0);
    expect(result.count).toBe(0);
  });

  it('empty graph (0 nodes) → count 0', () => {
    const result = detectCommunities({ nodes: [], edges: [] });

    expect(result.count).toBe(0);
    expect(result.assignments.size).toBe(0);
  });

  it('normalizePath is applied to output keys', () => {
    // Pass raw paths — keys in assignments must be normalized
    const rawA = '/project/src/a.ts';
    const rawB = '/project/src/b.ts';

    const result = detectCommunities({
      nodes: [rawA, rawB],
      edges: [{ source: rawA, target: rawB }],
    });

    // Keys must be normalized
    expect(result.assignments.has(normalizePath(rawA))).toBe(true);
    expect(result.assignments.has(normalizePath(rawB))).toBe(true);
  });

  it('mixed graph: connected nodes get community >= 1, isolated get 0', () => {
    const connected1 = normalizePath('/project/x.ts');
    const connected2 = normalizePath('/project/y.ts');
    const iso = normalizePath('/project/z.ts');

    const result = detectCommunities({
      nodes: [connected1, connected2, iso],
      edges: [{ source: connected1, target: connected2 }],
    });

    expect(result.assignments.get(connected1)).toBeGreaterThanOrEqual(1);
    expect(result.assignments.get(connected2)).toBeGreaterThanOrEqual(1);
    expect(result.assignments.get(iso)).toBe(0);
  });

  it('community ids are contiguous 1-indexed after remapping', () => {
    const a = normalizePath('/p/a.ts');
    const b = normalizePath('/p/b.ts');
    const c = normalizePath('/p/c.ts');
    const d = normalizePath('/p/d.ts');

    // Two separate pairs → 2 communities
    const result = detectCommunities({
      nodes: [a, b, c, d],
      edges: [
        { source: a, target: b },
        { source: c, target: d },
      ],
    });

    const ids = new Set([
      result.assignments.get(a),
      result.assignments.get(b),
      result.assignments.get(c),
      result.assignments.get(d),
    ]);

    // Should have exactly 2 distinct community ids, both >= 1
    expect(ids.size).toBe(2);
    for (const id of ids) {
      expect(id).toBeGreaterThanOrEqual(1);
    }
    // count matches
    expect(result.count).toBe(2);
  });
});
