import * as fs from 'node:fs/promises';
import {
  ReverseIndexEntry,
  FileHash,
  SerializedReverseIndex,
  Dependency,
  normalizePath,
} from './types';
import { getLogger } from '../shared/logger';

/** Logger instance for ReverseIndex */
const log = getLogger('ReverseIndex');

/**
 * Current version of the serialized index format
 * Increment when making breaking changes to the format
 */
const INDEX_VERSION = 1;

/**
 * ReverseIndex - Maintains a mapping from target files to their referencing files
 * 
 * This enables O(1) reverse dependency lookups instead of O(n) full workspace scans.
 * 
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 * Only Node.js built-in modules (fs, path) are permitted.
 */
export class ReverseIndex {
  /**
   * Maps target file path -> Map of source file path -> ReverseIndexEntry
   * Using nested Map for efficient updates when a source file changes
   */
  private readonly reverseMap: Map<string, Map<string, ReverseIndexEntry>> = new Map();

  /**
   * Maps file path -> FileHash for staleness detection
   */
  private readonly fileHashes: Map<string, FileHash> = new Map();

  /**
   * Root directory of the workspace (used for validation on deserialize)
   */
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = normalizePath(rootDir);
  }

  /**
   * Add dependencies from a source file to the reverse index
   * @param sourcePath The file that contains the imports
   * @param dependencies The resolved dependencies from that file
   * @param fileHash Optional hash for staleness tracking
   */
  addDependencies(
    sourcePath: string,
    dependencies: Dependency[],
    fileHash?: FileHash
  ): void {
    // Normalize paths for cross-platform consistency
    const normalizedSourcePath = normalizePath(sourcePath);
    
    // First, remove all existing entries from this source file
    // This handles the case where imports were removed
    this.removeDependenciesFromSource(normalizedSourcePath);

    // Add new entries
    for (const dep of dependencies) {
      const normalizedTargetPath = normalizePath(dep.path);
      
      const entry: ReverseIndexEntry = {
        sourcePath: normalizedSourcePath,
        type: dep.type,
        line: dep.line,
        module: dep.module,
      };

      let targetMap = this.reverseMap.get(normalizedTargetPath);
      if (!targetMap) {
        targetMap = new Map();
        this.reverseMap.set(normalizedTargetPath, targetMap);
      }
      targetMap.set(normalizedSourcePath, entry);
    }

    // Update file hash if provided
    if (fileHash) {
      this.fileHashes.set(normalizedSourcePath, fileHash);
    }
  }

  /**
   * Remove all dependencies originating from a source file
   * Call this when a file is deleted or before re-analyzing
   * 
   * NOTE: Empty maps are NOT cleaned up here to avoid race conditions during re-analysis.
   * Use cleanup() or rely on lazy cleanup in getReferencingFiles() instead.
   */
  removeDependenciesFromSource(sourcePath: string): void {
    const normalizedSourcePath = normalizePath(sourcePath);
    
    // Iterate through all target files and remove entries from this source
    for (const [, sourceMap] of this.reverseMap) {
      sourceMap.delete(normalizedSourcePath);
      // NOTE: Do NOT delete empty maps here - they will be cleaned up lazily
      // This prevents losing references when addDependencies() is called immediately after
    }
    this.fileHashes.delete(normalizedSourcePath);
  }

  /**
   * Get all files that reference the given target file
   * This is the O(1) lookup that replaces the expensive directory scan
   * @param targetPath The file to find references for
   * @returns Array of dependencies pointing to the target
   */
  getReferencingFiles(targetPath: string): Dependency[] {
    const normalizedTargetPath = normalizePath(targetPath);
    const sourceMap = this.reverseMap.get(normalizedTargetPath);
    
    // Lazy cleanup: remove empty maps when accessed
    if (sourceMap?.size === 0) {
      this.reverseMap.delete(normalizedTargetPath);
      return [];
    }
    
    if (!sourceMap) {
      return [];
    }

    return Array.from(sourceMap.values()).map((entry) => ({
      path: entry.sourcePath,
      type: entry.type,
      line: entry.line,
      module: entry.module,
    }));
  }

  /**
   * Check if a file's hash indicates it has changed since last indexing
   * @param filePath The file to check
   * @param currentHash The current file hash
   * @returns true if the file is stale (changed), false if unchanged
   */
  isFileStale(filePath: string, currentHash: FileHash): boolean {
    const normalizedPath = normalizePath(filePath);
    const storedHash = this.fileHashes.get(normalizedPath);
    if (!storedHash) {
      return true; // Not indexed yet = stale
    }
    return storedHash.mtime !== currentHash.mtime || storedHash.size !== currentHash.size;
  }

  /**
   * Get the stored hash for a file
   */
  getFileHash(filePath: string): FileHash | undefined {
    return this.fileHashes.get(normalizePath(filePath));
  }

  /**
   * Update the hash for a file without changing its dependencies
   */
  updateFileHash(filePath: string, fileHash: FileHash): void {
    this.fileHashes.set(normalizePath(filePath), fileHash);
  }

  /**
   * Check if the index has any entries (useful for determining if fallback is needed)
   */
  hasEntries(): boolean {
    return this.reverseMap.size > 0;
  }

  /**
   * Check if a specific file has been indexed
   */
  hasFile(filePath: string): boolean {
    return this.fileHashes.has(normalizePath(filePath));
  }

  /**
   * Get the number of indexed source files
   */
  get indexedFileCount(): number {
    return this.fileHashes.size;
  }

  /**
   * Get the number of target files with references
   */
  get targetFileCount(): number {
    return this.reverseMap.size;
  }

  /**
   * Clear all index data
   */
  clear(): void {
    this.reverseMap.clear();
    this.fileHashes.clear();
  }

  /**
   * Clean up empty maps in the reverse index
   * This removes target paths that have no references left
   * @returns Number of empty maps removed
   */
  cleanup(): number {
    let cleanedCount = 0;
    const emptyTargets: string[] = [];
    
    for (const [targetPath, sourceMap] of this.reverseMap) {
      if (sourceMap.size === 0) {
        emptyTargets.push(targetPath);
      }
    }
    
    for (const targetPath of emptyTargets) {
      this.reverseMap.delete(targetPath);
      cleanedCount++;
    }
    
    return cleanedCount;
  }

  /**
   * Get a file's hash from the filesystem
   * Uses mtime + size for fast staleness detection without reading content
   */
  static async getFileHashFromDisk(filePath: string): Promise<FileHash | null> {
    try {
      const stats = await fs.stat(filePath);
      return {
        mtime: stats.mtimeMs,
        size: stats.size,
      };
    } catch {
      return null; // File doesn't exist or can't be read
    }
  }

  /**
   * Serialize the index for persistence
   * @returns JSON-serializable object
   */
  serialize(): SerializedReverseIndex {
    const reverseMapObj: Record<string, ReverseIndexEntry[]> = {};
    for (const [targetPath, sourceMap] of this.reverseMap) {
      reverseMapObj[targetPath] = Array.from(sourceMap.values());
    }

    const fileHashesObj: Record<string, FileHash> = {};
    for (const [filePath, hash] of this.fileHashes) {
      fileHashesObj[filePath] = hash;
    }

    return {
      version: INDEX_VERSION,
      timestamp: Date.now(),
      rootDir: this.rootDir,
      reverseMap: reverseMapObj,
      fileHashes: fileHashesObj,
    };
  }

  /**
   * Deserialize and validate a persisted index
   * @param data The serialized index data
   * @param rootDir The current workspace root (must match)
   * @returns A new ReverseIndex instance, or null if validation fails
   */
  static deserialize(
    data: SerializedReverseIndex,
    rootDir: string
  ): ReverseIndex | null {
    const normalizedRootDir = normalizePath(rootDir);
    const normalizedDataRootDir = normalizePath(data.rootDir);
    
    // Validate version
    if (data.version !== INDEX_VERSION) {
      log.warn('Version mismatch:', data.version, '!==', INDEX_VERSION);
      return null;
    }

    // Validate rootDir matches (using normalized paths)
    if (normalizedDataRootDir !== normalizedRootDir) {
      log.warn('Root dir mismatch:', data.rootDir, '!==', rootDir);
      return null;
    }

    const index = new ReverseIndex(rootDir);

    // Restore file hashes (paths are already normalized in serialized data)
    for (const [filePath, hash] of Object.entries(data.fileHashes)) {
      index.fileHashes.set(normalizePath(filePath), hash);
    }

    // Restore reverse map (paths are already normalized in serialized data)
    for (const [targetPath, entries] of Object.entries(data.reverseMap)) {
      const normalizedTargetPath = normalizePath(targetPath);
      const sourceMap = new Map<string, ReverseIndexEntry>();
      for (const entry of entries) {
        const normalizedSourcePath = normalizePath(entry.sourcePath);
        sourceMap.set(normalizedSourcePath, {
          ...entry,
          sourcePath: normalizedSourcePath,
        });
      }
      index.reverseMap.set(normalizedTargetPath, sourceMap);
    }

    return index;
  }

  /**
   * Validate the index by checking if files are stale
   * @param staleThreshold Percentage of stale files (0-1) above which to reject
   * @returns Object with validation results
   */
  async validateIndex(staleThreshold: number = 0.2): Promise<{
    isValid: boolean;
    staleFiles: string[];
    stalePercentage: number;
    missingFiles: string[];
  }> {
    const staleFiles: string[] = [];
    const missingFiles: string[] = [];

    for (const filePath of this.fileHashes.keys()) {
      const currentHash = await ReverseIndex.getFileHashFromDisk(filePath);
      
      if (!currentHash) {
        missingFiles.push(filePath);
        continue;
      }

      if (this.isFileStale(filePath, currentHash)) {
        staleFiles.push(filePath);
      }
    }

    const totalFiles = this.fileHashes.size;
    const staleCount = staleFiles.length + missingFiles.length;
    const stalePercentage = totalFiles > 0 ? staleCount / totalFiles : 0;

    return {
      isValid: stalePercentage <= staleThreshold,
      staleFiles,
      stalePercentage,
      missingFiles,
    };
  }

  /**
   * Get statistics about the index
   */
  getStats(): {
    indexedFiles: number;
    targetFiles: number;
    totalReferences: number;
  } {
    let totalReferences = 0;
    for (const sourceMap of this.reverseMap.values()) {
      totalReferences += sourceMap.size;
    }

    return {
      indexedFiles: this.fileHashes.size,
      targetFiles: this.reverseMap.size,
      totalReferences,
    };
  }
}
