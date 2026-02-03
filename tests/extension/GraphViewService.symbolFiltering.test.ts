import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Spider } from '../../src/analyzer/Spider';
import { GraphViewService } from '../../src/extension/services/GraphViewService';
import type { ILogger } from '../../src/shared/logger';
import type { GraphData } from '../../src/shared/types';

describe('GraphViewService - Symbol Filtering', () => {
  let service: GraphViewService;
  let mockSpider: Spider;
  let mockLogger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    mockSpider = {
      crawl: vi.fn(),
      hasReverseIndex: vi.fn(),
      getReverseIndex: vi.fn(),
      getCallerCount: vi.fn(),
      verifyDependencyUsageBatch: vi.fn(),
    } as unknown as Spider;

    service = new GraphViewService(
      mockSpider,
      mockLogger as unknown as ILogger,
      {
        unusedAnalysisConcurrency: 4,
        unusedAnalysisMaxEdges: 1000,
      },
      undefined // No cache for these tests
    );
  });

  describe('buildGraphData with referencingFiles', () => {
    it('should accept referencingFiles parameter and filter nodes/edges', async () => {
      const mockGraphData: GraphData = {
        nodes: ['file1.ts', 'file2.ts', 'file3.ts'],
        edges: [
          { source: 'file1.ts', target: 'file2.ts' },
          { source: 'file2.ts', target: 'file3.ts' },
        ],
        nodeLabels: {},
      };

      vi.mocked(mockSpider.crawl).mockResolvedValue(mockGraphData);
      vi.mocked(mockSpider.hasReverseIndex).mockResolvedValue(false);

      const referencingFiles = new Set(['file1.ts', 'file2.ts']); // Exclude file3.ts

      const result = await service.buildGraphData(
        'file1.ts',
        false,
        undefined,
        referencingFiles
      );

      expect(result).toBeDefined();
      expect(result.nodes).toEqual(['file1.ts', 'file2.ts']); // file3.ts filtered out
      expect(result.edges).toEqual([{ source: 'file1.ts', target: 'file2.ts' }]); // edge to file3.ts filtered out
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Filtering graph to',
        2,
        'referencing files'
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Symbol filtering applied:',
        2,
        'nodes,',
        1,
        'edges (from',
        3,
        '/',
        2,
        ')'
      );
    });

    it('should pass through graph data when no referencingFiles provided', async () => {
      const mockGraphData: GraphData = {
        nodes: ['file1.ts', 'file2.ts', 'file3.ts'],
        edges: [
          { source: 'file1.ts', target: 'file2.ts' },
          { source: 'file2.ts', target: 'file3.ts' },
        ],
        nodeLabels: {},
      };

      vi.mocked(mockSpider.crawl).mockResolvedValue(mockGraphData);
      vi.mocked(mockSpider.hasReverseIndex).mockResolvedValue(false);

      const result = await service.buildGraphData('file1.ts', false);

      expect(result.nodes).toEqual(mockGraphData.nodes);
      expect(result.edges).toEqual(mockGraphData.edges);
      expect(mockLogger.debug).not.toHaveBeenCalledWith(
        expect.stringContaining('Filtering'),
        expect.anything()
      );
    });

    it('should handle empty graph data with referencingFiles', async () => {
      const emptyGraphData: GraphData = {
        nodes: [],
        edges: [],
        nodeLabels: {},
      };

      vi.mocked(mockSpider.crawl).mockResolvedValue(emptyGraphData);

      const referencingFiles = new Set(['file1.ts']);

      const result = await service.buildGraphData(
        'file1.ts',
        false,
        undefined,
        referencingFiles
      );

      expect(result.nodes).toHaveLength(0);
      expect(result.edges).toHaveLength(0);
    });

    it('should preserve existing graph data when using referencingFiles', async () => {
      const existingGraphData: GraphData = {
        nodes: ['file1.ts', 'file2.ts'],
        edges: [{ source: 'file1.ts', target: 'file2.ts' }],
        nodeLabels: { 'file1.ts': 'File 1' },
      };

      const referencingFiles = new Set(['file1.ts', 'file2.ts']);

      const result = await service.buildGraphData(
        'file1.ts',
        false,
        existingGraphData,
        referencingFiles
      );

      expect(result.nodeLabels).toEqual(existingGraphData.nodeLabels);
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('Crawl completed'),
        expect.anything(),
        expect.anything(),
        expect.anything()
      );
    });

    it('should work with checkUsage=true and referencingFiles', async () => {
      const mockGraphData: GraphData = {
        nodes: ['file1.ts', 'file2.ts'],
        edges: [{ source: 'file1.ts', target: 'file2.ts' }],
        nodeLabels: {},
      };

      vi.mocked(mockSpider.crawl).mockResolvedValue(mockGraphData);
      vi.mocked(mockSpider.hasReverseIndex).mockResolvedValue(false);
      vi.mocked(mockSpider.verifyDependencyUsageBatch).mockResolvedValue(
        new Map([['file2.ts', true]])
      );

      const referencingFiles = new Set(['file1.ts', 'file2.ts']);

      const result = await service.buildGraphData(
        'file1.ts',
        true, // Check usage
        undefined,
        referencingFiles
      );

      expect(result).toBeDefined();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Filtering graph to',
        2,
        'referencing files'
      );
    });

    it('should handle referencingFiles with parent counts', async () => {
      const mockGraphData: GraphData = {
        nodes: ['file1.ts', 'file2.ts', 'file3.ts'],
        edges: [
          { source: 'file1.ts', target: 'file2.ts' },
          { source: 'file2.ts', target: 'file3.ts' },
        ],
        nodeLabels: {},
      };

      const mockReverseIndex = {
        getReferencingFiles: vi.fn((file: string) => {
          if (file === 'file2.ts') return new Set(['file1.ts']);
          if (file === 'file3.ts') return new Set(['file2.ts']);
          return new Set();
        }),
      };

      vi.mocked(mockSpider.crawl).mockResolvedValue(mockGraphData);
      vi.mocked(mockSpider.hasReverseIndex).mockResolvedValue(true);
      vi.mocked(mockSpider.hasReverseIndex).mockReturnValue(true);
      // Access reverseIndex as a property, not a method
      Object.defineProperty(mockSpider, 'reverseIndex', {
        value: mockReverseIndex,
        writable: true,
      });
      vi.mocked(mockSpider.getCallerCount).mockImplementation((file: string) => {
        if (file === 'file2.ts') return 1;
        if (file === 'file3.ts') return 1;
        return 0;
      });

      const referencingFiles = new Set(['file1.ts', 'file2.ts']);

      const result = await service.buildGraphData(
        'file1.ts',
        false,
        undefined,
        referencingFiles
      );

      expect(result.parentCounts).toBeDefined();
      expect(result.parentCounts?.['file2.ts']).toBe(1);
      // file3.ts is filtered out, so it should not have parent counts
      expect(result.parentCounts?.['file3.ts']).toBeUndefined();
    });

    it('should properly filter nodes and edges with referencingFiles', async () => {
      // This test verifies the actual filtering implementation
      const mockGraphData: GraphData = {
        nodes: ['file1.ts', 'file2.ts', 'file3.ts'],
        edges: [
          { source: 'file1.ts', target: 'file2.ts' },
          { source: 'file2.ts', target: 'file3.ts' },
        ],
        nodeLabels: {},
      };

      vi.mocked(mockSpider.crawl).mockResolvedValue(mockGraphData);
      vi.mocked(mockSpider.hasReverseIndex).mockResolvedValue(false);

      const referencingFiles = new Set(['file1.ts']); // Only file1.ts should remain

      const result = await service.buildGraphData(
        'file1.ts',
        false,
        undefined,
        referencingFiles
      );

      // Only file1.ts should be in nodes, file2.ts and file3.ts filtered out
      expect(result.nodes).toEqual(['file1.ts']);
      // No edges should remain since file2.ts (target) is filtered out
      expect(result.edges).toEqual([]);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Filtering graph to',
        1,
        'referencing files'
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Symbol filtering applied:',
        1,
        'nodes,',
        0,
        'edges (from',
        3,
        '/',
        2,
        ')'
      );
    });
  });

  describe('Symbol filtering integration scenarios', () => {
    it('should handle rapid symbol selection changes', async () => {
      const mockGraphData: GraphData = {
        nodes: ['file1.ts', 'file2.ts'],
        edges: [{ source: 'file1.ts', target: 'file2.ts' }],
        nodeLabels: {},
      };

      vi.mocked(mockSpider.crawl).mockResolvedValue(mockGraphData);
      vi.mocked(mockSpider.hasReverseIndex).mockResolvedValue(false);

      // Simulate rapid selection changes with different referencingFiles sets
      const results = await Promise.all([
        service.buildGraphData('file1.ts', false, undefined, new Set(['file1.ts'])),
        service.buildGraphData('file1.ts', false, undefined, new Set(['file2.ts'])),
        service.buildGraphData('file1.ts', false, undefined, new Set(['file1.ts', 'file2.ts'])),
      ]);

      expect(results).toHaveLength(3);
      results.forEach((result) => {
        expect(result.nodes).toBeDefined();
        expect(result.edges).toBeDefined();
      });
    });

    it('should handle undefined referencingFiles after having one', async () => {
      const mockGraphData: GraphData = {
        nodes: ['file1.ts', 'file2.ts'],
        edges: [{ source: 'file1.ts', target: 'file2.ts' }],
        nodeLabels: {},
      };

      vi.mocked(mockSpider.crawl).mockResolvedValue(mockGraphData);
      vi.mocked(mockSpider.hasReverseIndex).mockResolvedValue(false);

      // First call with referencingFiles - verify filtering works
      await service.buildGraphData(
        'file1.ts',
        false,
        undefined,
        new Set(['file1.ts'])
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Filtering graph to',
        1,
        'referencing files'
      );

      // Second call without referencingFiles (cleared)
      const result2 = await service.buildGraphData('file1.ts', false);
      expect(result2.nodes).toEqual(mockGraphData.nodes);
    });
  });
});
