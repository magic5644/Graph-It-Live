import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { normalizePath } from '../../shared/path';
import { getExtensionLogger } from '../extensionLogger';

const log = getExtensionLogger('UnusedAnalysisCache');

/**
 * Persistent cache for unused dependency analysis results.
 * 
 * Cache structure:
 * {
 *   [sourceFilePath]: {
 *     results: { [targetFilePath]: boolean },
 *     timestamp: number,
 *     mtime: number
 *   }
 * }
 * 
 * Invalidation strategy:
 * - File modified (mtime changed)
 * - Cache older than 24 hours
 * - Manual invalidation via file watcher
 */
export class UnusedAnalysisCache {
  private readonly cache = new Map<string, { results: Map<string, boolean>; timestamp: number; mtime: number }>();
  private readonly cacheFilePath: string;
  private isDirty = false;
  private saveTimer?: NodeJS.Timeout;
  private readonly CACHE_VERSION = 1;
  private readonly MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor(
    context: vscode.ExtensionContext,
    private readonly enabled: boolean
  ) {
    this.cacheFilePath = path.join(
      context.globalStorageUri.fsPath,
      'unused-analysis-cache.json'
    );
    
    if (this.enabled) {
      this._initializeCache();
    }
  }

  private _initializeCache(): void {
    void this.loadFromDisk();
  }

  /**
   * Get cached results for a source file's targets
   */
  async get(sourceFile: string, targetFiles: string[]): Promise<Map<string, boolean> | null> {
    if (!this.enabled) {
      return null;
    }

    const normalizedSource = normalizePath(sourceFile);
    const cached = this.cache.get(normalizedSource);
    
    if (!cached) {
      return null;
    }

    // Check if cache is stale (file modified or cache expired)
    try {
      const stats = await fs.stat(sourceFile);
      const currentMtime = stats.mtimeMs;
      
      if (currentMtime !== cached.mtime) {
        log.debug(`Cache miss for ${sourceFile}: file modified`);
        this.cache.delete(normalizedSource);
        this.isDirty = true;
        return null;
      }

      // Check age
      const age = Date.now() - cached.timestamp;
      if (age > this.MAX_CACHE_AGE_MS) {
        log.debug(`Cache miss for ${sourceFile}: expired (${Math.round(age / 3600000)}h old)`);
        this.cache.delete(normalizedSource);
        this.isDirty = true;
        return null;
      }

      // Check if all requested targets are in cache
      const hasAll = targetFiles.every(t => cached.results.has(normalizePath(t)));
      if (!hasAll) {
        log.debug(`Cache partial hit for ${sourceFile}: missing some targets`);
        return null; // Partial cache not supported yet
      }

      log.debug(`Cache hit for ${sourceFile} with ${targetFiles.length} targets`);
      return cached.results;
    } catch (error) {
      log.warn(`Failed to stat ${sourceFile}:`, error);
      return null;
    }
  }

  /**
   * Store analysis results for a source file
   */
  async set(sourceFile: string, results: Map<string, boolean>): Promise<void> {
    if (!this.enabled) {
      return;
    }

    try {
      const stats = await fs.stat(sourceFile);
      const normalizedSource = normalizePath(sourceFile);
      
      this.cache.set(normalizedSource, {
        results,
        timestamp: Date.now(),
        mtime: stats.mtimeMs,
      });

      this.isDirty = true;
      this.scheduleSave();
    } catch (error) {
      log.warn(`Failed to cache results for ${sourceFile}:`, error);
    }
  }

  /**
   * Invalidate cache for specific files (called by file watcher)
   */
  invalidate(filePaths: string[]): void {
    if (!this.enabled) {
      return;
    }

    let invalidated = 0;
    for (const filePath of filePaths) {
      const normalized = normalizePath(filePath);
      if (this.cache.delete(normalized)) {
        invalidated++;
      }
    }

    if (invalidated > 0) {
      log.debug(`Invalidated ${invalidated} cache entries`);
      this.isDirty = true;
      this.scheduleSave();
    }
  }

  /**
   * Clear entire cache
   */
  clear(): void {
    this.cache.clear();
    this.isDirty = true;
    this.scheduleSave();
  }

  /**
   * Get cache statistics
   */
  getStats(): { entries: number; totalTargets: number; oldestEntry: number | null } {
    let totalTargets = 0;
    let oldestTimestamp: number | null = null;

    for (const entry of this.cache.values()) {
      totalTargets += entry.results.size;
      if (oldestTimestamp === null || entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
      }
    }

    return {
      entries: this.cache.size,
      totalTargets,
      oldestEntry: oldestTimestamp ? Date.now() - oldestTimestamp : null,
    };
  }

  /**
   * Load cache from disk on startup
   */
  private async loadFromDisk(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.cacheFilePath), { recursive: true });
      const content = await fs.readFile(this.cacheFilePath, 'utf-8');
      const data = JSON.parse(content);

      if (data.version !== this.CACHE_VERSION) {
        log.info('Cache version mismatch, clearing cache');
        return;
      }

      // Deserialize Map structures
      for (const [key, value] of Object.entries(data.entries)) {
        const entry = value as { results: Record<string, boolean>; timestamp: number; mtime: number };
        this.cache.set(key, {
          results: new Map(Object.entries(entry.results)),
          timestamp: entry.timestamp,
          mtime: entry.mtime,
        });
      }

      const stats = this.getStats();
      log.info(`Loaded cache from disk: ${stats.entries} sources, ${stats.totalTargets} targets`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('Failed to load cache from disk:', error);
      }
    }
  }

  /**
   * Save cache to disk (debounced)
   */
  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      void this.saveToDisk();
    }, 5000); // Debounce 5 seconds
  }

  /**
   * Immediately save cache to disk
   */
  private async saveToDisk(): Promise<void> {
    if (!this.isDirty) {
      return;
    }

    try {
      await fs.mkdir(path.dirname(this.cacheFilePath), { recursive: true });

      // Serialize Map structures to plain objects
      const entries: Record<string, { results: Record<string, boolean>; timestamp: number; mtime: number }> = {};
      for (const [key, value] of this.cache.entries()) {
        entries[key] = {
          results: Object.fromEntries(value.results),
          timestamp: value.timestamp,
          mtime: value.mtime,
        };
      }

      const data = {
        version: this.CACHE_VERSION,
        entries,
      };

      await fs.writeFile(this.cacheFilePath, JSON.stringify(data), 'utf-8');
      this.isDirty = false;

      const stats = this.getStats();
      log.debug(`Saved cache to disk: ${stats.entries} sources, ${stats.totalTargets} targets`);
    } catch (error) {
      log.error('Failed to save cache to disk:', error);
    }
  }

  /**
   * Flush cache to disk immediately (called on extension deactivation)
   */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    await this.saveToDisk();
  }
}
