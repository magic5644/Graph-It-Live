import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock vscode module
vi.mock('vscode', () => ({
  default: {},
  Uri: {
    file: (p: string) => ({ fsPath: p }),
  },
}));

import type { Spider } from '../../src/analyzer/Spider';
import type { ICallGraphQueryService } from '../../src/extension/services/ICallGraphQueryService';
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

const createCallGraphQuery = (overrides: Partial<ICallGraphQueryService> = {}): ICallGraphQueryService => ({
  findExternalCallers: vi.fn().mockReturnValue([]),
  isIndexed: vi.fn().mockReturnValue(false),
  ...overrides,
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

  describe('call graph enrichment', () => {
    it('merges external callers from call graph into incoming dependencies', async () => {
      (spider.getSymbolGraph as ReturnType<typeof vi.fn>).mockResolvedValue({
        symbols: [
          { id: 'fileA.ts:exportedFn', name: 'exportedFn', isExported: true },
        ],
        dependencies: [],
      });
      (spider.findReferencingFiles as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const callGraphQuery = createCallGraphQuery({
        isIndexed: vi.fn().mockReturnValue(true),
        findExternalCallers: vi.fn().mockReturnValue([
          {
            targetSymbolName: 'exportedFn',
            callerName: 'main',
            callerFilePath: '/src/main.ts',
            callerStartLine: 10,
          },
          {
            targetSymbolName: 'exportedFn',
            callerName: 'bootstrap',
            callerFilePath: '/src/bootstrap.ts',
            callerStartLine: 5,
          },
        ]),
      });

      const service = new SymbolViewService(spider, logger);
      service.setCallGraphQueryService(callGraphQuery);
      const result = await service.buildSymbolGraph('fileA.ts', 'fileA.ts');

      expect(result.incomingDependencies).toHaveLength(2);
      expect(result.incomingDependencies).toContainEqual(
        expect.objectContaining({
          sourceSymbolId: '/src/main.ts:main',
          targetSymbolId: 'fileA.ts:exportedFn',
          relationType: 'call',
        }),
      );
      expect(result.incomingDependencies).toContainEqual(
        expect.objectContaining({
          sourceSymbolId: '/src/bootstrap.ts:bootstrap',
          targetSymbolId: 'fileA.ts:exportedFn',
          relationType: 'call',
        }),
      );
    });

    it('deduplicates call graph callers against Spider incoming deps', async () => {
      const getSymbolGraph = spider.getSymbolGraph as ReturnType<typeof vi.fn>;
      getSymbolGraph.mockImplementation(async (filePath: string) => {
        if (filePath === 'fileA.ts') {
          return {
            symbols: [
              { id: 'fileA.ts:helperFn', name: 'helperFn', isExported: true },
            ],
            dependencies: [],
          };
        }
        // Spider already reports this incoming dep
        return {
          symbols: [{ id: 'fileB.ts:caller', name: 'caller', isExported: true }],
          dependencies: [
            {
              sourceSymbolId: 'fileB.ts:caller',
              targetSymbolId: './fileA:helperFn',
              targetFilePath: 'fileA.ts',
              relationType: 'call',
            },
          ],
        };
      });
      (spider.findReferencingFiles as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: 'fileB.ts' },
      ]);

      // Call graph also reports the same caller
      const callGraphQuery = createCallGraphQuery({
        isIndexed: vi.fn().mockReturnValue(true),
        findExternalCallers: vi.fn().mockReturnValue([
          {
            targetSymbolName: 'helperFn',
            callerName: 'caller',
            callerFilePath: 'fileB.ts',
            callerStartLine: 3,
          },
        ]),
      });

      const service = new SymbolViewService(spider, logger);
      service.setCallGraphQueryService(callGraphQuery);
      const result = await service.buildSymbolGraph('fileA.ts', 'fileA.ts');

      // Should NOT duplicate: Spider already found fileB.ts:caller → fileA.ts:helperFn
      expect(result.incomingDependencies).toHaveLength(1);
    });

    it('skips enrichment when call graph is not indexed', async () => {
      (spider.getSymbolGraph as ReturnType<typeof vi.fn>).mockResolvedValue({
        symbols: [
          { id: 'fileA.ts:fn', name: 'fn', isExported: true },
        ],
        dependencies: [],
      });
      (spider.findReferencingFiles as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const callGraphQuery = createCallGraphQuery({
        isIndexed: vi.fn().mockReturnValue(false),
      });

      const service = new SymbolViewService(spider, logger);
      service.setCallGraphQueryService(callGraphQuery);
      const result = await service.buildSymbolGraph('fileA.ts', 'fileA.ts');

      expect(result.incomingDependencies).toEqual([]);
      expect(callGraphQuery.findExternalCallers).not.toHaveBeenCalled();
    });

    it('handles call graph query errors gracefully', async () => {
      (spider.getSymbolGraph as ReturnType<typeof vi.fn>).mockResolvedValue({
        symbols: [
          { id: 'fileA.ts:fn', name: 'fn', isExported: true },
        ],
        dependencies: [],
      });
      (spider.findReferencingFiles as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const callGraphQuery = createCallGraphQuery({
        isIndexed: vi.fn().mockReturnValue(true),
        findExternalCallers: vi.fn().mockImplementation(() => {
          throw new Error('DB corrupted');
        }),
      });

      const service = new SymbolViewService(spider, logger);
      service.setCallGraphQueryService(callGraphQuery);
      const result = await service.buildSymbolGraph('fileA.ts', 'fileA.ts');

      // Should not throw, returns empty incoming deps
      expect(result.incomingDependencies).toEqual([]);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('only queries exported top-level symbols', async () => {
      (spider.getSymbolGraph as ReturnType<typeof vi.fn>).mockResolvedValue({
        symbols: [
          { id: 'fileA.ts:ExportedClass', name: 'ExportedClass', isExported: true },
          { id: 'fileA.ts:ExportedClass.method', name: 'method', isExported: false, parentSymbolId: 'fileA.ts:ExportedClass' },
          { id: 'fileA.ts:privateFn', name: 'privateFn', isExported: false },
          { id: 'fileA.ts:helperFn', name: 'helperFn', isExported: true },
        ],
        dependencies: [],
      });
      (spider.findReferencingFiles as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const findExternalCallers = vi.fn().mockReturnValue([]);
      const callGraphQuery = createCallGraphQuery({
        isIndexed: vi.fn().mockReturnValue(true),
        findExternalCallers,
      });

      const service = new SymbolViewService(spider, logger);
      service.setCallGraphQueryService(callGraphQuery);
      await service.buildSymbolGraph('fileA.ts', 'fileA.ts');

      // Should only query ExportedClass and helperFn (top-level + exported)
      expect(findExternalCallers).toHaveBeenCalledWith(
        'fileA.ts',
        ['ExportedClass', 'helperFn'],
      );
    });

    it('filters out callers targeting non-exported symbol names (method name collision)', async () => {
      // Scenario: file has exported class "Worker" and exported function "run",
      // plus the class has a method also named "run". The call graph DB might
      // return a caller that targets the method node (bare name "run"), but since
      // the method is not in our exported symbol set, we should still include it
      // because the bare name matches the top-level "run" function.
      // However, if the call graph returns a caller with a name that does NOT
      // match any exported symbol, it must be filtered out.
      (spider.getSymbolGraph as ReturnType<typeof vi.fn>).mockResolvedValue({
        symbols: [
          { id: 'service.ts:Worker', name: 'Worker', isExported: true },
          { id: 'service.ts:Worker.run', name: 'Worker.run', isExported: false, parentSymbolId: 'service.ts:Worker' },
        ],
        dependencies: [],
      });
      (spider.findReferencingFiles as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      // Call graph returns a caller with targetSymbolName "run" — but there is
      // no top-level export named "run" (only Worker.run method).
      // The enrichment should discard this because "service.ts:run" is not a
      // valid exported symbol ID.
      const callGraphQuery = createCallGraphQuery({
        isIndexed: vi.fn().mockReturnValue(true),
        findExternalCallers: vi.fn().mockReturnValue([
          {
            targetSymbolName: 'run',
            callerName: 'main',
            callerFilePath: '/src/main.ts',
            callerStartLine: 10,
          },
        ]),
      });

      const service = new SymbolViewService(spider, logger);
      service.setCallGraphQueryService(callGraphQuery);
      const result = await service.buildSymbolGraph('service.ts', 'service.ts');

      // "run" does not correspond to any exported top-level symbol — must be filtered out
      expect(result.incomingDependencies).toHaveLength(0);
    });

    it('keeps callers when target name matches a valid exported symbol despite method collision', async () => {
      // File has both exported function "format" and a class method "format"
      // A caller to the function should still be included.
      (spider.getSymbolGraph as ReturnType<typeof vi.fn>).mockResolvedValue({
        symbols: [
          { id: 'utils.ts:format', name: 'format', isExported: true },
          { id: 'utils.ts:Formatter', name: 'Formatter', isExported: true },
          { id: 'utils.ts:Formatter.format', name: 'Formatter.format', isExported: false, parentSymbolId: 'utils.ts:Formatter' },
        ],
        dependencies: [],
      });
      (spider.findReferencingFiles as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const callGraphQuery = createCallGraphQuery({
        isIndexed: vi.fn().mockReturnValue(true),
        findExternalCallers: vi.fn().mockReturnValue([
          {
            targetSymbolName: 'format',
            callerName: 'render',
            callerFilePath: '/src/view.ts',
            callerStartLine: 8,
          },
        ]),
      });

      const service = new SymbolViewService(spider, logger);
      service.setCallGraphQueryService(callGraphQuery);
      const result = await service.buildSymbolGraph('utils.ts', 'utils.ts');

      // "format" matches the top-level exported function — should be kept
      expect(result.incomingDependencies).toHaveLength(1);
      expect(result.incomingDependencies[0]).toEqual(
        expect.objectContaining({
          targetSymbolId: 'utils.ts:format',
          sourceSymbolId: '/src/view.ts:render',
          relationType: 'call',
        }),
      );
    });
  });
});
