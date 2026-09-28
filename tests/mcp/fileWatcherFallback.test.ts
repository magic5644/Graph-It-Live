import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  watchers: [] as Array<{
    usePolling: boolean;
    emit: (event: string, error?: unknown) => void;
    close: () => Promise<unknown>;
  }>,
  watch: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock('chokidar', () => ({ watch: mocks.watch }));

import { workerState } from '@/mcp/shared/state';
import { setupFileWatcher, stopFileWatcher } from '@/mcp/worker/fileWatcher';

describe('MCP file watcher polling fallback', () => {
  beforeEach(() => {
    vi.stubEnv('CI', 'false');
    mocks.watchers.length = 0;
    mocks.watch.mockReset();
    mocks.watch.mockImplementation((_root, options) => {
      const emitter = new EventEmitter();
      const close = vi.fn().mockResolvedValue(undefined);
      const usePolling = (options as { usePolling?: boolean }).usePolling === true;
      mocks.watchers.push({
        usePolling,
        emit: (event, error) => emitter.emit(event, error),
        close,
      });
      queueMicrotask(() => emitter.emit('ready'));
      return Object.assign(emitter, { close });
    });
    workerState.reset();
    workerState.config = {
      rootDir: process.cwd(),
      excludeNodeModules: true,
      maxDepth: 50,
    };
  });

  afterEach(async () => {
    await stopFileWatcher();
    workerState.reset();
    vi.unstubAllEnvs();
  });

  it('uses polling on macOS and Windows', () => {
    setupFileWatcher(vi.fn());

    expect(mocks.watchers[0].usePolling).toBe(
      process.platform === 'win32' || process.platform === 'darwin',
    );
  });

  it.skipIf(process.platform === 'win32' || process.platform === 'darwin')('switches to polling after native watcher EMFILE', async () => {
    const postMessage = vi.fn();
    setupFileWatcher(postMessage);
    const nativeWatcher = mocks.watchers[0];
    expect(nativeWatcher.usePolling).toBe(false);

    nativeWatcher.emit('error', Object.assign(new Error('too many open files'), { code: 'EMFILE' }));
    await vi.waitFor(() => expect(mocks.watchers).toHaveLength(2));

    expect(nativeWatcher.close).toHaveBeenCalledOnce();
    expect(mocks.watchers[1].usePolling).toBe(true);
    expect(workerState.fileWatcher).not.toBeNull();
  });

  it.skipIf(process.platform === 'win32' || process.platform === 'darwin')('does not restart for unrelated watcher errors', () => {
    setupFileWatcher(vi.fn());
    mocks.watchers[0].emit('error', Object.assign(new Error('permission denied'), { code: 'EACCES' }));

    expect(mocks.watchers).toHaveLength(1);
    expect(mocks.watchers[0].usePolling).toBe(false);
  });
});
