/**
 * Shared module exports
 * 
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

// Path utilities
export { normalizePath, normalizePathForComparison, getRelativePath } from './path';

// Constants
export * from './constants';

// Logger
export { getLogger, loggerFactory, setLoggerBackend, getLogLevelFromEnv } from './logger';
export type { ILogger, LogLevel, LoggerBackend } from './logger';

// Types
export type * from './types';

// TOON (Token-Oriented Object Notation) format
export { jsonToToon, toonToJson, estimateTokenSavings } from './toon';
export type { ToonOptions } from './toon';
