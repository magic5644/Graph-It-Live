export type TimeoutId = ReturnType<typeof setTimeout>;
export type RafId = number;

export interface FitViewSchedulerDeps {
  setTimeout: (handler: () => void, timeoutMs: number) => TimeoutId;
  clearTimeout: (timeoutId: TimeoutId) => void;
  requestAnimationFrame: (handler: () => void) => RafId;
  cancelAnimationFrame: (rafId: RafId) => void;
}

function getDefaultDeps(): FitViewSchedulerDeps {
  const g = globalThis as unknown as {
    setTimeout: FitViewSchedulerDeps['setTimeout'];
    clearTimeout: FitViewSchedulerDeps['clearTimeout'];
    requestAnimationFrame?: FitViewSchedulerDeps['requestAnimationFrame'];
    cancelAnimationFrame?: FitViewSchedulerDeps['cancelAnimationFrame'];
  };

  // In some browser/webview contexts, calling these timer functions detached can throw
  // "Illegal invocation". Bind them to `globalThis` to be safe.
  const boundSetTimeout = g.setTimeout.bind(globalThis) as FitViewSchedulerDeps['setTimeout'];
  const boundClearTimeout = g.clearTimeout.bind(globalThis) as FitViewSchedulerDeps['clearTimeout'];
  const boundRequestAnimationFrame = g.requestAnimationFrame
    ? (g.requestAnimationFrame.bind(globalThis) as FitViewSchedulerDeps['requestAnimationFrame'])
    : undefined;
  const boundCancelAnimationFrame = g.cancelAnimationFrame
    ? (g.cancelAnimationFrame.bind(globalThis) as FitViewSchedulerDeps['cancelAnimationFrame'])
    : undefined;

  return {
    setTimeout: boundSetTimeout,
    clearTimeout: boundClearTimeout,
    requestAnimationFrame:
      boundRequestAnimationFrame ??
      ((handler) => boundSetTimeout(handler, 0) as unknown as number),
    cancelAnimationFrame:
      boundCancelAnimationFrame ??
      ((rafId) => boundClearTimeout(rafId as unknown as TimeoutId)),
  };
}

/**
 * Debounced "fit view" scheduler: coalesces rapid triggers, then executes the callback
 * on the next animation frame after the debounce delay.
 */
export function createDebouncedRafScheduler(
  callback: () => void,
  debounceMs: number,
  deps: FitViewSchedulerDeps = getDefaultDeps()
): { trigger: () => void; dispose: () => void } {
  let timeoutId: TimeoutId | null = null;
  let rafId: RafId | null = null;

  const dispose = () => {
    if (timeoutId !== null) deps.clearTimeout(timeoutId);
    if (rafId !== null) deps.cancelAnimationFrame(rafId);
    timeoutId = null;
    rafId = null;
  };

  const trigger = () => {
    if (timeoutId !== null) deps.clearTimeout(timeoutId);

    timeoutId = deps.setTimeout(() => {
      timeoutId = null;
      if (rafId !== null) deps.cancelAnimationFrame(rafId);
      rafId = deps.requestAnimationFrame(() => {
        rafId = null;
        callback();
      });
    }, debounceMs);
  };

  return { trigger, dispose };
}

export interface IntervalDeps {
  setInterval: (handler: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  clearInterval: (intervalId: ReturnType<typeof setInterval>) => void;
}

function getDefaultIntervalDeps(): IntervalDeps {
  return {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  };
}

/**
 * Polls a size provider at a fixed interval and fires `onChange` when dimensions change.
 * Useful as a low-risk fallback when ResizeObserver/window events are unreliable.
 */
export function createSizePoller(
  getSize: () => { width: number; height: number },
  onChange: () => void,
  intervalMs: number,
  deps: IntervalDeps = getDefaultIntervalDeps()
): { start: () => void; dispose: () => void } {
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let last = getSize();

  const tick = () => {
    const next = getSize();
    if (next.width === last.width && next.height === last.height) return;
    last = next;
    onChange();
  };

  const start = () => {
    if (intervalId !== null) return;
    intervalId = deps.setInterval(tick, intervalMs);
  };

  const dispose = () => {
    if (intervalId === null) return;
    deps.clearInterval(intervalId);
    intervalId = null;
  };

  return { start, dispose };
}
