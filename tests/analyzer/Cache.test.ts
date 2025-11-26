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
        cache.set('key1', 'value2');
        
        expect(cache.get('key1')).toBe('value2');
        expect(cache.size).toBe(1);
    });
});
