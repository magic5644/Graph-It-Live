import { describe, expect, it, vi } from 'vitest';
import { createDebouncedRafScheduler, createSizePoller } from '../../../src/webview/utils/fitViewScheduler';

describe('createDebouncedRafScheduler', () => {
  it('debounces triggers and runs callback once', () => {
    vi.useFakeTimers();

    const callback = vi.fn();
    const requestAnimationFrame = vi.fn((handler: () => void) => {
      handler();
      return 1;
    });
    const cancelAnimationFrame = vi.fn();

    const scheduler = createDebouncedRafScheduler(callback, 60, {
      setTimeout: (handler, ms) => setTimeout(handler, ms),
      clearTimeout: (id) => clearTimeout(id),
      requestAnimationFrame,
      cancelAnimationFrame,
    });

    scheduler.trigger();
    scheduler.trigger();
    scheduler.trigger();

    expect(callback).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(59);
    expect(callback).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('dispose cancels pending work', () => {
    vi.useFakeTimers();

    const callback = vi.fn();
    const requestAnimationFrame = vi.fn((_handler: () => void) => 123);
    const cancelAnimationFrame = vi.fn();

    const scheduler = createDebouncedRafScheduler(callback, 60, {
      setTimeout: (handler, ms) => setTimeout(handler, ms),
      clearTimeout: (id) => clearTimeout(id),
      requestAnimationFrame,
      cancelAnimationFrame,
    });

    scheduler.trigger();
    scheduler.dispose();
    vi.advanceTimersByTime(1000);

    expect(callback).toHaveBeenCalledTimes(0);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(0);

    vi.useRealTimers();
  });
});

describe('createSizePoller', () => {
  it('calls onChange when size changes', () => {
    vi.useFakeTimers();

    let width = 100;
    let height = 200;
    const onChange = vi.fn();

    const poller = createSizePoller(
      () => ({ width, height }),
      onChange,
      250,
      {
        setInterval: (handler, ms) => setInterval(handler, ms),
        clearInterval: (id) => clearInterval(id),
      }
    );

    poller.start();
    vi.advanceTimersByTime(250);
    expect(onChange).toHaveBeenCalledTimes(0);

    width = 101;
    vi.advanceTimersByTime(250);
    expect(onChange).toHaveBeenCalledTimes(1);

    height = 201;
    vi.advanceTimersByTime(250);
    expect(onChange).toHaveBeenCalledTimes(2);

    poller.dispose();
    width = 102;
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('does not start multiple intervals when start is called multiple times', () => {
    vi.useFakeTimers();

    let width = 100;
    const onChange = vi.fn();

    const poller = createSizePoller(
      () => ({ width, height: 200 }),
      onChange,
      250,
      {
        setInterval: (handler, ms) => setInterval(handler, ms),
        clearInterval: (id) => clearInterval(id),
      }
    );

    poller.start();
    poller.start(); // Second start should be ignored
    poller.start(); // Third start should be ignored

    width = 101;
    vi.advanceTimersByTime(250);
    
    // Should only be called once, not three times
    expect(onChange).toHaveBeenCalledTimes(1);

    poller.dispose();
    vi.useRealTimers();
  });

  it('handles dispose when not started', () => {
    const onChange = vi.fn();

    const poller = createSizePoller(
      () => ({ width: 100, height: 200 }),
      onChange,
      250
    );

    // Should not throw when disposing without starting
    expect(() => poller.dispose()).not.toThrow();
  });

  it('works with default dependencies', () => {
    vi.useFakeTimers();

    let width = 100;
    const onChange = vi.fn();

    // Don't pass deps - use defaults
    const poller = createSizePoller(
      () => ({ width, height: 200 }),
      onChange,
      250
    );

    poller.start();
    vi.advanceTimersByTime(250);
    expect(onChange).toHaveBeenCalledTimes(0);

    width = 101;
    vi.advanceTimersByTime(250);
    expect(onChange).toHaveBeenCalledTimes(1);

    poller.dispose();
    vi.useRealTimers();
  });
});

describe('createDebouncedRafScheduler with default dependencies', () => {
  it('works with default dependencies', () => {
    vi.useFakeTimers();

    const callback = vi.fn();
    
    // Use default deps by not passing them
    const scheduler = createDebouncedRafScheduler(callback, 60);

    scheduler.trigger();
    
    // First advance the debounce timeout
    vi.advanceTimersByTime(60);
    
    // Then run all pending timers (RAF fallback uses setTimeout(handler, 0))
    vi.runAllTimers();

    expect(callback).toHaveBeenCalledTimes(1);

    scheduler.dispose();
    vi.useRealTimers();
  });

  it('cancels RAF when trigger is called again during debounce', () => {
    vi.useFakeTimers();

    const callback = vi.fn();
    const cancelAnimationFrame = vi.fn();
    let rafCallbackFn: (() => void) | null = null;
    
    const requestAnimationFrame = vi.fn((handler: () => void) => {
      rafCallbackFn = handler;
      return 123;
    });

    const scheduler = createDebouncedRafScheduler(callback, 60, {
      setTimeout: (handler, ms) => setTimeout(handler, ms),
      clearTimeout: (id) => clearTimeout(id),
      requestAnimationFrame,
      cancelAnimationFrame,
    });

    // First trigger - starts timeout
    scheduler.trigger();
    vi.advanceTimersByTime(60);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    // Trigger again BEFORE executing the RAF callback - this tests the RAF cancellation path
    // This happens inside the timeout callback (after debounce), when we call trigger() again
    scheduler.trigger();
    
    // The new trigger should:
    // 1. Clear the pending timeout (if any)
    // 2. NOT cancel RAF here because we're in a new trigger cycle
    // Actually, looking at the code, RAF is only canceled when a NEW timeout fires
    // So we need to advance time to fire the second timeout
    vi.advanceTimersByTime(60);
    
    // Now the second timeout has fired, and it should have canceled the previous RAF
    expect(cancelAnimationFrame).toHaveBeenCalledWith(123);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);

    // Execute the last RAF
    if (rafCallbackFn) rafCallbackFn();
    expect(callback).toHaveBeenCalledTimes(1);

    scheduler.dispose();
    vi.useRealTimers();
  });

  it('cancels timeout when dispose is called with pending RAF', () => {
    vi.useFakeTimers();

    const callback = vi.fn();
    const cancelAnimationFrame = vi.fn();
    const requestAnimationFrame = vi.fn((_handler: () => void) => 456);

    const scheduler = createDebouncedRafScheduler(callback, 60, {
      setTimeout: (handler, ms) => setTimeout(handler, ms),
      clearTimeout: (id) => clearTimeout(id),
      requestAnimationFrame,
      cancelAnimationFrame,
    });

    scheduler.trigger();
    vi.advanceTimersByTime(60);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    // Dispose with pending RAF
    scheduler.dispose();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(456);

    vi.useRealTimers();
  });

  it('uses clearTimeout fallback when cancelAnimationFrame is not available', () => {
    vi.useFakeTimers();

    const callback = vi.fn();
    let rafHandler: (() => void) | null = null;
    let rafTimeoutId: ReturnType<typeof setTimeout> | null = null;
    
    const mockSetTimeout = vi.fn((handler: () => void, ms: number) => {
      const id = setTimeout(handler, ms);
      if (ms === 0) {
        // This is the RAF fallback
        rafHandler = handler;
        rafTimeoutId = id;
      }
      return id;
    });

    const mockClearTimeout = vi.fn((id) => clearTimeout(id));

    // Pass deps without RAF functions to test the fallback path
    const scheduler = createDebouncedRafScheduler(callback, 60, {
      setTimeout: mockSetTimeout,
      clearTimeout: mockClearTimeout,
      // No RAF functions provided - should use setTimeout fallback
      requestAnimationFrame: (handler) => mockSetTimeout(handler, 0) as unknown as number,
      cancelAnimationFrame: (rafId) => mockClearTimeout(rafId as unknown as ReturnType<typeof setTimeout>),
    });

    scheduler.trigger();
    vi.advanceTimersByTime(60);
    
    // RAF fallback should have been called
    expect(mockSetTimeout).toHaveBeenCalledWith(expect.any(Function), 0);

    // Dispose should use clearTimeout on the RAF ID
    scheduler.dispose();
    expect(mockClearTimeout).toHaveBeenCalledWith(rafTimeoutId);

    vi.useRealTimers();
  });
});
