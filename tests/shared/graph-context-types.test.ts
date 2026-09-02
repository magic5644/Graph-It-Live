import { describe, expect, it } from 'vitest';
import type {
  GraphContextCandidate,
  GraphContextConfidence,
  GraphContextEdge,
  GraphContextEvidence,
  GraphContextMode,
  GraphContextNode,
  GraphContextNodeKind,
  GraphContextPath,
  GraphContextRelation,
  GraphContextRequest,
  GraphContextResolution,
  GraphContextResponse,
  GraphContextSeed,
  GraphContextSnapshot,
} from '../../src/shared/graph-context-types.js';

const modes: GraphContextMode[] = [
  'search',
  'neighbors',
  'path',
  'impact',
  'refactor',
  'overview',
];

const nodeKinds: GraphContextNodeKind[] = [
  'file',
  'symbol',
  'test',
  'community',
  'document',
  'rationale',
  'external',
];

const relations: GraphContextRelation[] = [
  'CONTAINS',
  'IMPORTS',
  'CALLS',
  'INHERITS',
  'IMPLEMENTS',
  'USES',
  'TESTED_BY',
  'IMPACTED_BY',
  'BELONGS_TO',
  'REFERENCES',
  'EXPLAINS',
  'DOCUMENTS',
];

const confidences: GraphContextConfidence[] = [
  'EXTRACTED',
  'RESOLVED',
  'INFERRED',
  'AMBIGUOUS',
  'STALE',
];

const seed: GraphContextSeed = {
  id: 'src/index.ts',
  filePath: 'src/index.ts',
  symbolName: 'main',
  label: 'entry point',
};

const node: GraphContextNode = {
  id: 'src/index.ts',
  kind: 'file',
  name: 'index.ts',
  path: 'src/index.ts',
  startLine: 1,
  endLine: 10,
  language: 'typescript',
  score: 1,
  isSeed: true,
};

const evidence: GraphContextEvidence = {
  sourcePath: 'src/index.ts',
  sourceLine: 3,
  sourceEndLine: 3,
  reason: 'Imported by the entry point',
};

const edge: GraphContextEdge = {
  source: 'src/index.ts',
  target: 'src/app.ts',
  relation: 'IMPORTS',
  confidence: 'RESOLVED',
  sourcePath: 'src/index.ts',
  sourceLine: 3,
  sourceEndLine: 3,
  evidence,
};

const path: GraphContextPath = {
  nodeIds: ['src/index.ts', 'src/app.ts'],
  edgeIndexes: [0],
  hops: 1,
};

const candidate: GraphContextCandidate = {
  node,
  score: 0.9,
  reason: 'Exact symbol match',
};

const resolution: GraphContextResolution = {
  selected: node,
  candidates: [candidate],
  ambiguous: false,
  notFound: false,
};

const request: GraphContextRequest = {
  question: 'Where is the application entry point?',
  seeds: [seed],
  mode: 'search',
  from: seed,
  to: { filePath: 'src/app.ts' },
  relations: ['CONTAINS', 'IMPORTS'],
  scope: 'src/**',
  depth: 2,
  maxNodes: 20,
  tokenBudget: 500,
  directed: true,
  cursor: 'cursor-1',
  format: 'json',
};

const snapshot: GraphContextSnapshot = {
  revision: 'revision-1',
  fresh: true,
  nodes: [node],
  edges: [edge],
};

const response: GraphContextResponse = {
  indexRevision: snapshot.revision,
  fresh: snapshot.fresh,
  mode: request.mode ?? 'search',
  seeds: [node],
  nodes: [node],
  edges: [edge],
  paths: [path],
  ambiguous: [candidate],
  omitted: { nodes: 0, edges: 0 },
  nextQueries: ['src/app.ts'],
  nextCursor: 'cursor-2',
  tokenEstimate: 120,
  truncated: false,
};

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

const exactUnionChecks: [
  Expect<Equal<GraphContextMode, 'search' | 'neighbors' | 'path' | 'impact' | 'refactor' | 'overview'>>,
  Expect<Equal<GraphContextNodeKind, 'file' | 'symbol' | 'test' | 'community' | 'document' | 'rationale' | 'external'>>,
  Expect<Equal<GraphContextRelation, 'CONTAINS' | 'IMPORTS' | 'CALLS' | 'INHERITS' | 'IMPLEMENTS' | 'USES' | 'TESTED_BY' | 'IMPACTED_BY' | 'BELONGS_TO' | 'REFERENCES' | 'EXPLAINS' | 'DOCUMENTS'>>,
  Expect<Equal<GraphContextConfidence, 'EXTRACTED' | 'RESOLVED' | 'INFERRED' | 'AMBIGUOUS' | 'STALE'>>,
] = [true, true, true, true];

const validQuestionRequest: GraphContextRequest = { question: 'find the entry point' };
const validSeedRequest: GraphContextRequest = { seeds: [seed] };
const validPathRequest: GraphContextRequest = { from: seed, to: { filePath: 'src/app.ts' } };

// @ts-expect-error A request must provide a question, a non-empty seed list, or both endpoints.
const emptyRequest: GraphContextRequest = {};
// @ts-expect-error A path request must provide both endpoints.
const fromOnlyRequest: GraphContextRequest = { from: seed };
// @ts-expect-error A path request must provide both endpoints.
const toOnlyRequest: GraphContextRequest = { to: seed };
// @ts-expect-error Seed-based requests must contain at least one seed.
const emptySeedsRequest: GraphContextRequest = { seeds: [] };

describe('GraphContext shared contract', () => {
  it('accepts every documented discriminant literal', () => {
    expect(exactUnionChecks).toEqual([true, true, true, true]);
    expect(modes).toEqual(['search', 'neighbors', 'path', 'impact', 'refactor', 'overview']);
    expect(nodeKinds).toEqual(['file', 'symbol', 'test', 'community', 'document', 'rationale', 'external']);
    expect(relations).toEqual(['CONTAINS', 'IMPORTS', 'CALLS', 'INHERITS', 'IMPLEMENTS', 'USES', 'TESTED_BY', 'IMPACTED_BY', 'BELONGS_TO', 'REFERENCES', 'EXPLAINS', 'DOCUMENTS']);
    expect(confidences).toEqual(['EXTRACTED', 'RESOLVED', 'INFERRED', 'AMBIGUOUS', 'STALE']);
  });

  it('serializes every contract shape as JSON', () => {
    const contract = {
      discriminants: { modes, nodeKinds, relations, confidences },
      requests: [request, validQuestionRequest, validSeedRequest, validPathRequest],
      resolution,
      snapshot,
      response,
    };
    const serialized = JSON.stringify(contract);

    expect(serialized).not.toBeUndefined();
    expect(JSON.parse(serialized)).toEqual(contract);
  });

  it('uses canonical ordered positional edgeIndexes in paths', () => {
    // The formal specification is canonical: path edges are positional indexes, not edge IDs.
    expect(path.nodeIds).toEqual(['src/index.ts', 'src/app.ts']);
    expect(path.edgeIndexes).toEqual([0]);
    expect(path.hops).toBe(path.edgeIndexes.length);
  });

  it('rejects unsupported relation and confidence literals at compile time', () => {
    // @ts-expect-error Unsupported relations must not enter the public contract.
    const unsupportedRelation: GraphContextRelation = 'EXTENDS';
    // @ts-expect-error Unsupported confidence values must not enter the public contract.
    const unsupportedConfidence: GraphContextConfidence = 'PREDICTED';

    expect(unsupportedRelation).toBe('EXTENDS');
    expect(unsupportedConfidence).toBe('PREDICTED');
  });
});
