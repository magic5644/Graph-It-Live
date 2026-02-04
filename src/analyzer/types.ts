export { normalizePath, normalizePathForComparison } from "../shared/path";

/**
 * Error codes for Spider analysis errors
 */
export enum SpiderErrorCode {
  /** File not found or unreadable */
  FILE_NOT_FOUND = "FILE_NOT_FOUND",
  /** File read permission denied */
  PERMISSION_DENIED = "PERMISSION_DENIED",
  /** File is too large to process */
  FILE_TOO_LARGE = "FILE_TOO_LARGE",
  /** Parse error in file content */
  PARSE_ERROR = "PARSE_ERROR",
  /** Module resolution failed */
  RESOLUTION_FAILED = "RESOLUTION_FAILED",
  /** Operation timeout */
  TIMEOUT = "TIMEOUT",
  /** Circular dependency detected */
  CIRCULAR_DEPENDENCY = "CIRCULAR_DEPENDENCY",
  /** Unknown or unclassified error */
  UNKNOWN = "UNKNOWN",
}

/**
 * Custom error class for Spider analysis errors with structured metadata
 */
export class SpiderError extends Error {
  readonly code: SpiderErrorCode;
  readonly filePath?: string;
  readonly cause?: Error;
  readonly timestamp: number;

  constructor(
    message: string,
    code: SpiderErrorCode,
    options?: {
      filePath?: string;
      cause?: Error;
    },
  ) {
    super(message);
    this.name = "SpiderError";
    this.code = code;
    this.filePath = options?.filePath;
    this.cause = options?.cause;
    this.timestamp = Date.now();

    // Maintains proper stack trace for where error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SpiderError);
    }
  }

  /**
   * Create a SpiderError from a native Error, classifying the error code
   */
  static fromError(error: unknown, filePath?: string): SpiderError {
    if (error instanceof SpiderError) {
      return error;
    }

    const cause = error instanceof Error ? error : undefined;
    const message = cause?.message || String(error);

    // Classify error based on message/code
    let code = SpiderErrorCode.UNKNOWN;
    if (cause) {
      const errCode = (cause as NodeJS.ErrnoException).code;
      if (errCode === "ENOENT") {
        code = SpiderErrorCode.FILE_NOT_FOUND;
      } else if (errCode === "EACCES" || errCode === "EPERM") {
        code = SpiderErrorCode.PERMISSION_DENIED;
      } else if (message.includes("too large") || errCode === "EFBIG") {
        code = SpiderErrorCode.FILE_TOO_LARGE;
      } else if (message.includes("parse") || message.includes("syntax")) {
        code = SpiderErrorCode.PARSE_ERROR;
      } else if (message.includes("timeout") || errCode === "ETIMEDOUT") {
        code = SpiderErrorCode.TIMEOUT;
      }
    }

    return new SpiderError(message, code, { filePath, cause });
  }

  /**
   * Check if error is recoverable (can continue processing other files)
   */
  isRecoverable(): boolean {
    return [
      SpiderErrorCode.FILE_NOT_FOUND,
      SpiderErrorCode.PERMISSION_DENIED,
      SpiderErrorCode.PARSE_ERROR,
      SpiderErrorCode.RESOLUTION_FAILED,
    ].includes(this.code);
  }

  /**
   * Get a user-friendly error message
   */
  toUserMessage(): string {
    switch (this.code) {
      case SpiderErrorCode.FILE_NOT_FOUND:
        return `File not found: ${this.filePath || "unknown"}`;
      case SpiderErrorCode.PERMISSION_DENIED:
        return `Permission denied: ${this.filePath || "unknown"}`;
      case SpiderErrorCode.FILE_TOO_LARGE:
        return `File too large to process: ${this.filePath || "unknown"}`;
      case SpiderErrorCode.PARSE_ERROR:
        return `Failed to parse: ${this.filePath || "unknown"}`;
      case SpiderErrorCode.RESOLUTION_FAILED:
        return `Could not resolve module in: ${this.filePath || "unknown"}`;
      case SpiderErrorCode.TIMEOUT:
        return `Operation timed out`;
      case SpiderErrorCode.CIRCULAR_DEPENDENCY:
        return `Circular dependency detected`;
      default:
        return this.message;
    }
  }

  /**
   * Serialize error for logging/transport
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      filePath: this.filePath,
      timestamp: this.timestamp,
      stack: this.stack,
    };
  }
}

/**
 * Type of import/dependency statement
 */
export type DependencyType = "import" | "require" | "export" | "dynamic";

export interface Dependency {
  path: string;
  type: DependencyType;
  line: number;
  module: string; // Original module specifier
}

export interface SpiderConfig {
  rootDir: string;
  tsConfigPath?: string;
  maxDepth?: number;
  excludeNodeModules?: boolean;
  /** Interval for worker progress reporting (defaults to 100 files) */
  indexingProgressInterval?: number;
  /** Enable reverse index for O(1) reverse dependency lookups */
  enableReverseIndex?: boolean;
  /** Number of files to process in parallel during indexing */
  indexingConcurrency?: number;
  /** Maximum cache size for dependency results (0 = unlimited) */
  maxCacheSize?: number;
  /** Maximum cache size for symbol analysis results (0 = unlimited) */
  maxSymbolCacheSize?: number;
  /** Maximum files to keep in SymbolAnalyzer memory (default: 100) */
  maxSymbolAnalyzerFiles?: number;
}

export interface ParsedImport {
  module: string;
  type: DependencyType;
  line: number;
}

/**
 * Entry in the reverse index mapping a target file to its referencing files
 */
export interface ReverseIndexEntry {
  /** The source file that imports the target */
  sourcePath: string;
  /** Type of import */
  type: DependencyType;
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

// Re-export IndexerStatus types for convenience
export type {
  IndexerState,
  IndexerStatusCallback,
  IndexerStatusSnapshot,
} from "./IndexerStatus";

/**
 * Progress callback for indexing operations
 */
export type IndexingProgressCallback = (
  processed: number,
  total: number,
  currentFile?: string,
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
  category: "function" | "class" | "variable" | "interface" | "type" | "other";
}

export interface SymbolDependency {
  sourceSymbolId: string; // The symbol using the dependency (or 'file' if top-level)
  targetSymbolId: string; // The symbol being used
  targetFilePath: string;
  /** Whether this is a type-only import (interface, type alias) vs runtime code */
  isTypeOnly?: boolean;
}

/**
 * Language-agnostic analyzer interface for parsing imports and resolving paths.
 * Each language (TypeScript, Python, Rust) implements this interface.
 */
export interface ILanguageAnalyzer {
  /**
   * Parse imports/dependencies from a file.
   * @param filePath Absolute path to the file to parse
   * @returns Array of dependencies found in the file
   */
  parseImports(filePath: string): Promise<Dependency[]>;

  /**
   * Resolve a module specifier to an absolute file path.
   * @param fromFile The file containing the import
   * @param moduleSpecifier The import path (e.g., './utils', '@/components', 'lodash')
   * @returns Resolved absolute path or null if cannot resolve
   */
  resolvePath(
    fromFile: string,
    moduleSpecifier: string,
  ): Promise<string | null>;
}

/**
 * Language-agnostic symbol analyzer interface for extracting symbols and dependencies.
 * Provides AST-level analysis for function/class/method dependencies.
 */
export interface ISymbolAnalyzer {
  /**
   * Analyze a file and extract symbols with their dependencies.
   * @param filePath Absolute path to the file to analyze
   * @returns Map of symbol IDs to symbol information
   */
  analyzeFile(filePath: string): Promise<Map<string, SymbolInfo>>;

  /**
   * Get symbol-level dependencies for a file.
   * @param filePath Absolute path to the file
   * @returns Array of symbol dependencies
   */
  getSymbolDependencies(filePath: string): Promise<SymbolDependency[]>;
}
