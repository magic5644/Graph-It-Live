import { normalizePath } from '../../shared/path';
import { getExtensionLogger } from '../extensionLogger';

/** Logger instance for FileChangeScheduler */
const log = getExtensionLogger('FileChangeScheduler');

export type EventType = 'create' | 'change' | 'delete';

interface ScheduledJob {
  filePath: string;
  eventType: EventType;
  timerId: NodeJS.Timeout | null;
  inFlight: boolean;
  needsReschedule: boolean;
}

interface FileChangeSchedulerOptions {
  processHandler: (filePath: string, eventType: EventType) => Promise<void>;
  debounceDelay?: number;
}

/**
 * FileChangeScheduler coalesces file change events from multiple sources
 * (editor saves, file system watcher) into a single processing pipeline.
 * 
 * Key features:
 * - Per-file debouncing (not global)
 * - Event priority: delete > change > create
 * - Re-schedules once if new event arrives during processing
 * - No event loss - all events eventually processed
 * - Cross-platform path normalization
 */
export class FileChangeScheduler {
  private readonly jobs = new Map<string, ScheduledJob>();
  private readonly failures = new Map<string, unknown>();
  private readonly idleWaiters = new Set<{ resolve: () => void; reject: (error: unknown) => void }>();
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly debounceDelay: number;
  private readonly processHandler: (filePath: string, eventType: EventType) => Promise<void>;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(options: FileChangeSchedulerOptions) {
    this.processHandler = options.processHandler;
    this.debounceDelay = options.debounceDelay ?? 300; // 300ms default
  }

  /**
   * Enqueue a file change event. If a higher priority event arrives during
   * the debounce window, it replaces the current scheduled event.
   * If processing is in-flight, marks for re-schedule after completion.
   */
  enqueue(filePath: string, eventType: EventType): void {
    if (this.disposed) return;
    const normalizedPath = normalizePath(filePath);
    const existing = this.jobs.get(normalizedPath);

    // Case 1: Processing in-flight - mark for re-schedule
    if (existing?.inFlight) {
      log.debug(
        `Job in-flight for ${normalizedPath}, marking for re-schedule with ${eventType}`
      );
      
      // Replace with higher priority event
      if (this.shouldReplaceEvent(existing.eventType, eventType)) {
        existing.eventType = eventType;
      }
      existing.needsReschedule = true;
      return;
    }

    // Case 2: Timer pending - replace if higher priority
    if (existing?.timerId) {
      const nextEventType = this.shouldReplaceEvent(existing.eventType, eventType)
        ? eventType
        : existing.eventType;
      log.debug(
        `Debounce reset for ${normalizedPath}: ${existing.eventType} -> ${nextEventType}`
      );
      clearTimeout(existing.timerId);
      this.scheduleJob(normalizedPath, nextEventType);
      return;
    }

    // Case 3: New job
    log.debug(`Scheduling ${eventType} for ${normalizedPath}`);
    this.scheduleJob(normalizedPath, eventType);
  }

  /**
   * Dispose all pending timers
   */
  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeAndWait();
    return this.disposePromise;
  }

  private async disposeAndWait(): Promise<void> {
    this.disposed = true;
    log.debug(`Disposing FileChangeScheduler with ${this.jobs.size} pending jobs`);
    
    for (const job of this.jobs.values()) {
      if (job.timerId) {
        clearTimeout(job.timerId);
      }
      if (!job.inFlight) this.jobs.delete(job.filePath);
    }
    for (const waiter of this.idleWaiters) waiter.reject(new Error('File updates were disposed.'));
    this.idleWaiters.clear();
    this.failures.clear();
    await Promise.allSettled([...this.activeTasks]);
    this.jobs.clear();
    this.failures.clear();
  }

  /** Observe completion without changing per-file debounce or coalescing semantics. */
  async whenIdle(): Promise<void> {
    if (this.jobs.size) await new Promise<void>((resolve, reject) => this.idleWaiters.add({ resolve, reject }));
    if (this.failures.size) throw this.failures.values().next().value;
  }

  /**
   * Get the number of pending jobs (for testing)
   */
  getPendingCount(): number {
    return this.jobs.size;
  }

  private scheduleJob(normalizedPath: string, eventType: EventType): void {
    const timerId = setTimeout(() => {
      const task = this.executeJob(normalizedPath);
      this.activeTasks.add(task);
      void task.finally(() => this.activeTasks.delete(task)).catch(() => {});
    }, this.debounceDelay);

    this.jobs.set(normalizedPath, {
      filePath: normalizedPath,
      eventType,
      timerId,
      inFlight: false,
      needsReschedule: false,
    });
  }

  private async executeJob(normalizedPath: string): Promise<void> {
    if (this.disposed) {
      this.jobs.delete(normalizedPath);
      return;
    }
    const job = this.jobs.get(normalizedPath);
    if (!job) {
      return; // Job was cancelled
    }

    // Mark as in-flight
    job.inFlight = true;
    job.timerId = null;

    const eventType = job.eventType;
    log.debug(`Processing ${eventType} for ${normalizedPath}`);

    try {
      await this.processHandler(normalizedPath, eventType);
      this.failures.delete(normalizedPath);
    } catch (error) {
      this.failures.set(normalizedPath, error);
      log.debug(`Error processing ${eventType} for ${normalizedPath}:`, error);
      // Don't throw - we want to continue processing other files
    }

    // Check if re-schedule is needed
    const currentJob = this.jobs.get(normalizedPath);
    if (currentJob?.needsReschedule && !this.disposed) {
      log.debug(`Re-scheduling ${currentJob.eventType} for ${normalizedPath}`);
      this.jobs.delete(normalizedPath);
      this.scheduleJob(normalizedPath, currentJob.eventType);
    } else {
      this.jobs.delete(normalizedPath);
    }
    if (this.jobs.size === 0) {
      for (const waiter of this.idleWaiters) waiter.resolve();
      this.idleWaiters.clear();
    }
  }

  /**
   * Determine event priority: delete > change > create
   */
  private getEventPriority(eventType: EventType): number {
    switch (eventType) {
      case 'delete':
        return 3;
      case 'change':
        return 2;
      case 'create':
        return 1;
    }
  }

  /**
   * Check if incoming event should replace current event
   */
  private shouldReplaceEvent(current: EventType, incoming: EventType): boolean {
    return this.getEventPriority(incoming) > this.getEventPriority(current);
  }
}
