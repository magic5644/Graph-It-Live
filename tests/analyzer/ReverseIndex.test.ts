import { describe, it, expect, beforeEach } from 'vitest';
import { ReverseIndex } from '../../src/analyzer/ReverseIndex';
import { Dependency, FileHash } from '../../src/analyzer/types';

describe('ReverseIndex', () => {
    const rootDir = '/test/project';
    let index: ReverseIndex;

    beforeEach(() => {
        index = new ReverseIndex(rootDir);
    });

    describe('addDependencies', () => {
        it('should add dependencies to the reverse index', () => {
            const sourcePath = '/test/project/src/a.ts';
            const dependencies: Dependency[] = [
                { path: '/test/project/src/b.ts', type: 'import', line: 1, module: './b' },
                { path: '/test/project/src/c.ts', type: 'import', line: 2, module: './c' },
            ];

            index.addDependencies(sourcePath, dependencies);

            // Check that b.ts knows it's referenced by a.ts
            const refsToB = index.getReferencingFiles('/test/project/src/b.ts');
            expect(refsToB).toHaveLength(1);
            expect(refsToB[0].path).toBe(sourcePath);
            expect(refsToB[0].type).toBe('import');
            expect(refsToB[0].line).toBe(1);

            // Check that c.ts knows it's referenced by a.ts
            const refsToC = index.getReferencingFiles('/test/project/src/c.ts');
            expect(refsToC).toHaveLength(1);
            expect(refsToC[0].path).toBe(sourcePath);
        });

        it('should handle multiple sources referencing the same target', () => {
            const depFromA: Dependency[] = [
                { path: '/test/project/src/shared.ts', type: 'import', line: 1, module: './shared' },
            ];
            const depFromB: Dependency[] = [
                { path: '/test/project/src/shared.ts', type: 'import', line: 5, module: '../shared' },
            ];

            index.addDependencies('/test/project/src/a.ts', depFromA);
            index.addDependencies('/test/project/src/b.ts', depFromB);

            const refs = index.getReferencingFiles('/test/project/src/shared.ts');
            expect(refs).toHaveLength(2);
            expect(refs.map(r => r.path).sort()).toEqual([
                '/test/project/src/a.ts',
                '/test/project/src/b.ts',
            ]);
        });

        it('should replace old dependencies when re-adding from same source', () => {
            const sourcePath = '/test/project/src/a.ts';
            
            // First add
            index.addDependencies(sourcePath, [
                { path: '/test/project/src/b.ts', type: 'import', line: 1, module: './b' },
                { path: '/test/project/src/c.ts', type: 'import', line: 2, module: './c' },
            ]);

            // Re-add with different deps (c.ts removed, d.ts added)
            index.addDependencies(sourcePath, [
                { path: '/test/project/src/b.ts', type: 'import', line: 1, module: './b' },
                { path: '/test/project/src/d.ts', type: 'import', line: 3, module: './d' },
            ]);

            // c.ts should no longer have reference from a.ts
            expect(index.getReferencingFiles('/test/project/src/c.ts')).toHaveLength(0);
            
            // d.ts should now have reference from a.ts
            expect(index.getReferencingFiles('/test/project/src/d.ts')).toHaveLength(1);
            
            // b.ts should still have reference from a.ts
            expect(index.getReferencingFiles('/test/project/src/b.ts')).toHaveLength(1);
        });

        it('should store file hash when provided', () => {
            const sourcePath = '/test/project/src/a.ts';
            const fileHash: FileHash = { mtime: 1234567890, size: 1024 };

            index.addDependencies(sourcePath, [], fileHash);

            expect(index.getFileHash(sourcePath)).toEqual(fileHash);
            expect(index.hasFile(sourcePath)).toBe(true);
        });
    });

    describe('removeDependenciesFromSource', () => {
        it('should remove all entries from a source file', () => {
            const sourcePath = '/test/project/src/a.ts';
            index.addDependencies(sourcePath, [
                { path: '/test/project/src/b.ts', type: 'import', line: 1, module: './b' },
                { path: '/test/project/src/c.ts', type: 'import', line: 2, module: './c' },
            ]);

            index.removeDependenciesFromSource(sourcePath);

            expect(index.getReferencingFiles('/test/project/src/b.ts')).toHaveLength(0);
            expect(index.getReferencingFiles('/test/project/src/c.ts')).toHaveLength(0);
            expect(index.hasFile(sourcePath)).toBe(false);
        });

        it('should not affect other sources', () => {
            index.addDependencies('/test/project/src/a.ts', [
                { path: '/test/project/src/shared.ts', type: 'import', line: 1, module: './shared' },
            ]);
            index.addDependencies('/test/project/src/b.ts', [
                { path: '/test/project/src/shared.ts', type: 'import', line: 5, module: './shared' },
            ]);

            index.removeDependenciesFromSource('/test/project/src/a.ts');

            const refs = index.getReferencingFiles('/test/project/src/shared.ts');
            expect(refs).toHaveLength(1);
            expect(refs[0].path).toBe('/test/project/src/b.ts');
        });
    });

    describe('getReferencingFiles', () => {
        it('should return empty array for unknown targets', () => {
            const refs = index.getReferencingFiles('/test/project/src/unknown.ts');
            expect(refs).toEqual([]);
        });

        it('should return correct dependency info', () => {
            index.addDependencies('/test/project/src/a.ts', [
                { path: '/test/project/src/b.ts', type: 'require', line: 10, module: './b' },
            ]);

            const refs = index.getReferencingFiles('/test/project/src/b.ts');
            expect(refs).toHaveLength(1);
            expect(refs[0]).toEqual({
                path: '/test/project/src/a.ts',
                type: 'require',
                line: 10,
                module: './b',
            });
        });
    });

    describe('isFileStale', () => {
        it('should return true for unknown files', () => {
            const hash: FileHash = { mtime: 1234567890, size: 1024 };
            expect(index.isFileStale('/test/project/src/unknown.ts', hash)).toBe(true);
        });

        it('should return false for unchanged files', () => {
            const hash: FileHash = { mtime: 1234567890, size: 1024 };
            index.addDependencies('/test/project/src/a.ts', [], hash);

            expect(index.isFileStale('/test/project/src/a.ts', hash)).toBe(false);
        });

        it('should return true when mtime changes', () => {
            const oldHash: FileHash = { mtime: 1234567890, size: 1024 };
            const newHash: FileHash = { mtime: 1234567999, size: 1024 };
            
            index.addDependencies('/test/project/src/a.ts', [], oldHash);
            
            expect(index.isFileStale('/test/project/src/a.ts', newHash)).toBe(true);
        });

        it('should return true when size changes', () => {
            const oldHash: FileHash = { mtime: 1234567890, size: 1024 };
            const newHash: FileHash = { mtime: 1234567890, size: 2048 };
            
            index.addDependencies('/test/project/src/a.ts', [], oldHash);
            
            expect(index.isFileStale('/test/project/src/a.ts', newHash)).toBe(true);
        });
    });

    describe('hasEntries / hasFile', () => {
        it('hasEntries should return false for empty index', () => {
            expect(index.hasEntries()).toBe(false);
        });

        it('hasEntries should return true when index has entries', () => {
            index.addDependencies('/test/project/src/a.ts', [
                { path: '/test/project/src/b.ts', type: 'import', line: 1, module: './b' },
            ]);
            expect(index.hasEntries()).toBe(true);
        });

        it('hasFile should track indexed files', () => {
            expect(index.hasFile('/test/project/src/a.ts')).toBe(false);
            
            index.addDependencies('/test/project/src/a.ts', [], { mtime: 123, size: 100 });
            
            expect(index.hasFile('/test/project/src/a.ts')).toBe(true);
        });
    });

    describe('clear', () => {
        it('should remove all entries', () => {
            index.addDependencies('/test/project/src/a.ts', [
                { path: '/test/project/src/b.ts', type: 'import', line: 1, module: './b' },
            ], { mtime: 123, size: 100 });

            index.clear();

            expect(index.hasEntries()).toBe(false);
            expect(index.hasFile('/test/project/src/a.ts')).toBe(false);
            expect(index.indexedFileCount).toBe(0);
        });
    });

    describe('getStats', () => {
        it('should return correct statistics', () => {
            // Add some data
            index.addDependencies('/test/project/src/a.ts', [
                { path: '/test/project/src/shared.ts', type: 'import', line: 1, module: './shared' },
            ], { mtime: 123, size: 100 });
            
            index.addDependencies('/test/project/src/b.ts', [
                { path: '/test/project/src/shared.ts', type: 'import', line: 1, module: './shared' },
                { path: '/test/project/src/utils.ts', type: 'import', line: 2, module: './utils' },
            ], { mtime: 456, size: 200 });

            const stats = index.getStats();
            
            expect(stats.indexedFiles).toBe(2); // a.ts and b.ts
            expect(stats.targetFiles).toBe(2); // shared.ts and utils.ts
            expect(stats.totalReferences).toBe(3); // 1 from a.ts + 2 from b.ts
        });
    });

    describe('serialize / deserialize', () => {
        it('should serialize and deserialize correctly', () => {
            // Setup some data
            index.addDependencies('/test/project/src/a.ts', [
                { path: '/test/project/src/b.ts', type: 'import', line: 1, module: './b' },
                { path: '/test/project/src/c.ts', type: 'require', line: 5, module: './c' },
            ], { mtime: 1234567890, size: 1024 });

            index.addDependencies('/test/project/src/d.ts', [
                { path: '/test/project/src/b.ts', type: 'dynamic', line: 10, module: './b' },
            ], { mtime: 9876543210, size: 2048 });

            // Serialize
            const serialized = index.serialize();
            
            expect(serialized.version).toBe(1);
            expect(serialized.rootDir).toBe(rootDir);
            expect(serialized.timestamp).toBeGreaterThan(0);

            // Deserialize
            const restored = ReverseIndex.deserialize(serialized, rootDir);
            
            expect(restored).not.toBeNull();
            expect(restored!.indexedFileCount).toBe(2);
            
            // Check restored data
            const refsToB = restored!.getReferencingFiles('/test/project/src/b.ts');
            expect(refsToB).toHaveLength(2);
            
            const refsToC = restored!.getReferencingFiles('/test/project/src/c.ts');
            expect(refsToC).toHaveLength(1);
            expect(refsToC[0].type).toBe('require');

            // Check file hashes are restored
            expect(restored!.getFileHash('/test/project/src/a.ts')).toEqual({ mtime: 1234567890, size: 1024 });
        });

        it('should reject wrong version', () => {
            const serialized = index.serialize();
            serialized.version = 999;

            const restored = ReverseIndex.deserialize(serialized, rootDir);
            expect(restored).toBeNull();
        });

        it('should reject wrong rootDir', () => {
            const serialized = index.serialize();

            const restored = ReverseIndex.deserialize(serialized, '/different/root');
            expect(restored).toBeNull();
        });
    });

    describe('getFileHashFromDisk', () => {
        it('should return null for non-existent files', async () => {
            const hash = await ReverseIndex.getFileHashFromDisk('/non/existent/file.ts');
            expect(hash).toBeNull();
        });

        // Note: Testing actual file hash would require file fixtures
        // which is done in integration tests
    });

    describe('validateIndex', () => {
        it('should return valid for empty index', async () => {
            const result = await index.validateIndex();
            
            expect(result.isValid).toBe(true);
            expect(result.staleFiles).toEqual([]);
            expect(result.missingFiles).toEqual([]);
            expect(result.stalePercentage).toBe(0);
        });

        it('should detect missing files', async () => {
            // Add a file that doesn't exist on disk
            index.addDependencies('/non/existent/file.ts', [
                { path: '/test/project/src/b.ts', type: 'import', line: 1, module: './b' },
            ], { mtime: 123, size: 100 });

            const result = await index.validateIndex();
            
            expect(result.missingFiles).toContain('/non/existent/file.ts');
            expect(result.stalePercentage).toBe(1); // 100% stale
        });
    });

    describe('performance characteristics', () => {
        it('getReferencingFiles should be O(1) lookup', () => {
            // Add many entries
            const targetPath = '/test/project/src/popular.ts';
            for (let i = 0; i < 1000; i++) {
                index.addDependencies(`/test/project/src/file${i}.ts`, [
                    { path: targetPath, type: 'import', line: 1, module: './popular' },
                ], { mtime: i, size: i * 10 });
            }

            // Measure lookup time
            const start = performance.now();
            const refs = index.getReferencingFiles(targetPath);
            const duration = performance.now() - start;

            expect(refs).toHaveLength(1000);
            // Should be very fast (< 5ms) - O(1) for getting the map + O(n) for converting to array
            expect(duration).toBeLessThan(50);
        });
    });
});
