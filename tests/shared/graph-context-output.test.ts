import { describe, expect, it } from 'vitest';
import { projectGraphContextOutput } from '../../src/shared/graph-context-output';
import type { GraphContextResponse } from '../../src/shared/graph-context-types';

const response: GraphContextResponse = {
  indexRevision: 'rev-1',
  fresh: true,
  mode: 'neighbors',
  seeds: [{ id: 'seed', kind: 'symbol', name: 'handleUser', path: 'src/controller.ts', startLine: 3, endLine: 8, language: 'typescript', score: 100, isSeed: true }],
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
