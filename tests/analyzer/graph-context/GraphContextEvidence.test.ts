import { describe, expect, it } from 'vitest';
import { toEvidence } from '../../../src/analyzer/graph-context/GraphContextEvidence';
import { GraphContextRetriever } from '../../../src/analyzer/graph-context/GraphContextRetriever';
import type {
  GraphContextEdge,
  GraphContextNode,
  GraphContextSnapshot,
} from '../../../src/shared/graph-context-types';

const WORKSPACE_ROOT = '/workspace';

describe('toEvidence', () => {
  it('maps an AST call to extracted evidence without changing its direction', () => {
    const edge = toEvidence({
      source: 'symbol:src/api.ts:handle:4',
      target: 'symbol:src/service.ts:run:8',
      relation: 'CALLS',
      origin: 'AST',
      workspaceRoot: WORKSPACE_ROOT,
      sourcePath: '/workspace/src/api.ts',
      sourceLine: 6,
    });

    expect(edge).toEqual({
      source: 'symbol:src/api.ts:handle:4',
      target: 'symbol:src/service.ts:run:8',
      relation: 'CALLS',
      confidence: 'EXTRACTED',
      sourcePath: 'src/api.ts',
      sourceLine: 6,
      evidence: {
        sourcePath: 'src/api.ts',
        sourceLine: 6,
        reason: 'CALLS relation extracted from the AST.',
      },
    });
  });

  it('maps a module-resolved import and its existing line metadata to resolved evidence', () => {
    const edge = toEvidence({
      source: 'file:src/api.ts',
      target: 'file:src/service.ts',
      relation: 'IMPORTS',
      origin: 'MODULE_RESOLUTION',
      workspaceRoot: WORKSPACE_ROOT,
      sourcePath: '/workspace/src/api.ts',
      sourceLine: 1,
    });

    expect(edge.confidence).toBe('RESOLVED');
    expect(edge.evidence).toEqual({
      sourcePath: 'src/api.ts',
      sourceLine: 1,
      reason: 'Import target resolved to a workspace file.',
    });
  });

  it('marks an unresolved multi-target edge ambiguous', () => {
    const edge = toEvidence({
      source: 'symbol:src/api.ts:handle:4',
      target: 'external:Worker',
      relation: 'CALLS',
      origin: 'AST',
      workspaceRoot: WORKSPACE_ROOT,
      sourcePath: '/workspace/src/api.ts',
      sourceLine: 7,
      ambiguous: true,
    });

    expect(edge.confidence).toBe('AMBIGUOUS');
    expect(edge.evidence?.reason).toBe('Unresolved CALLS target has multiple resolver candidates.');
  });

  it('marks evidence stale when its source changed after indexing', () => {
    const edge = toEvidence({
      source: 'symbol:src/api.ts:handle:4',
      target: 'symbol:src/service.ts:run:8',
      relation: 'CALLS',
      origin: 'AST',
      workspaceRoot: WORKSPACE_ROOT,
      sourcePath: '/workspace/src/api.ts',
      sourceLine: 6,
      stale: true,
    });

    expect(edge.confidence).toBe('STALE');
    expect(edge.evidence?.reason).toBe('Source changed after this relation was indexed.');
  });

  it('does not invent line precision or expose paths outside the workspace', () => {
    const edge = toEvidence({
      source: 'symbol:src/api.ts:handle:4',
      target: 'external:Worker',
      relation: 'CALLS',
      origin: 'AST',
      workspaceRoot: WORKSPACE_ROOT,
      sourcePath: '/other-project/private.ts',
      sourceLine: 0,
      sourceEndLine: 12,
    });

    expect(edge).not.toHaveProperty('sourcePath');
    expect(edge).not.toHaveProperty('sourceLine');
    expect(edge).not.toHaveProperty('sourceEndLine');
    expect(edge.evidence).not.toHaveProperty('sourcePath');
    expect(edge.evidence).not.toHaveProperty('sourceLine');
    expect(edge.evidence).not.toHaveProperty('sourceEndLine');
  });
});

describe('ambiguity diagnostics', () => {
  const start = node('symbol:src/start.ts:start:1', 'start', 'src/start.ts');
  const external = node('external:Worker', 'Worker', undefined, 'external');
  const workerA = node('symbol:src/a.ts:Worker:1', 'Worker', 'src/a.ts');
  const workerB = node('symbol:src/b.ts:Worker:1', 'Worker', 'src/b.ts');
  const finish = node('symbol:src/finish.ts:finish:1', 'finish', 'src/finish.ts');
  const ambiguousEdge = toEvidence({
    source: start.id,
    target: external.id,
    relation: 'CALLS',
    origin: 'AST',
    workspaceRoot: WORKSPACE_ROOT,
    sourcePath: '/workspace/src/start.ts',
    sourceLine: 2,
    ambiguous: true,
  });
  const snapshot: GraphContextSnapshot = {
    revision: 'ambiguity-fixture',
    fresh: true,
    nodes: [start, external, workerA, workerB, finish],
    edges: [
      ambiguousEdge,
      extractedEdge(external.id, finish.id),
    ],
  };

  it('returns candidate IDs and reasons without selecting an ambiguous path edge', async () => {
    const retriever = new GraphContextRetriever({
      snapshotProvider: { buildSnapshot: async () => snapshot },
      workspaceRoot: WORKSPACE_ROOT,
    });

    const response = await retriever.retrieve({
      question: 'How does start reach finish?',
      mode: 'path',
      from: { id: start.id },
      to: { id: finish.id },
      depth: 3,
    });

    expect(response.paths).toEqual([]);
    expect(response.edges).toEqual([]);
    expect(response.ambiguous.map(candidate => ({
      id: candidate.node.id,
      reason: candidate.reason,
    }))).toEqual([
      { id: workerA.id, reason: 'Exact symbol name' },
      { id: workerB.id, reason: 'Exact symbol name' },
    ]);
  });

  it('reports ambiguity beyond the last concrete node when a path is blocked', async () => {
    const a = node('symbol:src/a.ts:a:1', 'a', 'src/a.ts');
    const b = node('symbol:src/b.ts:b:1', 'b', 'src/b.ts');
    const unresolved = node('external:Worker', 'Worker', undefined, 'external');
    const c = node('symbol:src/c.ts:c:1', 'c', 'src/c.ts');
    const candidateA = node('symbol:src/worker-a.ts:Worker:1', 'Worker', 'src/worker-a.ts');
    const candidateB = node('symbol:src/worker-b.ts:Worker:1', 'Worker', 'src/worker-b.ts');
    const blockedSnapshot: GraphContextSnapshot = {
      revision: 'blocked-ambiguity-fixture',
      fresh: true,
      nodes: [a, b, unresolved, c, candidateA, candidateB],
      edges: [
        extractedEdge(a.id, b.id),
        toEvidence({
          source: b.id,
          target: unresolved.id,
          relation: 'CALLS',
          origin: 'AST',
          workspaceRoot: WORKSPACE_ROOT,
          sourceLine: 2,
          ambiguous: true,
        }),
        extractedEdge(unresolved.id, c.id),
      ],
    };
    const retriever = new GraphContextRetriever({
      snapshotProvider: { buildSnapshot: async () => blockedSnapshot },
      workspaceRoot: WORKSPACE_ROOT,
    });

    const response = await retriever.retrieve({
      question: 'How does a reach c?',
      mode: 'path',
      from: { id: a.id },
      to: { id: c.id },
      depth: 4,
    });

    expect(response.paths).toEqual([]);
    expect(response.nodes.map(result => result.id)).toEqual([a.id, b.id, c.id]);
    expect(response.ambiguous.map(candidate => candidate.node.id)).toEqual([
      candidateA.id,
      candidateB.id,
    ]);
  });
});

function node(
  id: string,
  name: string,
  filePath: string | undefined,
  kind: GraphContextNode['kind'] = 'symbol',
): GraphContextNode {
  return { id, kind, name, path: filePath };
}

function extractedEdge(source: string, target: string): GraphContextEdge {
  return { source, target, relation: 'CALLS', confidence: 'EXTRACTED' };
}
