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
import type {
  McpWorkerMessage,
  McpWorkerResponse,
  McpWorkerConfig,
  McpToolName,
} from './types';

// ============================================================================
// Types
// ============================================================================

export interface McpWorkerHostOptions {
  /** Path to the compiled worker script (dist/mcpWorker.js) */
  workerPath: string;
  /** Timeout for warmup in milliseconds (default: 60000 = 1 minute) */
  warmupTimeout?: number;
  /** Timeout for tool invocations in milliseconds (default: 30000 = 30 seconds) */
  invokeTimeout?: number;
}

export interface WarmupResult {
  /** Time taken for warmup in milliseconds */
  durationMs: number;
  /** Number of files indexed during warmup */
  filesIndexed: number;
}

export type WarmupProgressCallback = (processed: number, total: number, currentFile?: string) => void;

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
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
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private warmupProgressCallback: WarmupProgressCallback | null = null;

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
        this.dispose();
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
          this.dispose();
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
        this.dispose();
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
    }
  }

  /**
   * Invoke a tool on the worker
   * @param tool The tool name to invoke
   * @param params The parameters for the tool
   * @returns The result from the tool
   */
  async invoke<T = unknown>(tool: McpToolName, params: unknown): Promise<T> {
    if (!this.isReady || !this.worker) {
      throw new Error('Worker not ready. Call start() first.');
    }

    const requestId = this.generateRequestId();

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Tool invocation timeout after ${this.invokeTimeout}ms`));
      }, this.invokeTimeout);

      this.pendingRequests.set(requestId, {
        resolve: resolve as (data: unknown) => void,
        reject,
        timeoutId,
      });

      this.postMessage({
        type: 'invoke',
        requestId,
        tool,
        params,
      });
    });
  }

  /**
   * Check if the worker is ready
   */
  ready(): boolean {
    return this.isReady;
  }

  /**
   * Dispose the worker and clean up resources
   */
  dispose(): void {
    if (this.worker) {
      // Send shutdown message
      try {
        this.postMessage({ type: 'shutdown' });
      } catch {
        // Ignore errors when posting to terminated worker
      }

      // Terminate the worker
      this.worker.terminate().catch(() => {
        // Ignore termination errors
      });
    }

    this.cleanup();
  }

  /**
   * Clean up internal state
   */
  private cleanup(): void {
    // Reject all pending requests
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Worker terminated'));
      this.pendingRequests.delete(requestId);
    }

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
   * Resolve a pending request
   */
  private resolveRequest(requestId: string, data: unknown): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingRequests.delete(requestId);
      pending.resolve(data);
    }
  }

  /**
   * Reject a pending request
   */
  private rejectRequest(requestId: string, error: Error): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingRequests.delete(requestId);
      pending.reject(error);
    }
  }
}
