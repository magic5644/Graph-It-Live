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
  private readonly debounceDelay: number;
  private readonly processHandler: (filePath: string, eventType: EventType) => Promise<void>;

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
      if (this.shouldReplaceEvent(existing.eventType, eventType)) {
        log.debug(
          `Replacing ${existing.eventType} with ${eventType} for ${normalizedPath}`
        );
        clearTimeout(existing.timerId);
        this.scheduleJob(normalizedPath, eventType);
      } else {
        log.debug(
          `Keeping ${existing.eventType} over ${eventType} for ${normalizedPath}`
        );
      }
      return;
    }

    // Case 3: New job
    log.debug(`Scheduling ${eventType} for ${normalizedPath}`);
    this.scheduleJob(normalizedPath, eventType);
  }

  /**
   * Dispose all pending timers
   */
  dispose(): void {
    log.debug(`Disposing FileChangeScheduler with ${this.jobs.size} pending jobs`);
    
    for (const job of this.jobs.values()) {
      if (job.timerId) {
        clearTimeout(job.timerId);
      }
    }
    this.jobs.clear();
  }

  /**
   * Get the number of pending jobs (for testing)
   */
  getPendingCount(): number {
    return this.jobs.size;
  }

  private scheduleJob(normalizedPath: string, eventType: EventType): void {
    const timerId = setTimeout(() => {
      void this.executeJob(normalizedPath);
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
    } catch (error) {
      log.debug(`Error processing ${eventType} for ${normalizedPath}:`, error);
      // Don't throw - we want to continue processing other files
    }

    // Check if re-schedule is needed
    const currentJob = this.jobs.get(normalizedPath);
    if (currentJob?.needsReschedule) {
      log.debug(`Re-scheduling ${currentJob.eventType} for ${normalizedPath}`);
      this.jobs.delete(normalizedPath);
      this.scheduleJob(normalizedPath, currentJob.eventType);
    } else {
      this.jobs.delete(normalizedPath);
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
