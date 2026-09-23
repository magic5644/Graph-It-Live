/**
 * VS Code Extension Logger
 * 
 * Extends the base logging system with VS Code OutputChannel support.
 * This module CAN import vscode - it's only used in the extension layer.
 */

import * as vscode from 'vscode';
import { type ILogger, LOG_LEVEL_PRIORITY, loggerFactory, type LogLevel } from '../shared/logger';

/**
 * VS Code Logger - uses OutputChannel for output
 */
export class VsCodeLogger implements ILogger {
  private _level: LogLevel;
  private readonly outputChannel: vscode.OutputChannel;
  private readonly prefix: string;

  constructor(
    outputChannel: vscode.OutputChannel,
    prefix: string = '',
    level: LogLevel = 'info'
  ) {
    this.outputChannel = outputChannel;
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

  private formatArgs(args: unknown[]): string {
    if (args.length === 0) return '';
    return ' ' + args.map(arg => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      try {
        return JSON.stringify(arg);
      } catch {
        if (typeof arg === 'object' && arg !== null) {
          return Object.prototype.toString.call(arg);
        }
        return String(arg);
      }
    }).join(' ');
  }

  private appendLine(level: LogLevel, message: string, args: unknown[]): void {
    try {
      this.outputChannel.appendLine(this.formatMessage(level, message + this.formatArgs(args)));
    } catch {
      // Extension-host shutdown can dispose the channel before workers finish logging.
    }
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.shouldLog('debug')) {
      this.appendLine('debug', message, args);
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.shouldLog('info')) {
      this.appendLine('info', message, args);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.shouldLog('warn')) {
      this.appendLine('warn', message, args);
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (this.shouldLog('error')) {
      this.appendLine('error', message, args);
    }
  }

  /**
   * Show the output channel in the UI
   */
  show(): void {
    try {
      this.outputChannel.show();
    } catch {
      // The output channel may already be disposed during shutdown.
    }
  }
}

/**
 * Extension Logger Manager
 * Singleton that manages the VS Code output channel and logger instances
 */
class ExtensionLoggerManager {
  private outputChannel: vscode.OutputChannel | undefined;
  private readonly loggers: Map<string, VsCodeLogger> = new Map();
  private currentLevel: LogLevel = 'info';

  /**
   * Initialize the logger manager with an output channel
   * Call this once during extension activation
   */
  initialize(outputChannel: vscode.OutputChannel): void {
    this.outputChannel = outputChannel;
    // Re-create existing loggers with the new output channel
    for (const [prefix] of this.loggers) {
      const newLogger = new VsCodeLogger(outputChannel, prefix, this.currentLevel);
      this.loggers.set(prefix, newLogger);
    }
  }

  /**
   * Set the log level for all extension loggers
   */
  setLevel(level: LogLevel): void {
    this.currentLevel = level;
    for (const logger of this.loggers.values()) {
      logger.setLevel(level);
    }
    // Also update the shared logger factory for consistency
    loggerFactory.setDefaultLevel(level);
  }

  /**
   * Get the current log level
   */
  getLevel(): LogLevel {
    return this.currentLevel;
  }

  /**
   * Get a logger with the given prefix
   */
  getLogger(prefix: string): VsCodeLogger {
    let logger = this.loggers.get(prefix);
    if (!logger) {
      // Create output channel if not initialized
      this.outputChannel ??= vscode.window.createOutputChannel('Graph-It-Live');
      logger = new VsCodeLogger(this.outputChannel, prefix, this.currentLevel);
      this.loggers.set(prefix, logger);
    }
    return logger;
  }

  /**
   * Show the output channel
   */
  show(): void {
    try { this.outputChannel?.show(); }
    catch { /* The extension output channel may already be disposed. */ }
  }

  /**
   * Dispose the output channel
   */
  dispose(): void {
    this.outputChannel?.dispose();
    this.loggers.clear();
  }
}

/** Global extension logger manager */
export const extensionLoggerManager = new ExtensionLoggerManager();

/**
 * Get an extension logger with the given prefix
 */
export function getExtensionLogger(prefix: string): VsCodeLogger {
  return extensionLoggerManager.getLogger(prefix);
}

/**
 * Read log level from VS Code configuration
 */
export function getLogLevelFromConfig(): LogLevel {
  const config = vscode.workspace.getConfiguration('graph-it-live');
  const level = config.get<string>('logLevel', 'info');
  if (level && ['debug', 'info', 'warn', 'error', 'none'].includes(level)) {
    return level as LogLevel;
  }
  return 'info';
}

/**
 * Watch for configuration changes and update log level
 */
export function watchLogLevelConfig(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('graph-it-live.logLevel')) {
        const newLevel = getLogLevelFromConfig();
        extensionLoggerManager.setLevel(newLevel);
        extensionLoggerManager.getLogger('Extension').info('Log level changed to', newLevel);
      }
    })
  );
}
