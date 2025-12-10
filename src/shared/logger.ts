/**
 * Configurable Logging System
 * 
 * Provides a unified logging interface with configurable log levels.
 * Two implementations:
 * - ConsoleLogger: For VS Code agnostic modules (analyzer, mcp)
 * - VsCodeLogger: For extension modules (uses OutputChannel)
 * 
 * CRITICAL: This base module is VS Code agnostic!
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';

/** Log level priority (lower = more verbose) */
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  none: 4,
};

/**
 * Logger interface - all loggers implement this
 */
export interface ILogger {
  readonly level: LogLevel;
  setLevel(level: LogLevel): void;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Optional logger backend - used by the extension to redirect logs to a different sink
 */
export type LoggerBackend = {
  createLogger(prefix: string, level?: LogLevel): ILogger;
};

/**
 * Format log arguments for output
 */
function formatArgs(args: unknown[]): string {
  if (args.length === 0) return '';
  return ' ' + args.map(arg => {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }).join(' ');
}

/**
 * Console Logger - VS Code agnostic
 * Uses console.log/error for output
 */
export class ConsoleLogger implements ILogger {
  private _level: LogLevel;
  private readonly prefix: string;

  constructor(prefix: string = '', level: LogLevel = 'info') {
    this.prefix = prefix ? `[${prefix}]` : '';
    this._level = level;
  }

  get level(): LogLevel {
    return this._level;
  }

  setLevel(level: LogLevel): void {
    this._level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this._level];
  }

  private formatMessage(level: string, message: string): string {
    const timestamp = new Date().toISOString();
    return `${timestamp} ${this.prefix} [${level.toUpperCase()}] ${message}`;
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.shouldLog('debug')) {
      console.log(this.formatMessage('debug', message + formatArgs(args)));
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.shouldLog('info')) {
      console.log(this.formatMessage('info', message + formatArgs(args)));
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message + formatArgs(args)));
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (this.shouldLog('error')) {
      console.error(this.formatMessage('error', message + formatArgs(args)));
    }
  }
}

/**
 * Null Logger - discards all logs
 * Useful for testing or when logging is disabled
 */
export class NullLogger implements ILogger {
  readonly level: LogLevel = 'none';
  setLevel(): void { /* no-op */ }
  debug(): void { /* no-op */ }
  info(): void { /* no-op */ }
  warn(): void { /* no-op */ }
  error(): void { /* no-op */ }
}

/**
 * Delegating logger - forwards to an underlying delegate logger instance.
 * Useful for swapping the underlying logger (eg. ConsoleLogger -> VsCode Logger) while
 * preserving a single logger reference so callers that captured the logger continue
 * to receive forwarded messages.
 */
class DelegatingLogger implements ILogger {
  private delegate: ILogger;

  constructor(delegate: ILogger) {
    this.delegate = delegate;
  }

  get level(): LogLevel {
    return this.delegate.level;
  }

  setLevel(level: LogLevel): void {
    this.delegate.setLevel(level);
  }

  setDelegate(delegate: ILogger): void {
    this.delegate = delegate;
  }

  debug(message: string, ...args: unknown[]): void {
    this.delegate.debug(message, ...args);
  }
  info(message: string, ...args: unknown[]): void {
    this.delegate.info(message, ...args);
  }
  warn(message: string, ...args: unknown[]): void {
    this.delegate.warn(message, ...args);
  }
  error(message: string, ...args: unknown[]): void {
    this.delegate.error(message, ...args);
  }
}

/**
 * Logger Factory - creates loggers with shared configuration
 */
class LoggerFactory {
  private defaultLevel: LogLevel = 'info';
  private readonly loggers: Map<string, DelegatingLogger> = new Map();
  private backend?: LoggerBackend;

  /**
   * Set the default log level for new loggers
   */
  setDefaultLevel(level: LogLevel): void {
    this.defaultLevel = level;
    // Update all existing loggers
    for (const logger of this.loggers.values()) {
      logger.setLevel(level);
    }
  }

  /**
   * Get the current default log level
   */
  getDefaultLevel(): LogLevel {
    return this.defaultLevel;
  }

  /**
   * Create or get a console logger with the given prefix
   */
  getLogger(prefix: string): ILogger {
    let logger = this.loggers.get(prefix);
    if (!logger) {
      // Create a delegating logger wrapping the appropriate backend or console logger
      const baseLogger = this.backend ? this.backend.createLogger(prefix, this.defaultLevel) : new ConsoleLogger(prefix, this.defaultLevel);
      logger = new DelegatingLogger(baseLogger);
      this.loggers.set(prefix, logger);
    }
    return logger;
  }

  /**
   * Create a null logger (for testing)
   */
  getNullLogger(): ILogger {
    const base = new NullLogger();
    return new DelegatingLogger(base);
  }

  /**
   * Clear all cached loggers
   */
  clear(): void {
    this.loggers.clear();
  }

  /**
   * Set an optional backend for creating loggers. When set, newly-created loggers will
   * use the backend. Existing loggers in the factory will have their delegate replaced
   * with a backend-created logger instance (preserving existing references).
   */
  setBackend(backend?: LoggerBackend): void {
    this.backend = backend;

    for (const [prefix, delegatingLogger] of this.loggers.entries()) {
      const currentLevel = delegatingLogger.level ?? this.defaultLevel;
      const newBase = backend ? backend.createLogger(prefix, currentLevel) : new ConsoleLogger(prefix, currentLevel);
      delegatingLogger.setDelegate(newBase);
    }
  }

  getBackend(): LoggerBackend | undefined {
    return this.backend;
  }
}

/** Global logger factory instance */
export const loggerFactory = new LoggerFactory();

/**
 * Convenience function to get a logger
 */
export function getLogger(prefix: string): ILogger {
  return loggerFactory.getLogger(prefix);
}

/**
 * Allow external code (eg. the extension) to register a backend that will be used
 * to create logger instances. This is how the extension can redirect logs to a
 * `vscode.OutputChannel` logger instead of console
 */
export function setLoggerBackend(backend?: LoggerBackend): void {
  loggerFactory.setBackend(backend);
}

/**
 * Read log level from environment variable
 * Useful for MCP server and worker threads
 */
export function getLogLevelFromEnv(envVar: string = 'LOG_LEVEL'): LogLevel {
  const level = process.env[envVar]?.toLowerCase();
  if (level && level in LOG_LEVEL_PRIORITY) {
    return level as LogLevel;
  }
  return 'info';
}
