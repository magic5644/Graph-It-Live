/**
 * IndexerStatus - Lightweight class to track indexing state and progress
 * 
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 * Only Node.js built-in modules are permitted.
 * 
 * This class provides an observable pattern for monitoring indexing progress
 * without coupling to any specific UI framework.
 */

/**
 * Possible states of the indexer
 */
export type IndexerState = 'idle' | 'counting' | 'indexing' | 'validating' | 'complete' | 'error';

/**
 * Snapshot of the indexer status at a point in time
 */
export interface IndexerStatusSnapshot {
  /** Current state of the indexer */
  state: IndexerState;
  /** Number of files processed so far */
  processed: number;
  /** Total number of files to process (0 if not yet counted) */
  total: number;
  /** Path of the file currently being processed */
  currentFile?: string;
  /** Progress percentage (0-100) */
  percentage: number;
  /** Timestamp when indexing started */
  startTime?: number;
  /** Estimated time remaining in milliseconds */
  estimatedTimeRemaining?: number;
  /** Error message if state is 'error' */
  errorMessage?: string;
  /** Whether the indexer has been cancelled */
  cancelled: boolean;
}

/**
 * Callback type for status change notifications
 */
export type IndexerStatusCallback = (snapshot: IndexerStatusSnapshot) => void;

/**
 * IndexerStatus - Observable class for tracking indexing progress
 */
export class IndexerStatus {
  private _state: IndexerState = 'idle';
  private _processed = 0;
  private _total = 0;
  private _currentFile?: string;
  private _startTime?: number;
  private _errorMessage?: string;
  private _cancelled = false;
  
  /** Listeners for status changes */
  private readonly _listeners: Set<IndexerStatusCallback> = new Set();
  
  /** Throttle notifications to avoid overwhelming listeners */
  private _lastNotifyTime = 0;
  private readonly _notifyThrottleMs: number;

  constructor(options?: { notifyThrottleMs?: number }) {
    // Default to 250ms throttle to reduce overhead on large projects
    this._notifyThrottleMs = options?.notifyThrottleMs ?? 250;
  }

  /**
   * Subscribe to status changes
   * @returns Unsubscribe function
   */
  subscribe(callback: IndexerStatusCallback): () => void {
    this._listeners.add(callback);
    // Immediately notify with current state
    callback(this.getSnapshot());
    return () => this._listeners.delete(callback);
  }

  /**
   * Get a snapshot of the current status
   */
  getSnapshot(): IndexerStatusSnapshot {
    const percentage = this._total > 0 
      ? Math.round((this._processed / this._total) * 100) 
      : 0;

    let estimatedTimeRemaining: number | undefined;
    if (this._startTime && this._processed > 0 && this._total > 0 && this._state === 'indexing') {
      const elapsed = Date.now() - this._startTime;
      const avgTimePerFile = elapsed / this._processed;
      const remaining = this._total - this._processed;
      estimatedTimeRemaining = Math.round(avgTimePerFile * remaining);
    }

    return {
      state: this._state,
      processed: this._processed,
      total: this._total,
      currentFile: this._currentFile,
      percentage,
      startTime: this._startTime,
      estimatedTimeRemaining,
      errorMessage: this._errorMessage,
      cancelled: this._cancelled,
    };
  }

  /**
   * Start the counting phase
   */
  startCounting(): void {
    this._state = 'counting';
    this._processed = 0;
    this._total = 0;
    this._currentFile = undefined;
    this._startTime = Date.now();
    this._errorMessage = undefined;
    this._cancelled = false;
    this._notifyListeners(true);
  }

  /**
   * Set the total file count after counting phase
   */
  setTotal(total: number): void {
    this._total = total;
    this._notifyListeners(true);
  }

  /**
   * Start the indexing phase
   */
  startIndexing(): void {
    this._state = 'indexing';
    this._startTime = Date.now();
    this._notifyListeners(true);
  }

  /**
   * Start the validation phase
   */
  startValidating(): void {
    this._state = 'validating';
    this._notifyListeners(true);
  }

  /**
   * Update progress during indexing
   */
  updateProgress(processed: number, currentFile?: string): void {
    this._processed = processed;
    this._currentFile = currentFile;
    this._notifyListeners(false);
  }

  /**
   * Mark indexing as complete
   */
  complete(): void {
    this._state = 'complete';
    this._currentFile = undefined;
    this._notifyListeners(true);
  }

  /**
   * Mark indexing as failed
   */
  setError(message: string): void {
    this._state = 'error';
    this._errorMessage = message;
    this._currentFile = undefined;
    this._notifyListeners(true);
  }

  /**
   * Mark indexing as cancelled
   */
  setCancelled(): void {
    this._cancelled = true;
    this._state = 'idle';
    this._currentFile = undefined;
    this._notifyListeners(true);
  }

  /**
   * Reset to idle state
   */
  reset(): void {
    this._state = 'idle';
    this._processed = 0;
    this._total = 0;
    this._currentFile = undefined;
    this._startTime = undefined;
    this._errorMessage = undefined;
    this._cancelled = false;
    this._notifyListeners(true);
  }

  /**
   * Check if indexing is currently in progress
   */
  isActive(): boolean {
    return this._state === 'counting' || this._state === 'indexing' || this._state === 'validating';
  }

  /**
   * Check if index is ready for use
   */
  isReady(): boolean {
    return this._state === 'complete';
  }

  /**
   * Notify all listeners of the current status
   * @param force Force notification even if throttled
   */
  private _notifyListeners(force: boolean): void {
    const now = Date.now();
    if (!force && now - this._lastNotifyTime < this._notifyThrottleMs) {
      return;
    }
    this._lastNotifyTime = now;

    const snapshot = this.getSnapshot();
    for (const listener of this._listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error('[IndexerStatus] Listener error:', error);
      }
    }
  }

  /**
   * Get current state (for quick checks without full snapshot)
   */
  get state(): IndexerState {
    return this._state;
  }

  /**
   * Get current total (for quick checks)
   */
  get total(): number {
    return this._total;
  }

  /**
   * Get current processed count (for quick checks)
   */
  get processed(): number {
    return this._processed;
  }
}
