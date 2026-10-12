import { describe, expect, it } from 'vitest';
import {
  detectLouvainCommunities,
  labelCommunity,
} from '../../../src/analyzer/community/LouvainCommunityDetector';
import type { CommunityGraph } from '../../../src/analyzer/community/types';

/** Two 4-cliques joined by a single bridge, plus one isolated node. */
function twoCliques(prefix = '/project'): CommunityGraph {
  const left = ['a', 'b', 'c', 'd'].map(name => `${prefix}/left/${name}.ts`);
  const right = ['e', 'f', 'g', 'h'].map(name => `${prefix}/right/${name}.ts`);
  const clique = (members: string[]) => members.flatMap((source, index) => (
    members.slice(index + 1).map(target => ({ source, target }))
  ));
  return {
    nodes: [...left, ...right, `${prefix}/isolated.ts`],
    edges: [...clique(left), ...clique(right), { source: left[3], target: right[0] }],
  };
}

function groups(assignments: Map<string, number>): string[][] {
  const byCommunity = new Map<number, string[]>();
  for (const [node, community] of assignments) {
    byCommunity.set(community, [...(byCommunity.get(community) ?? []), node]);
  }
  return [...byCommunity.values()].map(members => members.sort()).sort((left, right) => left[0].localeCompare(right[0]));
}

describe('detectLouvainCommunities', () => {
  it('splits two dense clusters joined by a bridge and keeps isolated nodes at 0', () => {
    const result = detectLouvainCommunities(twoCliques());

    expect(result.count).toBe(2);
    expect(result.assignments.get('/project/isolated.ts')).toBe(0);
    expect(groups(result.assignments)).toEqual([
      ['/project/isolated.ts'],
      ['/project/left/a.ts', '/project/left/b.ts', '/project/left/c.ts', '/project/left/d.ts'],
      ['/project/right/e.ts', '/project/right/f.ts', '/project/right/g.ts', '/project/right/h.ts'],
    ]);
  });

  it('gives the same assignments whatever the input order', () => {
    const graph = twoCliques();
    const reversed = { nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() };
    const swapped = { nodes: graph.nodes, edges: graph.edges.map(edge => ({ source: edge.target, target: edge.source })) };

    const expected = [...detectLouvainCommunities(graph).assignments];
    expect([...detectLouvainCommunities(reversed).assignments].sort()).toEqual([...expected].sort());
    expect([...detectLouvainCommunities(swapped).assignments].sort()).toEqual([...expected].sort());
    expect([...detectLouvainCommunities(graph).assignments]).toEqual(expected);
  });

  it('aggregates small groups into larger communities across levels', () => {
    // Ring of 30 triangles: merging neighbor triangles beats one community per triangle
    // (modularity 0.808 vs 0.717), which only the aggregation phase can reach.
    const nodes: string[] = [];
    const edges: CommunityGraph['edges'] = [];
    for (let triangle = 0; triangle < 30; triangle += 1) {
      const members = [0, 1, 2].map(index => `t${triangle}n${index}`);
      nodes.push(...members);
      edges.push(
        { source: members[0], target: members[1] },
        { source: members[1], target: members[2] },
        { source: members[2], target: members[0] },
        { source: members[2], target: `t${(triangle + 1) % 30}n0` },
      );
    }

    const result = detectLouvainCommunities({ nodes, edges });

    expect(result.count).toBeGreaterThanOrEqual(2);
    expect(result.count).toBeLessThan(30);
    for (let triangle = 0; triangle < 30; triangle += 1) {
      const community = result.assignments.get(`t${triangle}n0`);
      expect(result.assignments.get(`t${triangle}n1`)).toBe(community);
      expect(result.assignments.get(`t${triangle}n2`)).toBe(community);
    }
  });

  it('separates disconnected components and numbers them largest first', () => {
    const result = detectLouvainCommunities({
      nodes: ['x1', 'x2', 'y1', 'y2', 'y3'],
      edges: [
        { source: 'x1', target: 'x2' },
        { source: 'y1', target: 'y2' },
        { source: 'y2', target: 'y3' },
        { source: 'y3', target: 'y1' },
      ],
    });

    expect(result.count).toBe(2);
    expect(['y1', 'y2', 'y3'].map(node => result.assignments.get(node))).toEqual([1, 1, 1]);
    expect(['x1', 'x2'].map(node => result.assignments.get(node))).toEqual([2, 2]);
  });

  it('follows edge weights', () => {
    const result = detectLouvainCommunities({
      nodes: ['a', 'b', 'c', 'd'],
      edges: [
        { source: 'a', target: 'b', weight: 10 },
        { source: 'c', target: 'd', weight: 10 },
        { source: 'b', target: 'c', weight: 1 },
        { source: 'a', target: 'd', weight: 1 },
      ],
    });

    expect(result.assignments.get('a')).toBe(result.assignments.get('b'));
    expect(result.assignments.get('c')).toBe(result.assignments.get('d'));
    expect(result.assignments.get('a')).not.toBe(result.assignments.get('c'));
  });

  it('returns no community for an empty graph or a graph without edges', () => {
    expect(detectLouvainCommunities({ nodes: [], edges: [] })).toEqual({ assignments: new Map(), count: 0 });
    expect(detectLouvainCommunities({ nodes: ['a', 'b'], edges: [] })).toEqual({
      assignments: new Map([['a', 0], ['b', 0]]),
      count: 0,
    });
  });

  it('ignores edges to unknown nodes and non-positive or non-finite weights', () => {
    const result = detectLouvainCommunities({
      nodes: ['a', 'b'],
      edges: [
        { source: 'a', target: 'missing' },
        { source: 'a', target: 'b', weight: 0 },
        { source: 'b', target: 'a', weight: -1 },
        { source: 'a', target: 'b', weight: Number.NaN },
        { source: 'a', target: 'b', weight: Number.POSITIVE_INFINITY },
      ],
    });

    expect(result).toEqual({ assignments: new Map([['a', 0], ['b', 0]]), count: 0 });
  });

  it('keeps a node with only a self-loop in its own community', () => {
    const result = detectLouvainCommunities({ nodes: ['a', 'b'], edges: [{ source: 'a', target: 'a' }] });

    expect(result).toEqual({ assignments: new Map([['a', 1], ['b', 0]]), count: 1 });
  });

  it('normalizes Windows paths in nodes and edges', () => {
    const graph = twoCliques(String.raw`C:\project`);
    const windows: CommunityGraph = {
      nodes: graph.nodes.map(node => node.replaceAll('/', '\\')),
      edges: graph.edges,
    };

    const result = detectLouvainCommunities(windows);

    expect(result.count).toBe(2);
    expect(result.assignments.get('c:/project/isolated.ts')).toBe(0);
    expect(result.assignments.get('c:/project/left/a.ts')).toBe(result.assignments.get('c:/project/left/d.ts'));
    expect(result.assignments.get('c:/project/left/a.ts')).not.toBe(result.assignments.get('c:/project/right/e.ts'));
  });
});

describe('labelCommunity', () => {
  it('names a community after the folder holding the most members', () => {
    expect(labelCommunity(['src/a/x.ts', 'src/a/y.ts', 'src/b/z.ts'], 'src/b/z.ts')).toBe('src/a');
  });

  it('breaks folder ties in sorted order', () => {
    expect(labelCommunity(['src/b/x.ts', 'src/a/y.ts'], 'hub.ts')).toBe('src/a');
  });

  it('falls back to the hub for root-level members or no paths', () => {
    expect(labelCommunity(['index.ts', 'main.ts'], 'index.ts')).toBe('index.ts');
    expect(labelCommunity([], 'externalHub')).toBe('externalHub');
  });

  it('normalizes Windows separators', () => {
    expect(labelCommunity([String.raw`src\a\x.ts`, 'src/a/y.ts'], 'hub')).toBe('src/a');
  });
});
