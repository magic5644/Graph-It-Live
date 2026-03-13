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

  it('returns empty incoming dependencies (AST-only analysis)', async () => {
    (spider.getSymbolGraph as ReturnType<typeof vi.fn>).mockResolvedValue({
      symbols: [{ id: 'fileA.ts:main', name: 'main', isExported: true }],
      dependencies: [],
    });
    (spider.findReferencingFiles as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const service = new SymbolViewService(spider, logger);
    const result = await service.buildSymbolGraph('fileA.ts', 'fileA.ts');

    expect(result.nodes).toContain('fileA.ts');
    expect(result.nodes).toContain('fileA.ts:main');
    expect(result.incomingDependencies).toEqual([]);
  });

  it('includes nested symbols with structural edges', async () => {
    (spider.getSymbolGraph as ReturnType<typeof vi.fn>).mockResolvedValue({
      symbols: [
        { id: 'fileA.ts:MyClass', name: 'MyClass', isExported: true },
        { id: 'fileA.ts:MyClass.method', name: 'MyClass.method', isExported: false, parentSymbolId: 'fileA.ts:MyClass' },
      ],
      dependencies: [],
    });
    (spider.findReferencingFiles as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const service = new SymbolViewService(spider, logger);
    const result = await service.buildSymbolGraph('fileA.ts', 'fileA.ts');

    // Root -> top-level class
    expect(result.edges).toContainEqual({ source: 'fileA.ts', target: 'fileA.ts:MyClass', relationType: 'dependency' });
    // Class -> method (structural)
    expect(result.edges).toContainEqual({ source: 'fileA.ts:MyClass', target: 'fileA.ts:MyClass.method', relationType: 'dependency' });
    expect(result.parentCounts).toBeUndefined(); // no referencing files
  });

  it('collects incoming dependencies from referencing files', async () => {
    // fileA.ts is the target file being analyzed
    const getSymbolGraph = spider.getSymbolGraph as ReturnType<typeof vi.fn>;
    getSymbolGraph.mockImplementation(async (filePath: string) => {
      if (filePath === 'fileA.ts') {
        return {
          symbols: [
            { id: 'fileA.ts:helperFn', name: 'helperFn', isExported: true },
            { id: 'fileA.ts:internal', name: 'internal', isExported: false },
          ],
          dependencies: [],
        };
      }
      // fileC.ts imports helperFn from fileA.ts
      return {
        symbols: [
          { id: 'fileC.ts:main', name: 'main', isExported: true },
        ],
        dependencies: [
          {
            sourceSymbolId: 'fileC.ts:main',
            targetSymbolId: './fileA:helperFn',
            targetFilePath: 'fileA.ts',
            relationType: 'call',
          },
        ],
      };
    });
    (spider.findReferencingFiles as ReturnType<typeof vi.fn>).mockResolvedValue([
      { path: 'fileC.ts' },
    ]);

    const service = new SymbolViewService(spider, logger);
    const result = await service.buildSymbolGraph('fileA.ts', 'fileA.ts');

    // Should have one incoming dependency: fileC.ts:main → fileA.ts:helperFn
    expect(result.incomingDependencies).toHaveLength(1);
    expect(result.incomingDependencies?.[0]).toMatchObject({
      sourceSymbolId: 'fileC.ts:main',
      targetSymbolId: 'fileA.ts:helperFn',
      targetFilePath: 'fileA.ts',
      relationType: 'call',
    });
  });

  it('skips referencing files that fail to analyze', async () => {
    const getSymbolGraph = spider.getSymbolGraph as ReturnType<typeof vi.fn>;
    getSymbolGraph.mockImplementation(async (filePath: string) => {
      if (filePath === 'fileA.ts') {
        return {
          symbols: [{ id: 'fileA.ts:fn', name: 'fn', isExported: true }],
          dependencies: [],
        };
      }
      throw new Error('parse error');
    });
    (spider.findReferencingFiles as ReturnType<typeof vi.fn>).mockResolvedValue([
      { path: 'broken.ts' },
    ]);

    const service = new SymbolViewService(spider, logger);
    const result = await service.buildSymbolGraph('fileA.ts', 'fileA.ts');

    expect(result.incomingDependencies).toEqual([]);
  });

  it('deduplicates incoming dependencies from multiple referencing files', async () => {
    const getSymbolGraph = spider.getSymbolGraph as ReturnType<typeof vi.fn>;
    getSymbolGraph.mockImplementation(async (filePath: string) => {
      if (filePath === 'fileA.ts') {
        return {
          symbols: [{ id: 'fileA.ts:util', name: 'util', isExported: true }],
          dependencies: [],
        };
      }
      // Both fileB.ts and fileC.ts call util from fileA.ts
      return {
        symbols: [{ id: `${filePath}:caller`, name: 'caller', isExported: true }],
        dependencies: [
          {
            sourceSymbolId: `${filePath}:caller`,
            targetSymbolId: './fileA:util',
            targetFilePath: 'fileA.ts',
          },
        ],
      };
    });
    (spider.findReferencingFiles as ReturnType<typeof vi.fn>).mockResolvedValue([
      { path: 'fileB.ts' },
      { path: 'fileC.ts' },
    ]);

    const service = new SymbolViewService(spider, logger);
    const result = await service.buildSymbolGraph('fileA.ts', 'fileA.ts');

    // Two distinct incoming deps (different source symbol IDs)
    expect(result.incomingDependencies).toHaveLength(2);
    expect(result.incomingDependencies?.map(d => d.sourceSymbolId)).toEqual([
      'fileB.ts:caller',
      'fileC.ts:caller',
    ]);
  });
});
