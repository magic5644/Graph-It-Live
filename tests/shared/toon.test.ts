/**
 * Tests for TOON (Token-Oriented Object Notation) format
 */

import { describe, it, expect } from 'vitest';
import { jsonToToon, toonToJson, estimateTokenSavings } from '../../src/shared/toon';

describe('TOON Format', () => {
  describe('jsonToToon', () => {
    it('should convert simple array of objects to TOON format', () => {
      const data = [
        { file: 'main.ts', line: 10 },
        { file: 'utils.ts', line: 20 },
      ];

      const toon = jsonToToon(data, { objectName: 'files' });

      expect(toon).toBe('files(file,line)\n[main.ts,10]\n[utils.ts,20]');
    });

    it('should handle arrays in values', () => {
      const data = [
        { file: 'main.ts', deps: ['fs', 'path'] },
        { file: 'utils.ts', deps: ['os'] },
      ];

      const toon = jsonToToon(data, { objectName: 'files' });

      expect(toon).toBe('files(file,deps)\n[main.ts,fs|path]\n[utils.ts,os]');
    });

    it('should handle empty arrays', () => {
      const data = [
        { file: 'main.ts', deps: [] },
        { file: 'utils.ts', deps: ['os'] },
      ];

      const toon = jsonToToon(data, { objectName: 'files' });

      expect(toon).toBe('files(file,deps)\n[main.ts,]\n[utils.ts,os]');
    });

    it('should handle null values', () => {
      const data = [
        { file: 'main.ts', description: null },
        { file: 'utils.ts', description: 'Utilities' },
      ];

      const toon = jsonToToon(data, { objectName: 'files' });

      expect(toon).toBe('files(file,description)\n[main.ts,]\n[utils.ts,Utilities]');
    });

    it('should handle empty data array', () => {
      const toon = jsonToToon([], { objectName: 'files' });
      expect(toon).toBe('files()\n');
    });

    it('should escape special characters when enabled', () => {
      const data = [
        { file: 'my,file.ts', tag: '[important]' },
      ];

      const toon = jsonToToon(data, { objectName: 'files', escapeValues: true });

      expect(toon).toContain(String.raw`my\,file.ts`);
      expect(toon).toContain(String.raw`\[important\]`);
    });

    it('should handle nested objects by converting to JSON', () => {
      const data = [
        { file: 'main.ts', metadata: { author: 'John', date: '2024-01-01' } },
      ];

      const toon = jsonToToon(data, { objectName: 'files' });

      expect(toon).toContain('main.ts');
      expect(toon).toContain('author');
      expect(toon).toContain('John');
    });

    it('should use default object name if not provided', () => {
      const data = [{ id: 1, name: 'test' }];
      const toon = jsonToToon(data);

      expect(toon.startsWith('data(')).toBe(true);
    });

    it('should throw error for non-object arrays', () => {
      const data = [1, 2, 3];

      expect(() => jsonToToon(data as never)).toThrow('TOON format requires an array of objects');
    });

    it('should throw error for mixed types in array', () => {
      const data = [
        { file: 'main.ts' },
        'invalid',
      ];

      expect(() => jsonToToon(data as never)).toThrow('All items must be objects');
    });
  });

  describe('toonToJson', () => {
    it('should parse TOON format back to JSON', () => {
      const toon = 'files(file,line)\n[main.ts,10]\n[utils.ts,20]';

      const data = toonToJson(toon);

      expect(data).toEqual([
        { file: 'main.ts', line: 10 },
        { file: 'utils.ts', line: 20 },
      ]);
    });

    it('should parse arrays in values', () => {
      const toon = 'files(file,deps)\n[main.ts,fs|path]\n[utils.ts,os|crypto]';

      const data = toonToJson(toon);

      expect(data).toEqual([
        { file: 'main.ts', deps: ['fs', 'path'] },
        { file: 'utils.ts', deps: ['os', 'crypto'] },
      ]);
    });

    it('should handle empty arrays', () => {
      const toon = 'files(file,deps)\n[main.ts,]\n[utils.ts,os]';

      const data = toonToJson(toon);

      expect(data).toEqual([
        { file: 'main.ts', deps: '' },
        { file: 'utils.ts', deps: 'os' },
      ]);
    });

    it('should handle empty dataset', () => {
      const toon = 'files()';

      const data = toonToJson(toon);

      expect(data).toEqual([]);
    });

    it('should skip empty lines', () => {
      const toon = 'files(file,line)\n[main.ts,10]\n\n[utils.ts,20]\n';

      const data = toonToJson(toon);

      expect(data).toEqual([
        { file: 'main.ts', line: 10 },
        { file: 'utils.ts', line: 20 },
      ]);
    });

    it('should unescape special characters', () => {
      const toon = 'files(file,tag)\n[my\\,file.ts,\\[important\\]]';

      const data = toonToJson(toon);

      expect(data).toEqual([
        { file: 'my,file.ts', tag: '[important]' },
      ]);
    });

    it('should parse booleans', () => {
      const toon = 'items(name,active)\n[item1,true]\n[item2,false]';

      const data = toonToJson(toon);

      expect(data).toEqual([
        { name: 'item1', active: true },
        { name: 'item2', active: false },
      ]);
    });

    it('should parse numbers', () => {
      const toon = 'items(name,count,price)\n[item1,42,19.99]\n[item2,0,-5]';

      const data = toonToJson(toon);

      expect(data).toEqual([
        { name: 'item1', count: 42, price: 19.99 },
        { name: 'item2', count: 0, price: -5 },
      ]);
    });

    it('should throw error for invalid header', () => {
      const toon = 'invalid header\n[value1,value2]';

      expect(() => toonToJson(toon)).toThrow('Invalid TOON header');
    });

    it('should throw error for invalid data line', () => {
      const toon = 'files(file,line)\ninvalid line';

      expect(() => toonToJson(toon)).toThrow('Invalid TOON data line');
    });

    it('should throw error for value count mismatch', () => {
      const toon = 'files(file,line)\n[main.ts,10,extra]';

      expect(() => toonToJson(toon)).toThrow('Value count mismatch');
    });
  });

  describe('Round-trip conversion', () => {
    it('should preserve data through JSON -> TOON -> JSON for multi-element arrays', () => {
      const original = [
        { file: 'main.ts', deps: ['fs', 'path'], line: 10 },
        { file: 'utils.ts', deps: ['os', 'crypto'], line: 20 },
      ];

      const toon = jsonToToon(original, { objectName: 'files' });
      const restored = toonToJson(toon);

      expect(restored).toEqual(original);
    });

    it('should handle complex data structures', () => {
      const original = [
        { id: 1, name: 'test', tags: ['a', 'b', 'c'], count: 42, active: true },
        { id: 2, name: 'demo', tags: [], count: 0, active: false },
      ];

      const toon = jsonToToon(original);
      const restored = toonToJson(toon);

      expect(restored).toEqual([
        { id: 1, name: 'test', tags: ['a', 'b', 'c'], count: 42, active: true },
        { id: 2, name: 'demo', tags: '', count: 0, active: false },
      ]);
    });
  });

  describe('estimateTokenSavings', () => {
    it('should calculate token savings', () => {
      const data = [
        { file: 'main.ts', deps: ['fs', 'path'] },
        { file: 'utils.ts', deps: ['os'] },
      ];

      const json = JSON.stringify(data, null, 2);
      const toon = jsonToToon(data, { objectName: 'files' });

      const savings = estimateTokenSavings(json, toon);

      expect(savings.jsonTokens).toBeGreaterThan(0);
      expect(savings.toonTokens).toBeGreaterThan(0);
      expect(savings.savings).toBeGreaterThan(0);
      expect(savings.savingsPercent).toBeGreaterThan(0);
      expect(savings.savingsPercent).toBeLessThanOrEqual(100);
    });

    it('should show significant savings for large datasets', () => {
      const data = Array.from({ length: 100 }, (_, i) => ({
        file: `file${i}.ts`,
        deps: ['dep1', 'dep2', 'dep3'],
        line: i * 10,
      }));

      const json = JSON.stringify(data, null, 2);
      const toon = jsonToToon(data, { objectName: 'files' });

      const savings = estimateTokenSavings(json, toon);

      // TOON should save at least 30% for structured data
      expect(savings.savingsPercent).toBeGreaterThan(30);
    });
  });

  describe('Edge cases', () => {
    it('should handle strings with pipes by escaping', () => {
      const data = [
        { name: 'test|pipe', value: 'a|b|c' },
      ];

      const toon = jsonToToon(data);
      
      // Pipes should be escaped
      expect(toon).toContain(String.raw`test\|pipe`);
      expect(toon).toContain(String.raw`a\|b\|c`);
      
      const restored = toonToJson(toon);
      // After round-trip, escaped pipes should be preserved
      expect(restored).toEqual(data);
    });

    it('should differentiate between arrays and strings with pipes', () => {
      // Arrays are joined with unescaped pipes
      const arrayData = [{ items: ['a', 'b', 'c'] }];
      const arrayToon = jsonToToon(arrayData);
      expect(arrayToon).toContain('a|b|c');  // Unescaped
      
      // Strings with pipes are escaped
      const stringData = [{ text: 'a|b|c' }];
      const stringToon = jsonToToon(stringData);
      expect(stringToon).toContain(String.raw`a\|b\|c`);  // Escaped
    });

    it('should handle strings with brackets', () => {
      const data = [
        { name: '[bracketed]', value: 'test[123]' },
      ];

      const toon = jsonToToon(data);
      const restored = toonToJson(toon);

      expect(restored).toEqual(data);
    });

    it('should handle strings with commas', () => {
      const data = [
        { name: 'test,comma', value: 'a,b,c' },
      ];

      const toon = jsonToToon(data);
      const restored = toonToJson(toon);

      expect(restored).toEqual(data);
    });

    it('should handle empty strings', () => {
      const data = [
        { name: '', value: '' },
        { name: 'test', value: '' },
      ];

      const toon = jsonToToon(data);
      const restored = toonToJson(toon);

      // Empty strings remain empty strings in TOON
      expect(restored).toEqual(data);
    });

    it('should handle undefined values as null', () => {
      const data = [
        { name: 'test', value: undefined },
      ];

      const toon = jsonToToon(data);
      const restored = toonToJson(toon);

      // undefined becomes empty string in TOON
      expect(restored).toEqual([
        { name: 'test', value: '' },
      ]);
    });
  });
});
