/**
 * Tests for McpWorkerHost
 *
 * These tests verify the worker host lifecycle management and Promise-based API.
 * Worker is mocked to isolate the host logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { McpWorkerResponse } from '@/mcp/types';

// Store the current mock instance
let currentMockWorker: MockWorkerInstance | null = null;

interface MockWorkerInstance extends EventEmitter {
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}

// Factory to create mock workers
function createMockWorker(): MockWorkerInstance {
  const emitter = new EventEmitter() as MockWorkerInstance;
  emitter.postMessage = vi.fn();
  emitter.terminate = vi.fn().mockResolvedValue(0);
  currentMockWorker = emitter;
  return emitter;
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
        this.postMessage = vi.fn();
        this.terminate = vi.fn().mockResolvedValue(0);
        currentMockWorker = this as unknown as MockWorkerInstance;
      }
    }
  };
});

// Import after mock setup
import { McpWorkerHost, type McpWorkerHostOptions } from '@/mcp/McpWorkerHost';

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
        workspaceRoot: '/workspace',
        tsconfigPath: '/workspace/tsconfig.json',
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
          workspaceRoot: '/workspace',
          tsconfigPath: '/workspace/tsconfig.json',
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
        workspaceRoot: '/workspace',
        tsconfigPath: '/workspace/tsconfig.json',
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
        host.start({ workspaceRoot: '/workspace', tsconfigPath: '/workspace/tsconfig.json' })
      ).rejects.toThrow('Worker already started');
    });

    it('should reject on worker error', async () => {
      host = new McpWorkerHost(defaultOptions);

      const startPromise = host.start({
        workspaceRoot: '/workspace',
        tsconfigPath: '/workspace/tsconfig.json',
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
        workspaceRoot: '/workspace',
        tsconfigPath: '/workspace/tsconfig.json',
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
        workspaceRoot: '/workspace',
        tsconfigPath: '/workspace/tsconfig.json',
      });

      // Don't emit ready - let it timeout

      await expect(startPromise).rejects.toThrow('Worker warmup timeout after 50ms');
    });
  });

  describe('invoke()', () => {
    beforeEach(async () => {
      host = new McpWorkerHost(defaultOptions);
      const startPromise = host.start({
        workspaceRoot: '/workspace',
        tsconfigPath: '/workspace/tsconfig.json',
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
        workspaceRoot: '/workspace',
        tsconfigPath: '/workspace/tsconfig.json',
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
    });

    it('should reject if worker not ready', async () => {
      const notReadyHost = new McpWorkerHost(defaultOptions);

      await expect(
        notReadyHost.invoke('get_index_status', {})
      ).rejects.toThrow('Worker not ready. Call start() first.');
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
        workspaceRoot: '/workspace',
        tsconfigPath: '/workspace/tsconfig.json',
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
        workspaceRoot: '/workspace',
        tsconfigPath: '/workspace/tsconfig.json',
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
        workspaceRoot: '/workspace',
        tsconfigPath: '/workspace/tsconfig.json',
      });

      await Promise.resolve();
      getMockWorker().emit('message', {
        type: 'ready',
        warmupDuration: 50,
        indexedFiles: 10,
      });

      await startPromise;

      host.dispose();

      // Should have posted shutdown message
      expect(getMockWorker().postMessage).toHaveBeenCalledWith({ type: 'shutdown' });
      expect(getMockWorker().terminate).toHaveBeenCalled();
    });

    it('should reject pending requests on dispose', async () => {
      host = new McpWorkerHost(defaultOptions);

      const startPromise = host.start({
        workspaceRoot: '/workspace',
        tsconfigPath: '/workspace/tsconfig.json',
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
        workspaceRoot: '/workspace',
        tsconfigPath: '/workspace/tsconfig.json',
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
    });
  });
});
