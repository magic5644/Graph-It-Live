import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SymbolViewService } from '../../src/extension/services/SymbolViewService';
import type { Spider } from '../../src/analyzer/Spider';

const createSpider = () => ({
  getSymbolGraph: vi.fn(),
  findReferencingFiles: vi.fn(),
}) as unknown as Spider;

const createLogger = () => ({
  debug: vi.fn(),
});

describe('SymbolViewService', () => {
  let spider: Spider;
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    spider = createSpider();
    logger = createLogger();
  });

  it('builds symbol graph payload with referencing info', async () => {
    (spider.getSymbolGraph as ReturnType<typeof vi.fn>).mockResolvedValue({
      symbols: [
        { id: 'fileA.ts:foo', name: 'foo', isExported: true },
        { id: 'fileA.ts:bar', name: 'bar', isExported: false, parentSymbolId: 'fileA.ts:foo' },
      ],
      dependencies: [
        { sourceSymbolId: 'fileA.ts:foo', targetSymbolId: 'fileB.ts:baz', targetFilePath: 'fileB.ts' },
      ],
    });
    (spider.findReferencingFiles as ReturnType<typeof vi.fn>).mockResolvedValue([{ path: 'fileC.ts' }]);

    const service = new SymbolViewService(spider, logger);
    const result = await service.buildSymbolGraph('fileA.ts', 'fileA.ts');

    expect(result.nodes).toContain('fileA.ts:foo');
    expect(result.edges).toContainEqual({ source: 'fileA.ts', target: 'fileA.ts:foo' });
    expect(result.referencingFiles).toEqual(['fileC.ts']);
    expect(result.parentCounts).toEqual({ 'fileA.ts': 1 });
  });
});
