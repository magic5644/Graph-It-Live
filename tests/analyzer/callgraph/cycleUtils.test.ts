import { describe, expect, it } from 'vitest';
import { detectCycleEdges, detectCycles, getCyclicEdgeIds } from '@/analyzer/callgraph/cycleUtils';

describe('cycle detection', () => {
  const overlapping = [
    { source: 'a', target: 'b' }, { source: 'b', target: 'a' },
    { source: 'a', target: 'c' }, { source: 'c', target: 'b' },
  ];

  it('finds all overlapping cycles regardless of edge order', () => {
    for (const edges of [overlapping, [...overlapping].reverse()]) {
      expect(detectCycles(edges)).toEqual(new Set(['a', 'b', 'c']));
      expect(detectCycleEdges(edges)).toEqual(new Set(edges.map(e => `${e.source}->${e.target}`)));
    }
  });

  it('excludes one-way bridges between separate cycles', () => {
    const edges = [
      { source: 'a', target: 'b' }, { source: 'b', target: 'a' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'd' }, { source: 'd', target: 'c' },
    ];
    expect(detectCycleEdges(edges)).toEqual(new Set(['a->b', 'b->a', 'c->d', 'd->c']));
    expect(getCyclicEdgeIds(edges, detectCycles(edges))).toEqual(['a::b', 'b::a', 'c::d', 'd::c']);
    expect(getCyclicEdgeIds(edges, new Set(['a', 'b']))).toEqual(['a::b', 'b::a']);
  });

  it('handles empty graphs, duplicates, self loops and acyclic tails', () => {
    expect(detectCycles([]).size).toBe(0);
    const edges = [
      { source: 'a', target: 'a' }, { source: 'a', target: 'a' },
      { source: 'a', target: 'b' }, { source: 'b', target: 'c' },
    ];
    expect(detectCycleEdges(edges)).toEqual(new Set(['a->a']));
    expect(detectCycles(edges)).toEqual(new Set(['a']));
  });

  it('matches return-path reachability for every directed graph on three nodes', () => {
    const allEdges = ['a', 'b', 'c'].flatMap(source => ['a', 'b', 'c'].map(target => ({ source, target })));
    for (let mask = 0; mask < 512; mask++) {
      const edges = allEdges.filter((_, i) => mask & (1 << i));
      const expected = new Set<string>();
      for (const edge of edges) {
        const reachable = new Set([edge.target]);
        for (const node of reachable) {
          for (const next of edges) if (next.source === node) reachable.add(next.target);
        }
        if (reachable.has(edge.source)) expected.add(`${edge.source}->${edge.target}`);
      }
      expect(detectCycleEdges(edges)).toEqual(expected);
      expect(detectCycleEdges([...edges].reverse())).toEqual(expected);
    }
  });

  it('handles a 20,000-edge chain and cycle without overflowing the stack', () => {
    const edges = Array.from({ length: 20000 }, (_, i) => ({ source: `n${i}`, target: `n${i + 1}` }));
    expect(detectCycleEdges(edges).size).toBe(0);
    edges.push({ source: 'n20000', target: 'n0' });
    expect(detectCycles(edges).size).toBe(20001);
  });
});
