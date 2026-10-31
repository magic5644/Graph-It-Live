import { describe, expect, it, vi } from 'vitest';
import type { Cache } from '@/analyzer/Cache';
import { IndexerStatus } from '@/analyzer/IndexerStatus';
import type { ReverseIndexManager } from '@/analyzer/ReverseIndexManager';
import type { SourceFileCollector } from '@/analyzer/SourceFileCollector';
import type { SpiderDependencyAnalyzer } from '@/analyzer/spider/SpiderDependencyAnalyzer';
import { SpiderIndexingCancellation } from '@/analyzer/spider/SpiderIndexingCancellation';
import { SpiderIndexingService } from '@/analyzer/spider/SpiderIndexingService';
import type { SpiderWorkerManager } from '@/analyzer/spider/SpiderWorkerManager';
import type { Dependency, SpiderConfig, SymbolDependency } from '@/analyzer/types';

const FILES = ['/ws/a.ts', '/ws/b.ts', '/ws/c.ts', '/ws/d.ts', '/ws/e.ts'];
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function createService(options: {
  analyze: (filePath: string) => Promise<Dependency[]>;
  getSymbolGraph?: (filePath: string) => Promise<{ symbols: []; dependencies: SymbolDependency[] }>;
  config?: Partial<SpiderConfig>;
}) {
  const reverseIndex = { ensure: vi.fn(), addSymbolDependencies: vi.fn(), removeDependenciesFromSource: vi.fn(), isEnabled: () => true };
  const service = new SpiderIndexingService(
    { analyze: options.analyze } as unknown as SpiderDependencyAnalyzer,
    { delete: vi.fn() } as unknown as Cache<Dependency[]>,
    reverseIndex as unknown as ReverseIndexManager,
    { collectAllSourceFiles: async () => FILES } as unknown as SourceFileCollector,
    new IndexerStatus(),
    { cancel: vi.fn() } as unknown as SpiderWorkerManager,
    new SpiderIndexingCancellation(),
    () => ({ rootDir: '/ws', indexingConcurrency: 3, ...options.config }) as SpiderConfig,
    async () => {},
    options.getSymbolGraph,
  );
  return { service, reverseIndex };
}

describe('SpiderIndexingService', () => {
  it('builds each symbol graph as soon as its file is analyzed, concurrently, within the symbol file limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const symbolOrder: string[] = [];
    const { service, reverseIndex } = createService({
      // Earlier files finish later, so completion order is the reverse of file order.
      analyze: async (filePath) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(5 * (FILES.length - FILES.indexOf(filePath)));
        inFlight--;
        return [];
      },
      getSymbolGraph: async (filePath) => {
        symbolOrder.push(filePath);
        return { symbols: [], dependencies: [{ sourceSymbolId: `${filePath}:x` } as SymbolDependency] };
      },
      config: { maxSymbolAnalyzerFiles: 4 },
    });
    const progress: number[] = [];

    const result = await service.buildFullIndex((processed) => progress.push(processed));

    expect(result).toMatchObject({ indexedFiles: 5, cancelled: false });
    expect(maxInFlight).toBe(3);
    // No ordering barrier: a file whose analysis ends first gets its symbol graph first (#541).
    expect(symbolOrder.slice(0, 2)).toEqual(['/ws/c.ts', '/ws/b.ts']);
    expect([...symbolOrder].sort()).toEqual(FILES.slice(0, 4));
    expect(reverseIndex.addSymbolDependencies.mock.calls.map(([file]) => file).sort()).toEqual(FILES.slice(0, 4));
    expect(progress).toEqual([1, 2, 3, 4, 5]);
  });

  it('skips symbol analysis for a file whose dependency analysis failed and keeps indexing the others', async () => {
    const symbolOrder: string[] = [];
    const { service } = createService({
      analyze: async (filePath) => {
        if (filePath === '/ws/b.ts') throw new Error('unreadable');
        return [];
      },
      getSymbolGraph: async (filePath) => {
        symbolOrder.push(filePath);
        if (filePath === '/ws/c.ts') throw new Error('unsupported');
        return { symbols: [], dependencies: [] };
      },
    });

    const result = await service.buildFullIndex();

    expect(result.indexedFiles).toBe(5);
    expect(symbolOrder).toEqual(['/ws/a.ts', '/ws/c.ts', '/ws/d.ts', '/ws/e.ts']);
  });

  it('stops starting files once cancelled and reports the files processed', async () => {
    const started: string[] = [];
    const { service } = createService({
      analyze: async (filePath) => {
        started.push(filePath);
        if (filePath === '/ws/a.ts') service.cancel();
        return [];
      },
      config: { indexingConcurrency: 1 },
    });

    const result = await service.buildFullIndex();

    expect(result).toMatchObject({ indexedFiles: 1, cancelled: true });
    expect(started).toEqual(['/ws/a.ts']);
  });

  it('re-indexes stale files with a progress call per file and isolates failures', async () => {
    const { service, reverseIndex } = createService({
      analyze: async (filePath) => {
        if (filePath === '/ws/c.ts') throw new Error('boom');
        return [];
      },
    });
    const progress: number[] = [];

    const processed = await service.reindexStaleFiles(FILES, (count) => progress.push(count));

    expect(processed).toBe(5);
    expect(progress).toEqual([1, 2, 3, 4, 5]);
    // c.ts: removed before re-analysis and again after its failure.
    expect(reverseIndex.removeDependenciesFromSource).toHaveBeenCalledTimes(6);
  });

  it('stops re-indexing once cancelled', async () => {
    const { service } = createService({ analyze: async () => [], config: { indexingConcurrency: 1 } });
    let calls = 0;

    const processed = await service.reindexStaleFiles(FILES, () => {
      calls++;
      if (calls === 2) service.cancel();
    });

    expect(processed).toBe(2);
  });
});
