/**
 * Cache statistics for monitoring
 */
export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  maxSize: number;
  hitRate: number;
}

/**
 * Cache configuration options
 */
export interface CacheOptions {
  /** Maximum number of entries (0 = unlimited) */
  maxSize?: number;
  /** Enable LRU eviction when maxSize is reached */
  enableLRU?: boolean;
}

/**
 * LRU cache implementation with size limits and statistics
 * 
 * Features:
 * - Configurable max size with LRU eviction
 * - Hit/miss/eviction statistics
 * - Memory-efficient: evicts least recently used entries
 */
export class Cache<T> {
  private readonly cache: Map<string, T> = new Map();
  private readonly maxSize: number;
  private readonly enableLRU: boolean;
  
  // Statistics
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(options: CacheOptions = {}) {
    this.maxSize = options.maxSize ?? 0; // 0 = unlimited
    this.enableLRU = options.enableLRU ?? true;
  }

  get(key: string): T | undefined {
    const value = this.cache.get(key);
    
    if (value !== undefined) {
      this.hits++;
      
      // LRU: Move to end (most recently used)
      if (this.enableLRU && this.maxSize > 0) {
        this.cache.delete(key);
        this.cache.set(key, value);
      }
      
      return value;
    }
    
    this.misses++;
    return undefined;
  }

  set(key: string, value: T): void {
    // If key exists, delete first to update position for LRU
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.maxSize > 0 && this.cache.size >= this.maxSize) {
      // Evict oldest entry (first in Map)
      this.evictOldest();
    }
    
    this.cache.set(key, value);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
    this.resetStats();
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  get size(): number {
    return this.cache.size;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  /**
   * Reset statistics counters
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  /**
   * Get all keys in the cache
   */
  keys(): IterableIterator<string> {
    return this.cache.keys();
  }

  /**
   * Get all entries in the cache
   */
  entries(): IterableIterator<[string, T]> {
    return this.cache.entries();
  }

  /**
   * Evict the oldest (least recently used) entry
   */
  private evictOldest(): void {
    const firstKey = this.cache.keys().next().value;
    if (firstKey !== undefined) {
      this.cache.delete(firstKey);
      this.evictions++;
    }
  }
}
