/**
 * Normalize a file path to use forward slashes consistently across all platforms.
 * This ensures Windows paths (C:\foo\bar) work the same as Unix paths (/foo/bar).
 * Should be used whenever comparing, storing, or displaying paths.
 */
export function normalizePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

export interface Dependency {
  path: string;
  type: 'import' | 'require' | 'export' | 'dynamic';
  line: number;
  module: string; // Original module specifier
}

export interface SpiderConfig {
  rootDir: string;
  tsConfigPath?: string;
  maxDepth?: number;
  excludeNodeModules?: boolean;
  /** Enable reverse index for O(1) reverse dependency lookups */
  enableReverseIndex?: boolean;
  /** Number of files to process in parallel during indexing */
  indexingConcurrency?: number;
}

export interface ParsedImport {
  module: string;
  type: 'import' | 'require' | 'export' | 'dynamic';
  line: number;
}

/**
 * Entry in the reverse index mapping a target file to its referencing files
 */
export interface ReverseIndexEntry {
  /** The source file that imports the target */
  sourcePath: string;
  /** Type of import */
  type: 'import' | 'require' | 'export' | 'dynamic';
  /** Line number of the import statement */
  line: number;
  /** Original module specifier */
  module: string;
}

/**
 * File hash for staleness detection (uses mtime + size for performance)
 */
export interface FileHash {
  /** File modification time in milliseconds */
  mtime: number;
  /** File size in bytes */
  size: number;
}

/**
 * State of the indexing process
 * @deprecated Use IndexerState from IndexerStatus.ts instead
 */
export type IndexingState = 'idle' | 'indexing' | 'complete' | 'error';

// Re-export IndexerStatus types for convenience
export type { IndexerState, IndexerStatusSnapshot, IndexerStatusCallback } from './IndexerStatus';

/**
 * Progress callback for indexing operations
 */
export type IndexingProgressCallback = (
  processed: number,
  total: number,
  currentFile?: string
) => void;

/**
 * Serializable format for persisting the reverse index
 */
export interface SerializedReverseIndex {
  version: number;
  timestamp: number;
  rootDir: string;
  /** Map of target path -> array of referencing entries */
  reverseMap: Record<string, ReverseIndexEntry[]>;
  /** Map of file path -> file hash */
  fileHashes: Record<string, FileHash>;
}

export interface SymbolInfo {
  name: string;
  kind: string; // 'Function', 'Class', 'Interface', 'Variable', etc.
  line: number;
  isExported: boolean;
  id: string; // Unique ID: filePath:name
  parentSymbolId?: string; // Parent class/namespace ID (for methods/properties)
  category: 'function' | 'class' | 'variable' | 'interface' | 'type' | 'other';
}

export interface SymbolDependency {
  sourceSymbolId: string; // The symbol using the dependency (or 'file' if top-level)
  targetSymbolId: string; // The symbol being used
  targetFilePath: string;
  /** Whether this is a type-only import (interface, type alias) vs runtime code */
  isTypeOnly?: boolean;
}
