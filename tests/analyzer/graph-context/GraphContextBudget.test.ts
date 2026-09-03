import { describe, expect, it } from 'vitest';
import { applyGraphContextBudget } from '../../../src/analyzer/graph-context/GraphContextBudget';
import type {
  GraphContextEdge,
  GraphContextNode,
  GraphContextResponse,
} from '../../../src/shared/graph-context-types';
import { estimateTokens } from '../../../src/shared/toon';

const TOKEN_BUDGET = 500;

function node(
  id: string,
  kind: GraphContextNode['kind'] = 'symbol',
  score = 0,
): GraphContextNode {
  return {
    id,
    kind,
    name: `DescriptiveGraphContextNode${id}`,
    path: `src/features/graph-context/${id}.ts`,
    startLine: 10,
    endLine: 20,
    language: 'typescript',
    score,
  };
}

function edge(
  source: string,
  target: string,
  relation: GraphContextEdge['relation'],
  confidence: GraphContextEdge['confidence'] = 'EXTRACTED',
): GraphContextEdge {
  return {
    source,
    target,
    relation,
    confidence,
    sourcePath: `src/features/graph-context/${source}.ts`,
    sourceLine: 12,
    evidence: {
      sourcePath: `src/features/graph-context/${source}.ts`,
      sourceLine: 12,
      reason: `${relation} evidence for ${source} to ${target}.`,
    },
  };
}

function responseFixture(): GraphContextResponse {
  const nodes = [
    node('seed', 'symbol', 100),
    node('path-middle', 'symbol', 90),
    node('path-target', 'symbol', 80),
    node('direct-neighbor', 'file', 70),
    node('contract-test', 'test', 1),
    node('runtime-caller', 'symbol', 60),
    node('resolved-source', 'symbol', 50),
    node('resolved-target', 'symbol', 40),
    ...Array.from({ length: 14 }, (_, index) => node(`transitive-${index}`, 'symbol', 30 - index)),
  ];
  const edges = [
    edge('seed', 'path-middle', 'CALLS'),
    edge('path-middle', 'path-target', 'USES'),
    edge('seed', 'direct-neighbor', 'IMPORTS'),
    edge('contract-test', 'seed', 'TESTED_BY'),
    edge('runtime-caller', 'seed', 'IMPACTED_BY', 'INFERRED'),
    edge('resolved-source', 'resolved-target', 'REFERENCES', 'RESOLVED'),
    ...Array.from({ length: 13 }, (_, index) => (
      edge(`transitive-${index}`, `transitive-${index + 1}`, 'CONTAINS')
    )),
    edge('missing-node', 'seed', 'CALLS'),
  ];

  return {
    indexRevision: 'budget-revision-1',
    fresh: true,
    mode: 'path',
    seeds: [{ ...nodes[0], isSeed: true }],
    nodes: nodes.map(graphNode => graphNode.id === 'seed'
      ? { ...graphNode, isSeed: true }
      : graphNode),
    edges,
    paths: [{
      nodeIds: ['seed', 'path-middle', 'path-target'],
      edgeIndexes: [0, 1],
      hops: 2,
    }],
    ambiguous: [],
    omitted: { nodes: 2, edges: 3 },
    nextQueries: ['Inspect the direct callers after following this path.'],
    tokenEstimate: 0,
    truncated: true,
  };
}

describe('applyGraphContextBudget', () => {
  it.each([
    499,
    16_001,
    500.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])('rejects an invalid token budget of %s', invalidBudget => {
    expect(() => applyGraphContextBudget(responseFixture(), invalidBudget)).toThrow(
      /between 500 and 16000/i,
    );
  });

  it.each([500, 16_000])('accepts the inclusive token budget boundary %s', tokenBudget => {
    expect(() => applyGraphContextBudget(responseFixture(), tokenBudget)).not.toThrow();
  });

  it('preserves seeds and path endpoints while reporting exact graph omissions', () => {
    const response = responseFixture();
    expect(estimateTokens(JSON.stringify(response))).toBeGreaterThan(TOKEN_BUDGET);

    const budgeted = applyGraphContextBudget(response, TOKEN_BUDGET);
    const retainedIds = new Set(budgeted.nodes.map(result => result.id));

    expect(retainedIds.has('seed')).toBe(true);
    expect(retainedIds.has('path-target')).toBe(true);
    expect(budgeted.seeds.map(seedNode => seedNode.id)).toEqual(['seed']);
    expect(budgeted.edges.every(result => (
      retainedIds.has(result.source) && retainedIds.has(result.target)
    ))).toBe(true);
    expect(budgeted.omitted).toEqual({
      nodes: response.omitted.nodes + response.nodes.length - budgeted.nodes.length,
      edges: response.omitted.edges + response.edges.length - budgeted.edges.length,
    });
    expect(budgeted.truncated).toBe(true);
    expect(budgeted.tokenEstimate).toBe(estimateTokens(JSON.stringify(budgeted)));
    expect(budgeted.tokenEstimate).toBeLessThanOrEqual(TOKEN_BUDGET);
  });

  it('keeps canonical path edge indexes after filtering the response edges', () => {
    const budgeted = applyGraphContextBudget(responseFixture(), TOKEN_BUDGET);
    const path = budgeted.paths[0];

    expect(path).toBeDefined();
    expect(path.edgeIndexes).toHaveLength(path.hops);
    expect(path.edgeIndexes.map(index => budgeted.edges[index])).toEqual([
      expect.objectContaining({ source: 'seed', target: 'path-middle' }),
      expect.objectContaining({ source: 'path-middle', target: 'path-target' }),
    ]);
  });

  it('uses the real tokenizer when a chars-per-four estimate would fit', () => {
    const seedNode = node('compact-seed', 'file', 10);
    const noisyNode = {
      ...node('punctuation-heavy', 'symbol', 9),
      name: '.;[]{}()<>!?'.repeat(60),
    };
    const response: GraphContextResponse = {
      indexRevision: 'tokenizer-revision',
      fresh: true,
      mode: 'search',
      seeds: [{ ...seedNode, isSeed: true }],
      nodes: [{ ...seedNode, isSeed: true }, noisyNode],
      edges: [],
      paths: [],
      ambiguous: [],
      omitted: { nodes: 0, edges: 0 },
      nextQueries: [],
      tokenEstimate: 0,
      truncated: false,
    };
    const serialized = JSON.stringify(response);

    expect(serialized.length / 4).toBeLessThan(TOKEN_BUDGET);
    expect(estimateTokens(serialized)).toBeGreaterThan(TOKEN_BUDGET);

    const budgeted = applyGraphContextBudget(response, TOKEN_BUDGET);

    expect(budgeted.nodes.map(result => result.id)).toEqual(['compact-seed']);
    expect(budgeted.tokenEstimate).toBeLessThanOrEqual(TOKEN_BUDGET);
  });

  it('prioritizes direct neighbors and tests over high-score transitive nodes', () => {
    const seedNode = node('priority-seed', 'symbol', 100);
    const transitiveNode = {
      ...node('large-transitive', 'symbol', 1_000),
      name: 'alpha beta gamma delta epsilon zeta eta theta '.repeat(120),
    };
    const directNode = node('small-direct', 'file', 1);
    const testNode = node('small-test', 'test', 0);
    const response: GraphContextResponse = {
      indexRevision: 'priority-revision',
      fresh: true,
      mode: 'refactor',
      seeds: [{ ...seedNode, isSeed: true }],
      nodes: [{ ...seedNode, isSeed: true }, transitiveNode, directNode, testNode],
      edges: [
        edge('priority-seed', 'small-direct', 'IMPORTS'),
      ],
      paths: [],
      ambiguous: [],
      omitted: { nodes: 0, edges: 0 },
      nextQueries: [],
      tokenEstimate: 0,
      truncated: false,
    };

    const budgeted = applyGraphContextBudget(response, TOKEN_BUDGET);

    expect(budgeted.nodes.map(result => result.id)).toEqual([
      'priority-seed',
      'small-direct',
      'small-test',
    ]);
  });

  it('rejects a budget that cannot contain mandatory graph identities', () => {
    const response = responseFixture();
    response.nodes[0] = {
      ...response.nodes[0],
      name: 'mandatory seed content '.repeat(200),
    };
    response.seeds[0] = { ...response.nodes[0], isSeed: true };

    expect(() => applyGraphContextBudget(response, TOKEN_BUDGET)).toThrow(
      /mandatory seeds and path endpoints/i,
    );
  });
});
