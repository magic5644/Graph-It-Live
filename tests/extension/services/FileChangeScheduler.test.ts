import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileChangeScheduler } from '../../../src/extension/services/FileChangeScheduler';
import * as path from 'node:path';
import { normalizePath } from '../../../src/shared/path';

const testRootDir = path.resolve(process.cwd(), 'temp-test-root');
const np = (p: string) => normalizePath(p);

// Mock the extension logger
vi.mock('../../../src/extension/extensionLogger', () => ({
  getExtensionLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('FileChangeScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('Basic event coalescence', () => {
    it('coalesces multiple change events into single processing', async () => {
      const processHandler = vi.fn().mockResolvedValue(undefined);
      const scheduler = new FileChangeScheduler({
        processHandler,
        debounceDelay: 300,
      });

      const filePath = path.join(testRootDir, 'src', 'file.ts');

      // Enqueue multiple change events rapidly
      scheduler.enqueue(filePath, 'change');
      scheduler.enqueue(filePath, 'change');
      scheduler.enqueue(filePath, 'change');

      expect(scheduler.getPendingCount()).toBe(1);
      expect(processHandler).not.toHaveBeenCalled();

      // Fast-forward timers
      await vi.advanceTimersByTimeAsync(300);

      expect(processHandler).toHaveBeenCalledTimes(1);
      expect(processHandler).toHaveBeenCalledWith(np(filePath), 'change');
      expect(scheduler.getPendingCount()).toBe(0);

      scheduler.dispose();
    });

    it('resets debounce window on same-priority events', async () => {
      const processHandler = vi.fn().mockResolvedValue(undefined);
      const scheduler = new FileChangeScheduler({
        processHandler,
        debounceDelay: 300,
      });

      const filePath = path.join(testRootDir, 'src', 'file.ts');

      scheduler.enqueue(filePath, 'change');

      await vi.advanceTimersByTimeAsync(200);
      scheduler.enqueue(filePath, 'change');

      await vi.advanceTimersByTimeAsync(200);
      expect(processHandler).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);

      expect(processHandler).toHaveBeenCalledTimes(1);
      expect(processHandler).toHaveBeenCalledWith(np(filePath), 'change');

      scheduler.dispose();
    });

    it('processes different files independently', async () => {
      const processHandler = vi.fn().mockResolvedValue(undefined);
      const scheduler = new FileChangeScheduler({
        processHandler,
        debounceDelay: 300,
      });

      const file1 = path.join(testRootDir, 'src', 'file1.ts');
      const file2 = path.join(testRootDir, 'src', 'file2.ts');

      scheduler.enqueue(file1, 'change');
      scheduler.enqueue(file2, 'change');

      expect(scheduler.getPendingCount()).toBe(2);

      await vi.advanceTimersByTimeAsync(300);

      expect(processHandler).toHaveBeenCalledTimes(2);
      expect(processHandler).toHaveBeenCalledWith(np(file1), 'change');
      expect(processHandler).toHaveBeenCalledWith(np(file2), 'change');

      scheduler.dispose();
    });
  });

  describe('Event priority', () => {
    it('replaces change with delete during debounce window', async () => {
      const processHandler = vi.fn().mockResolvedValue(undefined);
      const scheduler = new FileChangeScheduler({
        processHandler,
        debounceDelay: 300,
      });

      const filePath = path.join(testRootDir, 'src', 'file.ts');

      // Enqueue change, then delete
      scheduler.enqueue(filePath, 'change');
      await vi.advanceTimersByTimeAsync(100); // Still within debounce window
      scheduler.enqueue(filePath, 'delete');

      expect(scheduler.getPendingCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(300);

      // Only delete should be processed
      expect(processHandler).toHaveBeenCalledTimes(1);
      expect(processHandler).toHaveBeenCalledWith(np(filePath), 'delete');

      scheduler.dispose();
    });

    it('replaces create with change during debounce window', async () => {
      const processHandler = vi.fn().mockResolvedValue(undefined);
      const scheduler = new FileChangeScheduler({
        processHandler,
        debounceDelay: 300,
      });

      const filePath = path.join(testRootDir, 'src', 'file.ts');

      scheduler.enqueue(filePath, 'create');
      await vi.advanceTimersByTimeAsync(100);
      scheduler.enqueue(filePath, 'change');

      await vi.advanceTimersByTimeAsync(300);

      expect(processHandler).toHaveBeenCalledTimes(1);
      expect(processHandler).toHaveBeenCalledWith(np(filePath), 'change');

      scheduler.dispose();
    });

    it('does not replace delete with lower priority events', async () => {
      const processHandler = vi.fn().mockResolvedValue(undefined);
      const scheduler = new FileChangeScheduler({
        processHandler,
        debounceDelay: 300,
      });

      const filePath = path.join(testRootDir, 'src', 'file.ts');

      scheduler.enqueue(filePath, 'delete');
      await vi.advanceTimersByTimeAsync(100);
      scheduler.enqueue(filePath, 'change');
      scheduler.enqueue(filePath, 'create');

      await vi.advanceTimersByTimeAsync(300);

      // Delete should still be processed (highest priority)
      expect(processHandler).toHaveBeenCalledTimes(1);
      expect(processHandler).toHaveBeenCalledWith(np(filePath), 'delete');

      scheduler.dispose();
    });
  });

  describe('In-flight processing', () => {
    it('reschedules once if event arrives during processing', async () => {
      let resolveProcessing: (() => void) | null = null;
      const processingPromise = new Promise<void>((resolve) => {
        resolveProcessing = resolve;
      });

      const processHandler = vi.fn().mockImplementation(async () => {
        // Simulate async processing
        await processingPromise;
      });

      const scheduler = new FileChangeScheduler({
        processHandler,
        debounceDelay: 300,
      });

      const filePath = path.join(testRootDir, 'src', 'file.ts');

      // First event
      scheduler.enqueue(filePath, 'change');
      await vi.advanceTimersByTimeAsync(300);

      // Processing started but not finished
      expect(processHandler).toHaveBeenCalledTimes(1);
      expect(scheduler.getPendingCount()).toBe(1); // Job still tracked

      // New event arrives during processing
      scheduler.enqueue(filePath, 'change');

      // Complete first processing
      resolveProcessing!();
      await vi.runAllTimersAsync();

      // Should re-schedule and process again
      await vi.advanceTimersByTimeAsync(300);

      expect(processHandler).toHaveBeenCalledTimes(2);

      scheduler.dispose();
    });

    it('upgrades event type if higher priority arrives during processing', async () => {
      let resolveProcessing: (() => void) | null = null;
      const processingPromise = new Promise<void>((resolve) => {
        resolveProcessing = resolve;
      });

      const processHandler = vi.fn().mockImplementation(async () => {
        await processingPromise;
      });

      const scheduler = new FileChangeScheduler({
        processHandler,
        debounceDelay: 300,
      });

      const filePath = path.join(testRootDir, 'src', 'file.ts');

      // First event: change
      scheduler.enqueue(filePath, 'change');
      await vi.advanceTimersByTimeAsync(300);

      expect(processHandler).toHaveBeenCalledTimes(1);
      expect(processHandler).toHaveBeenCalledWith(np(filePath), 'change');

      // Higher priority event arrives during processing
      scheduler.enqueue(filePath, 'delete');

      // Complete first processing
      resolveProcessing!();
      await vi.runAllTimersAsync();

      await vi.advanceTimersByTimeAsync(300);

      // Should re-schedule with delete (higher priority)
      expect(processHandler).toHaveBeenCalledTimes(2);
      expect(processHandler).toHaveBeenCalledWith(np(filePath), 'delete');

      scheduler.dispose();
    });
  });

  describe('Cross-platform path normalization', () => {
    it('normalizes Windows paths', async () => {
      const processHandler = vi.fn().mockResolvedValue(undefined);
      const scheduler = new FileChangeScheduler({
        processHandler,
        debounceDelay: 300,
      });

      // Windows path with backslashes
      const windowsPath = String.raw`C:\Users\project\src\file.ts`;
      scheduler.enqueue(windowsPath, 'change');

      await vi.advanceTimersByTimeAsync(300);

      // Should be normalized to forward slashes
      expect(processHandler).toHaveBeenCalledWith('c:/Users/project/src/file.ts', 'change');

      scheduler.dispose();
    });

    it('coalesces different representations of same path', async () => {
      const processHandler = vi.fn().mockResolvedValue(undefined);
      const scheduler = new FileChangeScheduler({
        processHandler,
        debounceDelay: 300,
      });

      // Same file with different separators
      scheduler.enqueue(String.raw`C:\project\file.ts`, 'change');
      scheduler.enqueue('C:/project/file.ts', 'change');
      scheduler.enqueue('c:/project/file.ts', 'change');

      expect(scheduler.getPendingCount()).toBe(1); // All should map to same normalized path

      await vi.advanceTimersByTimeAsync(300);

      expect(processHandler).toHaveBeenCalledTimes(1);

      scheduler.dispose();
    });

    it('handles POSIX paths correctly', async () => {
      const processHandler = vi.fn().mockResolvedValue(undefined);
      const scheduler = new FileChangeScheduler({
        processHandler,
        debounceDelay: 300,
      });

      const posixPath = '/Users/project/src/file.ts';
      scheduler.enqueue(posixPath, 'change');

      await vi.advanceTimersByTimeAsync(300);

      expect(processHandler).toHaveBeenCalledWith(posixPath, 'change');

      scheduler.dispose();
    });
  });

  describe('Disposal and cleanup', () => {
    it('clears all pending timers on dispose', () => {
      const processHandler = vi.fn().mockResolvedValue(undefined);
      const scheduler = new FileChangeScheduler({
        processHandler,
        debounceDelay: 300,
      });

      scheduler.enqueue('/file1.ts', 'change');
      scheduler.enqueue('/file2.ts', 'change');
      scheduler.enqueue('/file3.ts', 'change');

      expect(scheduler.getPendingCount()).toBe(3);

      scheduler.dispose();

      expect(scheduler.getPendingCount()).toBe(0);
      expect(processHandler).not.toHaveBeenCalled();
    });

    it('does not process events after disposal', async () => {
      const processHandler = vi.fn().mockResolvedValue(undefined);
      const scheduler = new FileChangeScheduler({
        processHandler,
        debounceDelay: 300,
      });

      scheduler.enqueue('/file.ts', 'change');
      scheduler.dispose();

      await vi.advanceTimersByTimeAsync(500);

      expect(processHandler).not.toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    it('continues processing other files if one fails', async () => {
      const processHandler = vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Processing failed'))
        .mockResolvedValueOnce(undefined);

      const scheduler = new FileChangeScheduler({
        processHandler,
        debounceDelay: 300,
      });

      scheduler.enqueue('/file1.ts', 'change');
      scheduler.enqueue('/file2.ts', 'change'); // This will fail
      scheduler.enqueue('/file3.ts', 'change');

      await vi.advanceTimersByTimeAsync(300);

      // All files should be attempted
      expect(processHandler).toHaveBeenCalledTimes(3);
      // Error is caught and logged internally, no need to verify logger

      scheduler.dispose();
    });
  });

  describe('Custom debounce delay', () => {
    it('respects custom debounce delay', async () => {
      const processHandler = vi.fn().mockResolvedValue(undefined);
      const scheduler = new FileChangeScheduler({
        processHandler,
        debounceDelay: 500, // Custom delay
      });

      scheduler.enqueue('/file.ts', 'change');

      await vi.advanceTimersByTimeAsync(300);
      expect(processHandler).not.toHaveBeenCalled(); // Not yet

      await vi.advanceTimersByTimeAsync(200);
      expect(processHandler).toHaveBeenCalledTimes(1);

      scheduler.dispose();
    });
  });
});
