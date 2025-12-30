import { describe, it, expect, vi } from 'vitest';
import { GraphViewService } from '../../../src/extension/services/GraphViewService';
import type { GraphData } from '../../../src/shared/types';

describe('GraphViewService - Performance Optimization', () => {
  it('should reuse existing graph data to avoid re-crawling when checking usage', async () => {
    // Mock spider with crawl counter
    let crawlCount = 0;
    const mockSpider = {
      crawl: vi.fn(async () => {
        crawlCount++;
        return {
          nodes: ['fileA.ts', 'fileB.ts'],
          edges: [{ source: 'fileA.ts', target: 'fileB.ts' }],
          nodeLabels: {},
        };
      }),
      hasReverseIndex: vi.fn(async () => false),
      getCallerCount: vi.fn(() => 0),
    };

    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    const service = new GraphViewService(
      mockSpider as any,
      mockLogger,
      {
        unusedAnalysisConcurrency: 1,
        unusedAnalysisMaxEdges: 0, // Disable to avoid AST analysis in this test
      }
    );

    const filePath = 'test.ts';

    // First call: initial graph (no usage check)
    const initialGraphData = await service.buildGraphData(filePath, false);
    expect(crawlCount).toBe(1);
    expect(initialGraphData.nodes).toHaveLength(2);

    // Second call: usage check WITH existing graph data (should NOT re-crawl)
    const enrichedGraphData = await service.buildGraphData(filePath, true, initialGraphData);
    expect(crawlCount).toBe(1); // Still 1 - no second crawl!
    expect(enrichedGraphData.nodes).toHaveLength(2);
    expect(enrichedGraphData.edges).toHaveLength(1);
  });

  it('should crawl normally when no existing graph data is provided', async () => {
    let crawlCount = 0;
    const mockSpider = {
      crawl: vi.fn(async () => {
        crawlCount++;
        return {
          nodes: ['fileA.ts'],
          edges: [],
          nodeLabels: {},
        };
      }),
      hasReverseIndex: vi.fn(async () => false),
      getCallerCount: vi.fn(() => 0),
    };

    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    const service = new GraphViewService(
      mockSpider as any,
      mockLogger,
      {
        unusedAnalysisConcurrency: 1,
        unusedAnalysisMaxEdges: 0,
      }
    );

    // Call without existing data - should crawl
    await service.buildGraphData('test.ts', false);
    expect(crawlCount).toBe(1);

    // Call again without existing data - should crawl again
    await service.buildGraphData('test.ts', true);
    expect(crawlCount).toBe(2);
  });
});
