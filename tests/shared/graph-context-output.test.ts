import { describe, expect, it } from 'vitest';
import { projectGraphContextOutput } from '../../src/shared/graph-context-output';
import type { GraphContextResponse } from '../../src/shared/graph-context-types';

const response: GraphContextResponse = {
  indexRevision: 'rev-1',
  fresh: true,
  mode: 'neighbors',
  seeds: ['seed'],
  nodes: [
    { id: 'seed', kind: 'symbol', name: 'handleUser', path: 'src/controller.ts', startLine: 3, endLine: 8, language: 'typescript', score: 100, isSeed: true },
    { id: 'callee', kind: 'symbol', name: 'saveUser', path: 'src/repository.ts', startLine: 1, endLine: 5, language: 'typescript', score: 90 },
    { id: 'extra', kind: 'file', name: 'unrelated.ts', path: 'src/unrelated.ts', language: 'typescript', score: 1 },
  ],
  edges: [{ source: 'seed', target: 'callee', relation: 'CALLS', confidence: 'RESOLVED', sourcePath: 'src/controller.ts', sourceLine: 6 }],
  paths: [],
  ambiguous: [],
  omitted: { nodes: 0, edges: 0 },
  nextQueries: ['query 1', 'query 2', 'query 3', 'query 4'],
  tokenEstimate: 500,
  truncated: false,
};

describe('graph context output projection', () => {
  it('keeps evidence and relations while removing verbose fields and limiting nodes', () => {
    const compact = projectGraphContextOutput(response, 'compact');

    expect(compact.nodes).toEqual([
      { id: 'seed', kind: 'symbol', name: 'handleUser', path: 'src/controller.ts', startLine: 3, endLine: 8, isSeed: true },
      { id: 'callee', kind: 'symbol', name: 'saveUser', path: 'src/repository.ts', startLine: 1, endLine: 5 },
      { id: 'extra', kind: 'file', name: 'unrelated.ts', path: 'src/unrelated.ts' },
    ]);
    expect(compact.edges[0]).toMatchObject({ source: 'seed', target: 'callee', relation: 'CALLS', confidence: 'RESOLVED' });
    expect(compact.edges[0]?.sourcePath).toBeUndefined();
    expect(compact.omitted).toEqual({ nodes: 0, edges: 0 });
    expect(compact.nextQueries).toHaveLength(3);
  });

  it('leaves standard and full output unchanged', () => {
    expect(projectGraphContextOutput(response, undefined)).toBe(response);
    expect(projectGraphContextOutput(response, 'standard')).toBe(response);
    expect(projectGraphContextOutput(response, 'full')).toBe(response);
  });
});

describe('projectGraphContextOutput detail levels', () => {
  function bigResponse(nodeCount: number): GraphContextResponse {
    const nodes = Array.from({ length: nodeCount }, (_, index) => ({
      id: `n${index}`,
      kind: 'symbol' as const,
      name: `symbol${index}`,
      path: `src/file${index}.ts`,
      startLine: index + 1,
      language: 'typescript',
      score: nodeCount - index,
    }));
    return {
      indexRevision: 'rev',
      fresh: true,
      mode: 'search',
      seeds: ['n0'],
      nodes,
      edges: [],
      paths: [],
      ambiguous: [],
      omitted: { nodes: 0, edges: 0 },
      nextQueries: ['a', 'b', 'c', 'd', 'e'],
      nextCursor: 'cursor-token',
      tokenEstimate: 100,
      truncated: false,
    };
  }

  it('returns the response untouched at full detail', () => {
    const response = bigResponse(100);

    expect(projectGraphContextOutput(response, 'full')).toBe(response);
  });

  it('caps nodes at standard detail, which used to be identical to full', () => {
    const projected = projectGraphContextOutput(bigResponse(100), 'standard');

    expect(projected.nodes).toHaveLength(40);
    expect(projected.truncated).toBe(true);
    expect(projected.omitted.nodes).toBe(60);
  });

  it('keeps every node field at standard detail', () => {
    const projected = projectGraphContextOutput(bigResponse(100), 'standard');

    expect(projected.nodes[0]).toEqual(expect.objectContaining({
      language: 'typescript',
      score: 100,
    }));
  });

  it('keeps paginating at standard detail but not at compact', () => {
    expect(projectGraphContextOutput(bigResponse(100), 'standard').nextCursor).toBe('cursor-token');
    expect(projectGraphContextOutput(bigResponse(100), 'compact').nextCursor).toBeUndefined();
  });

  it('strips low-signal node fields at compact detail only', () => {
    const projected = projectGraphContextOutput(bigResponse(100), 'compact');

    expect(projected.nodes).toHaveLength(8);
    expect(projected.nodes[0]).not.toHaveProperty('language');
    expect(projected.nodes[0]).not.toHaveProperty('score');
  });

  it('defaults to standard when no detail is requested', () => {
    const projected = projectGraphContextOutput(bigResponse(100), undefined);

    expect(projected.nodes).toHaveLength(40);
  });

  it('returns a small response untouched at standard detail', () => {
    const response = bigResponse(5);

    expect(projectGraphContextOutput(response, 'standard')).toBe(response);
  });
});

describe('projectGraphContextOutput path remapping', () => {
  const base: GraphContextResponse = {
    indexRevision: 'rev',
    fresh: true,
    mode: 'path',
    seeds: ['a'],
    nodes: [
      { id: 'a', kind: 'symbol', name: 'a', path: 'src/a.ts', score: 100 },
      { id: 'b', kind: 'symbol', name: 'b', path: 'src/b.ts', score: 90 },
      { id: 'c', kind: 'symbol', name: 'c', path: 'src/c.ts', score: 80 },
    ],
    edges: [
      { source: 'a', target: 'b', relation: 'CALLS', confidence: 'EXTRACTED' },
      { source: 'b', target: 'c', relation: 'CALLS', confidence: 'EXTRACTED' },
    ],
    paths: [{ nodeIds: ['a', 'b', 'c'], edgeIndexes: [0, 1], hops: 2 }],
    ambiguous: [],
    omitted: { nodes: 0, edges: 0 },
    nextQueries: [],
    tokenEstimate: 10,
    truncated: false,
  };

  it('keeps a path whose nodes all survive, remapping its edge indexes', () => {
    const projected = projectGraphContextOutput(base, 'compact');

    expect(projected.paths).toEqual([{ nodeIds: ['a', 'b', 'c'], edgeIndexes: [0, 1], hops: 2 }]);
  });

  it('narrows seeds to the nodes that survived the projection', () => {
    const projected = projectGraphContextOutput(
      { ...base, seeds: ['a', 'missing'] },
      'compact',
    );

    expect(projected.seeds).toEqual(['a']);
  });

  it('compacts ambiguous candidates too', () => {
    const projected = projectGraphContextOutput(
      {
        ...base,
        ambiguous: [{
          node: { id: 'z', kind: 'symbol', name: 'z', path: 'src/z.ts', language: 'typescript', score: 5 },
          score: 5,
          reason: 'Exact symbol name',
        }],
      },
      'compact',
    );

    expect(projected.ambiguous[0].node).not.toHaveProperty('language');
  });
});
