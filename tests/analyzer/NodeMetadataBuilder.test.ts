/**
 * Unit tests for NodeMetadataBuilder.computeNodeMetadata (F2 + F4 feature).
 * AC3: hubScore is correctly computed from parentCounts.
 * AC4: loc is absent (NodeMetadataBuilder never reads the FS).
 * AC6: fileExtension absent when file has no extension.
 * F4: communityId assigned via detectCommunities, graceful degrade on failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computeNodeMetadata } from '../../src/analyzer/NodeMetadataBuilder.js';
import { normalizePath } from '../../src/shared/path.js';
import type { GraphData } from '../../src/shared/graph-types.js';

describe('computeNodeMetadata', () => {
  it('AC3 — computes hubScore from parentCounts', () => {
    const nodeA = normalizePath('/project/src/a.ts');
    const nodeB = normalizePath('/project/src/b.ts');
    const nodeC = normalizePath('/project/src/c.ts');

    const data: GraphData = {
      nodes: [nodeA, nodeB, nodeC],
      edges: [],
      parentCounts: {
        [nodeA]: 10,
        [nodeB]: 5,
        // nodeC has 0 callers (absent from parentCounts)
      },
    };

    computeNodeMetadata(data);

    expect(data.nodeMetadata).toBeDefined();
    expect(data.nodeMetadata![nodeA].hubScore).toBe(1);       // 10/10
    expect(data.nodeMetadata![nodeB].hubScore).toBe(0.5);     // 5/10
    expect(data.nodeMetadata![nodeC].hubScore).toBe(0);       // 0/10
  });

  it('AC3 — hubScore is rounded to 3 decimal places', () => {
    const nodeA = normalizePath('/project/src/a.ts');
    const nodeB = normalizePath('/project/src/b.ts');

    const data: GraphData = {
      nodes: [nodeA, nodeB],
      edges: [],
      parentCounts: { [nodeA]: 1, [nodeB]: 3 },
    };

    computeNodeMetadata(data);

    // 1/3 = 0.333...
    expect(data.nodeMetadata![nodeA].hubScore).toBe(0.333);
    expect(data.nodeMetadata![nodeB].hubScore).toBe(1);
  });

  it('AC3 — guard: when max === 0, all hubScores are 0', () => {
    const nodeA = normalizePath('/project/src/a.ts');
    const nodeB = normalizePath('/project/src/b.ts');

    const data: GraphData = {
      nodes: [nodeA, nodeB],
      edges: [],
      // no parentCounts → all counts are 0 → max guard kicks in
    };

    computeNodeMetadata(data);

    expect(data.nodeMetadata![nodeA].hubScore).toBe(0);
    expect(data.nodeMetadata![nodeB].hubScore).toBe(0);
  });

  it('AC3 — handles empty parentCounts object', () => {
    const nodeA = normalizePath('/project/src/a.ts');
    const data: GraphData = {
      nodes: [nodeA],
      edges: [],
      parentCounts: {},
    };

    computeNodeMetadata(data);

    expect(data.nodeMetadata![nodeA].hubScore).toBe(0);
  });

  it('AC4 — loc is never set (no FS reads in NodeMetadataBuilder)', () => {
    const nodeA = normalizePath('/project/src/a.ts');
    const data: GraphData = {
      nodes: [nodeA],
      edges: [],
    };

    computeNodeMetadata(data);

    expect(data.nodeMetadata![nodeA].loc).toBeUndefined();
  });

  it('AC6 — fileExtension is absent when file has no extension', () => {
    const nodeNoExt = normalizePath('/project/Makefile');
    const data: GraphData = {
      nodes: [nodeNoExt],
      edges: [],
    };

    computeNodeMetadata(data);

    expect(data.nodeMetadata![nodeNoExt].fileExtension).toBeUndefined();
  });

  it('fileExtension is lowercase without leading dot', () => {
    const nodeTs = normalizePath('/project/src/App.TSX');
    const data: GraphData = {
      nodes: [nodeTs],
      edges: [],
    };

    computeNodeMetadata(data);

    expect(data.nodeMetadata![nodeTs].fileExtension).toBe('tsx');
  });

  it('fileExtension is set for .ts files', () => {
    const node = normalizePath('/project/src/utils.ts');
    const data: GraphData = {
      nodes: [node],
      edges: [],
    };

    computeNodeMetadata(data);

    expect(data.nodeMetadata![node].fileExtension).toBe('ts');
  });

  it('does nothing when nodes array is empty', () => {
    const data: GraphData = {
      nodes: [],
      edges: [],
    };

    computeNodeMetadata(data);

    // nodeMetadata should not be set when there are no nodes
    expect(data.nodeMetadata).toBeUndefined();
  });

  it('keys in nodeMetadata are normalizePath results', () => {
    const rawPath = '/project/src/index.ts';
    const data: GraphData = {
      nodes: [rawPath],
      edges: [],
    };

    computeNodeMetadata(data);

    const expectedKey = normalizePath(rawPath);
    expect(data.nodeMetadata![expectedKey]).toBeDefined();
  });

  // F4 — communityId tests

  it('F4 — communityId is set for connected nodes', () => {
    const nodeA = normalizePath('/project/src/a.ts');
    const nodeB = normalizePath('/project/src/b.ts');

    const data: GraphData = {
      nodes: [nodeA, nodeB],
      edges: [{ source: nodeA, target: nodeB }],
      parentCounts: { [nodeA]: 1, [nodeB]: 1 },
    };

    computeNodeMetadata(data);

    expect(data.nodeMetadata![nodeA].communityId).toBeDefined();
    expect(data.nodeMetadata![nodeB].communityId).toBeDefined();
    // Both connected → same community
    expect(data.nodeMetadata![nodeA].communityId).toBe(
      data.nodeMetadata![nodeB].communityId,
    );
    expect(data.nodeMetadata![nodeA].communityId).toBeGreaterThanOrEqual(1);
  });

  it('F4 — isolated node gets communityId === 0', () => {
    const nodeA = normalizePath('/project/src/isolated.ts');

    const data: GraphData = {
      nodes: [nodeA],
      edges: [],
      parentCounts: {},
    };

    computeNodeMetadata(data);

    expect(data.nodeMetadata![nodeA].communityId).toBe(0);
  });

  it('F4 — graceful degrade: nodeMetadata still set when detectCommunities throws', async () => {
    // Mock LouvainDetector to throw
    vi.doMock('../../src/analyzer/community/LouvainDetector.js', () => ({
      detectCommunities: () => { throw new Error('WASM unavailable'); },
    }));

    // Re-import after mock
    const { computeNodeMetadata: computeFresh } = await import(
      '../../src/analyzer/NodeMetadataBuilder.js?v=fail'
    ).catch(() => import('../../src/analyzer/NodeMetadataBuilder.js'));

    const nodeA = normalizePath('/project/src/a.ts');
    const data: GraphData = {
      nodes: [nodeA],
      edges: [],
      parentCounts: { [nodeA]: 3 },
    };

    // Should not throw
    expect(() => computeFresh(data)).not.toThrow();

    // hubScore should still be computed
    expect(data.nodeMetadata).toBeDefined();
    expect(data.nodeMetadata![nodeA].hubScore).toBeDefined();

    vi.doUnmock('../../src/analyzer/community/LouvainDetector.js');
  });

  it('F4 — communityId absent when nodes array is empty', () => {
    const data: GraphData = { nodes: [], edges: [] };
    computeNodeMetadata(data);
    expect(data.nodeMetadata).toBeUndefined();
  });
});
