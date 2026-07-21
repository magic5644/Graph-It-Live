import { describe, it, expect } from 'vitest';
import { mergeGraphDataUnion } from '../../../src/webview/utils/graphMerge';
import type { GraphData } from '../../../src/shared/types';

describe('mergeGraphDataUnion', () => {
  it('never removes existing nodes/edges', () => {
    const base: GraphData = {
      nodes: ['a', 'b'],
      edges: [{ source: 'a', target: 'b' }],
      nodeLabels: { a: 'A' },
      parentCounts: { a: 1 },
    };

    const incoming: GraphData = {
      nodes: ['a'],
      edges: [],
      nodeLabels: { b: 'B' },
      parentCounts: { b: 2 },
    };

    const merged = mergeGraphDataUnion(base, incoming);

    expect(new Set(merged.nodes)).toEqual(new Set(['a', 'b']));
    expect(merged.edges).toEqual([{ source: 'a', target: 'b' }]);
    expect(merged.nodeLabels).toEqual({ a: 'A', b: 'B' });
    expect(merged.parentCounts).toEqual({ a: 1, b: 2 });
  });

  it('preserves nodeMetadata (communityId) when incoming data has none (GH #122)', () => {
    const base: GraphData = {
      nodes: ['a', 'b'],
      edges: [{ source: 'a', target: 'b' }],
      nodeMetadata: {
        a: { hubScore: 0.9, communityId: 1 },
        b: { hubScore: 0.4, communityId: 2 },
      },
    };
    const incoming: GraphData = {
      nodes: ['c'],
      edges: [{ source: 'c', target: 'a' }],
    };

    const merged = mergeGraphDataUnion(base, incoming);

    expect(merged.nodeMetadata).toEqual({
      a: { hubScore: 0.9, communityId: 1 },
      b: { hubScore: 0.4, communityId: 2 },
    });
  });

  it('merges nodeMetadata from both sides, incoming taking precedence on overlap', () => {
    const base: GraphData = {
      nodes: ['a'],
      edges: [],
      nodeMetadata: { a: { hubScore: 0.5, communityId: 1 } },
    };
    const incoming: GraphData = {
      nodes: ['a', 'c'],
      edges: [],
      nodeMetadata: {
        a: { hubScore: 0.5, communityId: 3 },
        c: { hubScore: 0.1, communityId: 3 },
      },
    };

    const merged = mergeGraphDataUnion(base, incoming);

    expect(merged.nodeMetadata).toEqual({
      a: { hubScore: 0.5, communityId: 3 },
      c: { hubScore: 0.1, communityId: 3 },
    });
  });
});

