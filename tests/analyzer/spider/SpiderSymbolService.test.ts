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
