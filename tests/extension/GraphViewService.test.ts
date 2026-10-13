import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GraphViewService } from '../../src/extension/services/GraphViewService';
import type { Spider } from '../../src/analyzer/Spider';

const createSpider = () => ({
  crawl: vi.fn(),
  hasReverseIndex: vi.fn(),
  getCallerCount: vi.fn(),
}) as unknown as Spider;

const createLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
});

describe('GraphViewService', () => {
  let spider: Spider;
  let logger: ReturnType<typeof createLogger>;
  const defaultConfig = {
    unusedAnalysisConcurrency: 4,
    unusedAnalysisMaxEdges: 2000,
  };

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
    (spider.getCallerCount as ReturnType<typeof vi.fn>).mockReturnValue(1);

    const service = new GraphViewService(spider, logger, defaultConfig);
    const data = await service.buildGraphData('fileA.ts');

    expect(data.parentCounts).toEqual({ 'fileA.ts': 1 });
    expect(spider.getCallerCount).toHaveBeenCalledWith('fileA.ts');
  });

  it('omits parentCounts when reverse index disabled', async () => {
    (spider.crawl as ReturnType<typeof vi.fn>).mockResolvedValue({
      nodes: ['fileA.ts'],
      edges: [],
    });
    (spider.hasReverseIndex as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const service = new GraphViewService(spider, logger, defaultConfig);
    const data = await service.buildGraphData('fileA.ts');

    expect(data.parentCounts).toBeUndefined();
    expect(spider.getCallerCount).not.toHaveBeenCalled();
  });

  it('assigns communities with the mode read at build time', async () => {
    const api = '/workspace/src/api/a.ts';
    const db = '/workspace/src/db/b.ts';
    (spider.crawl as ReturnType<typeof vi.fn>).mockResolvedValue({ nodes: [api, db], edges: [{ source: api, target: db }] });
    (spider.hasReverseIndex as ReturnType<typeof vi.fn>).mockReturnValue(false);
    Object.assign(spider, { workspaceRoot: '/workspace' });
    let mode: 'path' | 'louvain' = 'path';
    const service = new GraphViewService(spider, logger, defaultConfig, undefined, () => mode);

    const byFolder = await service.buildGraphData(api);
    expect(byFolder.nodeMetadata?.[db].communityKey).toBe('db');

    mode = 'louvain';
    const structural = await service.buildGraphData(api);
    expect(structural.nodeMetadata?.[db]).toMatchObject({ communityId: 1, communityKey: 'src/api' });
  });
});
