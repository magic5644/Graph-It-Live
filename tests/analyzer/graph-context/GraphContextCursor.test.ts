import { describe, expect, it } from 'vitest';
import {
  applyGraphContextBudgetPage,
} from '../../../src/analyzer/graph-context/GraphContextBudget';
import {
  createGraphContextCursor,
  createGraphContextRequestHash,
  parseGraphContextCursor,
} from '../../../src/analyzer/graph-context/GraphContextCursor';
import type {
  GraphContextCursorPayload,
} from '../../../src/analyzer/graph-context/GraphContextCursor';
import type {
  GraphContextNode,
  GraphContextRequest,
  GraphContextResponse,
} from '../../../src/shared/graph-context-types';

const request: GraphContextRequest = {
  question: 'How does authentication reach the database?',
  mode: 'search',
  scope: 'src/**',
  depth: 2,
  tokenBudget: 500,
  relations: ['CALLS', 'USES'],
};

const binding = {
  revision: 'revision-1',
  requestHash: createGraphContextRequestHash(request, '/workspace'),
  scope: 'src/**',
  mode: 'search' as const,
};

function encodeRawCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function pageNode(
  id: string,
  kind: GraphContextNode['kind'] = 'symbol',
  score = 0,
): GraphContextNode {
  return {
    id,
    kind,
    name: `GraphContextPaginationNode${id}`,
    path: `src/pagination/${id}.ts`,
    score,
  };
}

function pagedResponse(): GraphContextResponse {
  const seedNode = { ...pageNode('seed', 'file', 100), isSeed: true };
  const largeNode = {
    ...pageNode('large', 'symbol', 1_000),
    name: 'oversized pagination candidate '.repeat(150),
  };
  const directNode = pageNode('direct', 'file', 1);
  const testNode = pageNode('test', 'test', 0);
  const tailNode = pageNode('tail', 'symbol', -1);
  const nodes = [seedNode, largeNode, directNode, testNode, tailNode];
  return {
    indexRevision: binding.revision,
    fresh: true,
    mode: 'search',
    seeds: [nodes[0]],
    nodes,
    edges: [{
      source: 'seed',
      target: 'direct',
      relation: 'IMPORTS',
      confidence: 'EXTRACTED',
    }],
    paths: [],
    ambiguous: [],
    omitted: { nodes: 0, edges: 0 },
    nextQueries: [],
    tokenEstimate: 0,
    truncated: false,
  };
}

describe('GraphContextCursor', () => {
  it('round-trips an opaque URL-safe cursor containing metadata only', () => {
    const payload: GraphContextCursorPayload = { ...binding, offset: 7 };
    const cursor = createGraphContextCursor(payload);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parseGraphContextCursor(cursor, binding)).toEqual(payload);
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))).toEqual({
      revision: 'revision-1',
      requestHash: binding.requestHash,
      offset: 7,
      scope: 'src/**',
      mode: 'search',
    });
  });

  it('invalidates a cursor when the index revision changes', () => {
    const cursor = createGraphContextCursor({ ...binding, offset: 4 });

    expect(() => parseGraphContextCursor(cursor, {
      ...binding,
      revision: 'revision-2',
    })).toThrow(/revision/i);
  });

  it('invalidates a cursor when the request budget changes', () => {
    const cursor = createGraphContextCursor({ ...binding, offset: 4 });
    const changedBudgetHash = createGraphContextRequestHash({
      ...request,
      tokenBudget: 1_000,
    }, '/workspace');

    expect(changedBudgetHash).not.toBe(binding.requestHash);
    expect(() => parseGraphContextCursor(cursor, {
      ...binding,
      requestHash: changedBudgetHash,
    })).toThrow(/request/i);
  });

  it('validates scope, mode, offset, and the exact cursor shape', () => {
    const cursor = createGraphContextCursor({ ...binding, offset: 4 });

    expect(() => parseGraphContextCursor(cursor, {
      ...binding,
      scope: 'tests/**',
    })).toThrow(/scope/i);
    expect(() => parseGraphContextCursor(cursor, {
      ...binding,
      mode: 'impact',
    })).toThrow(/mode/i);
    expect(() => parseGraphContextCursor(encodeRawCursor({
      ...binding,
      offset: -1,
    }), binding)).toThrow(/offset/i);
    expect(() => parseGraphContextCursor(encodeRawCursor({
      ...binding,
      offset: 1,
      sourceContent: 'secret implementation details',
    }), binding)).toThrow(/field/i);
  });

  it('uses the cursor offset to build a page without duplicate node IDs', () => {
    const response = pagedResponse();
    const firstPage = applyGraphContextBudgetPage(response, 500);
    expect(firstPage.nextOffset).toBeDefined();

    const cursor = createGraphContextCursor({
      ...binding,
      offset: firstPage.nextOffset as number,
    });
    const { offset } = parseGraphContextCursor(cursor, binding);
    const nextPage = applyGraphContextBudgetPage(response, 500, offset);
    const firstIds = new Set(firstPage.response.nodes.map(result => result.id));

    expect(response.nodes.map(result => result.id)).toEqual([
      'seed',
      'large',
      'direct',
      'test',
      'tail',
    ]);
    expect(firstPage.response.nodes.map(result => result.id)).toEqual([
      'seed',
      'direct',
      'test',
    ]);
    expect(nextPage.response.nodes.map(result => result.id)).toEqual(['tail']);
    expect(nextPage.response.nodes.every(result => !firstIds.has(result.id))).toBe(true);
    expect(firstPage.response.truncated).toBe(true);
    expect(firstPage.response.omitted).toEqual({ nodes: 2, edges: 0 });
    expect(nextPage.response.omitted).toEqual({ nodes: 4, edges: 1 });
    expect(nextPage.response.seeds).toEqual([]);
    expect(nextPage.response.edges).toEqual([]);
    expect(nextPage.response.tokenEstimate).toBeLessThanOrEqual(500);
    expect(nextPage.nextOffset).toBeUndefined();
  });

  it('rejects offsets outside the canonical candidate sequence', () => {
    const response = pagedResponse();

    expect(() => applyGraphContextBudgetPage(response, 500, -1)).toThrow(/offset/i);
    expect(() => applyGraphContextBudgetPage(response, 500, response.nodes.length + 1)).toThrow(
      /offset/i,
    );
  });

  it('rejects malformed cursors and invalid creation payloads', () => {
    expect(() => parseGraphContextCursor('not-json', binding)).toThrow(/cursor/i);
    expect(() => createGraphContextCursor({
      ...binding,
      offset: Number.NaN,
    })).toThrow(/offset/i);
  });

  it('rejects creation when the encoded cursor would exceed 4096 characters', () => {
    expect(() => createGraphContextCursor({
      ...binding,
      revision: 'r'.repeat(4_096),
      offset: 0,
    })).toThrow(/4096/i);
  });
});
