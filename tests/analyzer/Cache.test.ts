import { describe, it, expect, beforeEach } from 'vitest';
import { Cache } from '../../src/analyzer/Cache';

describe('Cache', () => {
    let cache: Cache<string>;

    beforeEach(() => {
        cache = new Cache<string>();
    });

    it('should set and get values', () => {
        cache.set('key1', 'value1');
        expect(cache.get('key1')).toBe('value1');
    });

    it('should return undefined for non-existent keys', () => {
        expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('should check if key exists with has()', () => {
        cache.set('key1', 'value1');
        expect(cache.has('key1')).toBe(true);
        expect(cache.has('nonexistent')).toBe(false);
    });

    it('should clear all entries', () => {
        cache.set('key1', 'value1');
        cache.set('key2', 'value2');
        expect(cache.size).toBe(2);
        
        cache.clear();
        expect(cache.size).toBe(0);
        expect(cache.get('key1')).toBeUndefined();
    });

    it('should delete specific entries', () => {
        cache.set('key1', 'value1');
        cache.set('key2', 'value2');
        
        const result = cache.delete('key1');
        expect(result).toBe(true);
        expect(cache.get('key1')).toBeUndefined();
        expect(cache.get('key2')).toBe('value2');
    });

    it('should return false when deleting non-existent key', () => {
        const result = cache.delete('nonexistent');
        expect(result).toBe(false);
    });

    it('should report correct size', () => {
        expect(cache.size).toBe(0);
        
        cache.set('key1', 'value1');
        expect(cache.size).toBe(1);
        
        cache.set('key2', 'value2');
        expect(cache.size).toBe(2);
        
        cache.delete('key1');
        expect(cache.size).toBe(1);
    });

    it('should handle complex objects as values', () => {
        interface TestObject {
            name: string;
            count: number;
        }
        const objectCache = new Cache<TestObject>();
        const testObj = { name: 'test', count: 42 };
        
        objectCache.set('obj1', testObj);
        expect(objectCache.get('obj1')).toEqual(testObj);
    });

    it('should handle arrays as values', () => {
        const arrayCache = new Cache<number[]>();
        const testArray = [1, 2, 3, 4, 5];
        
        arrayCache.set('arr1', testArray);
        expect(arrayCache.get('arr1')).toEqual(testArray);
    });

    it('should overwrite existing values', () => {
        // We overrite existing values
        cache.set('key1', 'value1');
        cache.set('key1', 'value2'); //NOSONAR
        
        expect(cache.get('key1')).toBe('value2');
        expect(cache.size).toBe(1);
    });
});

describe('Cache LRU', () => {
    it('should evict oldest entry when maxSize is reached', () => {
        const lruCache = new Cache<string>({ maxSize: 3 });
        
        lruCache.set('a', '1');
        lruCache.set('b', '2');
        lruCache.set('c', '3');
        expect(lruCache.size).toBe(3);
        
        // Adding a 4th entry should evict 'a' (oldest)
        lruCache.set('d', '4');
        expect(lruCache.size).toBe(3);
        expect(lruCache.get('a')).toBeUndefined();
        expect(lruCache.get('b')).toBe('2');
        expect(lruCache.get('c')).toBe('3');
        expect(lruCache.get('d')).toBe('4');
    });

    it('should update LRU order on get()', () => {
        const lruCache = new Cache<string>({ maxSize: 3 });
        
        lruCache.set('a', '1');
        lruCache.set('b', '2');
        lruCache.set('c', '3');
        
        // Access 'a' to make it most recently used
        lruCache.get('a');
        
        // Adding 'd' should now evict 'b' (oldest after 'a' was accessed)
        lruCache.set('d', '4');
        expect(lruCache.get('a')).toBe('1');
        expect(lruCache.get('b')).toBeUndefined();
        expect(lruCache.get('c')).toBe('3');
        expect(lruCache.get('d')).toBe('4');
    });

    it('should update LRU order on set() for existing key', () => {
        const lruCache = new Cache<string>({ maxSize: 3 });
        
        lruCache.set('a', '1');
        lruCache.set('b', '2');
        lruCache.set('c', '3');
        
        // Update 'a' to make it most recently used
        lruCache.set('a', 'updated'); //NOSONAR
        
        // Adding 'd' should evict 'b'
        lruCache.set('d', '4');
        expect(lruCache.get('a')).toBe('updated');
        expect(lruCache.get('b')).toBeUndefined();
    });

    it('should work with unlimited size when maxSize is 0', () => {
        const unlimitedCache = new Cache<string>({ maxSize: 0 });
        
        for (let i = 0; i < 1000; i++) {
            unlimitedCache.set(`key${i}`, `value${i}`);
        }
        
        expect(unlimitedCache.size).toBe(1000);
        expect(unlimitedCache.get('key0')).toBe('value0');
        expect(unlimitedCache.get('key999')).toBe('value999');
    });

    it('should disable LRU reordering when enableLRU is false', () => {
        const noLRUCache = new Cache<string>({ maxSize: 3, enableLRU: false });
        
        noLRUCache.set('a', '1');
        noLRUCache.set('b', '2');
        noLRUCache.set('c', '3');
        
        // Access 'a' - should NOT update order since LRU is disabled
        noLRUCache.get('a');
        
        // Adding 'd' should still evict 'a' (first inserted)
        noLRUCache.set('d', '4');
        expect(noLRUCache.get('a')).toBeUndefined();
    });
});

describe('Cache Statistics', () => {
    it('should track hits and misses', () => {
        const cache = new Cache<string>();
        
        cache.set('key1', 'value1');
        cache.get('key1'); // hit
        cache.get('key1'); // hit
        cache.get('key2'); // miss
        cache.get('key3'); // miss
        
        const stats = cache.getStats();
        expect(stats.hits).toBe(2);
        expect(stats.misses).toBe(2);
        expect(stats.hitRate).toBe(0.5);
    });

    it('should track evictions', () => {
        const cache = new Cache<string>({ maxSize: 2 });
        
        cache.set('a', '1');
        cache.set('b', '2');
        cache.set('c', '3'); // evicts 'a'
        cache.set('d', '4'); // evicts 'b'
        
        const stats = cache.getStats();
        expect(stats.evictions).toBe(2);
    });

    it('should reset stats on clear()', () => {
        const cache = new Cache<string>();
        
        cache.set('key1', 'value1');
        cache.get('key1');
        cache.get('miss');
        
        cache.clear();
        
        const stats = cache.getStats();
        expect(stats.hits).toBe(0);
        expect(stats.misses).toBe(0);
        expect(stats.evictions).toBe(0);
    });

    it('should allow manual stats reset', () => {
        const cache = new Cache<string>();
        
        cache.set('key1', 'value1');
        cache.get('key1');
        
        cache.resetStats();
        
        const stats = cache.getStats();
        expect(stats.hits).toBe(0);
        expect(stats.size).toBe(1); // size not affected
    });

    it('should report maxSize in stats', () => {
        const cache = new Cache<string>({ maxSize: 100 });
        const stats = cache.getStats();
        expect(stats.maxSize).toBe(100);
    });

    it('should handle hitRate when no operations', () => {
        const cache = new Cache<string>();
        const stats = cache.getStats();
        expect(stats.hitRate).toBe(0);
    });
});

describe('Cache Iteration', () => {
    it('should iterate over keys', () => {
        const cache = new Cache<string>();
        cache.set('a', '1');
        cache.set('b', '2');
        cache.set('c', '3');
        
        const keys = Array.from(cache.keys());
        expect(keys).toEqual(['a', 'b', 'c']);
    });

    it('should iterate over entries', () => {
        const cache = new Cache<string>();
        cache.set('a', '1');
        cache.set('b', '2');
        
        const entries = Array.from(cache.entries());
        expect(entries).toEqual([['a', '1'], ['b', '2']]);
    });
});
