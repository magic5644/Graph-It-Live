import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileChangeScheduler } from '../../src/extension/services/FileChangeScheduler';
import type { EventType } from '../../src/extension/services/FileChangeScheduler';
import * as path from 'node:path';
import { normalizePath } from '../../src/shared/path';

const testRootDir = path.resolve(process.cwd(), 'temp-test-root');
const np = (p: string) => normalizePath(p);

// Mock the extension logger
vi.mock('../../src/extension/extensionLogger', () => ({
  getExtensionLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

/**
 * Integration tests for file change coalescence.
 * These tests verify that the FileChangeScheduler correctly coalesces
 * save events from EditorEventsService and watcher events from SourceFileWatcher.
 */

describe('File Change Coalescence Integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('save in editor triggers exactly one reanalyze + refresh', async () => {
    const processHandler = vi.fn().mockResolvedValue(undefined);
    const scheduler = new FileChangeScheduler({
      processHandler,
      debounceDelay: 300,
    });

    const filePath = path.join(testRootDir, 'src', 'component.tsx');

    // Simulate save event from EditorEventsService
    scheduler.enqueue(filePath, 'change');

    expect(processHandler).not.toHaveBeenCalled();

    // Fast-forward past debounce
    await vi.advanceTimersByTimeAsync(300);

    // Should process exactly once
    expect(processHandler).toHaveBeenCalledTimes(1);
    expect(processHandler).toHaveBeenCalledWith(filePath, 'change');

    scheduler.dispose();
  });

  it('external change + save triggers only one processing pass', async () => {
    const processHandler = vi.fn().mockResolvedValue(undefined);
    const scheduler = new FileChangeScheduler({
      processHandler,
      debounceDelay: 300,
    });

    const filePath = path.join(testRootDir, 'src', 'utils.ts');

    // Simulate rapid sequence:
    // 1. External file change (FileSystemWatcher)
    scheduler.enqueue(filePath, 'change');
    
    await vi.advanceTimersByTimeAsync(50);
    
    // 2. User saves in editor (EditorEventsService)
    scheduler.enqueue(filePath, 'change');
    
    await vi.advanceTimersByTimeAsync(50);
    
    // 3. Another external change (debounced file watcher)
    scheduler.enqueue(filePath, 'change');

    expect(processHandler).not.toHaveBeenCalled();

    // Fast-forward past debounce
    await vi.advanceTimersByTimeAsync(300);

    // Should coalesce all three events into single processing
    expect(processHandler).toHaveBeenCalledTimes(1);
    expect(processHandler).toHaveBeenCalledWith(filePath, 'change');

    scheduler.dispose();
  });

  it('delete event takes priority over pending change', async () => {
    const processHandler = vi.fn().mockResolvedValue(undefined);
    const scheduler = new FileChangeScheduler({
      processHandler,
      debounceDelay: 300,
    });

    const filePath = path.join(testRootDir, 'src', 'deprecated.ts');

    // User saves file
    scheduler.enqueue(filePath, 'change');
    
    await vi.advanceTimersByTimeAsync(100);
    
    // Then deletes it (higher priority)
    scheduler.enqueue(filePath, 'delete');

    await vi.advanceTimersByTimeAsync(300);

    // Should only process delete (higher priority)
    expect(processHandler).toHaveBeenCalledTimes(1);
    expect(processHandler).toHaveBeenCalledWith(filePath, 'delete');

    scheduler.dispose();
  });

  it('preserves current view mode during refresh', async () => {
    // Mock state to track view mode
    let currentSymbol: string | undefined = '/file.ts:MyClass';
    const symbolRefreshCalls: string[] = [];
    const fileRefreshCalls: number[] = [];

    const processHandler = vi.fn().mockImplementation(async (filePath: string, eventType: EventType) => {
      // Simulate refresh behavior based on view mode
      if (currentSymbol) {
        symbolRefreshCalls.push(currentSymbol);
      } else {
        fileRefreshCalls.push(Date.now());
      }
    });

    const scheduler = new FileChangeScheduler({
      processHandler,
      debounceDelay: 300,
    });

    // In symbol view, trigger change
    scheduler.enqueue('/file.ts', 'change');
    await vi.advanceTimersByTimeAsync(300);

    expect(symbolRefreshCalls).toHaveLength(1);
    expect(fileRefreshCalls).toHaveLength(0);

    // Switch to file view
    currentSymbol = undefined;
    
    scheduler.enqueue('/other.ts', 'change');
    await vi.advanceTimersByTimeAsync(300);

    expect(symbolRefreshCalls).toHaveLength(1); // No change
    expect(fileRefreshCalls).toHaveLength(1);

    scheduler.dispose();
  });

  it('handles multiple files with independent debouncing', async () => {
    const processHandler = vi.fn().mockResolvedValue(undefined);
    const scheduler = new FileChangeScheduler({
      processHandler,
      debounceDelay: 300,
    });

    // Multiple files modified at different times
    scheduler.enqueue(path.join(testRootDir, 'file1.ts'), 'change');
    
    await vi.advanceTimersByTimeAsync(100);
    scheduler.enqueue(path.join(testRootDir, 'file2.ts'), 'change');
    
    await vi.advanceTimersByTimeAsync(100);
    scheduler.enqueue(path.join(testRootDir, 'file3.ts'), 'change');

    // file1 timer expires first
    await vi.advanceTimersByTimeAsync(100);
    expect(processHandler).toHaveBeenCalledTimes(1);
    expect(processHandler).toHaveBeenCalledWith(path.join(testRootDir, 'file1.ts'), 'change');

    // file2 timer expires
    await vi.advanceTimersByTimeAsync(100);
    expect(processHandler).toHaveBeenCalledTimes(2);
    expect(processHandler).toHaveBeenCalledWith(path.join(testRootDir, 'file2.ts'), 'change');

    // file3 timer expires
    await vi.advanceTimersByTimeAsync(100);
    expect(processHandler).toHaveBeenCalledTimes(3);
    expect(processHandler).toHaveBeenCalledWith(path.join(testRootDir, 'file3.ts'), 'change');

    scheduler.dispose();
  });

  it('handles rapid save sequences without loss', async () => {
    const processHandler = vi.fn().mockResolvedValue(undefined);
    const scheduler = new FileChangeScheduler({
      processHandler,
      debounceDelay: 300,
    });

    const filePath = '/project/src/fast-edit.ts';

    // Simulate user making rapid edits with auto-save enabled
    // Enqueue all events without advancing timers (simulating very rapid succession)
    for (let i = 0; i < 10; i++) {
      scheduler.enqueue(filePath, 'change');
    }

    expect(processHandler).not.toHaveBeenCalled();

    // Wait for debounce to complete
    await vi.advanceTimersByTimeAsync(300);

    // All 10 saves should coalesce into single processing
    expect(processHandler).toHaveBeenCalledTimes(1);
    expect(processHandler).toHaveBeenCalledWith(filePath, 'change');

    scheduler.dispose();
  });

  it('reschedules if new event arrives during processing', async () => {
    let resolveFirstProcessing: (() => void) | null = null;
    const firstProcessingPromise = new Promise<void>((resolve) => {
      resolveFirstProcessing = resolve;
    });

    let callCount = 0;
    const processHandler = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First call - wait for resolution
        await firstProcessingPromise;
      }
      // Second call - resolve immediately
    });

    const scheduler = new FileChangeScheduler({
      processHandler,
      debounceDelay: 300,
    });

    const filePath = '/project/src/busy.ts';

    // First event
    scheduler.enqueue(filePath, 'change');
    await vi.advanceTimersByTimeAsync(300);

    // Processing started (but blocked on promise)
    expect(processHandler).toHaveBeenCalledTimes(1);

    // New event arrives during processing
    scheduler.enqueue(filePath, 'change');

    // Complete first processing
    resolveFirstProcessing!();
    await vi.runAllTimersAsync();

    // Should re-schedule
    await vi.advanceTimersByTimeAsync(300);

    expect(processHandler).toHaveBeenCalledTimes(2);

    scheduler.dispose();
  });

  it('continues processing other files if one fails', async () => {
    const processHandler = vi.fn()
      .mockResolvedValueOnce(undefined) // file1 succeeds
      .mockRejectedValueOnce(new Error('Analysis failed')) // file2 fails
      .mockResolvedValueOnce(undefined); // file3 succeeds

    const scheduler = new FileChangeScheduler({
      processHandler,
      debounceDelay: 300,
    });

    scheduler.enqueue(path.join(testRootDir, 'file1.ts'), 'change');
    scheduler.enqueue(path.join(testRootDir, 'file2.ts'), 'change');
    scheduler.enqueue(path.join(testRootDir, 'file3.ts'), 'change');

    await vi.advanceTimersByTimeAsync(300);

    // All files should be attempted despite file2 failure
    expect(processHandler).toHaveBeenCalledTimes(3);
    
    // Error is caught and logged internally

    scheduler.dispose();
  });

  it('normalizes paths from different sources before coalescence', async () => {
    const processHandler = vi.fn().mockResolvedValue(undefined);
    const scheduler = new FileChangeScheduler({
      processHandler,
      debounceDelay: 300,
    });

    // Same file with different path representations
    scheduler.enqueue(String.raw`C:\project\src\file.ts`, 'change'); // Windows backslash
    await vi.advanceTimersByTimeAsync(50);
    scheduler.enqueue('C:/project/src/file.ts', 'change'); // Windows forward slash
    await vi.advanceTimersByTimeAsync(50);
    scheduler.enqueue('c:/project/src/file.ts', 'change'); // Lowercase drive

    await vi.advanceTimersByTimeAsync(300);

    // All should coalesce into single processing call
    expect(processHandler).toHaveBeenCalledTimes(1);

    scheduler.dispose();
  });
});
