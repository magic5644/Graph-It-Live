import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { normalizePath } from '../../shared/path';
import { getExtensionLogger } from '../extensionLogger';

const log = getExtensionLogger('UnusedAnalysisCache');

interface CacheEntry {
  results: Map<string, boolean>;
  timestamp: number;
  mtime: number;
  lastAccess: number; // For LRU eviction
}

/**
 * Persistent cache for unused dependency analysis results with LRU eviction.
 * 
 * Cache structure:
 * {
 *   [sourceFilePath]: {
 *     results: { [targetFilePath]: boolean },
 *     timestamp: number,
 *     mtime: number,
 *     lastAccess: number
 *   }
 * }
 * 
 * Eviction strategy:
 * - LRU (Least Recently Used) when maxEntries exceeded
 * - File modified (mtime changed)
 * - Cache older than 24 hours
 * - Manual invalidation via file watcher
 */
export class UnusedAnalysisCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheFilePath: string;
  private isDirty = false;
  private saveTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private readonly CACHE_VERSION = 2; // Bumped for lastAccess field
  private readonly MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
  private readonly MAX_ENTRIES: number;
  private hitCount = 0;
  private missCount = 0; // True cache misses (stale/expired/partial, excluding notFound)
  private missNotFoundCount = 0; // Cache entry doesn't exist (not counted in hit rate)
  private missStaleCount = 0; // File modified
  private missExpiredCount = 0; // Age > MAX_CACHE_AGE_MS
  private missPartialCount = 0; // Missing some targets
  private missErrorCount = 0; // Stat error
  private evictionCount = 0;

  constructor(
    context: vscode.ExtensionContext,
    private readonly enabled: boolean,
    maxEntries: number = 200 // Default to 200 source files
  ) {
    this.cacheFilePath = path.join(
      context.globalStorageUri.fsPath,
      'unused-analysis-cache.json'
    );
    this.MAX_ENTRIES = Math.max(10, maxEntries); // At least 10 entries
    
    if (this.enabled) {
      this._initializeCache();
      this._startPeriodicCleanup();
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
      this.missNotFoundCount++;
      // Don't increment missCount for notFound - not a true cache miss
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
        this.missStaleCount++;
        this.missCount++; // True miss - was cached but stale
        return null;
      }

      // Check age
      const age = Date.now() - cached.timestamp;
      if (age > this.MAX_CACHE_AGE_MS) {
        log.debug(`Cache miss for ${sourceFile}: expired (${Math.round(age / 3600000)}h old)`);
        this.cache.delete(normalizedSource);
        this.isDirty = true;
        this.missExpiredCount++;
        this.missCount++; // True miss - was cached but expired
        return null;
      }

      // Check if all requested targets are in cache
      const hasAll = targetFiles.every(t => cached.results.has(normalizePath(t)));
      if (!hasAll) {
        log.debug(`Cache partial hit for ${sourceFile}: missing some targets`);
        this.missPartialCount++;
        this.missCount++; // True miss - was cached but incomplete
        return null; // Partial cache not supported yet
      }

      // Update last access time for LRU
      cached.lastAccess = Date.now();
      this.hitCount++;
      
      log.debug(`Cache hit for ${sourceFile} with ${targetFiles.length} targets`);
      return cached.results;
    } catch (error) {
      log.warn(`Failed to stat ${sourceFile}:`, error);
      this.missErrorCount++;
      this.missCount++; // True miss - lookup failed
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
      const now = Date.now();
      
      this.cache.set(normalizedSource, {
        results,
        timestamp: now,
        mtime: stats.mtimeMs,
        lastAccess: now,
      });

      // Evict if over limit
      this._evictIfNeeded();

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
   * Evict least recently used entries if cache exceeds max size
   */
  private _evictIfNeeded(): void {
    if (this.cache.size <= this.MAX_ENTRIES) {
      return;
    }

    const excessCount = this.cache.size - this.MAX_ENTRIES;
    
    // Sort entries by lastAccess (oldest first)
    const sortedEntries = Array.from(this.cache.entries())
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    log.debug(
      'Cache evict candidates',
      sortedEntries.slice(0, excessCount).map(([key, entry]) => ({ key, lastAccess: entry.lastAccess }))
    );
    
    // Remove oldest entries
    for (let i = 0; i < excessCount; i++) {
      const [key] = sortedEntries[i];
      this.cache.delete(key);
      this.evictionCount++;
    }

    log.debug(`Evicted ${excessCount} LRU entries (limit: ${this.MAX_ENTRIES})`);
    this.isDirty = true;
  }

  /**
   * Proactively clean up expired entries
   */
  private _cleanupExpiredEntries(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.cache.entries()) {
      const age = now - entry.timestamp;
      if (age > this.MAX_CACHE_AGE_MS) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      log.debug(`Cleaned up ${cleaned} expired entries`);
      this.isDirty = true;
      this.scheduleSave();
    }
  }

  /**
   * Start periodic cleanup of expired entries (every 30 minutes)
   */
  private _startPeriodicCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this._cleanupExpiredEntries();
    }, 30 * 60 * 1000); // 30 minutes
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    entries: number;
    maxEntries: number;
    totalTargets: number;
    oldestEntry: number | null;
    hitRate: number;
    effectiveHitRate: number; // Excludes notFound from denominator
    evictions: number;
    hits: number;
    misses: number;
    notFound: number; // Separate from true misses
    totalLookups: number; // hits + misses + notFound
    missBreakdown: {
      notFound: number;
      stale: number;
      expired: number;
      partial: number;
      error: number;
    };
  } {
    let totalTargets = 0;
    let oldestTimestamp: number | null = null;

    for (const entry of this.cache.values()) {
      totalTargets += entry.results.size;
      if (oldestTimestamp === null || entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
      }
    }

    // Effective hit rate excludes notFound (never cached) from denominator
    const cacheLookups = this.hitCount + this.missCount; // Only cached entries
    const effectiveHitRate = cacheLookups > 0 ? this.hitCount / cacheLookups : 0;
    
    const totalLookups = this.hitCount + this.missCount + this.missNotFoundCount;

    return {
      entries: this.cache.size,
      maxEntries: this.MAX_ENTRIES,
      totalTargets,
      oldestEntry: oldestTimestamp ? Date.now() - oldestTimestamp : null,
      hitRate: Math.round(effectiveHitRate * 100) / 100, // Same as effectiveHitRate (true cached hit rate)
      effectiveHitRate: Math.round(effectiveHitRate * 100) / 100, // Better metric (excludes notFound)
      evictions: this.evictionCount,
      hits: this.hitCount,
      misses: this.missCount,
      notFound: this.missNotFoundCount,
      totalLookups,
      missBreakdown: {
        notFound: this.missNotFoundCount,
        stale: this.missStaleCount,
        expired: this.missExpiredCount,
        partial: this.missPartialCount,
        error: this.missErrorCount,
      },
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
      const now = Date.now();
      for (const [key, value] of Object.entries(data.entries)) {
        const entry = value as { results: Record<string, boolean>; timestamp: number; mtime: number; lastAccess?: number };
        this.cache.set(key, {
          results: new Map(Object.entries(entry.results)),
          timestamp: entry.timestamp,
          mtime: entry.mtime,
          lastAccess: entry.lastAccess ?? now, // Fallback for old cache version
        });
      }

      // Evict if loaded cache exceeds limit
      this._evictIfNeeded();

      const stats = this.getStats();
      log.info(`Loaded cache from disk: ${stats.entries}/${stats.maxEntries} sources, ${stats.totalTargets} targets`);
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
      const entries: Record<string, { results: Record<string, boolean>; timestamp: number; mtime: number; lastAccess: number }> = {};
      for (const [key, value] of this.cache.entries()) {
        entries[key] = {
          results: Object.fromEntries(value.results),
          timestamp: value.timestamp,
          mtime: value.mtime,
          lastAccess: value.lastAccess,
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
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    await this.saveToDisk();
  }
}
