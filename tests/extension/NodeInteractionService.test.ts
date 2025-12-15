import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NodeInteractionService } from '../../src/extension/services/NodeInteractionService';
import type { Spider } from '../../src/analyzer/Spider';

const createSpider = () => ({
  crawlFrom: vi.fn(),
  findReferencingFiles: vi.fn(),
  hasReverseIndex: vi.fn(),
  getCallerCount: vi.fn(),
}) as unknown as Spider;

const createLogger = () => ({
  debug: vi.fn(),
  error: vi.fn(),
});

describe('NodeInteractionService', () => {
  let spider: Spider;
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    spider = createSpider();
    logger = createLogger();
  });

  it('expands nodes with crawlFrom result', async () => {
    (spider.crawlFrom as ReturnType<typeof vi.fn>).mockResolvedValue({ nodes: [], edges: [] });

    const service = new NodeInteractionService(spider, logger);
    const result = await service.expandNode('fileA.ts', []);

    expect(result.command).toBe('expandedGraph');
    expect(spider.crawlFrom).toHaveBeenCalledWith(
      'fileA.ts',
      expect.any(Set),
      10,
      expect.objectContaining({
        onBatch: undefined,
        signal: undefined,
      }),
    );
  });

  it('computes referencing files and parent counts', async () => {
    (spider.findReferencingFiles as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ path: 'fileB.ts' }])
      .mockResolvedValueOnce([{ path: 'fileC.ts' }]);
    (spider.hasReverseIndex as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (spider.getCallerCount as ReturnType<typeof vi.fn>).mockReturnValue(1);

    const service = new NodeInteractionService(spider, logger);
    const result = await service.getReferencingFiles('fileA.ts');

    expect(result.command).toBe('referencingFiles');
    expect(result.data.nodes).toEqual(['fileB.ts']);
    expect(result.data.parentCounts).toEqual({ 'fileB.ts': 1 });
    expect(spider.getCallerCount).toHaveBeenCalledWith('fileB.ts');
  });
});
