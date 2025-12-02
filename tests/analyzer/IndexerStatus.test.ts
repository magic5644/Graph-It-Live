import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IndexerStatus } from '../../src/analyzer/IndexerStatus';

describe('IndexerStatus', () => {
  let status: IndexerStatus;

  beforeEach(() => {
    vi.useFakeTimers();
    status = new IndexerStatus({ notifyThrottleMs: 0 }); // Disable throttling for tests
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('should start in idle state', () => {
      expect(status.state).toBe('idle');
      expect(status.processed).toBe(0);
      expect(status.total).toBe(0);
    });

    it('should return correct initial snapshot', () => {
      const snapshot = status.getSnapshot();
      expect(snapshot.state).toBe('idle');
      expect(snapshot.processed).toBe(0);
      expect(snapshot.total).toBe(0);
      expect(snapshot.percentage).toBe(0);
      expect(snapshot.cancelled).toBe(false);
      expect(snapshot.currentFile).toBeUndefined();
      expect(snapshot.errorMessage).toBeUndefined();
      expect(snapshot.startTime).toBeUndefined();
      expect(snapshot.estimatedTimeRemaining).toBeUndefined();
    });
  });

  describe('counting phase', () => {
    it('should transition to counting state', () => {
      status.startCounting();
      expect(status.state).toBe('counting');
      const snapshot = status.getSnapshot();
      expect(snapshot.startTime).toBeDefined();
    });

    it('should set total after counting', () => {
      status.startCounting();
      status.setTotal(100);
      expect(status.total).toBe(100);
    });
  });

  describe('indexing phase', () => {
    it('should transition to indexing state', () => {
      status.startCounting();
      status.setTotal(100);
      status.startIndexing();
      expect(status.state).toBe('indexing');
    });

    it('should update progress correctly', () => {
      status.startCounting();
      status.setTotal(100);
      status.startIndexing();
      status.updateProgress(50, '/path/to/file.ts');
      
      expect(status.processed).toBe(50);
      const snapshot = status.getSnapshot();
      expect(snapshot.currentFile).toBe('/path/to/file.ts');
      expect(snapshot.percentage).toBe(50);
    });

    it('should calculate percentage correctly', () => {
      status.startCounting();
      status.setTotal(200);
      status.startIndexing();
      status.updateProgress(50);
      
      expect(status.getSnapshot().percentage).toBe(25);
    });

    it('should calculate estimated time remaining', () => {
      const now = Date.now();
      vi.setSystemTime(now);
      
      status.startCounting();
      status.setTotal(100);
      status.startIndexing();
      
      // Advance time by 1 second and process 10 files
      vi.setSystemTime(now + 1000);
      status.updateProgress(10);
      
      const snapshot = status.getSnapshot();
      // 10 files in 1000ms = 100ms per file
      // 90 remaining files * 100ms = 9000ms
      expect(snapshot.estimatedTimeRemaining).toBe(9000);
    });
  });

  describe('validation phase', () => {
    it('should transition to validating state', () => {
      status.startValidating();
      expect(status.state).toBe('validating');
    });
  });

  describe('completion', () => {
    it('should transition to complete state', () => {
      status.startCounting();
      status.setTotal(10);
      status.startIndexing();
      status.updateProgress(10);
      status.complete();
      
      expect(status.state).toBe('complete');
      expect(status.getSnapshot().currentFile).toBeUndefined();
    });

    it('should report isReady correctly', () => {
      expect(status.isReady()).toBe(false);
      status.complete();
      expect(status.isReady()).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should transition to error state with message', () => {
      status.setError('Something went wrong');
      
      expect(status.state).toBe('error');
      const snapshot = status.getSnapshot();
      expect(snapshot.errorMessage).toBe('Something went wrong');
      expect(snapshot.currentFile).toBeUndefined();
    });
  });

  describe('cancellation', () => {
    it('should mark as cancelled and return to idle', () => {
      status.startIndexing();
      status.setCancelled();
      
      expect(status.state).toBe('idle');
      const snapshot = status.getSnapshot();
      expect(snapshot.cancelled).toBe(true);
      expect(snapshot.currentFile).toBeUndefined();
    });
  });

  describe('reset', () => {
    it('should reset all state to initial values', () => {
      status.startCounting();
      status.setTotal(100);
      status.startIndexing();
      status.updateProgress(50, '/file.ts');
      status.reset();
      
      const snapshot = status.getSnapshot();
      expect(snapshot.state).toBe('idle');
      expect(snapshot.processed).toBe(0);
      expect(snapshot.total).toBe(0);
      expect(snapshot.currentFile).toBeUndefined();
      expect(snapshot.startTime).toBeUndefined();
      expect(snapshot.errorMessage).toBeUndefined();
      expect(snapshot.cancelled).toBe(false);
    });
  });

  describe('isActive', () => {
    it('should return true during counting', () => {
      status.startCounting();
      expect(status.isActive()).toBe(true);
    });

    it('should return true during indexing', () => {
      status.startIndexing();
      expect(status.isActive()).toBe(true);
    });

    it('should return true during validating', () => {
      status.startValidating();
      expect(status.isActive()).toBe(true);
    });

    it('should return false when idle', () => {
      expect(status.isActive()).toBe(false);
    });

    it('should return false when complete', () => {
      status.complete();
      expect(status.isActive()).toBe(false);
    });

    it('should return false when error', () => {
      status.setError('error');
      expect(status.isActive()).toBe(false);
    });
  });

  describe('subscription', () => {
    it('should notify subscriber immediately with current state', () => {
      const callback = vi.fn();
      status.subscribe(callback);
      
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({ state: 'idle' }));
    });

    it('should notify subscriber on state changes', () => {
      const callback = vi.fn();
      status.subscribe(callback);
      callback.mockClear();
      
      status.startCounting();
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({ state: 'counting' }));
    });

    it('should allow unsubscribing', () => {
      const callback = vi.fn();
      const unsubscribe = status.subscribe(callback);
      callback.mockClear();
      
      unsubscribe();
      status.startCounting();
      
      expect(callback).not.toHaveBeenCalled();
    });

    it('should handle listener errors gracefully', () => {
      // Mock console.error to avoid noise
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      // Subscribe a good callback first
      const goodCallback = vi.fn();
      status.subscribe(goodCallback);
      goodCallback.mockClear();
      
      // Now subscribe an error callback that throws on subsequent calls (not initial)
      let throwError = false;
      const errorCallback = vi.fn().mockImplementation(() => {
        if (throwError) {
          throw new Error('Listener error');
        }
      });
      status.subscribe(errorCallback);
      errorCallback.mockClear();
      
      // Enable throwing for subsequent notifications
      throwError = true;
      
      // Should not throw when notifying, even when a listener throws
      expect(() => status.startCounting()).not.toThrow();
      
      // Error should be logged
      expect(consoleSpy).toHaveBeenCalledWith('[IndexerStatus] Listener error:', expect.any(Error));
      
      // Good callback should still be called
      expect(goodCallback).toHaveBeenCalled();
      
      consoleSpy.mockRestore();
    });
  });

  describe('notification throttling', () => {
    it('should throttle non-forced notifications', () => {
      const throttledStatus = new IndexerStatus({ notifyThrottleMs: 100 });
      const callback = vi.fn();
      
      throttledStatus.subscribe(callback);
      callback.mockClear();
      
      // Start indexing (forced notification)
      throttledStatus.startIndexing();
      throttledStatus.setTotal(100);
      expect(callback).toHaveBeenCalledTimes(2);
      callback.mockClear();
      
      // Advance time past throttle window before first progress update
      vi.advanceTimersByTime(150);
      
      // First progress update should go through (outside throttle window)
      throttledStatus.updateProgress(1);
      expect(callback).toHaveBeenCalledTimes(1);
      callback.mockClear();
      
      // Subsequent updates within throttle window should be skipped
      throttledStatus.updateProgress(2);
      throttledStatus.updateProgress(3);
      expect(callback).toHaveBeenCalledTimes(0);
      
      // Advance time past throttle
      vi.advanceTimersByTime(150);
      throttledStatus.updateProgress(4);
      
      // Now should be called again
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should use default throttle when not specified', () => {
      const defaultStatus = new IndexerStatus();
      // Just verify it doesn't throw
      defaultStatus.startCounting();
      expect(defaultStatus.state).toBe('counting');
    });
  });

  describe('getters', () => {
    it('should return state via getter', () => {
      status.startIndexing();
      expect(status.state).toBe('indexing');
    });

    it('should return total via getter', () => {
      status.setTotal(50);
      expect(status.total).toBe(50);
    });

    it('should return processed via getter', () => {
      status.updateProgress(25);
      expect(status.processed).toBe(25);
    });
  });
});
