import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GraphViewService } from '../../src/extension/services/GraphViewService';
import type { Spider } from '../../src/analyzer/Spider';

const createSpider = () => ({
  crawl: vi.fn(),
  hasReverseIndex: vi.fn(),
  findReferencingFiles: vi.fn(),
}) as unknown as Spider;

const createLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
});

describe('GraphViewService', () => {
  let spider: Spider;
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    spider = createSpider();
    logger = createLogger();
  });

  it('returns graph data with parent counts when reverse index enabled', async () => {
    (spider.crawl as ReturnType<typeof vi.fn>).mockResolvedValue({
      nodes: ['fileA.ts'],
      edges: [],
    });
    (spider.hasReverseIndex as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (spider.findReferencingFiles as ReturnType<typeof vi.fn>).mockResolvedValue([{ path: 'fileB.ts' }]);

    const service = new GraphViewService(spider, logger);
    const data = await service.buildGraphData('fileA.ts');

    expect(data.parentCounts).toEqual({ 'fileA.ts': 1 });
    expect(spider.findReferencingFiles).toHaveBeenCalledWith('fileA.ts');
  });

  it('omits parentCounts when reverse index disabled', async () => {
    (spider.crawl as ReturnType<typeof vi.fn>).mockResolvedValue({
      nodes: ['fileA.ts'],
      edges: [],
    });
    (spider.hasReverseIndex as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const service = new GraphViewService(spider, logger);
    const data = await service.buildGraphData('fileA.ts');

    expect(data.parentCounts).toBeUndefined();
    expect(spider.findReferencingFiles).not.toHaveBeenCalled();
  });
});
