import { describe, it, expect, beforeEach } from 'vitest';
import { SymbolReverseIndex } from '../../src/analyzer/SymbolReverseIndex';
import { SymbolDependency } from '../../src/analyzer/types';

describe('SymbolReverseIndex', () => {
  let index: SymbolReverseIndex;
  const rootDir = '/test/project';

  beforeEach(() => {
    index = new SymbolReverseIndex(rootDir);
  });

  describe('addDependencies', () => {
    it('should add symbol dependencies to the reverse index', () => {
      const sourceFile = '/test/project/src/app.ts';
      const dependencies: SymbolDependency[] = [
        {
          sourceSymbolId: 'src/app.ts:processData',
          targetSymbolId: './utils:formatString',
          targetFilePath: './utils',
          isTypeOnly: false,
        },
        {
          sourceSymbolId: 'src/app.ts:processData',
          targetSymbolId: './types:DataConfig',
          targetFilePath: './types',
          isTypeOnly: true,
        },
      ];

      index.addDependencies(sourceFile, dependencies);

      // Check that formatString has processData as a caller
      const formatCallers = index.getCallers('./utils:formatString');
      expect(formatCallers).toHaveLength(1);
      expect(formatCallers[0].callerSymbolId).toBe('src/app.ts:processData');
      expect(formatCallers[0].isTypeOnly).toBe(false);

      // Check that DataConfig has processData as a caller
      const configCallers = index.getCallers('./types:DataConfig');
      expect(configCallers).toHaveLength(1);
      expect(configCallers[0].callerSymbolId).toBe('src/app.ts:processData');
      expect(configCallers[0].isTypeOnly).toBe(true);
    });

    it('should handle multiple callers for the same symbol', () => {
      const deps1: SymbolDependency[] = [
        {
          sourceSymbolId: 'src/a.ts:funcA',
          targetSymbolId: './shared:helper',
          targetFilePath: './shared',
          isTypeOnly: false,
        },
      ];
      const deps2: SymbolDependency[] = [
        {
          sourceSymbolId: 'src/b.ts:funcB',
          targetSymbolId: './shared:helper',
          targetFilePath: './shared',
          isTypeOnly: false,
        },
      ];

      index.addDependencies('/test/project/src/a.ts', deps1);
      index.addDependencies('/test/project/src/b.ts', deps2);

      const helperCallers = index.getCallers('./shared:helper');
      expect(helperCallers).toHaveLength(2);
      
      const callerIds = helperCallers.map(c => c.callerSymbolId).sort();
      expect(callerIds).toEqual(['src/a.ts:funcA', 'src/b.ts:funcB']);
    });

    it('should replace old dependencies when re-adding from same source', () => {
      const sourceFile = '/test/project/src/app.ts';
      
      // First add
      index.addDependencies(sourceFile, [
        {
          sourceSymbolId: 'src/app.ts:handler',
          targetSymbolId: './old:oldHelper',
          targetFilePath: './old',
          isTypeOnly: false,
        },
      ]);

      // Check oldHelper has caller
      expect(index.getCallers('./old:oldHelper')).toHaveLength(1);

      // Re-add with different deps
      index.addDependencies(sourceFile, [
        {
          sourceSymbolId: 'src/app.ts:handler',
          targetSymbolId: './new:newHelper',
          targetFilePath: './new',
          isTypeOnly: false,
        },
      ]);

      // oldHelper should no longer have callers
      expect(index.getCallers('./old:oldHelper')).toHaveLength(0);
      
      // newHelper should now have caller
      expect(index.getCallers('./new:newHelper')).toHaveLength(1);
    });

    it('should store file hash when provided', () => {
      const sourceFile = '/test/project/src/app.ts';
      const fileHash = { mtime: 1234567890, size: 1024 };

      index.addDependencies(sourceFile, [], fileHash);

      // We can verify via isFileStale - if hash matches, it's not stale
      expect(index.isFileStale(sourceFile, fileHash)).toBe(false);
      // Different hash should be stale
      expect(index.isFileStale(sourceFile, { mtime: 0, size: 0 })).toBe(true);
    });
  });

  describe('getCallers', () => {
    it('should return empty array for unknown symbols', () => {
      const callers = index.getCallers('./unknown:unknownSymbol');
      expect(callers).toEqual([]);
    });

    it('should return callers with isTypeOnly distinction', () => {
      index.addDependencies('/test/project/src/a.ts', [
        {
          sourceSymbolId: 'src/a.ts:funcA',
          targetSymbolId: './types:UserType',
          targetFilePath: './types',
          isTypeOnly: true,
        },
      ]);
      index.addDependencies('/test/project/src/b.ts', [
        {
          sourceSymbolId: 'src/b.ts:funcB',
          targetSymbolId: './types:UserType',
          targetFilePath: './types',
          isTypeOnly: false,
        },
      ]);

      const callers = index.getCallers('./types:UserType');
      expect(callers).toHaveLength(2);
      
      const typeOnlyCallers = callers.filter(c => c.isTypeOnly);
      const runtimeCallers = callers.filter(c => !c.isTypeOnly);
      
      expect(typeOnlyCallers).toHaveLength(1);
      expect(typeOnlyCallers[0].callerSymbolId).toBe('src/a.ts:funcA');
      
      expect(runtimeCallers).toHaveLength(1);
      expect(runtimeCallers[0].callerSymbolId).toBe('src/b.ts:funcB');
    });
  });

  describe('getCallersFiltered', () => {
    beforeEach(() => {
      index.addDependencies('/test/project/src/a.ts', [
        {
          sourceSymbolId: 'src/a.ts:funcA',
          targetSymbolId: './types:Config',
          targetFilePath: './types',
          isTypeOnly: true,
        },
      ]);
      index.addDependencies('/test/project/src/b.ts', [
        {
          sourceSymbolId: 'src/b.ts:funcB',
          targetSymbolId: './types:Config',
          targetFilePath: './types',
          isTypeOnly: false,
        },
      ]);
    });

    it('should include all callers when includeTypeOnly is true', () => {
      const callers = index.getCallersFiltered('./types:Config', true);
      expect(callers).toHaveLength(2);
    });

    it('should exclude type-only callers when includeTypeOnly is false', () => {
      const callers = index.getCallersFiltered('./types:Config', false);
      expect(callers).toHaveLength(1);
      expect(callers[0].callerSymbolId).toBe('src/b.ts:funcB');
    });
  });

  describe('getRuntimeCallers', () => {
    it('should only return non-type-only callers', () => {
      index.addDependencies('/test/project/src/a.ts', [
        {
          sourceSymbolId: 'src/a.ts:typeFunc',
          targetSymbolId: './utils:helper',
          targetFilePath: './utils',
          isTypeOnly: true,
        },
      ]);
      index.addDependencies('/test/project/src/b.ts', [
        {
          sourceSymbolId: 'src/b.ts:runtimeFunc',
          targetSymbolId: './utils:helper',
          targetFilePath: './utils',
          isTypeOnly: false,
        },
      ]);

      const runtimeCallers = index.getRuntimeCallers('./utils:helper');
      expect(runtimeCallers).toHaveLength(1);
      expect(runtimeCallers[0].callerSymbolId).toBe('src/b.ts:runtimeFunc');
    });
  });

  describe('removeDependenciesFromSource', () => {
    it('should remove all entries from a source file', () => {
      const sourceFile = '/test/project/src/app.ts';
      index.addDependencies(sourceFile, [
        {
          sourceSymbolId: 'src/app.ts:funcA',
          targetSymbolId: './utils:helper',
          targetFilePath: './utils',
          isTypeOnly: false,
        },
        {
          sourceSymbolId: 'src/app.ts:funcB',
          targetSymbolId: './types:Config',
          targetFilePath: './types',
          isTypeOnly: true,
        },
      ]);

      expect(index.getCallers('./utils:helper')).toHaveLength(1);
      expect(index.getCallers('./types:Config')).toHaveLength(1);

      index.removeDependenciesFromSource(sourceFile);

      expect(index.getCallers('./utils:helper')).toHaveLength(0);
      expect(index.getCallers('./types:Config')).toHaveLength(0);
    });

    it('should preserve dependencies from other files', () => {
      index.addDependencies('/test/project/src/a.ts', [
        {
          sourceSymbolId: 'src/a.ts:funcA',
          targetSymbolId: './shared:helper',
          targetFilePath: './shared',
          isTypeOnly: false,
        },
      ]);
      index.addDependencies('/test/project/src/b.ts', [
        {
          sourceSymbolId: 'src/b.ts:funcB',
          targetSymbolId: './shared:helper',
          targetFilePath: './shared',
          isTypeOnly: false,
        },
      ]);

      index.removeDependenciesFromSource('/test/project/src/a.ts');

      const callers = index.getCallers('./shared:helper');
      expect(callers).toHaveLength(1);
      expect(callers[0].callerSymbolId).toBe('src/b.ts:funcB');
    });
  });

  describe('clear', () => {
    it('should remove all data from the index', () => {
      index.addDependencies('/test/project/src/a.ts', [
        {
          sourceSymbolId: 'src/a.ts:func',
          targetSymbolId: './utils:helper',
          targetFilePath: './utils',
          isTypeOnly: false,
        },
      ]);
      index.addDependencies('/test/project/src/b.ts', [
        {
          sourceSymbolId: 'src/b.ts:func',
          targetSymbolId: './types:Type',
          targetFilePath: './types',
          isTypeOnly: true,
        },
      ]);

      index.clear();

      expect(index.getCallers('./utils:helper')).toHaveLength(0);
      expect(index.getCallers('./types:Type')).toHaveLength(0);
      
      const stats = index.getStats();
      expect(stats.targetSymbolCount).toBe(0);
      expect(stats.totalCallerCount).toBe(0);
      expect(stats.sourceFileCount).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', () => {
      index.addDependencies('/test/project/src/a.ts', [
        {
          sourceSymbolId: 'src/a.ts:funcA',
          targetSymbolId: './utils:helper1',
          targetFilePath: './utils',
          isTypeOnly: false,
        },
        {
          sourceSymbolId: 'src/a.ts:funcA',
          targetSymbolId: './utils:helper2',
          targetFilePath: './utils',
          isTypeOnly: false,
        },
      ], { mtime: 123, size: 100 });
      index.addDependencies('/test/project/src/b.ts', [
        {
          sourceSymbolId: 'src/b.ts:funcB',
          targetSymbolId: './utils:helper1',
          targetFilePath: './utils',
          isTypeOnly: false,
        },
      ], { mtime: 456, size: 200 });

      const stats = index.getStats();
      expect(stats.sourceFileCount).toBe(2);
      expect(stats.targetSymbolCount).toBe(2); // helper1 and helper2
      expect(stats.totalCallerCount).toBe(3); // 2 for helper1, 1 for helper2
    });

    it('should return zeros for empty index', () => {
      const stats = index.getStats();
      expect(stats.targetSymbolCount).toBe(0);
      expect(stats.totalCallerCount).toBe(0);
      expect(stats.sourceFileCount).toBe(0);
    });
  });

  describe('isFileStale', () => {
    it('should return true for unknown files', () => {
      const sourceFile = '/test/project/src/unknown.ts';
      const hash = { mtime: 1234567890, size: 500 };

      // Unknown file - always stale
      expect(index.isFileStale(sourceFile, hash)).toBe(true);
    });

    it('should detect stale files correctly', () => {
      const sourceFile = '/test/project/src/app.ts';
      const hash = { mtime: 1234567890, size: 500 };

      index.addDependencies(sourceFile, [], hash);
      
      // Same hash - not stale
      expect(index.isFileStale(sourceFile, hash)).toBe(false);
      
      // Different mtime - stale
      expect(index.isFileStale(sourceFile, { mtime: 9999999999, size: 500 })).toBe(true);
      
      // Different size - stale
      expect(index.isFileStale(sourceFile, { mtime: 1234567890, size: 999 })).toBe(true);
    });
  });

  describe('hasCallers', () => {
    it('should return false for symbols without callers', () => {
      expect(index.hasCallers('./unknown:symbol')).toBe(false);
    });

    it('should return true for symbols with callers', () => {
      index.addDependencies('/test/project/src/a.ts', [
        {
          sourceSymbolId: 'src/a.ts:funcA',
          targetSymbolId: './utils:helper',
          targetFilePath: './utils',
          isTypeOnly: false,
        },
      ]);

      expect(index.hasCallers('./utils:helper')).toBe(true);
    });
  });

  describe('getCallerCount', () => {
    it('should return correct caller counts', () => {
      expect(index.getCallerCount('./unknown:symbol')).toBe(0);

      index.addDependencies('/test/project/src/a.ts', [
        {
          sourceSymbolId: 'src/a.ts:funcA',
          targetSymbolId: './utils:helper',
          targetFilePath: './utils',
          isTypeOnly: false,
        },
      ]);
      index.addDependencies('/test/project/src/b.ts', [
        {
          sourceSymbolId: 'src/b.ts:funcB',
          targetSymbolId: './utils:helper',
          targetFilePath: './utils',
          isTypeOnly: false,
        },
      ]);

      expect(index.getCallerCount('./utils:helper')).toBe(2);
    });
  });

  describe('getCallerFiles', () => {
    it('should return unique caller files', () => {
      index.addDependencies('/test/project/src/a.ts', [
        {
          sourceSymbolId: 'src/a.ts:func1',
          targetSymbolId: './utils:helper',
          targetFilePath: './utils',
          isTypeOnly: false,
        },
        {
          sourceSymbolId: 'src/a.ts:func2',
          targetSymbolId: './utils:helper',
          targetFilePath: './utils',
          isTypeOnly: false,
        },
      ]);
      index.addDependencies('/test/project/src/b.ts', [
        {
          sourceSymbolId: 'src/b.ts:func',
          targetSymbolId: './utils:helper',
          targetFilePath: './utils',
          isTypeOnly: false,
        },
      ]);

      const files = index.getCallerFiles('./utils:helper');
      expect(files).toHaveLength(2);
      expect(files.sort()).toEqual([
        '/test/project/src/a.ts',
        '/test/project/src/b.ts',
      ]);
    });
  });

  describe('getTypeOnlyCallers', () => {
    it('should only return type-only callers', () => {
      index.addDependencies('/test/project/src/a.ts', [
        {
          sourceSymbolId: 'src/a.ts:runtimeFunc',
          targetSymbolId: './types:Config',
          targetFilePath: './types',
          isTypeOnly: false,
        },
      ]);
      index.addDependencies('/test/project/src/b.ts', [
        {
          sourceSymbolId: 'src/b.ts:typeFunc',
          targetSymbolId: './types:Config',
          targetFilePath: './types',
          isTypeOnly: true,
        },
      ]);

      const typeOnlyCallers = index.getTypeOnlyCallers('./types:Config');
      expect(typeOnlyCallers).toHaveLength(1);
      expect(typeOnlyCallers[0].callerSymbolId).toBe('src/b.ts:typeFunc');
    });
  });

  describe('serialization', () => {
    it('should serialize and deserialize correctly', () => {
      index.addDependencies('/test/project/src/a.ts', [
        {
          sourceSymbolId: 'src/a.ts:func',
          targetSymbolId: './utils:helper',
          targetFilePath: './utils',
          isTypeOnly: false,
        },
      ], { mtime: 123, size: 456 });

      const serialized = index.serialize();

      const newIndex = new SymbolReverseIndex(rootDir);
      const success = newIndex.deserialize(serialized);

      expect(success).toBe(true);
      expect(newIndex.getCallers('./utils:helper')).toHaveLength(1);
      expect(newIndex.isFileStale('/test/project/src/a.ts', { mtime: 123, size: 456 })).toBe(false);
    });

    it('should reject different root directory', () => {
      index.addDependencies('/test/project/src/a.ts', [], { mtime: 1, size: 1 });
      const serialized = index.serialize();

      const newIndex = new SymbolReverseIndex('/different/root');
      const success = newIndex.deserialize(serialized);

      expect(success).toBe(false);
    });
  });
});
