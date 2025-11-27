/**
 * Host for the Indexer Worker Thread
 * 
 * This class manages the worker thread lifecycle and communication.
 * It provides a Promise-based API for the main thread to interact with the worker.
 */

import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import type { Dependency } from './types';
import type { IndexerStatusCallback, IndexerStatusSnapshot, IndexerState } from './IndexerStatus';

interface WorkerConfig {
  rootDir: string;
  excludeNodeModules?: boolean;
  tsConfigPath?: string;
}

interface WorkerResponse {
  type: 'progress' | 'complete' | 'error' | 'counting';
  data?: {
    processed?: number;
    total?: number;
    currentFile?: string;
    duration?: number;
    indexData?: IndexedFileData[];
  };
  error?: string;
}

export interface IndexedFileData {
  filePath: string;
  dependencies: Dependency[];
  mtime: number;
  size: number;
}

export interface IndexingResult {
  indexedFiles: number;
  duration: number;
  cancelled: boolean;
  data: IndexedFileData[];
}

/**
 * Manages the worker thread for background indexing
 */
export class IndexerWorkerHost {
  private worker: Worker | null = null;
  private readonly statusCallbacks = new Set<IndexerStatusCallback>();
  private currentState: IndexerState = 'idle';
  private currentProgress = 0;
  private currentTotal = 0;
  private currentFile = '';
  private startTime: number | undefined = undefined;
  private cancelled = false;

  // Path to the worker script (set by esbuild output)
  private readonly workerPath: string;

  constructor(workerPath?: string) {
    // Default to the worker file in the same directory as the extension bundle
    // This will be adjusted based on the actual esbuild output structure
    this.workerPath = workerPath ?? path.join(__dirname, 'indexerWorker.js');
  }

  /**
   * Subscribe to indexing status updates
   */
  subscribeToStatus(callback: IndexerStatusCallback): () => void {
    this.statusCallbacks.add(callback);
    // Immediately notify with current state
    callback(this.getSnapshot());
    return () => this.statusCallbacks.delete(callback);
  }

  /**
   * Get the current indexing status
   */
  getSnapshot(): IndexerStatusSnapshot {
    const percentage = this.currentTotal > 0 
      ? Math.round((this.currentProgress / this.currentTotal) * 100) 
      : 0;
    
    return {
      state: this.currentState,
      processed: this.currentProgress,
      total: this.currentTotal,
      currentFile: this.currentFile,
      percentage,
      startTime: this.startTime,
      cancelled: this.cancelled,
    };
  }

  /**
   * Notify all subscribers of status changes
   */
  private notifySubscribers(): void {
    const snapshot = this.getSnapshot();
    for (const callback of this.statusCallbacks) {
      try {
        callback(snapshot);
      } catch {
        // Ignore callback errors
      }
    }
  }

  /**
   * Update the current state and notify subscribers
   */
  private updateState(state: IndexerState, progress = 0, total = 0, currentFile = ''): void {
    this.currentState = state;
    this.currentProgress = progress;
    this.currentTotal = total;
    this.currentFile = currentFile;
    this.notifySubscribers();
  }

  /**
   * Start background indexing in a worker thread
   */
  async startIndexing(config: WorkerConfig): Promise<IndexingResult> {
    if (this.worker) {
      throw new Error('Indexing already in progress');
    }

    this.cancelled = false;
    this.startTime = Date.now();
    this.updateState('counting');

    return new Promise((resolve, reject) => {
      try {
        // Create the worker with the config as workerData
        this.worker = new Worker(this.workerPath, {
          workerData: config,
        });

        let result: IndexingResult = {
          indexedFiles: 0,
          duration: 0,
          cancelled: false,
          data: [],
        };

        this.worker.on('message', (msg: WorkerResponse) => {
          switch (msg.type) {
            case 'counting':
              this.updateState('counting');
              break;

            case 'progress':
              if (msg.data) {
                this.updateState(
                  'indexing',
                  msg.data.processed ?? 0,
                  msg.data.total ?? 0,
                  msg.data.currentFile ?? ''
                );
              }
              break;

            case 'complete':
              if (msg.data) {
                result = {
                  indexedFiles: msg.data.processed ?? 0,
                  duration: msg.data.duration ?? 0,
                  cancelled: this.cancelled,
                  data: msg.data.indexData ?? [],
                };
              }
              this.updateState('complete');
              this.cleanupWorker();
              resolve(result);
              break;

            case 'error':
              this.updateState('error');
              this.cleanupWorker();
              reject(new Error(msg.error ?? 'Unknown worker error'));
              break;
          }
        });

        this.worker.on('error', (error) => {
          this.updateState('error');
          this.cleanupWorker();
          reject(error);
        });

        this.worker.on('exit', (code) => {
          if (code !== 0 && this.currentState !== 'complete' && this.currentState !== 'error') {
            this.updateState('error');
            this.cleanupWorker();
            reject(new Error(`Worker stopped with exit code ${code}`));
          }
        });

        // Start indexing
        this.worker.postMessage({ type: 'start' });
      } catch (error) {
        this.updateState('error');
        this.cleanupWorker();
        reject(error);
      }
    });
  }

  /**
   * Cancel ongoing indexing
   */
  cancel(): void {
    this.cancelled = true;
    if (this.worker) {
      this.worker.postMessage({ type: 'cancel' });
    }
  }

  /**
   * Check if indexing is in progress
   */
  isIndexing(): boolean {
    return this.currentState === 'indexing' || this.currentState === 'counting';
  }

  /**
   * Clean up the worker
   */
  private cleanupWorker(): void {
    if (this.worker) {
      this.worker.removeAllListeners();
      this.worker.terminate().catch(() => {
        // Ignore termination errors
      });
      this.worker = null;
    }
  }

  /**
   * Dispose of the host and terminate any running worker
   */
  dispose(): void {
    this.cancel();
    this.cleanupWorker();
    this.statusCallbacks.clear();
  }
}
