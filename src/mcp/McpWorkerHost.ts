/**
 * MCP Worker Host
 *
 * Manages the MCP Worker Thread lifecycle and provides a Promise-based API
 * for invoking tools. Spawns the worker, handles warmup, and routes requests.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import { Worker } from 'node:worker_threads';
import { getLogger } from '../shared/logger';
import type {
  McpWorkerMessage,
  McpWorkerResponse,
  McpWorkerConfig,
  McpToolName,
} from './types';

/** Logger instance for McpWorkerHost */
const log = getLogger('McpWorkerHost');

// ============================================================================
// Types
// ============================================================================

export interface McpWorkerHostOptions {
  /** Path to the compiled worker script (dist/mcpWorker.js) */
  workerPath: string;
  /** Timeout for warmup in milliseconds (default: 60000 = 1 minute) */
  warmupTimeout?: number;
  /**
   * Timeout for tool invocations in milliseconds (default: 30000 = 30 seconds).
   * Measured from when the worker starts the request, not from when it was queued.
   */
  invokeTimeout?: number;
}

export interface WarmupResult {
  /** Time taken for warmup in milliseconds */
  durationMs: number;
  /** Number of files indexed during warmup */
  filesIndexed: number;
}

export type WarmupProgressCallback = (processed: number, total: number, currentFile?: string) => void;

/**
 * Freshness of the index backing tool results.
 *
 * `stale` is true once the file watcher has reported a change after the last
 * full index pass. The watcher invalidates the affected file immediately, so a
 * stale index is still usable - the flag tells the caller that results may not
 * reflect every edit yet.
 */
export interface IndexFreshness {
  /** ISO timestamp of the last completed full index pass, or null before warmup */
  indexedAt: string | null;
  /** ISO timestamp of the last file invalidation, or null if none since indexing */
  lastInvalidatedAt: string | null;
  /** True when a file changed after the last full index pass */
  stale: boolean;
}

interface PendingRequest {
  tool: McpToolName;
  params: unknown;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  /** Time the request entered the queue */
  queuedAt: number;
  /** Requests queued or running ahead of this one when it was queued */
  queuedAhead: number;
  /** Set once the request is posted to the worker */
  timeoutId?: ReturnType<typeof setTimeout>;
}

// ============================================================================
// McpWorkerHost Class
// ============================================================================

/**
 * Host for the MCP Worker Thread
 * Manages worker lifecycle and provides Promise-based tool invocation
 */
export class McpWorkerHost {
  private worker: Worker | null = null;
  private readonly workerPath: string;
  private readonly warmupTimeout: number;
  private readonly invokeTimeout: number;
  private isReady = false;
  private isStarting = false;
  /** Running and queued requests, in FIFO order (Map keeps insertion order) */
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private activeRequestId: string | null = null;
  private requestCounter = 0;
  private warmupProgressCallback: WarmupProgressCallback | null = null;
  private indexedAt: string | null = null;
  private lastInvalidatedAt: string | null = null;

  constructor(options: McpWorkerHostOptions) {
    this.workerPath = options.workerPath;
    this.warmupTimeout = options.warmupTimeout ?? 60000; // 1 minute default
    this.invokeTimeout = options.invokeTimeout ?? 30000; // 30 seconds default
  }

  /**
   * Start the worker and perform warmup
   * @param config Configuration for the worker
   * @param onProgress Optional callback for warmup progress updates
   * @returns Warmup result with duration and files indexed
   */
  async start(config: McpWorkerConfig, onProgress?: WarmupProgressCallback): Promise<WarmupResult> {
    if (this.worker) {
      throw new Error('Worker already started');
    }

    if (this.isStarting) {
      throw new Error('Worker is already starting');
    }

    this.isStarting = true;
    this.warmupProgressCallback = onProgress ?? null;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        void this.dispose();
        reject(new Error(`Worker warmup timeout after ${this.warmupTimeout}ms`));
      }, this.warmupTimeout);

      try {
        // Create the worker
        this.worker = new Worker(this.workerPath);

        // Handle messages from worker
        this.worker.on('message', (msg: McpWorkerResponse) => {
          this.handleMessage(msg, resolve, timeoutId);
        });

        // Handle worker errors
        this.worker.on('error', (error) => {
          clearTimeout(timeoutId);
          this.isStarting = false;
          void this.dispose();
          reject(error);
        });

        // Handle worker exit
        this.worker.on('exit', (code) => {
          if (code !== 0 && !this.isReady) {
            clearTimeout(timeoutId);
            this.isStarting = false;
            reject(new Error(`Worker exited with code ${code}`));
          }
          this.cleanup();
        });

        // Send init message to start warmup
        this.postMessage({ type: 'init', config });
      } catch (error) {
        clearTimeout(timeoutId);
        this.isStarting = false;
        void this.dispose();
        reject(error);
      }
    });
  }

  /**
   * Handle messages from the worker
   */
  private handleMessage(
    msg: McpWorkerResponse,
    startResolve?: (result: WarmupResult) => void,
    startTimeoutId?: ReturnType<typeof setTimeout>
  ): void {
    switch (msg.type) {
      case 'ready':
        // Warmup complete
        if (startTimeoutId) {
          clearTimeout(startTimeoutId);
        }
        this.isReady = true;
        this.isStarting = false;
        this.warmupProgressCallback = null;
        this.indexedAt = new Date().toISOString();
        this.lastInvalidatedAt = null;
        startResolve?.({
          durationMs: msg.warmupDuration,
          filesIndexed: msg.indexedFiles,
        });
        break;

      case 'warmup-progress':
        // Forward warmup progress
        this.warmupProgressCallback?.(msg.processed, msg.total, msg.currentFile);
        break;

      case 'result':
        // Tool invocation result
        this.resolveRequest(msg.requestId, msg.data);
        break;

      case 'error':
        // Tool invocation error
        this.rejectRequest(msg.requestId, new Error(msg.error));
        break;
        
      case 'file-invalidated':
        // File change detected by the worker's file watcher. The worker has
        // already invalidated its cache; record it so tool responses can report
        // that the index no longer matches the last full pass.
        this.lastInvalidatedAt = new Date().toISOString();
        log.debug('Cache invalidated:', msg.event, msg.filePath);
        break;
    }
  }

  /**
   * Invoke a tool on the worker.
   *
   * Requests run one at a time, in arrival order. CPU-bound analysis on the
   * single worker thread does not get faster by interleaving, and interleaved
   * requests all finish together, so a burst would exhaust every caller's
   * timeout at once. Serialized, each request gets the full timeout for its own
   * work and the error says how long it waited behind others.
   * @param tool The tool name to invoke
   * @param params The parameters for the tool
   * @returns The result from the tool
   */
  async invoke<T = unknown>(tool: McpToolName, params: unknown): Promise<T> {
    if (!this.isReady || !this.worker) {
      throw new Error('Worker not ready. Call start() first.');
    }

    const requestId = this.generateRequestId();

    const result = await new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        tool,
        params,
        resolve: resolve as (data: unknown) => void,
        reject,
        queuedAt: Date.now(),
        queuedAhead: this.pendingRequests.size,
      });
      this.startNextRequest();
    });
    this.recordFreshness(tool);
    return result;
  }

  /** Post the oldest queued request once the worker is idle, and arm its timeout. */
  private startNextRequest(): void {
    if (this.activeRequestId || !this.worker) return;
    const next = this.pendingRequests.entries().next();
    if (next.done) return;
    const [requestId, request] = next.value;
    this.activeRequestId = requestId;
    const waitedMs = Date.now() - request.queuedAt;

    // ponytail: a timed-out request frees the slot at once. A handler that ignores
    // the cancel keeps running beside the next request; handlers that loop over
    // files check the AbortSignal, so this overlap stays short.
    request.timeoutId = setTimeout(() => {
      this.worker?.postMessage({ type: 'cancel', requestId });
      const stillQueued = this.pendingRequests.size - 1;
      this.takeRequest(requestId)?.reject(new Error(
        `Tool invocation timeout after ${this.invokeTimeout}ms of work ` +
        `(waited ${waitedMs}ms in queue behind ${request.queuedAhead} request(s); ` +
        `${stillQueued} still queued)`
      ));
    }, this.invokeTimeout);

    this.postMessage({ type: 'invoke', requestId, tool: request.tool, params: request.params });
  }

  /** Explicit invalidations and rebuilds move the freshness the same way the file watcher does. */
  private recordFreshness(tool: McpToolName): void {
    if (tool === 'invalidate_files') {
      this.lastInvalidatedAt = new Date().toISOString();
    } else if (tool === 'rebuild_index') {
      this.indexedAt = new Date().toISOString();
      this.lastInvalidatedAt = null;
    }
  }

  /**
   * Check if the worker is ready
   */
  ready(): boolean {
    return this.isReady;
  }

  /**
   * Freshness of the index backing tool results.
   *
   * Reported on every tool response so a caller can tell a genuinely empty
   * result from one produced against an index that has not caught up yet.
   */
  freshness(): IndexFreshness {
    return {
      indexedAt: this.indexedAt,
      lastInvalidatedAt: this.lastInvalidatedAt,
      stale: this.lastInvalidatedAt !== null,
    };
  }

  /**
   * Dispose the worker and clean up resources.
   * Sends a shutdown message and waits for the worker to exit gracefully
   * (with a 5 s timeout fallback) before resolving. This ensures any chokidar
   * file-watchers inside the worker are fully closed before callers proceed
   * with cleanup such as deleting the watched directory.
   */
  async dispose(): Promise<void> {
    if (!this.worker) {
      this.cleanup();
      return;
    }

    // Mark as not ready immediately so callers see consistent state
    this.isReady = false;

    const worker = this.worker;
    // Clear this.worker first so cleanup() won't try to use it
    this.worker = null;

    // Listen for the worker exit BEFORE sending shutdown so we don't miss it
    const exitPromise = new Promise<void>((resolve) => {
      worker.once('exit', () => resolve());
    });

    // Ask the worker to shut down gracefully
    try {
      worker.postMessage({ type: 'shutdown' });
    } catch {
      // Worker may have already terminated — force-terminate below
    }

    // Wait up to 5 s for graceful exit, then force-terminate
    const SHUTDOWN_TIMEOUT_MS = 5000;
    await Promise.race([
      exitPromise,
      new Promise<void>((_resolve, reject) =>
        setTimeout(() => reject(new Error('Worker shutdown timeout')), SHUTDOWN_TIMEOUT_MS)
      ),
    ]).catch(async () => {
      // Graceful shutdown timed out — force terminate
      await worker.terminate().catch(() => {
        // Ignore errors
      });
    });

    this.cleanup();
  }

  /**
   * Clean up internal state
   */
  private cleanup(): void {
    // Reject all running and queued requests
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Worker terminated'));
      this.pendingRequests.delete(requestId);
    }
    this.activeRequestId = null;

    this.worker = null;
    this.isReady = false;
    this.isStarting = false;
    this.warmupProgressCallback = null;
  }

  /**
   * Post a message to the worker
   */
  private postMessage(msg: McpWorkerMessage): void {
    if (!this.worker) {
      throw new Error('Worker not initialized');
    }
    this.worker.postMessage(msg);
  }

  /**
   * Generate a unique request ID
   */
  private generateRequestId(): string {
    return `req_${++this.requestCounter}_${Date.now()}`;
  }

  /**
   * Remove a request and, when it was the running one, start the next queued request
   */
  private takeRequest(requestId: string): PendingRequest | undefined {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return undefined;
    clearTimeout(pending.timeoutId);
    this.pendingRequests.delete(requestId);
    if (this.activeRequestId === requestId) {
      this.activeRequestId = null;
      this.startNextRequest();
    }
    return pending;
  }

  /**
   * Resolve a pending request
   */
  private resolveRequest(requestId: string, data: unknown): void {
    this.takeRequest(requestId)?.resolve(data);
  }

  /**
   * Reject a pending request
   */
  private rejectRequest(requestId: string, error: Error): void {
    this.takeRequest(requestId)?.reject(error);
  }
}
