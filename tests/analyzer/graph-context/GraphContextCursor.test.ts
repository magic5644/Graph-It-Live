import { describe, expect, it } from 'vitest';
import { applyGraphContextBudget } from '../../../src/analyzer/graph-context/GraphContextBudget';
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

function pageNode(index: number): GraphContextNode {
  return {
    id: `node-${index}`,
    kind: index === 0 ? 'file' : 'symbol',
    name: `GraphContextPaginationNode${index}`,
    path: `src/pagination/GraphContextPaginationNode${index}.ts`,
    score: 100 - index,
    isSeed: index === 0 || undefined,
  };
}

function pagedResponse(): GraphContextResponse {
  const nodes = Array.from({ length: 30 }, (_, index) => pageNode(index));
  return {
    indexRevision: binding.revision,
    fresh: true,
    mode: 'search',
    seeds: [nodes[0]],
    nodes,
    edges: [],
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
    const firstPage = applyGraphContextBudget(response, 500);
    const cursor = createGraphContextCursor({
      ...binding,
      offset: firstPage.nodes.length,
    });
    const { offset } = parseGraphContextCursor(cursor, binding);
    const nextInput: GraphContextResponse = {
      ...response,
      seeds: [],
      nodes: response.nodes.slice(offset),
    };
    const nextPage = applyGraphContextBudget(nextInput, 500);
    const firstIds = new Set(firstPage.nodes.map(result => result.id));

    expect(firstPage.truncated).toBe(true);
    expect(nextPage.nodes.length).toBeGreaterThan(0);
    expect(nextPage.nodes.every(result => !firstIds.has(result.id))).toBe(true);
  });

  it('rejects malformed cursors and invalid creation payloads', () => {
    expect(() => parseGraphContextCursor('not-json', binding)).toThrow(/cursor/i);
    expect(() => createGraphContextCursor({
      ...binding,
      offset: Number.NaN,
    })).toThrow(/offset/i);
  });
});
