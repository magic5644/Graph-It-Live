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
});

