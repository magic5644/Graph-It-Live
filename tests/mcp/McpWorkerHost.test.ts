/**
 * Tests for McpWorkerHost
 *
 * These tests verify the worker host lifecycle management and Promise-based API.
 * Worker is mocked to isolate the host logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { McpWorkerResponse } from '../../src/mcp/types';

// Store the current mock instance
let currentMockWorker: MockWorkerInstance | null = null;

interface MockWorkerInstance extends EventEmitter {
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}

// Mock worker_threads before importing McpWorkerHost
// Using class syntax to properly be recognized as a constructor
vi.mock('node:worker_threads', () => {
  return {
    Worker: class MockWorker extends EventEmitter {
      postMessage: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
      
      constructor() {
        super();
        this.postMessage = vi.fn().mockImplementation((msg: { type: string }) => {
          // When a shutdown message is sent, simulate the worker exiting
          if (msg?.type === 'shutdown') {
            setImmediate(() => this.emit('exit', 0));
          }
        });
        this.terminate = vi.fn().mockImplementation(() => {
          // Emit 'exit' so that McpWorkerHost.dispose() resolves immediately
          setImmediate(() => this.emit('exit', 0));
          return Promise.resolve(0);
        });
        currentMockWorker = this as unknown as MockWorkerInstance;
      }
    }
  };
});

// Import after mock setup
import { McpWorkerHost, type McpWorkerHostOptions } from '../../src/mcp/McpWorkerHost';

// Helper to get the current mock worker or throw
function getMockWorker(): MockWorkerInstance {
  if (!currentMockWorker) {
    throw new Error('Mock worker not initialized - start() must be called first');
  }
  return currentMockWorker;
}

describe('McpWorkerHost', () => {
  let host: McpWorkerHost;
  const defaultOptions: McpWorkerHostOptions = {
    workerPath: '/path/to/worker.js',
    warmupTimeout: 5000,
    invokeTimeout: 2000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    currentMockWorker = null;
  });

  afterEach(() => {
    host?.dispose();
    currentMockWorker?.removeAllListeners();
  });

  describe('constructor', () => {
    it('should create host with custom options', () => {
      host = new McpWorkerHost(defaultOptions);
      expect(host).toBeInstanceOf(McpWorkerHost);
    });

    it('should use default timeout values when not specified', () => {
      host = new McpWorkerHost({ workerPath: '/path/to/worker.js' });
      expect(host).toBeInstanceOf(McpWorkerHost);
    });
  });

  describe('start()', () => {
    it('should start worker and resolve on ready message', async () => {
      host = new McpWorkerHost(defaultOptions);

      const startPromise = host.start({
        rootDir: '/workspace',
        tsConfigPath: '/workspace/tsconfig.json',
        excludeNodeModules: true,
        maxDepth: 50,
      });

      // Schedule the emit after the worker is created (next tick)
      await Promise.resolve();

      // Simulate worker ready message
      const readyResponse: McpWorkerResponse = {
        type: 'ready',
        warmupDuration: 100,
        indexedFiles: 50,
      };
      getMockWorker().emit('message', readyResponse);

      const result = await startPromise;

      expect(result).toEqual({
        durationMs: 100,
        filesIndexed: 50,
      });
      expect(host.ready()).toBe(true);
    });

    it('should call progress callback during warmup', async () => {
      host = new McpWorkerHost(defaultOptions);
      const progressCallback = vi.fn();

      const startPromise = host.start(
        {
          rootDir: '/workspace',
          tsConfigPath: '/workspace/tsconfig.json',
          excludeNodeModules: true,
          maxDepth: 50,
        },
        progressCallback
      );

      await Promise.resolve();

      // Simulate progress messages
      const progressResponse: McpWorkerResponse = {
        type: 'warmup-progress',
        processed: 10,
        total: 100,
        currentFile: 'src/index.ts',
      };
      getMockWorker().emit('message', progressResponse);

      // Simulate ready
      getMockWorker().emit('message', {
        type: 'ready',
        warmupDuration: 50,
        indexedFiles: 100,
      });

      await startPromise;

      expect(progressCallback).toHaveBeenCalledWith(10, 100, 'src/index.ts');
    });

    it('should reject if worker already started', async () => {
      host = new McpWorkerHost(defaultOptions);

      const startPromise = host.start({
        rootDir: '/workspace',
        tsConfigPath: '/workspace/tsconfig.json',
        excludeNodeModules: true,
        maxDepth: 50,
      });

      await Promise.resolve();

      // Simulate ready
      getMockWorker().emit('message', {
        type: 'ready',
        warmupDuration: 50,
        indexedFiles: 10,
      });

      await startPromise;

      // Try to start again
      await expect(
        host.start({ rootDir: '/workspace', tsConfigPath: '/workspace/tsconfig.json', excludeNodeModules: true, maxDepth: 50 })
      ).rejects.toThrow('Worker already started');
    });

    it('should reject on worker error', async () => {
      host = new McpWorkerHost(defaultOptions);

      const startPromise = host.start({
        rootDir: '/workspace',
        tsConfigPath: '/workspace/tsconfig.json',
        excludeNodeModules: true,
        maxDepth: 50,
      });

      await Promise.resolve();

      // Simulate worker error
      const error = new Error('Worker crashed');
      getMockWorker().emit('error', error);

      await expect(startPromise).rejects.toThrow('Worker crashed');
      expect(host.ready()).toBe(false);
    });

    it('should reject on non-zero exit code', async () => {
      host = new McpWorkerHost(defaultOptions);

      const startPromise = host.start({
        rootDir: '/workspace',
        tsConfigPath: '/workspace/tsconfig.json',
        excludeNodeModules: true,
        maxDepth: 50,
      });

      await Promise.resolve();

      // Simulate abnormal exit
      getMockWorker().emit('exit', 1);

      await expect(startPromise).rejects.toThrow('Worker exited with code 1');
    });

    it('should timeout if warmup takes too long', async () => {
      host = new McpWorkerHost({
        ...defaultOptions,
        warmupTimeout: 50, // Very short timeout for test
      });

      const startPromise = host.start({
        rootDir: '/workspace',
        tsConfigPath: '/workspace/tsconfig.json',
        excludeNodeModules: true,
        maxDepth: 50,
      });

      // Don't emit ready - let it timeout

      await expect(startPromise).rejects.toThrow('Worker warmup timeout after 50ms');
    });
  });

  describe('invoke()', () => {
    beforeEach(async () => {
      host = new McpWorkerHost(defaultOptions);
      const startPromise = host.start({
        rootDir: '/workspace',
        tsConfigPath: '/workspace/tsconfig.json',
        excludeNodeModules: true,
        maxDepth: 50,
      });
      await Promise.resolve();
      getMockWorker().emit('message', {
        type: 'ready',
        warmupDuration: 50,
        indexedFiles: 10,
      });
      await startPromise;
    });

    it('should invoke tool and return result', async () => {
      const invokePromise = host.invoke('analyze_dependencies', { filePath: '/src/index.ts' });

      // Get the request ID from the posted message
      const postedMessage = getMockWorker().postMessage.mock.calls.find(
        (call) => call[0]?.type === 'invoke'
      )?.[0];

      expect(postedMessage).toBeDefined();
      expect(postedMessage.tool).toBe('analyze_dependencies');

      // Simulate result
      const resultResponse: McpWorkerResponse = {
        type: 'result',
        requestId: postedMessage.requestId,
        data: { success: true, data: { imports: [] } },
        executionTimeMs: 10,
      };
      getMockWorker().emit('message', resultResponse);

      const result = await invokePromise;
      expect(result).toEqual({ success: true, data: { imports: [] } });
    });

    it('should reject on error response', async () => {
      const invokePromise = host.invoke('parse_imports', { content: 'invalid' });

      const postedMessage = getMockWorker().postMessage.mock.calls.find(
        (call) => call[0]?.type === 'invoke'
      )?.[0];

      // Simulate error
      const errorResponse: McpWorkerResponse = {
        type: 'error',
        requestId: postedMessage.requestId,
        error: 'Parse failed',
      };
      getMockWorker().emit('message', errorResponse);

      await expect(invokePromise).rejects.toThrow('Parse failed');
    });

    it('should timeout if tool takes too long', async () => {
      host = new McpWorkerHost({
        ...defaultOptions,
        invokeTimeout: 50, // Very short timeout
      });

      const startPromise = host.start({
        rootDir: '/workspace',
        tsConfigPath: '/workspace/tsconfig.json',
        excludeNodeModules: true,
        maxDepth: 50,
      });
      await Promise.resolve();
      getMockWorker().emit('message', {
        type: 'ready',
        warmupDuration: 50,
        indexedFiles: 10,
      });
      await startPromise;

      const invokePromise = host.invoke('crawl_dependency_graph', { entryFile: '/src/index.ts' });

      // Don't emit result - let it timeout

      await expect(invokePromise).rejects.toThrow('Tool invocation timeout after 50ms');
      const invokeMessage = getMockWorker().postMessage.mock.calls.find(
        (call) => call[0]?.type === 'invoke',
      )?.[0];
      expect(getMockWorker().postMessage).toHaveBeenCalledWith({
        type: 'cancel',
        requestId: invokeMessage.requestId,
      });
    });

    it('should reject if worker not ready', async () => {
      const notReadyHost = new McpWorkerHost(defaultOptions);

      await expect(
        notReadyHost.invoke('get_index_status', {})
      ).rejects.toThrow('Worker not ready. Call start() first.');
    });

    it('rejects pending requests and terminates cleanly during disposal', async () => {
      const pending = host.invoke('crawl_dependency_graph', { entryFile: '/src/index.ts' });
      await expect(host.dispose()).resolves.toBeUndefined();
      await expect(pending).rejects.toThrow('Worker terminated');
      expect(host.ready()).toBe(false);
    });
  });

  describe('request queue', () => {
    const invokeMessages = () =>
      getMockWorker().postMessage.mock.calls
        .map((call) => call[0])
        .filter((msg) => msg?.type === 'invoke');
    const answer = (requestId: string, data: unknown) =>
      getMockWorker().emit('message', { type: 'result', requestId, data, executionTimeMs: 1 });

    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      host = new McpWorkerHost({ ...defaultOptions, invokeTimeout: 60000 });
      const startPromise = host.start({
        rootDir: '/workspace',
        excludeNodeModules: true,
        maxDepth: 50,
      });
      await Promise.resolve();
      getMockWorker().emit('message', { type: 'ready', warmupDuration: 1, indexedFiles: 1 });
      await startPromise;
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('runs a concurrent burst one request at a time and resolves every call', async () => {
      const calls = [1, 2, 3].map(() => host.invoke('scan_dead_code', {}));

      for (let i = 0; i < calls.length; i++) {
        expect(invokeMessages()).toHaveLength(i + 1);
        vi.advanceTimersByTime(50000);
        answer(invokeMessages()[i].requestId, i);
      }

      await expect(Promise.all(calls)).resolves.toEqual([0, 1, 2]);
    });

    it('arms the timeout when a request starts, not when it is queued', async () => {
      const first = host.invoke('scan_dead_code', {});
      const second = host.invoke('scan_dead_code', {});

      vi.advanceTimersByTime(50000);
      answer(invokeMessages()[0].requestId, 'first');
      vi.advanceTimersByTime(20000);
      answer(invokeMessages()[1].requestId, 'second');

      await expect(first).resolves.toBe('first');
      await expect(second).resolves.toBe('second');
    });

    it('times out an isolated request, cancels it and starts the next one', async () => {
      const first = host.invoke('scan_dead_code', {});
      const second = host.invoke('get_index_status', {});
      const third = host.invoke('get_index_status', {});
      const firstFailure = expect(first).rejects.toThrow(
        'Tool invocation timeout after 60000ms of work (waited 0ms in queue behind 0 request(s); 2 still queued)',
      );

      vi.advanceTimersByTime(60000);
      await firstFailure;
      const [firstMessage, secondMessage] = invokeMessages();
      expect(getMockWorker().postMessage).toHaveBeenCalledWith({ type: 'cancel', requestId: firstMessage.requestId });
      expect(secondMessage.tool).toBe('get_index_status');

      // A late answer to the timed-out request must not settle anything else.
      answer(firstMessage.requestId, 'late');
      answer(secondMessage.requestId, 'second');
      await expect(second).resolves.toBe('second');

      const thirdFailure = expect(third).rejects.toThrow('(waited 60000ms in queue behind 2 request(s); 0 still queued)');
      vi.advanceTimersByTime(60000);
      await thirdFailure;
    });

    it('rejects queued requests that never started when the host is disposed', async () => {
      const running = host.invoke('scan_dead_code', {});
      const queued = host.invoke('scan_dead_code', {});
      expect(invokeMessages()).toHaveLength(1);

      void host.dispose();

      await expect(running).rejects.toThrow('Worker terminated');
      await expect(queued).rejects.toThrow('Worker terminated');
      expect(invokeMessages()).toHaveLength(1);
    });
  });

  describe('ready()', () => {
    it('should return false before start', () => {
      host = new McpWorkerHost(defaultOptions);
      expect(host.ready()).toBe(false);
    });

    it('should return true after successful start', async () => {
      host = new McpWorkerHost(defaultOptions);

      const startPromise = host.start({
        rootDir: '/workspace',
        tsConfigPath: '/workspace/tsconfig.json',
        excludeNodeModules: true,
        maxDepth: 50,
      });

      await Promise.resolve();
      getMockWorker().emit('message', {
        type: 'ready',
        warmupDuration: 50,
        indexedFiles: 10,
      });

      await startPromise;

      expect(host.ready()).toBe(true);
    });

    it('should return false after dispose', async () => {
      host = new McpWorkerHost(defaultOptions);

      const startPromise = host.start({
        rootDir: '/workspace',
        tsConfigPath: '/workspace/tsconfig.json',
        excludeNodeModules: true,
        maxDepth: 50,
      });

      await Promise.resolve();
      getMockWorker().emit('message', {
        type: 'ready',
        warmupDuration: 50,
        indexedFiles: 10,
      });

      await startPromise;
      expect(host.ready()).toBe(true);

      host.dispose();
      expect(host.ready()).toBe(false);
    });
  });

  describe('dispose()', () => {
    it('should terminate worker on dispose', async () => {
      host = new McpWorkerHost(defaultOptions);

      const startPromise = host.start({
        rootDir: '/workspace',
        tsConfigPath: '/workspace/tsconfig.json',
        excludeNodeModules: true,
        maxDepth: 50,
      });

      await Promise.resolve();
      getMockWorker().emit('message', {
        type: 'ready',
        warmupDuration: 50,
        indexedFiles: 10,
      });

      await startPromise;

      host.dispose();

      // Should have posted shutdown message; terminate is only called on timeout
      expect(getMockWorker().postMessage).toHaveBeenCalledWith({ type: 'shutdown' });
    });

    it('should reject pending requests on dispose', async () => {
      host = new McpWorkerHost(defaultOptions);

      const startPromise = host.start({
        rootDir: '/workspace',
        tsConfigPath: '/workspace/tsconfig.json',
        excludeNodeModules: true,
        maxDepth: 50,
      });

      await Promise.resolve();
      getMockWorker().emit('message', {
        type: 'ready',
        warmupDuration: 50,
        indexedFiles: 10,
      });

      await startPromise;

      const invokePromise = host.invoke('get_index_status', {});

      // Dispose before result
      host.dispose();

      await expect(invokePromise).rejects.toThrow('Worker terminated');
    });

    it('should be safe to call dispose multiple times', async () => {
      host = new McpWorkerHost(defaultOptions);

      const startPromise = host.start({
        rootDir: '/workspace',
        tsConfigPath: '/workspace/tsconfig.json',
        excludeNodeModules: true,
        maxDepth: 50,
      });

      await Promise.resolve();
      getMockWorker().emit('message', {
        type: 'ready',
        warmupDuration: 50,
        indexedFiles: 10,
      });

      await startPromise;

      // Should not throw
      host.dispose();
      host.dispose();
      host.dispose();
      expect(host.ready()).toBe(false);
    });
  });

  describe('file-invalidated message handling', () => {
    beforeEach(async () => {
      host = new McpWorkerHost(defaultOptions);
      const startPromise = host.start({
        rootDir: '/workspace',
        tsConfigPath: '/workspace/tsconfig.json',
        excludeNodeModules: true,
        maxDepth: 50,
      });
      await Promise.resolve();
      getMockWorker().emit('message', {
        type: 'ready',
        warmupDuration: 50,
        indexedFiles: 10,
      });
      await startPromise;
    });

    it('should handle file-invalidated message for change event', () => {
      // This message should be handled without throwing
      const invalidationMessage: McpWorkerResponse = {
        type: 'file-invalidated',
        filePath: '/workspace/src/utils.ts',
        event: 'change',
      };

      // Should not throw - just logs to console.error
      expect(() => {
        getMockWorker().emit('message', invalidationMessage);
      }).not.toThrow();
    });

    it('should handle file-invalidated message for add event', () => {
      const invalidationMessage: McpWorkerResponse = {
        type: 'file-invalidated',
        filePath: '/workspace/src/newFile.ts',
        event: 'add',
      };

      expect(() => {
        getMockWorker().emit('message', invalidationMessage);
      }).not.toThrow();
    });

    it('should handle file-invalidated message for unlink event', () => {
      const invalidationMessage: McpWorkerResponse = {
        type: 'file-invalidated',
        filePath: '/workspace/src/deletedFile.ts',
        event: 'unlink',
      };

      expect(() => {
        getMockWorker().emit('message', invalidationMessage);
      }).not.toThrow();
    });
  });
  describe('freshness()', () => {
    async function startReadyHost(): Promise<void> {
      host = new McpWorkerHost(defaultOptions);
      const startPromise = host.start({
        rootDir: '/workspace',
        tsConfigPath: '/workspace/tsconfig.json',
        excludeNodeModules: true,
        maxDepth: 50,
      });
      await Promise.resolve();
      const readyResponse: McpWorkerResponse = {
        type: 'ready',
        warmupDuration: 100,
        indexedFiles: 50,
      };
      getMockWorker().emit('message', readyResponse);
      await startPromise;
    }

    it('reports no index and no staleness before warmup', () => {
      host = new McpWorkerHost(defaultOptions);

      expect(host.freshness()).toEqual({
        indexedAt: null,
        lastInvalidatedAt: null,
        stale: false,
      });
    });

    it('stamps indexedAt and stays fresh once warmup completes', async () => {
      await startReadyHost();

      const freshness = host.freshness();
      expect(freshness.indexedAt).not.toBeNull();
      expect(() => new Date(freshness.indexedAt as string).toISOString()).not.toThrow();
      expect(freshness.lastInvalidatedAt).toBeNull();
      expect(freshness.stale).toBe(false);
    });

    it('becomes stale once the watcher reports a change', async () => {
      await startReadyHost();

      const invalidation: McpWorkerResponse = {
        type: 'file-invalidated',
        filePath: '/workspace/src/changed.ts',
        event: 'change',
      };
      getMockWorker().emit('message', invalidation);

      const freshness = host.freshness();
      expect(freshness.stale).toBe(true);
      expect(freshness.lastInvalidatedAt).not.toBeNull();
      expect(freshness.indexedAt).not.toBeNull();
    });

    /** Invoke `tool` and answer it like the worker would. */
    async function invokeAndAnswer(tool: 'invalidate_files' | 'rebuild_index' | 'get_index_status', error = false) {
      const invokePromise = host.invoke(tool, {});
      const posted = getMockWorker().postMessage.mock.calls
        .map((call) => call[0])
        .filter((msg) => msg?.type === 'invoke' && msg.tool === tool)
        .at(-1);
      getMockWorker().emit('message', error
        ? { type: 'error', requestId: posted.requestId, error: 'boom' }
        : { type: 'result', requestId: posted.requestId, data: {}, executionTimeMs: 1 });
      return invokePromise;
    }

    it('becomes stale after an explicit invalidate_files (#227)', async () => {
      await startReadyHost();

      await invokeAndAnswer('invalidate_files');

      expect(host.freshness().stale).toBe(true);
      expect(host.freshness().lastInvalidatedAt).not.toBeNull();
    });

    it('is fresh again after rebuild_index, with a new indexedAt (#227)', async () => {
      await startReadyHost();
      const warmupIndexedAt = host.freshness().indexedAt;
      await invokeAndAnswer('invalidate_files');
      await new Promise((resolve) => setTimeout(resolve, 5));

      await invokeAndAnswer('rebuild_index');

      const freshness = host.freshness();
      expect(freshness).toMatchObject({ lastInvalidatedAt: null, stale: false });
      expect(freshness.indexedAt).not.toBe(warmupIndexedAt);
    });

    it('keeps staleness when rebuild_index fails (#227)', async () => {
      await startReadyHost();
      await invokeAndAnswer('invalidate_files');

      await expect(invokeAndAnswer('rebuild_index', true)).rejects.toThrow('boom');

      expect(host.freshness().stale).toBe(true);
    });

    it('leaves freshness alone for read-only tools', async () => {
      await startReadyHost();

      await invokeAndAnswer('get_index_status');

      expect(host.freshness().stale).toBe(false);
    });

    it('clears staleness after a new full index pass', async () => {
      await startReadyHost();
      getMockWorker().emit('message', {
        type: 'file-invalidated',
        filePath: '/workspace/src/changed.ts',
        event: 'change',
      } satisfies McpWorkerResponse);
      expect(host.freshness().stale).toBe(true);

      getMockWorker().emit('message', {
        type: 'ready',
        warmupDuration: 120,
        indexedFiles: 51,
      } satisfies McpWorkerResponse);

      expect(host.freshness()).toMatchObject({
        lastInvalidatedAt: null,
        stale: false,
      });
    });
  });
});
