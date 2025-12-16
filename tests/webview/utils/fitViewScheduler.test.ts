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
});
