import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NodeInteractionService } from '../../src/extension/services/NodeInteractionService';
import type { Spider } from '../../src/analyzer/Spider';

const createSpider = () => ({
  crawlFrom: vi.fn(),
  findReferencingFiles: vi.fn(),
  hasReverseIndex: vi.fn(),
  getCallerCount: vi.fn(),
  verifyDependencyUsage: vi.fn().mockResolvedValue(true),
  workspaceRoot: '/workspace',
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

  it('expandNode computes nodeMetadata (communityId) over the full known+new node union (GH #122)', async () => {
    (spider.crawlFrom as ReturnType<typeof vi.fn>).mockResolvedValue({
      nodes: ['src/analyzer/newFile.ts'],
      edges: [{ source: 'src/analyzer/root.ts', target: 'src/analyzer/newFile.ts' }],
    });

    const service = new NodeInteractionService(spider, logger);
    const result = await service.expandNode('src/analyzer/root.ts', ['src/analyzer/root.ts']);

    expect(result.data.nodeMetadata).toBeDefined();
    // Both the already-known node and the newly-expanded node must get metadata —
    // otherwise the newly expanded node renders with no cluster color.
    expect(Object.keys(result.data.nodeMetadata ?? {})).toEqual(
      expect.arrayContaining(['src/analyzer/root.ts', 'src/analyzer/newFile.ts']),
    );
  });

  it('getReferencingFiles computes nodeMetadata over the full known+new node union (GH #122)', async () => {
    (spider.findReferencingFiles as ReturnType<typeof vi.fn>).mockResolvedValue([
      { path: 'src/analyzer/caller.ts' },
    ]);
    (spider.hasReverseIndex as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const service = new NodeInteractionService(spider, logger);
    const result = await service.getReferencingFiles('src/analyzer/root.ts', [
      'src/analyzer/root.ts',
      'src/analyzer/sibling.ts',
    ]);

    expect(result.data.nodeMetadata).toBeDefined();
    expect(Object.keys(result.data.nodeMetadata ?? {})).toEqual(
      expect.arrayContaining([
        'src/analyzer/root.ts',
        'src/analyzer/sibling.ts',
        'src/analyzer/caller.ts',
      ]),
    );
  });
});
