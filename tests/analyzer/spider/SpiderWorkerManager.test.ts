import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Cache } from '@/analyzer/Cache';
import { IndexerStatus } from '@/analyzer/IndexerStatus';
import { ReverseIndexManager } from '@/analyzer/ReverseIndexManager';
import { SpiderWorkerManager } from '@/analyzer/spider/SpiderWorkerManager';
import type { Dependency } from '@/analyzer/types';

type StatusCallback = (snapshot: Record<string, unknown>) => void;

const host = vi.hoisted(() => ({
  startIndexing: vi.fn(),
  subscribeToStatus: vi.fn(),
  cancel: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock('@/analyzer/IndexerWorkerHost', () => ({
  // A plain function, not an arrow: SpiderWorkerManager calls it with `new`.
  IndexerWorkerHost: vi.fn().mockImplementation(function () {
    return host;
  }),
}));

describe('SpiderWorkerManager', () => {
  const root = '/repo/apps/worker';
  let status: IndexerStatus;
  let reverseIndex: ReverseIndexManager;
  let cache: Cache<Dependency[]>;
  let manager: SpiderWorkerManager;
  let emit: StatusCallback;

  beforeEach(() => {
    vi.clearAllMocks();
    host.subscribeToStatus.mockImplementation((callback: StatusCallback) => {
      emit = callback;
      return () => {};
    });
    status = new IndexerStatus();
    reverseIndex = new ReverseIndexManager(root);
    cache = new Cache<Dependency[]>({ maxSize: 10 });
    manager = new SpiderWorkerManager(status, reverseIndex, cache);
  });

  // Regression test for #264: worker-built indexes keep the out-of-root count.
  it('imports worker dependencies and out-of-root imports into the reverse index', async () => {
    const dep: Dependency = { path: `${root}/src/y.ts`, type: 'import', line: 2, module: './y' };
    host.startIndexing.mockResolvedValue({
      indexedFiles: 2,
      duration: 5,
      cancelled: false,
      data: [
        { filePath: `${root}/src/a.ts`, dependencies: [dep], outOfRootImports: ['@core/x'], mtime: 1, size: 1 },
        { filePath: `${root}/src/y.ts`, dependencies: [], mtime: 1, size: 1 },
      ],
    });

    const result = await manager.buildFullIndexInWorker({ workerPath: '/w.js', config: { rootDir: root } });

    expect(result).toEqual({ indexedFiles: 2, duration: 5, cancelled: false });
    expect(cache.get(`${root}/src/a.ts`)).toEqual([dep]);
    expect(reverseIndex.getReferencingFiles(`${root}/src/y.ts`)).toHaveLength(1);
    expect(reverseIndex.getOutOfRootImports()).toEqual({ count: 1, examples: ['@core/x'] });
  });

  it('reports out-of-root imports as unknown until the reverse index exists', () => {
    expect(new ReverseIndexManager(root).getOutOfRootImports()).toBeNull();
  });

  it('mirrors worker status snapshots and reports indexing progress', async () => {
    const progress = vi.fn();
    host.startIndexing.mockImplementation(async () => {
      emit({ state: 'counting', processed: 0, total: 0 });
      emit({ state: 'indexing', processed: 1, total: 2, currentFile: 'a.ts' });
      emit({ state: 'complete', processed: 2, total: 2 });
      return { indexedFiles: 0, duration: 0, cancelled: false, data: [] };
    });

    await manager.buildFullIndexInWorker({ workerPath: '/w.js', config: { rootDir: root }, progressCallback: progress });

    expect(progress).toHaveBeenCalledWith(1, 2, 'a.ts');
    expect(status.getSnapshot().state).toBe('complete');
  });

  it('records a worker error and forwards cancel and dispose to the host', async () => {
    host.startIndexing.mockImplementation(async () => {
      emit({ state: 'error', processed: 0, total: 0 });
      throw new Error('worker crashed');
    });

    await expect(manager.buildFullIndexInWorker({ workerPath: '/w.js', config: { rootDir: root } })).rejects.toThrow(
      'worker crashed',
    );
    expect(status.getSnapshot().state).toBe('error');

    manager.cancel();
    await manager.dispose();
    expect(host.cancel).toHaveBeenCalled();
    expect(host.dispose).toHaveBeenCalled();
  });
});
