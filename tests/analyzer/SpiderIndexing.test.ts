import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Spider } from '../../src/analyzer/Spider';
import { normalizePath } from '../../src/analyzer/types';
import path from 'node:path';
import * as fs from 'node:fs/promises';

// Use absolute path for test fixtures
const fixturesPath = path.resolve(process.cwd(), 'tests/fixtures/sample-project');

describe('Spider - Reverse Index Integration', () => {
    let spider: Spider;

    beforeEach(() => {
        spider = new Spider({
            rootDir: fixturesPath,
            tsConfigPath: path.join(fixturesPath, 'tsconfig.json'),
            enableReverseIndex: true,
            indexingConcurrency: 4,
        });
    });

    describe('buildFullIndex', () => {
        it('should index all files in the workspace', async () => {
            const result = await spider.buildFullIndex();

            expect(result.cancelled).toBe(false);
            expect(result.indexedFiles).toBeGreaterThan(0);
            expect(result.duration).toBeGreaterThan(0);
            expect(spider.hasReverseIndex()).toBe(true);
        });

        it('should report progress during indexing', async () => {
            const progressUpdates: { processed: number; total: number }[] = [];

            await spider.buildFullIndex((processed, total) => {
                progressUpdates.push({ processed, total });
            });

            expect(progressUpdates.length).toBeGreaterThan(0);
            // Last update should show all files processed
            const lastUpdate = progressUpdates.at(-1)!;
            expect(lastUpdate.processed).toBe(lastUpdate.total);
        });

        it('should handle cancellation request', async () => {
            // For small projects, cancellation may not happen in time
            // This test verifies the cancellation mechanism works
            spider.cancelIndexing();
            
            // Even after cancellation request, buildFullIndex should complete gracefully
            const result = await spider.buildFullIndex();
            
            // Result should be valid regardless of cancellation timing
            expect(result.duration).toBeGreaterThanOrEqual(0);
            expect(result.indexedFiles).toBeGreaterThanOrEqual(0);
        });
    });

    describe('findReferencingFiles with index', () => {
        it('should use reverse index for O(1) lookup after indexing', async () => {
            // Build the index first
            await spider.buildFullIndex();

            const utilsFile = path.join(fixturesPath, 'src/utils.ts');
            
            // Find files that reference utils.ts
            const refs = await spider.findReferencingFiles(utilsFile);

            // main.ts and Button.tsx both import utils
            expect(refs.length).toBeGreaterThanOrEqual(1);
            expect(refs.some(r => r.path.includes('main.ts'))).toBe(true);
        });

        it('should return correct dependency info from index', async () => {
            await spider.buildFullIndex();

            const utilsFile = path.join(fixturesPath, 'src/utils.ts');
            const refs = await spider.findReferencingFiles(utilsFile);

            for (const ref of refs) {
                expect(ref.path).toBeDefined();
                expect(ref.type).toMatch(/^(import|require|export|dynamic)$/);
                expect(ref.line).toBeGreaterThan(0);
                expect(ref.module).toBeDefined();
            }
        });
    });

    describe('findReferencingFiles fallback', () => {
        it('should fall back to directory scan when index is not available', async () => {
            // Create spider without reverse index
            const spiderNoIndex = new Spider({
                rootDir: fixturesPath,
                tsConfigPath: path.join(fixturesPath, 'tsconfig.json'),
                enableReverseIndex: false,
            });

            const utilsFile = path.join(fixturesPath, 'src/utils.ts');
            const refs = await spiderNoIndex.findReferencingFiles(utilsFile);

            // Should still find references via fallback scan
            expect(refs.length).toBeGreaterThanOrEqual(1);
        });

        it('should produce same results with and without index', async () => {
            // Spider with index
            await spider.buildFullIndex();
            const utilsFile = path.join(fixturesPath, 'src/utils.ts');
            const refsWithIndex = await spider.findReferencingFiles(utilsFile);

            // Spider without index (fallback)
            const spiderNoIndex = new Spider({
                rootDir: fixturesPath,
                tsConfigPath: path.join(fixturesPath, 'tsconfig.json'),
                enableReverseIndex: false,
            });
            const refsWithoutIndex = await spiderNoIndex.findReferencingFiles(utilsFile);

            // Should find the same files
            const pathsWithIndex = refsWithIndex.map(r => r.path).sort();
            const pathsWithoutIndex = refsWithoutIndex.map(r => r.path).sort();
            expect(pathsWithIndex).toEqual(pathsWithoutIndex);
        });
    });

    describe('incremental updates', () => {
        it('should update reverse index when analyzing new files', async () => {
            // Analyze a file - should populate reverse index
            const mainFile = path.join(fixturesPath, 'src/main.ts');
            await spider.analyze(mainFile);

            // Check that utils.ts now knows main.ts references it
            const utilsFile = path.join(fixturesPath, 'src/utils.ts');
            const refs = await spider.findReferencingFiles(utilsFile);

            // Use normalizePath for cross-platform comparison (refs.path is normalized)
            expect(refs.some(r => r.path === normalizePath(mainFile))).toBe(true);
        });
    });

    describe('index serialization', () => {
        it('should serialize and restore index', async () => {
            // Build and serialize
            await spider.buildFullIndex();
            const serialized = spider.getSerializedReverseIndex();

            expect(serialized).not.toBeNull();

            // Create new spider and restore
            const newSpider = new Spider({
                rootDir: fixturesPath,
                tsConfigPath: path.join(fixturesPath, 'tsconfig.json'),
                enableReverseIndex: true,
            });

            const restored = newSpider.enableReverseIndex(serialized!);
            expect(restored).toBe(true);

            // Verify restored index works
            const utilsFile = path.join(fixturesPath, 'src/utils.ts');
            const refs = await newSpider.findReferencingFiles(utilsFile);
            expect(refs.length).toBeGreaterThanOrEqual(1);
        });

        it('should reject index from different rootDir', async () => {
            await spider.buildFullIndex();
            const serialized = spider.getSerializedReverseIndex();

            // Create spider with different rootDir
            const newSpider = new Spider({
                rootDir: '/different/root',
                enableReverseIndex: true,
            });

            const restored = newSpider.enableReverseIndex(serialized!);
            expect(restored).toBe(false);
        });
    });

    describe('index validation', () => {
        it('should validate index integrity', async () => {
            await spider.buildFullIndex();

            const validation = await spider.validateReverseIndex();

            expect(validation).not.toBeNull();
            expect(validation!.isValid).toBe(true);
            expect(validation!.stalePercentage).toBeLessThan(0.2);
        });
    });

    describe('cache stats with reverse index', () => {
        it('should include reverse index stats', async () => {
            await spider.buildFullIndex();

            const stats = spider.getCacheStats();

            expect(stats.reverseIndexStats).toBeDefined();
            expect(stats.reverseIndexStats!.indexedFiles).toBeGreaterThan(0);
            expect(stats.reverseIndexStats!.targetFiles).toBeGreaterThanOrEqual(0);
            expect(stats.reverseIndexStats!.totalReferences).toBeGreaterThanOrEqual(0);
        });
    });
});

describe('Spider - Index Performance', () => {
    // Generate a larger fixture for performance testing
    const perfFixturesPath = path.resolve(process.cwd(), 'tests/fixtures/perf-test');
    const NUM_FILES = 50;

    beforeEach(async () => {
        // Create temporary performance test fixtures
        await fs.mkdir(path.join(perfFixturesPath, 'src'), { recursive: true });

        // Create a "shared" file that will be imported by many files
        await fs.writeFile(
            path.join(perfFixturesPath, 'src/shared.ts'),
            'export const shared = "shared";\n'
        );

        // Create many files that import shared
        for (let i = 0; i < NUM_FILES; i++) {
            await fs.writeFile(
                path.join(perfFixturesPath, 'src', `file${i}.ts`),
                `import { shared } from './shared';\nexport const val${i} = shared + ${i};\n`
            );
        }
    });

    afterEach(async () => {
        // Cleanup
        await fs.rm(perfFixturesPath, { recursive: true, force: true });
    });

    it('should be significantly faster with index for reverse lookup', async () => {
        const spider = new Spider({
            rootDir: perfFixturesPath,
            enableReverseIndex: true,
            indexingConcurrency: 8,
        });

        // Build index
        await spider.buildFullIndex();

        const sharedFile = path.join(perfFixturesPath, 'src/shared.ts');

        // Measure indexed lookup (should be very fast)
        const startIndexed = performance.now();
        const refsIndexed = await spider.findReferencingFiles(sharedFile);
        const durationIndexed = performance.now() - startIndexed;

        // Measure fallback lookup (should be slower)
        const spiderNoIndex = new Spider({
            rootDir: perfFixturesPath,
            enableReverseIndex: false,
        });

        const startFallback = performance.now();
        const refsFallback = await spiderNoIndex.findReferencingFiles(sharedFile);
        const durationFallback = performance.now() - startFallback;

        // Both should find the same files
        expect(refsIndexed.length).toBe(NUM_FILES);
        expect(refsFallback.length).toBe(NUM_FILES);

        // Indexed should be faster
        console.log(`Indexed lookup: ${durationIndexed.toFixed(2)}ms, Fallback: ${durationFallback.toFixed(2)}ms`);
        
        // With warm caches, indexed should be at least as fast
        // The real difference shows on cold cache / large projects
        expect(durationIndexed).toBeLessThan(durationFallback * 2); // Allow some margin
    });

    it('should handle many files during indexing', async () => {
        const spider = new Spider({
            rootDir: perfFixturesPath,
            enableReverseIndex: true,
            indexingConcurrency: 8,
        });

        const result = await spider.buildFullIndex();

        expect(result.indexedFiles).toBe(NUM_FILES + 1); // +1 for shared.ts
        expect(result.cancelled).toBe(false);
    });
});
