/**
 * Unit tests for GraphNodeMetadata and GraphData.nodeMetadata (F2 feature).
 * AC1: GraphData compiles and works without nodeMetadata present.
 * AC2: nodeMetadata keys must be normalized paths.
 */
import { describe, it, expect } from 'vitest';
import { normalizePath } from '../../src/shared/path.js';
import type { GraphData, GraphNodeMetadata } from '../../src/shared/graph-types.js';

describe('GraphData.nodeMetadata', () => {
  it('AC1 — GraphData is valid without nodeMetadata', () => {
    const data: GraphData = {
      nodes: ['src/index.ts'],
      edges: [],
    };
    expect(data.nodeMetadata).toBeUndefined();
    expect(data.nodes).toHaveLength(1);
  });

  it('AC1 — GraphData with only nodes and edges has no nodeMetadata by default', () => {
    const data: GraphData = {
      nodes: [],
      edges: [],
    };
    expect(data.nodeMetadata).toBeUndefined();
  });

  it('AC2 — nodeMetadata keys should be normalizePath results', () => {
    const filePath = 'src/utils.ts';
    const key = normalizePath(filePath);
    const meta: GraphNodeMetadata = { hubScore: 0.5, fileExtension: 'ts' };
    const data: GraphData = {
      nodes: [filePath],
      edges: [],
      nodeMetadata: { [key]: meta },
    };
    expect(data.nodeMetadata).toBeDefined();
    expect(data.nodeMetadata![key]).toEqual({ hubScore: 0.5, fileExtension: 'ts' });
  });

  it('AC2 — normalizePath is idempotent for nodeMetadata keys', () => {
    const path1 = 'src/foo.ts';
    const path2 = normalizePath(path1);
    expect(normalizePath(path2)).toBe(path2);
  });

  describe('GraphNodeMetadata shape', () => {
    it('hubScore is required', () => {
      const meta: GraphNodeMetadata = { hubScore: 0 };
      expect(meta.hubScore).toBe(0);
    });

    it('loc is optional — absent means not computed, not zero', () => {
      const metaWithLoc: GraphNodeMetadata = { hubScore: 0.3, loc: 42 };
      const metaWithoutLoc: GraphNodeMetadata = { hubScore: 0.3 };
      expect(metaWithLoc.loc).toBe(42);
      expect(metaWithoutLoc.loc).toBeUndefined();
    });

    it('fileExtension is optional — absent if unknown', () => {
      const metaWithExt: GraphNodeMetadata = { hubScore: 0.1, fileExtension: 'ts' };
      const metaWithoutExt: GraphNodeMetadata = { hubScore: 0.1 };
      expect(metaWithExt.fileExtension).toBe('ts');
      expect(metaWithoutExt.fileExtension).toBeUndefined();
    });

    it('hubScore guard: max === 0 → hubScore should be 0', () => {
      const meta: GraphNodeMetadata = { hubScore: 0 };
      expect(meta.hubScore).toBe(0);
    });

    it('hubScore is in [0-1] range', () => {
      const scores = [0, 0.001, 0.5, 0.999, 1];
      for (const s of scores) {
        const meta: GraphNodeMetadata = { hubScore: s };
        expect(meta.hubScore).toBeGreaterThanOrEqual(0);
        expect(meta.hubScore).toBeLessThanOrEqual(1);
      }
    });
  });
});
