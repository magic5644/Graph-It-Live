import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AstWorkerHost } from '@/analyzer/ast/AstWorkerHost';
import { Cache } from '@/analyzer/Cache';
import type { FileReader } from '@/analyzer/FileReader';
import type { LanguageService } from '@/analyzer/LanguageService';
import { SpiderSymbolService } from '@/analyzer/spider/SpiderSymbolService';
import type { SymbolDependencyHelper } from '@/analyzer/SymbolDependencyHelper';
import type { SpiderConfig, SymbolDependency, SymbolInfo } from '@/analyzer/types';
import type { PathResolver } from '@/analyzer/utils/PathResolver';

type SymbolGraph = { symbols: SymbolInfo[]; dependencies: SymbolDependency[] };

const SYMBOL: SymbolInfo = {
  name: 'run',
  kind: 'FunctionDeclaration',
  line: 1,
  isExported: true,
  id: '/ws/a.ts:run',
};

describe('SpiderSymbolService unsupported languages', () => {
  let analyzeFile: ReturnType<typeof vi.fn>;
  let readFile: ReturnType<typeof vi.fn>;
  let service: SpiderSymbolService;

  beforeEach(() => {
    analyzeFile = vi.fn().mockResolvedValue({ symbols: [SYMBOL], dependencies: [] });
    readFile = vi.fn().mockResolvedValue('content');
    const resolver = { resolve: vi.fn().mockResolvedValue(null) };
    service = new SpiderSymbolService(
      { analyzeFile } as unknown as AstWorkerHost,
      new Cache<SymbolGraph>({ maxSize: 10 }),
      { readFile } as unknown as FileReader,
      resolver as unknown as PathResolver,
      {} as SymbolDependencyHelper,
      () => ({ rootDir: '/ws' }) as SpiderConfig,
      vi.fn().mockResolvedValue([]),
      {} as LanguageService,
    );
  });

  it.each([
    '/ws/main.go',
    '/ws/Foo.cs',
    '/ws/Foo.java',
    '/ws/app.csproj',
    '/ws/schema.graphql',
    '/ws/MAIN.GO',
    '/ws/Foo.CS',
    String.raw`C:\ws\main.go`,
    String.raw`C:\WS\Foo.Java`,
  ])('returns an empty graph without parsing %s', async (filePath) => {
    await expect(service.getSymbolGraph(filePath)).resolves.toEqual({ symbols: [], dependencies: [] });
    expect(readFile).not.toHaveBeenCalled();
    expect(analyzeFile).not.toHaveBeenCalled();
  });

  it.each(['/ws/a.ts', '/ws/A.TSX', '/ws/m.py', String.raw`C:\ws\lib.rs`])(
    'still analyzes supported file %s',
    async (filePath) => {
      const graph = await service.getSymbolGraph(filePath);
      expect(graph.symbols).toEqual([SYMBOL]);
      expect(analyzeFile).toHaveBeenCalledTimes(1);
    },
  );

  it('shares one analysis between concurrent lookups of a file, then analyzes again after a failure', async () => {
    const graphs = await Promise.all([service.getSymbolGraph('/ws/a.ts'), service.getSymbolGraph('/ws/a.ts')]);
    expect(graphs[0]).toBe(graphs[1]);
    expect(analyzeFile).toHaveBeenCalledTimes(1);

    readFile.mockRejectedValueOnce(new Error('gone')).mockResolvedValueOnce('content');
    await expect(service.getSymbolGraph('/ws/b.ts')).rejects.toThrow('gone');
    await expect(service.getSymbolGraph('/ws/b.ts')).resolves.toEqual({ symbols: [SYMBOL], dependencies: [] });
  });

  it('treats imports of unsupported sources as used without parsing', async () => {
    await expect(service.verifyDependencyUsage('/ws/MAIN.GO', '/ws/util.go')).resolves.toBe(true);
    const batch = await service.verifyDependencyUsageBatch(String.raw`C:\ws\Foo.cs`, [String.raw`C:\ws\Bar.cs`]);
    expect([...batch.values()]).toEqual([true]);
    expect(analyzeFile).not.toHaveBeenCalled();
  });

  it('reports no unused symbols for unsupported files', async () => {
    await expect(service.findUnusedSymbols('/ws/Foo.java')).resolves.toEqual([]);
    expect(analyzeFile).not.toHaveBeenCalled();
  });
});

describe('SpiderSymbolService side-effect imports (#515)', () => {
  const build = (analyzer: { parseImports: ReturnType<typeof vi.fn>; resolvePath: ReturnType<typeof vi.fn> }) => {
    const analyzeFile = vi.fn().mockResolvedValue({ symbols: [], dependencies: [] });
    const service = new SpiderSymbolService(
      { analyzeFile } as unknown as AstWorkerHost,
      new Cache<SymbolGraph>({ maxSize: 10 }),
      { readFile: vi.fn().mockResolvedValue('') } as unknown as FileReader,
      { resolve: vi.fn().mockResolvedValue(null) } as unknown as PathResolver,
      {} as SymbolDependencyHelper,
      () => ({ rootDir: '/ws' }) as SpiderConfig,
      vi.fn().mockResolvedValue([]),
      { getAnalyzer: () => analyzer } as unknown as LanguageService,
    );
    return service;
  };
  const bare = { path: '', type: 'side-effect', line: 1, module: './side' };

  it('treats a resolved bare import as used, with and without symbol dependencies', async () => {
    const service = build({
      parseImports: vi.fn().mockResolvedValue([bare]),
      resolvePath: vi.fn().mockResolvedValue(String.raw`C:\ws\side.ts`),
    });
    await expect(service.verifyDependencyUsage('/ws/main.ts', 'C:/ws/side.ts')).resolves.toBe(true);
    const batch = await service.verifyDependencyUsageBatch('/ws/main.ts', ['C:/ws/side.ts', 'C:/ws/other.ts']);
    expect([...batch.values()]).toEqual([true, false]);
  });

  it('ignores a bare import that resolves to nothing', async () => {
    const service = build({
      parseImports: vi.fn().mockResolvedValue([bare, { ...bare, type: 'import', module: './named' }]),
      resolvePath: vi.fn().mockResolvedValue(null),
    });
    await expect(service.verifyDependencyUsage('/ws/main.ts', '/ws/side.ts')).resolves.toBe(false);
    const batch = await service.verifyDependencyUsageBatch('/ws/main.ts', ['/ws/side.ts']);
    expect([...batch.values()]).toEqual([false]);
  });

  it('assumes used when the imports cannot be read', async () => {
    const service = build({
      parseImports: vi.fn().mockRejectedValue(new Error('boom')),
      resolvePath: vi.fn(),
    });
    await expect(service.verifyDependencyUsage('/ws/main.ts', '/ws/side.ts')).resolves.toBe(true);
    const batch = await service.verifyDependencyUsageBatch('/ws/main.ts', ['/ws/side.ts']);
    expect([...batch.values()]).toEqual([true]);
  });
});
