/**
 * SymbolReverseIndex - O(1) lookup of symbol dependents
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 * Only Node.js built-in modules (fs, path) are permitted.
 *
 * This enables instant reverse lookups: "Who calls formatDate()?"
 * Instead of scanning all files at query time, we maintain a pre-computed index.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SymbolDependency, FileHash, normalizePath } from './types';

/**
 * Entry in the symbol reverse index
 */
export interface SymbolReverseEntry {
  /** The symbol that uses the target symbol (caller) */
  callerSymbolId: string;
  /** The file containing the caller */
  callerFilePath: string;
  /** Whether this is a type-only import (interface, type) */
  isTypeOnly: boolean;
  /** Line number where the usage occurs */
  line?: number;
}

/**
 * Statistics about the symbol reverse index
 */
export interface SymbolReverseIndexStats {
  /** Total number of unique target symbols indexed */
  targetSymbolCount: number;
  /** Total number of caller entries */
  totalCallerCount: number;
  /** Number of source files indexed */
  sourceFileCount: number;
  /** Timestamp of last update */
  lastUpdated: number;
}

/**
 * Serializable format for persisting the symbol reverse index
 */
export interface SerializedSymbolReverseIndex {
  version: number;
  timestamp: number;
  rootDir: string;
  /** Map of target symbol ID -> array of caller entries */
  reverseMap: Record<string, SymbolReverseEntry[]>;
  /** Map of file path -> file hash for staleness detection */
  fileHashes: Record<string, FileHash>;
}

/** Current version of the serialized index format */
const INDEX_VERSION = 1;

/**
 * SymbolReverseIndex maintains a mapping from target symbols to their callers.
 * This enables O(1) lookups for questions like:
 * - "Who calls this function?"
 * - "What uses this interface?"
 * - "What's the impact of changing this method signature?"
 */
export class SymbolReverseIndex {
  /**
   * Maps target symbol ID -> Map of caller symbol ID -> SymbolReverseEntry
   * Using nested Map for efficient updates when a source file changes
   */
  private readonly reverseMap: Map<string, Map<string, SymbolReverseEntry>> = new Map();

  /**
   * Maps file path -> file hash for staleness detection
   */
  private readonly fileHashes: Map<string, FileHash> = new Map();

  /**
   * Root directory of the workspace
   */
  private readonly rootDir: string;

  /**
   * Timestamp of last update
   */
  private lastUpdated: number = 0;

  constructor(rootDir: string) {
    this.rootDir = normalizePath(rootDir);
  }

  /**
   * Add symbol dependencies from a source file to the reverse index
   * @param sourceFilePath The file that contains the symbol usages
   * @param dependencies The symbol dependencies from that file
   * @param fileHash Optional hash for staleness tracking
   */
  addDependencies(
    sourceFilePath: string,
    dependencies: SymbolDependency[],
    fileHash?: FileHash
  ): void {
    const normalizedSourcePath = normalizePath(sourceFilePath);

    // First, remove all existing entries from this source file
    this.removeDependenciesFromSource(normalizedSourcePath);

    // Add new entries
    for (const dep of dependencies) {
      const entry: SymbolReverseEntry = {
        callerSymbolId: dep.sourceSymbolId,
        callerFilePath: normalizedSourcePath,
        isTypeOnly: dep.isTypeOnly ?? false,
      };

      let targetMap = this.reverseMap.get(dep.targetSymbolId);
      if (!targetMap) {
        targetMap = new Map();
        this.reverseMap.set(dep.targetSymbolId, targetMap);
      }
      targetMap.set(dep.sourceSymbolId, entry);
    }

    // Update file hash if provided
    if (fileHash) {
      this.fileHashes.set(normalizedSourcePath, fileHash);
    }

    this.lastUpdated = Date.now();
  }

  /**
   * Remove all dependencies originating from a source file
   * Call this when a file is deleted or before re-analyzing
   */
  removeDependenciesFromSource(sourceFilePath: string): void {
    const normalizedSourcePath = normalizePath(sourceFilePath);

    // Iterate all target symbols and remove entries from this source
    for (const [targetSymbolId, callerMap] of this.reverseMap) {
      // Find and remove entries where callerFilePath matches
      for (const [callerSymbolId, entry] of callerMap) {
        if (entry.callerFilePath === normalizedSourcePath) {
          callerMap.delete(callerSymbolId);
        }
      }

      // Clean up empty maps
      if (callerMap.size === 0) {
        this.reverseMap.delete(targetSymbolId);
      }
    }

    // Remove file hash
    this.fileHashes.delete(normalizedSourcePath);
    this.lastUpdated = Date.now();
  }

  /**
   * Get all callers of a specific symbol
   * @param targetSymbolId The symbol to find callers for (e.g., "src/utils.ts:formatDate")
   * @returns Array of caller entries, or empty array if none found
   */
  getCallers(targetSymbolId: string): SymbolReverseEntry[] {
    const callerMap = this.reverseMap.get(targetSymbolId);
    if (!callerMap) {
      return [];
    }
    return Array.from(callerMap.values());
  }

  /**
   * Get callers filtered by type (runtime only or all)
   * @param targetSymbolId The symbol to find callers for
   * @param includeTypeOnly Whether to include type-only imports
   */
  getCallersFiltered(targetSymbolId: string, includeTypeOnly: boolean = true): SymbolReverseEntry[] {
    const callers = this.getCallers(targetSymbolId);
    if (includeTypeOnly) {
      return callers;
    }
    return callers.filter(c => !c.isTypeOnly);
  }

  /**
   * Get runtime-only callers (excludes type imports)
   * Useful for impact analysis of runtime changes
   */
  getRuntimeCallers(targetSymbolId: string): SymbolReverseEntry[] {
    return this.getCallersFiltered(targetSymbolId, false);
  }

  /**
   * Get type-only callers
   * Useful for understanding type system impact
   */
  getTypeOnlyCallers(targetSymbolId: string): SymbolReverseEntry[] {
    return this.getCallers(targetSymbolId).filter(c => c.isTypeOnly);
  }

  /**
   * Check if a symbol has any callers
   */
  hasCallers(targetSymbolId: string): boolean {
    const callerMap = this.reverseMap.get(targetSymbolId);
    return callerMap !== undefined && callerMap.size > 0;
  }

  /**
   * Get the count of callers for a symbol
   */
  getCallerCount(targetSymbolId: string): number {
    const callerMap = this.reverseMap.get(targetSymbolId);
    return callerMap?.size ?? 0;
  }

  /**
   * Get all unique files that depend on a symbol
   */
  getCallerFiles(targetSymbolId: string): string[] {
    const callers = this.getCallers(targetSymbolId);
    const files = new Set<string>();
    for (const caller of callers) {
      files.add(caller.callerFilePath);
    }
    return Array.from(files);
  }

  /**
   * Get statistics about the index
   */
  getStats(): SymbolReverseIndexStats {
    let totalCallerCount = 0;
    for (const callerMap of this.reverseMap.values()) {
      totalCallerCount += callerMap.size;
    }

    return {
      targetSymbolCount: this.reverseMap.size,
      totalCallerCount,
      sourceFileCount: this.fileHashes.size,
      lastUpdated: this.lastUpdated,
    };
  }

  /**
   * Check if a file is stale (needs re-indexing)
   */
  isFileStale(filePath: string, currentHash: FileHash): boolean {
    const normalizedPath = normalizePath(filePath);
    const storedHash = this.fileHashes.get(normalizedPath);

    if (!storedHash) {
      return true; // Never indexed
    }

    return storedHash.mtime !== currentHash.mtime || storedHash.size !== currentHash.size;
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.reverseMap.clear();
    this.fileHashes.clear();
    this.lastUpdated = Date.now();
  }

  /**
   * Serialize the index to JSON for persistence
   */
  serialize(): SerializedSymbolReverseIndex {
    const reverseMap: Record<string, SymbolReverseEntry[]> = {};

    for (const [targetSymbolId, callerMap] of this.reverseMap) {
      reverseMap[targetSymbolId] = Array.from(callerMap.values());
    }

    const fileHashes: Record<string, FileHash> = {};
    for (const [filePath, hash] of this.fileHashes) {
      fileHashes[filePath] = hash;
    }

    return {
      version: INDEX_VERSION,
      timestamp: Date.now(),
      rootDir: this.rootDir,
      reverseMap,
      fileHashes,
    };
  }

  /**
   * Deserialize and load index from persisted data
   */
  deserialize(data: SerializedSymbolReverseIndex): boolean {
    // Version check
    if (data.version !== INDEX_VERSION) {
      return false;
    }

    // Root directory check
    if (normalizePath(data.rootDir) !== this.rootDir) {
      return false;
    }

    // Clear existing data
    this.clear();

    // Load reverse map
    for (const [targetSymbolId, entries] of Object.entries(data.reverseMap)) {
      const callerMap = new Map<string, SymbolReverseEntry>();
      for (const entry of entries) {
        callerMap.set(entry.callerSymbolId, entry);
      }
      this.reverseMap.set(targetSymbolId, callerMap);
    }

    // Load file hashes
    for (const [filePath, hash] of Object.entries(data.fileHashes)) {
      this.fileHashes.set(filePath, hash);
    }

    this.lastUpdated = data.timestamp;
    return true;
  }

  /**
   * Save index to a file
   */
  async saveToFile(filePath: string): Promise<void> {
    const data = this.serialize();
    const json = JSON.stringify(data, null, 2);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, json, 'utf-8');
  }

  /**
   * Load index from a file
   */
  async loadFromFile(filePath: string): Promise<boolean> {
    try {
      const json = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(json) as SerializedSymbolReverseIndex;
      return this.deserialize(data);
    } catch {
      return false;
    }
  }
}
