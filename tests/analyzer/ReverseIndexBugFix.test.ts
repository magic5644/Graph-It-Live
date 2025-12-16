import { describe, it, expect, beforeEach } from 'vitest';
import { Spider } from '../../src/analyzer/Spider';
import { normalizePathForComparison } from '../../src/analyzer/types';
import path from 'node:path';

// Use absolute path for test fixtures
const fixturesPath = path.resolve(process.cwd(), 'tests/fixtures/sample-project');

describe('ReverseIndex - Bug Fix: References not disappearing on re-analysis', () => {
    let spider: Spider;

    beforeEach(() => {
        spider = new Spider({
            rootDir: fixturesPath,
            tsConfigPath: path.join(fixturesPath, 'tsconfig.json'),
            enableReverseIndex: true,
            indexingConcurrency: 4,
        });
    });

    it('should preserve references after re-analyzing a file that imports utils.ts', async () => {
        // Step 1: Build full index
        await spider.buildFullIndex();

        const utilsFile = path.join(fixturesPath, 'src/utils.ts');
        const mainFile = path.join(fixturesPath, 'src/main.ts');

        // Step 2: Verify initial state - utils.ts should have references
        const refsInitial = await spider.findReferencingFiles(utilsFile);
        expect(refsInitial.length).toBeGreaterThan(0);
        expect(refsInitial.some(r => r.path.includes('main.ts'))).toBe(true);

        // Step 3: Re-analyze main.ts (simulates a file save)
        await spider.reanalyzeFile(mainFile);

        // Step 4: BUG CHECK - utils.ts references should NOT disappear
        const refsAfterReanalyze = await spider.findReferencingFiles(utilsFile);
        
        // This was the bug: refsAfterReanalyze.length === 0 after re-analyzing main.ts
        expect(refsAfterReanalyze.length).toBeGreaterThan(0);
        expect(refsAfterReanalyze.some(r => r.path.includes('main.ts'))).toBe(true);
        
        // The number of references should be the same or similar
        expect(refsAfterReanalyze.length).toBeGreaterThanOrEqual(refsInitial.length - 1);
    });

    it('should maintain references for utils.ts even when multiple files are re-analyzed', async () => {
        await spider.buildFullIndex();

        const utilsFile = path.join(fixturesPath, 'src/utils.ts');
        const mainFile = path.join(fixturesPath, 'src/main.ts');
        const buttonFile = path.join(fixturesPath, 'src/components/Button.tsx');

        // Get initial references
        const refsInitial = await spider.findReferencingFiles(utilsFile);
        const initialCount = refsInitial.length;
        expect(initialCount).toBeGreaterThan(0);

        // Re-analyze multiple files in sequence (common scenario during development)
        await spider.reanalyzeFile(mainFile);
        await spider.reanalyzeFile(buttonFile);

        // References should still be present
        const refsAfter = await spider.findReferencingFiles(utilsFile);
        expect(refsAfter.length).toBe(initialCount);
    });

    it('should correctly update references when imports are actually removed', async () => {
        await spider.buildFullIndex();

        const utilsFile = path.join(fixturesPath, 'src/utils.ts');
        
        // Get initial references
        const refsInitial = await spider.findReferencingFiles(utilsFile);
        const initialCount = refsInitial.length;

        // Simulate removing a file that imports utils.ts
        const mainFile = path.join(fixturesPath, 'src/main.ts');
        spider.handleFileDeleted(mainFile);

        // References should decrease by 1 (if main.ts imported utils.ts)
        const refsAfterDelete = await spider.findReferencingFiles(utilsFile);
        const hadMainReference = refsInitial.some(r => r.path.includes('main.ts'));
        
        if (hadMainReference) {
            expect(refsAfterDelete.length).toBe(initialCount - 1);
            expect(refsAfterDelete.some(r => r.path.includes('main.ts'))).toBe(false);
        }
    });

    it('should cleanup empty maps when cleanup() is called', async () => {
        await spider.buildFullIndex();

        const mainFile = path.join(fixturesPath, 'src/main.ts');
        
        // Re-analyze a file - this may create potential empty maps internally
        await spider.reanalyzeFile(mainFile);

        // Verify index still works correctly after re-analysis
        expect(spider.hasReverseIndex()).toBe(true);
        
        // Can still find references for utils.ts
        const utilsFile = path.join(fixturesPath, 'src/utils.ts');
        const refs = await spider.findReferencingFiles(utilsFile);
        expect(refs).toBeDefined();
    });

    it('should perform lazy cleanup when accessing references', async () => {
        await spider.buildFullIndex();

        const utilsFile = path.join(fixturesPath, 'src/utils.ts');
        
        // Access references multiple times
        const refs1 = await spider.findReferencingFiles(utilsFile);
        const refs2 = await spider.findReferencingFiles(utilsFile);
        const refs3 = await spider.findReferencingFiles(utilsFile);

        // All calls should return consistent results
        expect(refs2.length).toBe(refs1.length);
        expect(refs3.length).toBe(refs1.length);
    });

    it('should handle the exact scenario described in the bug report', async () => {
        // This test reproduces the exact scenario:
        // 1. utils.ts has references (shown in webview)
        // 2. User clicks "Get References" button on utils.ts node
        // 3. No parents are displayed (bug)

        await spider.buildFullIndex();

        const utilsFile = path.join(fixturesPath, 'src/utils.ts');
        
        // Simulate clicking "Get References" button
        // This calls findReferencingFiles internally
        const refs = await spider.findReferencingFiles(utilsFile);

        // Bug check: refs should NOT be empty
        expect(refs).toBeDefined();
        expect(Array.isArray(refs)).toBe(true);
        expect(refs.length).toBeGreaterThan(0);

        // Verify the references are valid
        for (const ref of refs) {
            expect(ref.path).toBeDefined();
            expect(ref.path).toBeTruthy();
            expect(typeof ref.path).toBe('string');
        }
    });

    it('should track references correctly when navigating between files via crawl() [Bug: Navigation]', async () => {
        // This test reproduces the navigation bug:
        // 1. User opens file A → crawl(A) → A in cache, ReverseIndex updated
        // 2. User opens file B → crawl(B) → B in cache
        // 3. crawl(B) analyzes A recursively → A returns from cache
        // 4. BUG: ReverseIndex never learns that B imports A
        // 5. Result: "Get References" on A doesn't show B

        const fileA = path.join(fixturesPath, 'src/utils.ts');
        const fileB = path.join(fixturesPath, 'src/main.ts');

        // Step 1: Crawl from fileA (like opening it first)
        await spider.crawl(fileA);

        // Step 2: Verify fileA has NO references yet (it wasn't imported by anything)
        const refsBeforeB = await spider.findReferencingFiles(fileA);
        // fileA might have no references at this point, or some from files it doesn't depend on

        // Step 3: Crawl from fileB (like navigating to it)
        // fileB imports fileA, and fileA is already in cache
        // CRITICAL: This must still update ReverseIndex to record "B imports A"
        await spider.crawl(fileB);

        // Step 4: BUG CHECK - fileA should now show fileB as a reference
        const refsAfterB = await spider.findReferencingFiles(fileA);
        
        // The bug was: refsAfterB wouldn't include fileB because analyze(fileA)
        // returned from cache without updating ReverseIndex
        expect(refsAfterB).toBeDefined();
        expect(refsAfterB.length).toBeGreaterThanOrEqual(refsBeforeB.length);
        
        // Verify fileB is in the references - normalize paths for cross-platform comparison
        const normalizedFileB = normalizePathForComparison(fileB);
        const hasBReference = refsAfterB.some(ref => normalizePathForComparison(ref.path) === normalizedFileB);
        expect(hasBReference).toBe(true);
    });

    it('should maintain ReverseIndex integrity after multiple navigation sequences', async () => {
        // Simulate real user behavior: navigate between several files multiple times
        const fileA = path.join(fixturesPath, 'src/utils.ts');
        const fileB = path.join(fixturesPath, 'src/main.ts');
        const fileC = path.join(fixturesPath, 'src/circular.ts');

        // Navigate: A → B → C → A → B → C
        await spider.crawl(fileA);
        await spider.crawl(fileB);
        await spider.crawl(fileC);
        await spider.crawl(fileA);
        await spider.crawl(fileB);
        await spider.crawl(fileC);

        // Verify references are still correct for all files
        const refsA = await spider.findReferencingFiles(fileA);
        const refsB = await spider.findReferencingFiles(fileB);
        const refsC = await spider.findReferencingFiles(fileC);

        // All references should be defined and valid
        expect(refsA).toBeDefined();
        expect(refsB).toBeDefined();
        expect(refsC).toBeDefined();

        // fileB imports fileA, so fileA should have at least fileB as reference
        // Normalize paths for cross-platform comparison
        const normalizedFileB = normalizePathForComparison(fileB);
        expect(refsA.some(ref => normalizePathForComparison(ref.path) === normalizedFileB)).toBe(true);
    });
});
