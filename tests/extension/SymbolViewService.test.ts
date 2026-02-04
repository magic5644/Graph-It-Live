import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock vscode module
vi.mock('vscode', () => ({
  default: {},
  Uri: {
    file: (p: string) => ({ fsPath: p }),
  },
}));

import type { Spider } from '../../src/analyzer/Spider';
import { SymbolViewService } from '../../src/extension/services/SymbolViewService';

const createSpider = () => ({
  getSymbolGraph: vi.fn(),
  findReferencingFiles: vi.fn(),
}) as unknown as Spider;

const createLogger = () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
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
    expect(result.edges).toContainEqual({ source: 'fileA.ts', target: 'fileA.ts:foo', relationType: 'dependency' });
    expect(result.referencingFiles).toEqual(['fileC.ts']);
    expect(result.parentCounts).toEqual({ 'fileA.ts': 1 });
  });

  it('builds symbol graph without call hierarchy by default', async () => {
    (spider.getSymbolGraph as ReturnType<typeof vi.fn>).mockResolvedValue({
      symbols: [{ id: 'fileA.ts:main', name: 'main', isExported: true }],
      dependencies: [],
    });
    (spider.findReferencingFiles as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const service = new SymbolViewService(spider, logger);
    const result = await service.buildSymbolGraph('fileA.ts', 'fileA.ts');

    // Should have metadata indicating LSP was not used
    expect(result.metadata).toBeDefined();
    expect(result.metadata?.lspUsed).toBe(false);
    expect(result.metadata?.callEdgesCount).toBe(0);
  });

  it('includes call hierarchy when option is enabled (falls back gracefully without LSP)', async () => {
    (spider.getSymbolGraph as ReturnType<typeof vi.fn>).mockResolvedValue({
      symbols: [{ id: 'fileA.ts:main', name: 'main', isExported: true }],
      dependencies: [],
    });
    (spider.findReferencingFiles as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const service = new SymbolViewService(spider, logger);

    // Even with option enabled, should gracefully fall back when LSP is not available
    // (since we're running in a test environment without VS Code)
    const result = await service.buildSymbolGraph('fileA.ts', 'fileA.ts', {
      includeCallHierarchy: true,
    });

    // Should still return valid result with metadata
    expect(result.nodes).toContain('fileA.ts');
    expect(result.metadata).toBeDefined();
  });

  it('normalizes incoming dependencies to AST symbol IDs (handles Class.method)', async () => {
    // Prepare spider to return symbols with class.method full IDs
    const filePath = '/project/src/geocodingApiService.ts';
    const otherFile = '/project/src/expenseReportDistance.ts';

    (spider.getSymbolGraph as ReturnType<typeof vi.fn>).mockResolvedValue({
      symbols: [
        { id: `${filePath}:GeocodingApiService`, name: 'GeocodingApiService', isExported: true },
        { id: `${filePath}:GeocodingApiService.calculateDistance`, name: 'GeocodingApiService.calculateDistance', isExported: false },
      ],
      dependencies: [],
    });

    (spider.findReferencingFiles as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    // Fake LSP service that returns incoming edges targeting the short method name
    const fakeLspService = {
      isCallHierarchyAvailable: vi.fn().mockResolvedValue(true),
      buildIntraFileCallGraph: vi.fn().mockResolvedValue({
        nodes: [],
        edges: [
          // incoming edge that uses the short method name as target
          { source: `${otherFile}:distance`, target: `${filePath}:calculateDistance`, type: 'reference', direction: 'incoming', locations: [] },
        ],
        lspUsed: true,
        warnings: [],
      }),
    } as unknown as any;

    const service = new SymbolViewService(spider, logger, fakeLspService);

    // Sanity check: ensure getLspService returns our fake
    const resolved = await (service as any).getLspService();
    expect(resolved).toBe(fakeLspService);

    const result = await service.buildSymbolGraph(filePath, filePath, { includeCallHierarchy: true });

    // Ensure LSP was invoked
    expect((fakeLspService.buildIntraFileCallGraph as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);

    expect(result.incomingDependencies).toBeDefined();
    // Should have normalized target to the full AST symbol id
    // Debug output to see what targetSymbolIds were produced (helpful when test fails)
    // eslint-disable-next-line no-console
    console.log('incomingDeps:', result.incomingDependencies!.map(d => d.targetSymbolId));

    const found = result.incomingDependencies!.some(d => d.targetSymbolId === `${filePath}:GeocodingApiService.calculateDistance`);
    expect(found).toBe(true);
  });
});
