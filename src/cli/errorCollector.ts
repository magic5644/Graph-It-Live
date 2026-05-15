/**
 * Error Collector Logger
 *
 * Silent logger backend that accumulates parse/analysis errors in memory
 * instead of writing to stderr. Prevents pollution of CLI output during
 * file parsing and indexing.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import type { ILogger, LoggerBackend, LogLevel } from '../shared/logger';

export interface CollectedLogEntry {
  level: LogLevel;
  source: string;
  message: string;
  timestamp: number;
}

/**
 * Silent logger that accumulates entries without writing to stdout/stderr.
 * Used during CLI analysis to capture all logs cleanly.
 */
export class ErrorCollectorLogger implements ILogger {
  readonly level: LogLevel;

  constructor(
    readonly source: string,
    level: LogLevel = 'info',
    private readonly entries: CollectedLogEntry[] = [],
  ) {
    this.level = level;
  }

  setLevel(): void {
    // No-op: ErrorCollectorLogger is immutable
  }

  debug(message: string): void {
    this.record('debug', message);
  }

  info(message: string): void {
    this.record('info', message);
  }

  warn(message: string): void {
    this.record('warn', message);
  }

  error(message: string): void {
    this.record('error', message);
  }

  private record(level: LogLevel, message: string): void {
    // Keep last 1000 entries to bound memory
    if (this.entries.length >= 1000) {
      this.entries.shift();
    }
    this.entries.push({
      level,
      source: this.source,
      message,
      timestamp: Date.now(),
    });
  }

  getEntries(): CollectedLogEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries.length = 0;
  }
}

/**
 * Error collector backend factory.
 * Creates ErrorCollectorLogger instances and manages shared entry storage.
 */
export class ErrorCollectorBackend implements LoggerBackend {
  private readonly sharedEntries: CollectedLogEntry[] = [];

  createLogger(source: string, level?: LogLevel): ILogger {
    return new ErrorCollectorLogger(source, level ?? 'info', this.sharedEntries);
  }

  getCollectedEntries(): CollectedLogEntry[] {
    return [...this.sharedEntries];
  }

  clear(): void {
    this.sharedEntries.length = 0;
  }

  /**
   * Get error count by level
   */
  getErrorCount(): { errors: number; warnings: number; total: number } {
    let errors = 0;
    let warnings = 0;

    for (const entry of this.sharedEntries) {
      if (entry.level === 'error') {
        errors += 1;
      } else if (entry.level === 'warn') {
        warnings += 1;
      }
    }

    return { errors, warnings, total: this.sharedEntries.length };
  }
}
