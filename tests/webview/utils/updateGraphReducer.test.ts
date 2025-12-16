import { describe, it, expect } from 'vitest';
import type { GraphData } from '../../../src/shared/types';
import { applyUpdateGraph, isUpdateGraphNavigation } from '../../../src/webview/utils/updateGraphReducer';

describe('updateGraphReducer', () => {
  it('merges on refresh for the same file', () => {
    const current: GraphData = {
      nodes: ['/a', '/b', '/expanded'],
      edges: [{ source: '/a', target: '/expanded' }],
    };

    const incoming: GraphData = {
      nodes: ['/a', '/b'],
      edges: [{ source: '/a', target: '/b' }],
    };

    const result = applyUpdateGraph(current, '/a', {
      filePath: '/a',
      data: incoming,
      isRefresh: true,
      refreshReason: 'indexing',
    });

    expect(new Set(result.nodes)).toEqual(new Set(['/a', '/b', '/expanded']));
    expect(result.edges).toEqual(
      expect.arrayContaining([
        { source: '/a', target: '/b' },
        { source: '/a', target: '/expanded' },
      ])
    );
  });

  it('replaces on navigation to a different file', () => {
    const current: GraphData = { nodes: ['/a', '/expanded'], edges: [] };
    const incoming: GraphData = { nodes: ['/c'], edges: [] };

    const result = applyUpdateGraph(current, '/a', {
      filePath: '/c',
      data: incoming,
      isRefresh: true,
      refreshReason: 'indexing',
    });

    expect(result).toEqual(incoming);
  });

  it('detects navigation based on normalized paths', () => {
    expect(isUpdateGraphNavigation('C:\\root\\a.ts', 'c:/root/a.ts')).toBe(false);
    expect(isUpdateGraphNavigation('/a', '/b')).toBe(true);
  });

  it('replaces on manual refresh even for the same file', () => {
    const current: GraphData = { nodes: ['/a', '/expanded'], edges: [{ source: '/a', target: '/expanded' }] };
    const incoming: GraphData = { nodes: ['/a'], edges: [] };

    const result = applyUpdateGraph(current, '/a', {
      filePath: '/a',
      data: incoming,
      isRefresh: true,
      refreshReason: 'manual',
    });

    expect(result).toEqual(incoming);
  });
});
